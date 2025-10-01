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
 * @param {ReadableStream} consumableStream The client data stream.
 * @param {Uint8Array} vlessVersion VLESS version bytes.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
export async function handleUdpProxy(webSocket, consumableStream, vlessVersion, config, logContext) {
  const udpLogContext = { ...logContext, section: 'UDP_PROXY' };

  try {
    // Perform the VLESS handshake for UDP.
    webSocket.send(new Uint8Array([vlessVersion[0], 0]));

    // Start the main proxying loop.
    await proxyUdpOverDoH(webSocket, consumableStream, config, udpLogContext);
  } catch (error) {
    logger.error(udpLogContext, 'UDP:FATAL_ERROR', 'An unrecoverable error occurred in the UDP handler:', error);
  } finally {
    // Ensure resources are always cleaned up.
    safeCloseWebSocket(webSocket, udpLogContext);
  }
}

/**
 * The main proxying loop for UDP. It sets up a stream pipeline to listen for
 * client packets and process them individually.
 * This function is the architectural equivalent of TCP's `attemptConnection`.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {ReadableStream} consumableStream The client data stream.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
async function proxyUdpOverDoH(webSocket, consumableStream, config, logContext) {
  const vlessUdpParser = createVlessUdpParser(logContext);

  await consumableStream.pipeThrough(vlessUdpParser).pipeTo(
    new WritableStream({
      async write(dnsQuery) {
        await processDnsPacket(dnsQuery, webSocket, config, logContext);
      },
      close() {
        logger.info(logContext, 'UDP:CLOSE', 'Client UDP stream closed.');
      },
      abort(reason) {
        logger.warn(logContext, 'UDP:ABORT', 'Client UDP stream aborted:', reason);
      },
    })
  );
}

/**
 * Creates a TransformStream to parse VLESS UDP packets.
 * This is a low-level helper for the UDP proxy.
 * @param {object} logContext Logging context.
 * @returns {TransformStream}
 */
function createVlessUdpParser(logContext) {
  return new TransformStream({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength; ) {
        if (offset + 2 > chunk.byteLength) {
          logger.warn(logContext, 'UDP:PARSE', 'Incomplete length header in VLESS UDP chunk.');
          break;
        }
        const length = new DataView(chunk.buffer, chunk.byteOffset).getUint16(offset);
        offset += 2;
        if (offset + length > chunk.byteLength) {
          logger.warn(logContext, 'UDP:PARSE', 'Incomplete VLESS UDP packet payload.');
          break;
        }
        controller.enqueue(chunk.slice(offset, offset + length));
        offset += length;
      }
    },
  });
}

/**
 * Processes a single DNS packet. It forwards the query to the DoH server
 * and sends the VLESS-formatted response back to the client.
 * This is the core "unit of work" for the UDP proxy.
 * @param {Uint8Array} dnsQuery The raw DNS query payload.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
async function processDnsPacket(dnsQuery, webSocket, config, logContext) {
  try {
    const response = await fetch(config.DOH_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/dns-message' },
      body: dnsQuery,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`DoH request failed with status ${response.status}: ${errorText}`);
    }

    const dnsResult = new Uint8Array(await response.arrayBuffer());
    const resultSize = dnsResult.byteLength;
    const responsePacket = new Uint8Array(2 + resultSize);
    new DataView(responsePacket.buffer).setUint16(0, resultSize);
    responsePacket.set(dnsResult, 2);

    webSocket.send(responsePacket);
  } catch (error) {
    logger.error(logContext, 'UDP:PACKET_ERROR', 'Failed to process a DNS packet:', error);
  }
}
