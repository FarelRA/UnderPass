// =================================================================
// File: lib/utils.js
// Description: Shared utilities for VLESS parsing, stream manipulation, and WebSockets.
// =================================================================

import { byteToHex, VLESS, WS_READY_STATE } from './config.js';
import { logger } from './logger.js';

/**
 * Decodes a base64 string (URL-safe) to a Uint8Array.
 * @param {string} base64Str The base64-encoded string.
 * @returns {{data: Uint8Array | null, error: Error | null}}
 */
export function base64ToUint8Array(base64Str) {
  if (!base64Str) {
    return { data: null, error: null };
  }
  try {
    const padded = base64Str.replace(/-/g, '+').replace(/_/g, '/') + '=='.substring(0, (3 * base64Str.length) % 4);
    const decoded = atob(padded);
    const uint8Array = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; ++i) {
      uint8Array[i] = decoded.charCodeAt(i);
    }
    return { data: uint8Array, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

/**
 * Creates a ReadableStream from a WebSocket, atomically handling early data
 * and subsequent messages to prevent race conditions.
 * @param {WebSocket} webSocket The server-side WebSocket.
 * @param {string} earlyDataHeader The base64-encoded early data from the 'Sec-WebSocket-Protocol' header.
 * @param {object} logContext Logging context.
 * @returns {ReadableStream}
 */
export function makeReadableWebSocketStream(webSocket, earlyDataHeader, logContext) {
  let readableStreamCancel = false;
  return new ReadableStream({
    start(controller) {
      webSocket.addEventListener('message', (event) => {
        if (readableStreamCancel) return;
        controller.enqueue(new Uint8Array(event.data));
      });
      webSocket.addEventListener('close', () => {
        if (readableStreamCancel) return;
        try {
          controller.close();
        } catch (e) {
          logger.warn(logContext, 'WEBSOCKET_STREAM', 'Controller already closed.', e);
        }
      });
      webSocket.addEventListener('error', (err) => controller.error(err));

      // Atomically process and enqueue early data if it exists.
      const { data, error } = base64ToUint8Array(earlyDataHeader);
      if (error) {
        controller.error(new Error('Failed to decode early data.'));
      } else if (data) {
        controller.enqueue(data);
      }
    },
    pull() {
      /* Backpressure is not needed */
    },
    cancel() {
      if (readableStreamCancel) return;
      readableStreamCancel = true;
      safeCloseWebSocket(webSocket, logContext);
    },
  });
}

/**
 * Processes the VLESS protocol header from a Uint8Array.
 * @param {Uint8Array} chunk The initial data chunk from the client.
 * @returns {{vlessVersion: Uint8Array, protocol: string, address: string, port: number, payload: Uint8Array, error: string | null}}
 */
export function processVlessHeader(chunk) {
  if (chunk.byteLength < VLESS.MIN_HEADER_LENGTH) {
    return { error: `Invalid VLESS header: insufficient length. Got ${chunk.byteLength}, expected at least ${VLESS.MIN_HEADER_LENGTH}.` };
  }

  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  let offset = 0;

  const vlessVersion = chunk.slice(offset, VLESS.VERSION_LENGTH);
  offset += VLESS.VERSION_LENGTH;

  const userID = chunk.slice(offset, offset + VLESS.USERID_LENGTH);
  offset += VLESS.USERID_LENGTH;

  const addonLength = view.getUint8(offset);
  offset += 1 + addonLength; // Skip addon section

  const command = view.getUint8(offset);
  offset += 1;

  let protocol;
  if (command === VLESS.COMMAND.TCP) protocol = 'TCP';
  else if (command === VLESS.COMMAND.UDP) protocol = 'UDP';
  else return { error: `Unsupported VLESS command: ${command}` };

  const port = view.getUint16(offset);
  offset += 2;

  const addressType = view.getUint8(offset);
  offset += 1;
  let address;

  switch (addressType) {
    case VLESS.ADDRESS_TYPE.IPV4:
      address = Array.from(chunk.slice(offset, offset + 4)).join('.');
      offset += 4;
      break;
    case VLESS.ADDRESS_TYPE.FQDN:
      const domainLength = view.getUint8(offset);
      offset += 1;
      address = new TextDecoder().decode(chunk.slice(offset, offset + domainLength));
      offset += domainLength;
      break;
    case VLESS.ADDRESS_TYPE.IPV6:
      const ipv6Bytes = chunk.slice(offset, offset + 16);
      const parts = [];
      for (let i = 0; i < 8; i++) {
        parts.push(view.getUint16(offset + i * 2).toString(16));
      }
      address = `[${parts.join(':').replace(/:(:0)+:0/g, '::')}]`;
      offset += 16;
      break;
    default:
      return { error: `Invalid address type: ${addressType}` };
  }

  const payload = chunk.slice(offset);

  return { vlessVersion, userID, protocol, address, port, payload, error: null };
}

/**
 * Creates a stream that can be consumed again after peeking at its first chunk.
 * @param {ReadableStreamDefaultReader} reader The reader of the original stream.
 * @param {Uint8Array} initialChunk The data that was already read.
 * @returns {ReadableStream}
 */
export function createConsumableStream(reader, initialChunk) {
  let isInitialChunkSent = false;
  return new ReadableStream({
    async pull(controller) {
      if (!isInitialChunkSent) {
        controller.enqueue(initialChunk);
        isInitialChunkSent = true;
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
 * Safely closes a WebSocket connection.
 * @param {WebSocket} socket The WebSocket to close.
 * @param {object} logContext Logging context.
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
 * Converts a Uint8Array UUID to its string representation.
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
