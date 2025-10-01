// =================================================================
// File: lib/utils.js
// Description: Shared utilities for VLESS parsing, stream manipulation, and WebSockets.
// =================================================================

import { byteToHex, config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export const WS_READY_STATE = { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 };

function createBufferReader(buffer) {
  const view = new DataView(buffer);
  let offset = 0;
  return {
    get offset() {
      return offset;
    },
    readUint8() {
      const value = view.getUint8(offset);
      offset += 1;
      return value;
    },
    readUint16() {
      const value = view.getUint16(offset);
      offset += 2;
      return value;
    },
    readBytes(length) {
      const value = new Uint8Array(buffer, offset, length);
      offset += length;
      return value;
    },
    skip(length) {
      offset += length;
    },
  };
}

/**
 * Creates a ReadableStream from a WebSocket, bridging the event-based API
 * to the modern Streams API.
 * @param {WebSocket} webSocket - The server-side WebSocket.
 * @param {object} logContext - Logging context.
 * @returns {ReadableStream}
 */
export function makeReadableWebSocketStream(webSocket, logContext) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        // Ensure data is in a consistent Uint8Array format
        const data = event.data instanceof ArrayBuffer ? new Uint8Array(event.data) : event.data;
        controller.enqueue(data);
      });
      webSocket.addEventListener('close', () => {
        if (readableStreamCancel) return;
        try {
          controller.close();
        } catch (e) {
          // Suppress errors if the stream is already closed.
        }
      });
      webSocket.addEventListener('error', (err) => {
        logger.error(logContext, 'WEBSOCKET_STREAM_ERROR', 'WebSocket error:', err);
        controller.error(err);
      });
    },
    pull() {
      // Backpressure is not implemented as WebSocket events are push-based.
    },
    cancel(reason) {
      if (readableStreamCancel) return;
      readableStreamCancel = true;
      safeCloseWebSocket(webSocket, logContext);
    },
  });
}

/**
 * Safely closes a WebSocket connection, ignoring errors if it's already closing or closed.
 * @param {WebSocket} socket - The WebSocket to close.
 * @param {object} logContext - Logging context.
 */
export function safeCloseWebSocket(socket, logContext) {
  try {
    if (socket.readyState === WS_READY_STATE.OPEN || socket.readyState === WS_READY_STATE.CLOSING) {
      socket.close(1000, 'Connection closed by worker.');
    }
  } catch (error) {
    logger.error(logContext, 'safeCloseWebSocket', 'Error closing WebSocket:', error);
  }
}

/**
 * Decodes a base64 string (URL-safe) to an ArrayBuffer.
 * @param {string} base64Str - The base64-encoded string.
 * @returns {{earlyData: ArrayBuffer | null, error: Error | null}}
 */
export function base64ToArrayBuffer(base64Str) {
  if (!base64Str) {
    return { earlyData: null, error: null };
  }
  try {
    base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decode = atob(base64Str);
    const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
    return { earlyData: arryBuffer.buffer, error: null };
  } catch (error) {
    return { earlyData: null, error };
  }
}

/**
 * Processes the VLESS protocol header from a buffer.
 * @param {ArrayBuffer} streamBuffer - The buffer containing the protocol header.
 * @returns {object} An object containing the extracted destination info, or an error.
 */
export function processVlessHeader(streamBuffer) {
  if (streamBuffer.byteLength < 24) {
    return { error: 'Invalid VLESS header: insufficient length.' };
  }
  const reader = createBufferReader(streamBuffer);
  const version = reader.readBytes(1); // Normally [0]
  const userID = reader.readBytes(16);
  if (stringifyUUID(userID) !== config.USER_ID) {
    return { error: 'Invalid user ID.' };
  }
  const optLength = reader.readUint8();
  reader.skip(optLength); // Skip options
  const command = reader.readUint8(); // 1: TCP, 2: UDP
  const port = reader.readUint16();
  const addressType = reader.readUint8(); // 1: IPv4, 2: FQDN, 3: IPv6
  let address = '';

  switch (addressType) {
    case 1: // IPv4
      address = reader.readBytes(4).join('.');
      break;
    case 2: // FQDN
      const domainLength = reader.readUint8();
      address = new TextDecoder().decode(reader.readBytes(domainLength));
      break;
    case 3: // IPv6
      const ipv6Bytes = reader.readBytes(16);
      const ipv6 = Array.from({ length: 8 }, (_, i) => new DataView(ipv6Bytes.buffer).getUint16(i * 2).toString(16));
      address = `[${ipv6.join(':')}]`;
      break;
    default:
      return { error: `Invalid address type: ${addressType}.` };
  }

  return {
    isUDP: command === 2,
    address,
    port,
    rawData: new Uint8Array(streamBuffer.slice(reader.offset)),
    vlessVersion: version,
  };
}

/**
 * Creates a ReadableStream that combines a single initial chunk with the rest of a reader's stream.
 * This is useful for "peeking" at the start of a stream and then passing the full, reconstituted stream on.
 * @param {ReadableStreamDefaultReader} reader - The reader of the original stream.
 * @param {Uint8Array} initialChunk - The data that was already read.
 * @returns {ReadableStream}
 */
export function createConsumableStream(reader, initialChunk) {
  let initialChunkSent = false;
  return new ReadableStream({
    async pull(controller) {
      if (!initialChunkSent) {
        controller.enqueue(initialChunk);
        initialChunkSent = true;
      }
      const { value, done } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      reader.cancel(reason);
    },
  });
}

/**
 * Converts a Uint8Array to a UUID string.
 * @param {Uint8Array} arr
 * @returns {string}
 */
export function stringifyUUID(arr) {
  return (
    byteToHex[arr[0]] +
    byteToHex[arr[1]] +
    byteToHex[arr[2]] +
    byteToHex[arr[3]] +
    '-' +
    byteToHex[arr[4]] +
    byteToHex[arr[5]] +
    '-' +
    byteToHex[arr[6]] +
    byteToHex[arr[7]] +
    '-' +
    byteToHex[arr[8]] +
    byteToHex[arr[9]] +
    '-' +
    byteToHex[arr[10]] +
    byteToHex[arr[11]] +
    byteToHex[arr[12]] +
    byteToHex[arr[13]] +
    byteToHex[arr[14]] +
    byteToHex[arr[15]]
  );
}
