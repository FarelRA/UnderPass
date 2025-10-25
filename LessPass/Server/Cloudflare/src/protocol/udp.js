// =================================================================
// File: protocol/udp.js
// Description: Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { logger } from '../lib/logger.js';

// === Public API ===

/**
 * Handles a single DNS query over UDP via DNS-over-HTTPS.
 *
 * @param {ReadableStream} wsReadable - The WebSocket readable stream.
 * @param {WritableStream} wsWritable - The WebSocket writable stream.
 * @param {Uint8Array} initialPayload - The initial payload from VLESS header.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function handleUdpProxy(wsReadable, wsWritable, initialPayload, config) {
  try {
    const dnsQuery = await readPacket(initialPayload, wsReadable);
    const dnsResponse = await queryDns(dnsQuery, config);
    await sendResponse(wsWritable, dnsResponse);
    logger.info('UDP:PROXY', 'DNS query processed successfully');
  } catch (error) {
    logger.error('UDP:PROXY', `Error: ${error.message}`);
  }
}

// === Private Helper Functions ===

/**
 * Reads chunks until a complete DNS packet is assembled.
 *
 * @param {Uint8Array} initialPayload - The initial payload from VLESS header.
 * @param {ReadableStream} wsReadable - The WebSocket readable stream.
 * @returns {Promise<Uint8Array>} The complete DNS packet.
 */
async function readPacket(initialPayload, wsReadable) {
  let buffer = initialPayload;

  // Check if initial payload already contains complete packet
  if (buffer.byteLength >= 2) {
    const packetLength = new DataView(buffer.buffer, buffer.byteOffset).getUint16(0);
    if (buffer.byteLength >= 2 + packetLength) {
      return buffer.subarray(2, 2 + packetLength);
    }
  }

  // Read additional chunks until complete
  const reader = wsReadable.getReader();
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
 * @param {WritableStream} wsWritable - The WebSocket writable stream.
 * @param {Uint8Array} dnsResponse - The DNS response data.
 */
async function sendResponse(wsWritable, dnsResponse) {
  const packet = new Uint8Array(2 + dnsResponse.byteLength);
  new DataView(packet.buffer).setUint16(0, dnsResponse.byteLength);
  packet.set(dnsResponse, 2);
  
  const writer = wsWritable.getWriter();
  await writer.write(packet);
  writer.releaseLock();
}
