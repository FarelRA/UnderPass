// =================================================================
// File: protocol/udp.js
// Description: UDP proxy handler for DNS-over-HTTPS.
//              Handles single DNS query per connection with proper buffer management.
// =================================================================

import { logger } from '../lib/logger.js';
import { concatBuffers, isExpectedError } from '../lib/utils.js';

// === Public API ===

/**
 * Proxies UDP DNS queries over DNS-over-HTTPS.
 * Reads DNS packet from WebSocket, queries DoH server, and sends response back.
 *
 * @param {{readable: ReadableStreamDefaultReader, writable: WritableStreamDefaultWriter}} clientStream - The client streams.
 * @param {Uint8Array} payload - The initial payload from VLESS header.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function proxyUdp(clientStream, payload, config) {
  logger.debug('UDP:PROXY', 'Starting UDP proxy for DNS query');
  logger.trace('UDP:PROXY', `Payload size: ${payload.byteLength} bytes`);

  try {
    // Read complete DNS packet
    logger.debug('UDP:PACKET', 'Reading DNS packet from WebSocket');
    const query = await readPacket(payload, clientStream.readable);
    logger.info('UDP:PACKET', `DNS query received: ${query.byteLength} bytes`);

    // Query DoH server
    logger.debug('UDP:DOH', `Querying DoH server: ${config.DOH_URL}`);
    const response = await queryDns(query, config);
    logger.info('UDP:DOH', `DNS response received: ${response.byteLength} bytes`);

    // Send response back to client
    logger.debug('UDP:RESPONSE', 'Sending DNS response to client');
    await sendResponse(clientStream.writable, response);
    logger.info('UDP:PROXY', 'DNS query processed successfully');
  } catch (error) {
    if (isExpectedError(error)) {
      logger.debug('UDP:PROXY', `Connection closed: ${error.message}`);
    } else {
      logger.error('UDP:PROXY', `DNS query failed: ${error.message}`);
    }
    throw error;
  }
}

// === Private Helper Functions ===

/**
 * Reads chunks until a complete DNS packet is assembled.
 * Handles packets that may span multiple WebSocket messages.
 *
 * @param {Uint8Array} payload - The initial payload from VLESS header.
 * @param {ReadableStreamDefaultReader} reader - The WebSocket readable stream reader.
 * @returns {Promise<Uint8Array>} The complete DNS packet.
 * @throws {Error} If WebSocket closes before complete packet is received.
 */
async function readPacket(payload, reader) {
  logger.trace('UDP:PACKET', `Starting packet read with ${payload.byteLength} bytes payload`);
  let buffer = payload;

  // Check if payload contains complete packet
  if (buffer.byteLength >= 2) {
    const packetLength = new DataView(buffer.buffer, buffer.byteOffset).getUint16(0);
    logger.trace('UDP:PACKET', `Expected packet length: ${packetLength} bytes`);
    
    if (buffer.byteLength >= 2 + packetLength) {
      logger.debug('UDP:PACKET', 'Complete packet found in payload');
      return buffer.subarray(2, 2 + packetLength);
    }
    
    logger.debug('UDP:PACKET', `Incomplete packet in payload (${buffer.byteLength} of ${2 + packetLength} bytes)`);
  }

  // Read additional chunks until complete
  logger.debug('UDP:PACKET', 'Reading additional chunks from WebSocket');
  let chunksRead = 0;
  
  while (true) {
    const { value, done } = await reader.read();
    
    if (done) {
      logger.debug('UDP:PACKET', 'Stream closed before complete packet received');
      throw new Error('Stream closed');
    }

    chunksRead++;
    buffer = concatBuffers(buffer, value);
    logger.trace('UDP:PACKET', `Chunk ${chunksRead} received: ${value.byteLength} bytes (total: ${buffer.byteLength})`);

    if (buffer.byteLength >= 2) {
      const packetLength = new DataView(buffer.buffer, buffer.byteOffset).getUint16(0);
      
      if (buffer.byteLength >= 2 + packetLength) {
        logger.debug('UDP:PACKET', `Complete packet assembled after ${chunksRead} chunks`);
        return buffer.subarray(2, 2 + packetLength);
      }
    }
  }
}

/**
 * Queries the DoH server with a DNS packet.
 * Sends DNS query via HTTPS POST and returns the response.
 *
 * @param {Uint8Array} query - The DNS query payload.
 * @param {object} config - Configuration containing DOH_URL.
 * @returns {Promise<Uint8Array>} The DNS response.
 * @throws {Error} If DoH request fails or returns empty response.
 */
async function queryDns(query, config) {
  logger.trace('UDP:DOH', `Sending DNS query: ${query.byteLength} bytes`);

  try {
    const response = await fetch(config.DOH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: query,
    });

    if (!response.ok) {
      const error = `DoH request failed with status ${response.status}`;
      logger.error('UDP:DOH', error);
      throw new Error(error);
    }

    logger.trace('UDP:DOH', `DoH response status: ${response.status}`);
    const result = new Uint8Array(await response.arrayBuffer());
    logger.debug('UDP:DOH', `DoH response received: ${result.byteLength} bytes`);

    return result;
  } catch (error) {
    if (isExpectedError(error)) {
      logger.debug('UDP:DOH', `Connection closed: ${error.message}`);
    } else {
      logger.error('UDP:DOH', `DoH query failed: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Sends a DNS response back to the client in VLESS UDP format.
 * Format: [2-byte length][DNS response data]
 *
 * @param {WritableStreamDefaultWriter} writer - The WebSocket writable stream writer.
 * @param {Uint8Array} response - The DNS response data.
 * @returns {Promise<void>}
 */
async function sendResponse(writer, response) {
  logger.trace('UDP:RESPONSE', `Formatting response: ${response.byteLength} bytes`);
  
  // Format response in VLESS UDP format
  const packet = new Uint8Array(2 + response.byteLength);
  new DataView(packet.buffer).setUint16(0, response.byteLength);
  packet.set(response, 2);
  logger.trace('UDP:RESPONSE', `Packet formatted: ${packet.byteLength} bytes total`);

  // Send to client
  await writer.write(packet);
  logger.debug('UDP:RESPONSE', 'Response sent to client');
}
