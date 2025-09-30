// transport.js
import { log } from './logs.js';

/**
 * Creates a standard Transport object from an accepted server-side WebSocket.
 * @param {WebSocket} server The server-side WebSocket from a WebSocketPair.
 * @param {Request} request The original upgrade request, for early data.
 * @param {object} logContext The logging context.
 * @returns {{ readable: ReadableStream, writable: WritableStream }}
 */
export function createWebSocketTransport(server, request, logContext) {
  // Handle early data sent in the Sec-WebSocket-Protocol header
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';

  // The VLESS client uses this header to tunnel the first data packet.
  // It is a single Base64 value, not a comma-separated list of protocols.
  // We must not split it.
  const earlyData = base64ToArrayBuffer(earlyDataHeader, logContext);

  const readable = new ReadableStream({
    start(controller) {
      if (earlyData) {
        log.debug({ ...logContext, section: 'TRANSPORT' }, 'EARLY_DATA', `Enqueuing ${earlyData.byteLength} bytes of early data.`);
        controller.enqueue(earlyData);
      }
      server.addEventListener('message', (event) => controller.enqueue(event.data));
      server.addEventListener('close', () => controller.close());
      server.addEventListener('error', (err) => controller.error(err));
    },
    cancel() {
      if (server.readyState === 1) server.close(1000, 'Stream canceled');
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      if (server.readyState === 1) {
        server.send(chunk);
      }
    },
    close() {
      if (server.readyState === 1) server.close(1000, 'Stream closed');
    },
    abort(reason) {
      if (server.readyState === 1) server.close(1011, String(reason));
    },
  });

  return { readable, writable };
}

function base64ToArrayBuffer(base64Str, logContext) {
  if (!base64Str) return null;
  try {
    // VLESS clients use URL-safe Base64, so we need to replace '-' and '_'
    const base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const binaryStr = atob(base64);
    const len = binaryStr.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    return bytes;
  } catch (err) {
    log.error({ ...logContext, section: 'TRANSPORT' }, 'BASE64', 'Failed to decode early data:', err);
    return null;
  }
}
