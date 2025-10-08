// =================================================================
// File: protocol/udp.js
// Description: Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

// === Public API ===

/**
 * Main handler for UDP proxying via DNS-over-HTTPS.
 * Currently only supports DNS queries (port 53) proxied through DoH.
 * 
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket connection.
 * @param {Uint8Array} initialPayload - The payload from VLESS header parsing.
 * @param {ReadableStream} wsStream - The WebSocket message stream.
 * @param {object} config - The request-scoped configuration containing DOH_URL.
 * @returns {Promise<void>}
 */
export async function handleUdpProxy(clientWebSocket, initialPayload, wsStream, config) {
  await proxyUdpOverDoH(clientWebSocket, initialPayload, wsStream, config);
  safeCloseWebSocket(clientWebSocket);
}

// === Private Helper Functions ===

/**
 * The main proxying loop for UDP over DNS-over-HTTPS.
 * Processes the initial payload and then continuously reads from the WebSocket stream,
 * forwarding each DNS packet to the DoH server and sending responses back to the client.
 * 
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket connection.
 * @param {Uint8Array} initialPayload - The initial payload from VLESS header.
 * @param {ReadableStream} wsStream - The WebSocket message stream.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
async function proxyUdpOverDoH(clientWebSocket, initialPayload, wsStream, config) {
  // Process initial payload if present
  if (initialPayload.byteLength > 0) {
    await processChunk(initialPayload, clientWebSocket, config);
  }

  // Set up stream reader
  const reader = wsStream.getReader();

  try {
    // Continuously process incoming chunks
    while (true) {
      const { value, done } = await reader.read();
      
      if (done) {
        logger.info('UDP:CLOSE', 'Client UDP stream closed.');
        break;
      }
      
      await processChunk(value, clientWebSocket, config);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Processes a single UDP chunk containing one or more DNS packets.
 * Each chunk follows the VLESS UDP format: [2-byte length][DNS packet][2-byte length][DNS packet]...
 * 
 * @param {Uint8Array} chunk - The chunk data to process.
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
async function processChunk(chunk, clientWebSocket, config) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

  let offset = 0;
  
  // Process all packets in the chunk
  while (offset < chunk.byteLength) {
    // === Read Packet Length (2 bytes) ===
    if (offset + 2 > chunk.byteLength) {
      logger.warn('UDP:PARSE', 'Incomplete length header in VLESS UDP chunk.');
      break;
    }

    const packetLength = view.getUint16(offset);
    offset += 2;
    
    // === Validate Packet Data ===
    if (offset + packetLength > chunk.byteLength) {
      logger.warn('UDP:PARSE', 'Incomplete VLESS UDP packet payload.');
      break;
    }

    // === Extract and Process DNS Packet ===
    const dnsPacket = chunk.subarray(offset, offset + packetLength);
    await processDnsPacket(dnsPacket, clientWebSocket, config);
    
    offset += packetLength;
  }
}

/**
 * Processes a single DNS packet by forwarding it to the DoH server
 * and sending the VLESS-formatted response back to the client.
 * 
 * @param {Uint8Array} dnsQuery - The raw DNS query payload.
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket.
 * @param {object} config - The request-scoped configuration containing DOH_URL.
 * @returns {Promise<void>}
 */
async function processDnsPacket(dnsQuery, clientWebSocket, config) {
  // === Forward DNS Query to DoH Server ===
  const response = await fetch(config.DOH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message' },
    body: dnsQuery,
  });

  if (!response.ok) {
    logger.error('UDP:DOH_ERROR', `DoH request failed with status ${response.status}`);
    return;
  }

  // === Read DNS Response ===
  const dnsResult = new Uint8Array(await response.arrayBuffer());
  const resultSize = dnsResult.byteLength;

  if (resultSize === 0) {
    logger.warn('UDP:EMPTY_RESPONSE', 'DoH returned empty response');
    return;
  }

  // === Format Response in VLESS UDP Format ===
  // Format: [2-byte length][DNS response data]
  const responsePacket = new Uint8Array(2 + resultSize);
  new DataView(responsePacket.buffer).setUint16(0, resultSize);
  responsePacket.set(dnsResult, 2);

  // === Send Response Back to Client ===
  clientWebSocket.send(responsePacket);
}
