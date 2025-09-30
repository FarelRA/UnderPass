// =================================================================
// File: protocols/udp.js
// Description: The UDP Actor. Handles proxying UDP via DNS-over-HTTPS.
// =================================================================

import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { WS_READY_STATE } from '../lib/utils.js';

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
  let isVlessHeaderSent = false;

  // Transform stream to parse VLESS UDP packet format.
  // VLESS UDP format: [2-byte length][payload]
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

  consumableStream
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const transformedChunk = await new Response(chunk).arrayBuffer(); // This is a bit of a hack to ensure ArrayBuffer
          logger.debug(udpLogContext, 'UDP:DOH_REQUEST', 'Sending DNS query via DoH.');
          try {
            const response = await fetch(config.DOH_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: transformedChunk,
            });

            if (!response.ok) {
              logger.error(udpLogContext, 'UDP:DOH_ERROR', `DoH request failed with status: ${response.status}`);
              return;
            }

            const dnsResult = await response.arrayBuffer();
            const resultSize = dnsResult.byteLength;
            // Format response back into VLESS UDP packet format.
            const sizeBuffer = new Uint8Array([(resultSize >> 8) & 0xff, resultSize & 0xff]);

            if (webSocket.readyState === WS_READY_STATE.OPEN) {
              if (!isVlessHeaderSent) {
                const vlessHeader = new Uint8Array([vlessVersion[0], 0]);
                const combined = new Uint8Array(vlessHeader.length + sizeBuffer.length + resultSize);
                combined.set(vlessHeader, 0);
                combined.set(sizeBuffer, vlessHeader.length);
                combined.set(new Uint8Array(dnsResult), vlessHeader.length + sizeBuffer.length);
                webSocket.send(combined);
                isVlessHeaderSent = true;
              } else {
                const combined = new Uint8Array(sizeBuffer.length + resultSize);
                combined.set(sizeBuffer, 0);
                combined.set(new Uint8Array(dnsResult), sizeBuffer.length);
                webSocket.send(combined);
              }
            }
          } catch (error) {
            logger.error(udpLogContext, 'UDP:DOH_FETCH_ERROR', 'Error fetching DoH:', error);
          }
        },
        close() {
          logger.info(udpLogContext, 'UDP:CLOSE', 'UDP input stream closed.');
        },
        abort(reason) {
          logger.warn(udpLogContext, 'UDP:ABORT', 'UDP input stream aborted:', reason);
        },
      })
    )
    .catch((error) => {
      logger.error(udpLogContext, 'UDP:PIPE_ERROR', 'Error in UDP processing pipe:', error);
    });

  // Pipe the client's data through the VLESS UDP parser
  consumableStream.pipeThrough(vlessUdpParser).pipeTo(vlessUdpParser.writable);
}
