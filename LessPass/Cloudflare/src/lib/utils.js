// =================================================================
// File: lib/utils.js
// Description: Shared utilities for VLESS parsing, stream manipulation, and WebSockets.
// =================================================================

import { byteToHex, WS_READY_STATE } from './config.js';
import { logger } from './logger.js';

/**
 * Gets the first chunk from WebSocket, either from early data header or by reading first message.
 * @param {WebSocket} server The server-side WebSocket.
 * @param {Request} request The incoming request.
 * @returns {Promise<Uint8Array>} The first data chunk.
 * @throws {Error} If WebSocket or request is invalid, or if no data is received.
 */
export async function getFirstChunk(server, request) {
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (earlyDataHeader) {
    return base64ToUint8Array(earlyDataHeader);
  }

  return new Promise((resolve, reject) => {
    server.addEventListener('message', (event) => {
      resolve(new Uint8Array(event.data));
    }, { once: true });
    
    server.addEventListener('close', () => reject(new Error('WebSocket closed before first chunk')), { once: true });
    server.addEventListener('error', (err) => reject(err || new Error('WebSocket error')), { once: true });
  });
}

/**
 * Creates a ReadableStream from WebSocket messages.
 * @param {WebSocket} server The server-side WebSocket.
 * @returns {ReadableStream} A readable stream of WebSocket messages.
 * @throws {Error} If WebSocket is invalid or stream creation fails.
 */
export function createConsumableStream(server) {
  return new ReadableStream({
    start(controller) {
      server.addEventListener('message', (event) => {
        controller.enqueue(new Uint8Array(event.data));
      });
      server.addEventListener('close', () => controller.close());
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
  const base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Safely closes a WebSocket connection.
 * @param {WebSocket} socket The WebSocket to close.
 */
export function safeCloseWebSocket(socket) {
  try {
    if (socket?.readyState < WS_READY_STATE.CLOSING) {
      socket.close();
    }
  } catch {}
}

/**
 * Converts a Uint8Array UUID to its string representation.
 * @param {Uint8Array} arr The 16-byte UUID array.
 * @returns {string} The UUID string in format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
 * @throws {Error} If the array is not a Uint8Array or not 16 bytes.
 */
export function stringifyUUID(arr) {
  if (arr.length !== 16) {
    throw new Error(`UUID must be 16 bytes, got ${arr.length}`);
  }
  return (
    byteToHex[arr[0]] + byteToHex[arr[1]] + byteToHex[arr[2]] + byteToHex[arr[3]] + '-' +
    byteToHex[arr[4]] + byteToHex[arr[5]] + '-' +
    byteToHex[arr[6]] + byteToHex[arr[7]] + '-' +
    byteToHex[arr[8]] + byteToHex[arr[9]] + '-' +
    byteToHex[arr[10]] + byteToHex[arr[11]] + byteToHex[arr[12]] + byteToHex[arr[13]] + byteToHex[arr[14]] + byteToHex[arr[15]]
  );
}
