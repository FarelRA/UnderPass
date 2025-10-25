// =================================================================
// File: protocol/udp.js
// Description: Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

// === Public API ===

/**
 * Handles a single DNS query over UDP via DNS-over-HTTPS.
 *
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket connection.
 * @param {Uint8Array} initialPayload - The initial payload from VLESS header.
 * @param {ReadableStream} wsStream - The WebSocket message stream.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function handleUdpProxy(clientWebSocket, initialPayload, wsStream, config) {
  try {
    const dnsQuery = await readPacket(clientWebSocket, initialPayload, wsStream);
    const dnsResponse = await queryDns(dnsQuery, config);
    sendResponse(clientWebSocket, dnsResponse);
    logger.info('UDP:PROXY', 'DNS query processed successfully');
  } catch (error) {
    logger.error('UDP:PROXY', `Error: ${error.message}`);
  }

  safeCloseWebSocket(clientWebSocket);
}

// === Private Helper Functions ===

/**
 * Reads chunks until a complete DNS packet is assembled.
 *
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket.
 * @param {Uint8Array} initialPayload - The initial payload from VLESS header.
 * @param {ReadableStream} wsStream - The WebSocket message stream.
 * @returns {Promise<Uint8Array>} The complete DNS packet.
 */
async function readPacket(clientWebSocket, initialPayload, wsStream) {
  let buffer = initialPayload;

  // Check if initial payload already contains complete packet
  if (buffer.byteLength >= 2) {
    const packetLength = new DataView(buffer.buffer, buffer.byteOffset).getUint16(0);
    if (buffer.byteLength >= 2 + packetLength) {
      return buffer.subarray(2, 2 + packetLength);
    }
  }

  // Read additional chunks until complete
  const reader = wsStream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        throw new Error('WebSocket closed before complete packet received');
      }

      buffer = concatBuffers(buffer, value);

      if (buffer.byteLength >= 2) {
        const packetLength = new DataView(buffer.buffer, buffer.byteOffset).getUint16(0);
        if (buffer.byteLength >= 2 + packetLength) {
          return buffer.subarray(2, 2 + packetLength);
        }
      }
    }
  } finally {
    reader.releaseLock();
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
 *
 * @param {Uint8Array} dnsQuery - The DNS query payload.
 * @param {object} config - Configuration containing DOH_URL.
 * @returns {Promise<Uint8Array>} The DNS response.
 */
async function queryDns(dnsQuery, config) {
  const response = await fetch(config.DOH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message' },
    body: dnsQuery,
  });

  if (!response.ok) {
    throw new Error(`DoH request failed with status ${response.status}`);
  }

  const dnsResult = new Uint8Array(await response.arrayBuffer());

  if (dnsResult.byteLength === 0) {
    throw new Error('DoH returned empty response');
  }

  return dnsResult;
}

/**
 * Sends a DNS response back to the client in VLESS UDP format.
 *
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket.
 * @param {Uint8Array} dnsResponse - The DNS response data.
 */
function sendResponse(clientWebSocket, dnsResponse) {
  const packet = new Uint8Array(2 + dnsResponse.byteLength);
  new DataView(packet.buffer).setUint16(0, dnsResponse.byteLength);
  packet.set(dnsResponse, 2);
  clientWebSocket.send(packet);
}
