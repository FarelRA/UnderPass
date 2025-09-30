// transport.js
import { log } from './logs.js';

/**
 * Creates a standard Transport object from a client WebSocket connection.
 * @param {Request} request The incoming WebSocket upgrade request.
 * @param {object} logContext The logging context.
 * @returns {{ client: WebSocket, transport: { readable: ReadableStream, writable: WritableStream } }}
 */
export function createClientTransport(request, logContext) {
  const wsPair = new WebSocketPair();
  const [client, server] = Object.values(wsPair);
  server.accept();

  // Handle early data sent in the Sec-WebSocket-Protocol header
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  const earlyData = base64ToArrayBuffer(earlyDataHeader.split(', ')[1] || '', logContext);

  const readable = new ReadableStream({
    start(controller) {
      if (earlyData) {
        controller.enqueue(earlyData);
      }
      server.addEventListener('message', (event) => controller.enqueue(event.data));
      server.addEventListener('close', () => controller.close());
      server.addEventListener('error', (err) => controller.error(err));
    },
    cancel() {
      if (server.readyState === 1) server.close(1000);
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      if (server.readyState === 1) {
        server.send(chunk);
      }
    },
    close() {
      if (server.readyState === 1) server.close(1000);
    },
    abort(reason) {
      if (server.readyState === 1) server.close(1011, reason);
    },
  });

  return { client, transport: { readable, writable } };
}

function base64ToArrayBuffer(base64Str, logContext) {
  if (!base64Str) return null;
  try {
    const binaryStr = atob(base64Str.replace(/-/g, '+').replace(/_/g, '/'));
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
