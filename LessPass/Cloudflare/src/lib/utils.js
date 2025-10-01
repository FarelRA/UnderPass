// =================================================================
// File: lib/utils.js
// Description: Shared utilities for VLESS parsing, stream manipulation, and WebSockets.
// =================================================================

import { byteToHex, WS_READY_STATE } from './config.js';
import { logger } from './logger.js';

/**
 * Awaits the first data chunk from a WebSocket, checking for early data first.
 * @param {WebSocket} server The server-side WebSocket.
 * @param {Request} request The incoming request.
 * @returns {Promise<Uint8Array>} A promise that resolves with the first data chunk.
 * @throws {Error} If the WebSocket closes or errors before data is received, or if early data is malformed.
 */
export async function getFirstChunk(server, request) {
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol') || '';
  if (earlyDataHeader) {
    return base64ToUint8Array(earlyDataHeader);
  }

  // If no early data, wait for the first 'message' event.
  return new Promise((resolve, reject) => {
    server.addEventListener('message', (event) => resolve(new Uint8Array(event.data)), { once: true });
    server.addEventListener('close', () => reject(new Error('WebSocket closed before receiving any data.')), { once: true });
    server.addEventListener('error', (err) => reject(new Error(`WebSocket error before receiving data: ${err}`)), { once: true });
  });
}

/**
 * Creates a ReadableStream from a WebSocket that starts with an initial payload,
 * then seamlessly continues with subsequent WebSocket messages.
 * @param {WebSocket} server The server-side WebSocket.
 * @param {Uint8Array} initialPayload The first chunk of data (e.g., VLESS payload).
 * @param {object} logContext Logging context for cleanup actions.
 * @returns {ReadableStream}
 */
export function createConsumableStream(server, initialPayload, logContext) {
  let isStreamCancelled = false;
  return new ReadableStream({
    start(controller) {
      if (initialPayload.byteLength > 0) {
        controller.enqueue(initialPayload);
      }
      server.addEventListener('message', (event) => {
        if (isStreamCancelled) return;
        controller.enqueue(new Uint8Array(event.data));
      });
      server.addEventListener('close', () => {
        if (isStreamCancelled) return;
        try {
          controller.close();
        } catch (e) {
          /* Ignore */
        }
      });
      server.addEventListener('error', (err) => controller.error(err));
    },
    pull() {
      /* No backpressure needed */
    },
    cancel() {
      isStreamCancelled = true;
      safeCloseWebSocket(server, logContext);
    },
  });
}

/**
 * Decodes a base64 string (URL-safe) to a Uint8Array.
 * @param {string} base64Str The base64-encoded string.
 * @returns {Uint8Array | null} The decoded data, or null if the input string is empty.
 * @throws {Error} If the base64 string is malformed.
 */
export function base64ToUint8Array(base64Str) {
  try {
    const padded = base64Str.replace(/-/g, '+').replace(/_/g, '/') + '=='.substring(0, (3 * base64Str.length) % 4);
    const decoded = atob(padded);
    const uint8Array = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; ++i) {
      uint8Array[i] = decoded.charCodeAt(i);
    }
    return uint8Array;
  } catch (error) {
    throw new Error(`Invalid base64 string for early data: ${error.message}`);
  }
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
