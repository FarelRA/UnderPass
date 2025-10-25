// =================================================================
// File: protocol/udp.js
// Description: UDP proxy handler for DNS-over-HTTPS.
//              Handles single DNS query per connection with proper buffer management.
// =================================================================

import { logger } from '../lib/logger.js';

// === Public API ===

/**
 * Handles a single DNS query over UDP via DNS-over-HTTPS.
 * Reads DNS packet from WebSocket, queries DoH server, and sends response back.
 *
 * @param {{readable: ReadableStream, writable: WritableStream}} webStream - The WebSocket streams.
 * @param {Uint8Array} initialPayload - The initial payload from VLESS header.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function handleUdpProxy(webStream, initialPayload, config) {
  logger.debug('UDP:PROXY', 'Starting UDP proxy for DNS query');
  logger.trace('UDP:PROXY', `Initial payload size: ${initialPayload.byteLength} bytes`);

  try {
    // Read complete DNS packet
    logger.debug('UDP:PACKET', 'Reading DNS packet from WebSocket');
    const dnsQuery = await readPacket(initialPayload, webStream.readable);
    logger.info('UDP:PACKET', `DNS query received: ${dnsQuery.byteLength} bytes`);

    // Query DoH server
    logger.debug('UDP:DOH', `Querying DoH server: ${config.DOH_URL}`);
    const dnsResponse = await queryDns(dnsQuery, config);
    logger.info('UDP:DOH', `DNS response received: ${dnsResponse.byteLength} bytes`);

    // Send response back to client
    logger.debug('UDP:RESPONSE', 'Sending DNS response to client');
    await sendResponse(webStream.writable, dnsResponse);
    logger.info('UDP:PROXY', 'DNS query processed successfully');
  } catch (error) {
    logger.error('UDP:PROXY', `DNS query failed: ${error.message}`);
    throw error;
  }
}

// === Private Helper Functions ===

/**
 * Reads chunks until a complete DNS packet is assembled.
 * Handles packets that may span multiple WebSocket messages.
 *
 * @param {Uint8Array} initialPayload - The initial payload from VLESS header.
 * @param {ReadableStreamDefaultReader} wsReader - The WebSocket readable stream reader.
 * @returns {Promise<Uint8Array>} The complete DNS packet.
 * @throws {Error} If WebSocket closes before complete packet is received.
 */
async function readPacket(initialPayload, wsReader) {
  logger.trace('UDP:PACKET', `Starting packet read with ${initialPayload.byteLength} bytes initial payload`);
  let buffer = initialPayload;

  // Check if initial payload contains complete packet
  if (buffer.byteLength >= 2) {
    const packetLength = new DataView(buffer.buffer, buffer.byteOffset).getUint16(0);
    logger.trace('UDP:PACKET', `Expected packet length: ${packetLength} bytes`);
    
    if (buffer.byteLength >= 2 + packetLength) {
      logger.debug('UDP:PACKET', 'Complete packet found in initial payload');
      return buffer.subarray(2, 2 + packetLength);
    }
    
    logger.debug('UDP:PACKET', `Incomplete packet in initial payload (${buffer.byteLength} of ${2 + packetLength} bytes)`);
  }

  // Read additional chunks until complete
  logger.debug('UDP:PACKET', 'Reading additional chunks from WebSocket');
  let chunksRead = 0;
  
  while (true) {
    const { value, done } = await wsReader.read();
    
    if (done) {
      const error = 'WebSocket closed before complete packet received';
      logger.error('UDP:PACKET', error);
      throw new Error(error);
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
 * Concatenates two Uint8Arrays.
 *
 * @param {Uint8Array} a - First buffer.
 * @param {Uint8Array} b - Second buffer.
 * @returns {Uint8Array} Combined buffer.
 */
function concatBuffers(a, b) {
  const result = new Uint8Array(a.byteLength + b.byteLength);
  result.set(a);
  result.set(b, a.byteLength);
  return result;
}

/**
 * Queries the DoH server with a DNS packet.
 * Sends DNS query via HTTPS POST and returns the response.
 *
 * @param {Uint8Array} dnsQuery - The DNS query payload.
 * @param {object} config - Configuration containing DOH_URL.
 * @returns {Promise<Uint8Array>} The DNS response.
 * @throws {Error} If DoH request fails or returns empty response.
 */
async function queryDns(dnsQuery, config) {
  logger.trace('UDP:DOH', `Sending DNS query: ${dnsQuery.byteLength} bytes`);

  try {
    const response = await fetch(config.DOH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: dnsQuery,
    });

    if (!response.ok) {
      const error = `DoH request failed with status ${response.status}`;
      logger.error('UDP:DOH', error);
      throw new Error(error);
    }

    logger.trace('UDP:DOH', `DoH response status: ${response.status}`);
    const dnsResult = new Uint8Array(await response.arrayBuffer());

    if (dnsResult.byteLength === 0) {
      const error = 'DoH returned empty response';
      logger.error('UDP:DOH', error);
      throw new Error(error);
    }

    logger.debug('UDP:DOH', `DoH response received: ${dnsResult.byteLength} bytes`);
    return dnsResult;
  } catch (error) {
    logger.error('UDP:DOH', `DoH query failed: ${error.message}`);
    throw error;
  }
}

/**
 * Sends a DNS response back to the client in VLESS UDP format.
 * Format: [2-byte length][DNS response data]
 *
 * @param {WritableStreamDefaultWriter} wsWriter - The WebSocket writable stream writer.
 * @param {Uint8Array} dnsResponse - The DNS response data.
 * @returns {Promise<void>}
 */
async function sendResponse(wsWriter, dnsResponse) {
  logger.trace('UDP:RESPONSE', `Formatting response: ${dnsResponse.byteLength} bytes`);
  
  // Format response in VLESS UDP format
  const packet = new Uint8Array(2 + dnsResponse.byteLength);
  new DataView(packet.buffer).setUint16(0, dnsResponse.byteLength);
  packet.set(dnsResponse, 2);
  logger.trace('UDP:RESPONSE', `Packet formatted: ${packet.byteLength} bytes total`);

  // Send to client
  await wsWriter.write(packet);
  logger.debug('UDP:RESPONSE', 'Response sent to client');
}
