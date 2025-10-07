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
 * Creates a ReadableStream from WebSocket messages.
 * @param {WebSocket} server The server-side WebSocket.
 * @returns {ReadableStream}
 */
export function createConsumableStream(server) {
  return new ReadableStream({
    start(controller) {
      server.addEventListener('message', (event) => {
        controller.enqueue(new Uint8Array(event.data));
      });
      server.addEventListener('close', () => {
        try {
          controller.close();
        } catch (e) {
          /* Ignore */
        }
      });
      server.addEventListener('error', (err) => controller.error(err));
    },
  });
}

/**
 * Decodes a base64 string (URL-safe) to a Uint8Array.
 * @param {string} base64Str The base64-encoded string.
 * @returns {Uint8Array} The decoded data.
 * @throws {Error} If the base64 string is malformed.
 */
export function base64ToUint8Array(base64Str) {
  try {
    const base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(base64);
    const uint8Array = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
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
    if (socket.readyState < WS_READY_STATE.CLOSING) {
      socket.close();
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
