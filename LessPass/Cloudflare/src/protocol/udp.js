// =================================================================
// File: protocol/udp.js
// Description: Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

/**
 * Main handler for UDP proxying. Its primary responsibilities are to perform
 * the initial VLESS handshake and orchestrate the main proxying loop.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {Uint8Array} initialPayload The payload from VLESS header parsing.
 * @param {ReadableStream} wsStream The WebSocket message stream.
 * @param {object} config The request-scoped configuration.
 * @returns {Promise<void>}
 * @throws {Error} If parameters are invalid or handshake fails.
 */
export async function handleUdpProxy(webSocket, initialPayload, wsStream, config) {
  await proxyUdpOverDoH(webSocket, initialPayload, wsStream, config);
  safeCloseWebSocket(webSocket);
}

/**
 * The main proxying loop for UDP. It sets up a stream pipeline to listen for
 * client packets and process them individually.
 * This function is the architectural equivalent of TCP's `attemptConnection`.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {Uint8Array} initialPayload The payload from VLESS header parsing.
 * @param {ReadableStream} wsStream The WebSocket message stream.
 * @param {object} config The request-scoped configuration.
 * @returns {Promise<void>}
 */
async function proxyUdpOverDoH(webSocket, initialPayload, wsStream, config) {
  const processChunk = async (chunk) => {
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    for (let offset = 0; offset < chunk.byteLength; ) {
      if (offset + 2 > chunk.byteLength) {
        logger.warn('UDP:PARSE', 'Incomplete length header in VLESS UDP chunk.');
        break;
      }

      const length = view.getUint16(offset);
      offset += 2;
      
      if (offset + length > chunk.byteLength) {
        logger.warn('UDP:PARSE', 'Incomplete VLESS UDP packet payload.');
        break;
      }

      await processDnsPacket(chunk.subarray(offset, offset + length), webSocket, config);
      offset += length;
    }
  };

  if (initialPayload.byteLength > 0) {
    await processChunk(initialPayload);
  }

  const reader = wsStream.getReader();

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.info('UDP:CLOSE', 'Client UDP stream closed.');
        break;
      }
      await processChunk(value);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Processes a single DNS packet. It forwards the query to the DoH server
 * and sends the VLESS-formatted response back to the client.
 * This is the core "unit of work" for the UDP proxy.
 * @param {Uint8Array} dnsQuery The raw DNS query payload.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {object} config The request-scoped configuration.
 * @returns {Promise<void>}
 */
async function processDnsPacket(dnsQuery, webSocket, config) {
  const response = await fetch(config.DOH_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/dns-message' },
    body: dnsQuery,
  });

  if (!response.ok) {
    logger.error('UDP:DOH_ERROR', `DoH request failed with status ${response.status}`);
    return;
  }

  const dnsResult = new Uint8Array(await response.arrayBuffer());
  const resultSize = dnsResult.byteLength;

  if (resultSize === 0) {
    logger.warn('UDP:EMPTY_RESPONSE', 'DoH returned empty response');
    return;
  }

  const responsePacket = new Uint8Array(2 + resultSize);
  new DataView(responsePacket.buffer).setUint16(0, resultSize);
  responsePacket.set(dnsResult, 2);

  webSocket.send(responsePacket);
}

