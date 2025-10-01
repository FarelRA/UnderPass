// =================================================================
// File: protocol/udp.js
// Description: The UDP Actor. Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

/**
 * Handles UDP proxying by transforming VLESS UDP packets into DNS queries
 * sent over HTTPS (DoH). This is specifically for DNS traffic (port 53).
 * @param {WebSocket} webSocket
 * @param {ReadableStream} consumableStream - The client data stream.
 * @param {Uint8Array} vlessVersion - VLESS version bytes.
 * @param {object} logContext - Logging context.
 */
export async function handleUdpProxy(webSocket, consumableStream, vlessVersion, logContext) {
  const udpLogContext = { ...logContext, section: 'UDP_PROXY' };

  // Send the VLESS response header immediately for consistency.
  // This signals to the client that the proxy is ready.
  webSocket.send(new Uint8Array([vlessVersion[0], 0]));

  // Transform stream to parse VLESS UDP packet format.
  // Incoming VLESS UDP format: [2-byte length][DNS payload]
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
        const payload = chunk.slice(offset, offset + length);
        controller.enqueue(payload);
        offset += length;
      }
    },
  });

  // The client's stream is piped through the parser, and the parser's
  // output is then piped to our DoH handler.
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
              logger.error(udpLogContext, 'UDP:DOH_ERROR', `DoH request failed with status: ${response.status}`);
              return;
            }

            const dnsResult = await response.arrayBuffer();
            const resultSize = dnsResult.byteLength;

            // Format response back into VLESS UDP packet format: [2-byte length][DNS payload]
            const sizeBuffer = new Uint8Array([(resultSize >> 8) & 0xff, resultSize & 0xff]);
            const combinedResponse = new Uint8Array(sizeBuffer.length + resultSize);
            combinedResponse.set(sizeBuffer, 0);
            combinedResponse.set(new Uint8Array(dnsResult), sizeBuffer.length);

            webSocket.send(combinedResponse);
          } catch (error) {
            logger.error(udpLogContext, 'UDP:DOH_FETCH_ERROR', 'Error fetching DoH:', error);
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
