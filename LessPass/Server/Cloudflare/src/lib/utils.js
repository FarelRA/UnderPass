// =================================================================
// File: lib/utils.js
// Description: Shared utilities for VLESS parsing, stream manipulation, and WebSockets.
// =================================================================

import { byteToHex, WS_READY_STATE } from './config.js';

// === WebSocket Stream Utilities ===

/**
 * Gets the first chunk of data from a WebSocket connection.
 * Checks for early data in the Sec-WebSocket-Protocol header first,
 * otherwise waits for the first WebSocket message.
 *
 * @param {Request} request - The incoming HTTP request with WebSocket upgrade.
 * @param {WebSocket} server - The server-side WebSocket connection.
 * @returns {Promise<Uint8Array>} The first data chunk.
 * @throws {Error} If WebSocket closes or errors before receiving data.
 */
export async function getFirstChunk(request, server) {
  // Check for early data in header (0-RTT optimization)
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (earlyDataHeader) {
    return base64ToUint8Array(earlyDataHeader);
  }

  // Wait for first WebSocket message
  return new Promise((resolve, reject) => {
    server.addEventListener(
      'message',
      (event) => {
        resolve(new Uint8Array(event.data));
      },
      { once: true }
    );

    server.addEventListener(
      'close',
      () => {
        reject(new Error('WebSocket closed before first chunk'));
      },
      { once: true }
    );

    server.addEventListener(
      'error',
      (err) => {
        reject(err || new Error('WebSocket error'));
      },
      { once: true }
    );
  });
}

/**
 * Creates a ReadableStream from WebSocket messages.
 * Converts the event-based WebSocket API into a stream-based API for easier processing.
 *
 * @param {WebSocket} server - The server-side WebSocket connection.
 * @returns {ReadableStream} A readable stream of Uint8Array chunks from WebSocket messages.
 */
export function createReadableStream(server) {
  return new ReadableStream({
    start(controller) {
      server.addEventListener('message', (event) => {
        controller.enqueue(new Uint8Array(event.data));
      });

      server.addEventListener('close', () => {
        controller.close();
      });

      server.addEventListener('error', (err) => {
        controller.error(err);
      });
    },
  });
}

/**
 * Creates a WritableStream that sends data to a WebSocket.
 * Converts the WebSocket send API into a stream-based API for easier processing.
 *
 * @param {WebSocket} server - The server-side WebSocket connection.
 * @returns {WritableStream} A writable stream that sends Uint8Array chunks to WebSocket.
 */
export function createWritableStream(server) {
  return new WritableStream({
    write(chunk) {
      server.send(chunk);
    },
  });
}

/**
 * Safely closes a WebSocket connection.
 * Only attempts to close if the WebSocket is in an open or connecting state.
 * Silently ignores any errors during closure.
 *
 * @param {WebSocket} socket - The WebSocket to close.
 */
export function safeCloseWebSocket(socket) {
  try {
    if (socket?.readyState < WS_READY_STATE.CLOSING) {
      socket.close();
    }
  } catch {
    // Ignore errors during close
  }
}

// === Data Conversion Utilities ===

/**
 * Decodes a base64 string (URL-safe variant) to a Uint8Array.
 * Handles both standard base64 and URL-safe base64 (with - and _ instead of + and /).
 *
 * @param {string} base64Str - The base64-encoded string.
 * @returns {Uint8Array} The decoded binary data.
 * @throws {Error} If the base64 string is malformed.
 */
export function base64ToUint8Array(base64Str) {
  // Convert URL-safe base64 to standard base64
  const base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');

  // Decode base64 to binary string
  const binaryString = atob(base64);
  const length = binaryString.length;

  // Convert binary string to Uint8Array
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return bytes;
}

/**
 * Converts a Uint8Array UUID (16 bytes) to its string representation.
 * Uses a pre-computed lookup table for efficient byte-to-hex conversion.
 *
 * Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * @param {Uint8Array} uuidBytes - The 16-byte UUID array.
 * @returns {string} The UUID string in standard format with hyphens.
 * @throws {Error} If the array is not exactly 16 bytes.
 *
 * @example
 * const uuid = new Uint8Array([0x12, 0x34, 0x56, 0x78, ...]);
 * stringifyUUID(uuid); // "12345678-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
export function stringifyUUID(uuidBytes) {
  // Build UUID string using pre-computed hex lookup table
  return (
    byteToHex[uuidBytes[0]] +
    byteToHex[uuidBytes[1]] +
    byteToHex[uuidBytes[2]] +
    byteToHex[uuidBytes[3]] +
    '-' +
    byteToHex[uuidBytes[4]] +
    byteToHex[uuidBytes[5]] +
    '-' +
    byteToHex[uuidBytes[6]] +
    byteToHex[uuidBytes[7]] +
    '-' +
    byteToHex[uuidBytes[8]] +
    byteToHex[uuidBytes[9]] +
    '-' +
    byteToHex[uuidBytes[10]] +
    byteToHex[uuidBytes[11]] +
    byteToHex[uuidBytes[12]] +
    byteToHex[uuidBytes[13]] +
    byteToHex[uuidBytes[14]] +
    byteToHex[uuidBytes[15]]
  );
}
