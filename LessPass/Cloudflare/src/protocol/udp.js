// =================================================================
// File: protocol/udp.js
// Description: Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

/**
 * Handles UDP proxying by transforming VLESS UDP packets into DNS queries
 * sent over HTTPS (DoH). This is specifically for DNS traffic (port 53).
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {ReadableStream} consumableStream The client data stream.
 * @param {Uint8Array} vlessVersion VLESS version bytes.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
export async function handleUdpProxy(webSocket, consumableStream, vlessVersion, config, logContext) {
  const udpLogContext = { ...logContext, section: 'UDP_PROXY' };

  webSocket.send(new Uint8Array([vlessVersion[0], 0]));

  // Create a TransformStream to parse the VLESS UDP format: [2-byte length][DNS payload]
  const vlessUdpParser = new TransformStream({
    transform(chunk, controller) {
      for (let offset = 0; offset < chunk.byteLength; ) {
        if (offset + 2 > chunk.byteLength) {
          logger.warn(udpLogContext, 'UDP:PARSE', 'Incomplete length header in UDP chunk.');
          break;
        }
        const length = new DataView(chunk.buffer, chunk.byteOffset).getUint16(offset);
        offset += 2;
        if (offset + length > chunk.byteLength) {
          logger.warn(udpLogContext, 'UDP:PARSE', 'Incomplete UDP packet payload.');
          break;
        }
        controller.enqueue(chunk.slice(offset, offset + length));
        offset += length;
      }
    },
  });

  try {
    await consumableStream.pipeThrough(vlessUdpParser).pipeTo(
      new WritableStream({
        async write(dnsQuery) {
          try {
            logger.debug(udpLogContext, 'UDP:DOH_REQUEST', 'Sending DNS query via DoH.');
            const response = await fetch(config.DOH_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: dnsQuery,
            });

            if (!response.ok) {
              throw new Error(`DoH request failed with status: ${response.status}`);
            }

            const dnsResultBuffer = await response.arrayBuffer();
            const dnsResult = new Uint8Array(dnsResultBuffer);
            const resultSize = dnsResult.byteLength;

            // Format response back into VLESS UDP packet format
            const responsePacket = new Uint8Array(2 + resultSize);
            new DataView(responsePacket.buffer).setUint16(0, resultSize);
            responsePacket.set(dnsResult, 2);
            webSocket.send(responsePacket);
          } catch (error) {
            logger.error(udpLogContext, 'UDP:DOH_FETCH_ERROR', 'Error during DoH fetch:', error);
          }
        },
        close() {
          logger.info(udpLogContext, 'UDP:CLOSE', 'Client UDP stream closed.');
        },
        abort(reason) {
          logger.warn(udpLogContext, 'UDP:ABORT', 'Client UDP stream aborted:', reason);
        },
      })
    );
  } catch (error) {
    logger.error(udpLogContext, 'UDP:PIPE_ERROR', 'Error in UDP processing pipe:', error);
  } finally {
    safeCloseWebSocket(webSocket, udpLogContext);
  }
}
