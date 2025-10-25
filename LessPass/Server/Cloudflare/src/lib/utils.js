// =================================================================
// File: lib/utils.js
// Description: Shared utilities for VLESS parsing, stream manipulation,
//              and WebSocket operations. Provides stream wrappers for
//              WebSocket API and data conversion utilities.
// =================================================================

import { byteToHex, WS_READY_STATE } from './config.js';
import { logger } from './logger.js';

// === WebSocket Stream Utilities ===

/**
 * Gets the first chunk of data from a WebSocket connection.
 * Checks for early data in the Sec-WebSocket-Protocol header first (0-RTT optimization),
 * otherwise waits for the first WebSocket message using event listeners.
 *
 * @param {Request} request - The incoming HTTP request with WebSocket upgrade.
 * @param {WebSocket} server - The server-side WebSocket connection.
 * @returns {Promise<Uint8Array>} The first data chunk.
 * @throws {Error} If WebSocket closes or errors before receiving data.
 */
export async function getFirstChunk(request, server) {
  logger.trace('UTILS:CHUNK', 'Getting first chunk from WebSocket');

  // Check for early data in header (0-RTT optimization)
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (earlyDataHeader) {
    logger.debug('UTILS:CHUNK', 'Early data found in Sec-WebSocket-Protocol header');
    const chunk = base64ToUint8Array(earlyDataHeader);
    logger.trace('UTILS:CHUNK', `Early data decoded: ${chunk.byteLength} bytes`);
    return chunk;
  }

  // Wait for first WebSocket message using event listeners
  logger.debug('UTILS:CHUNK', 'Waiting for first WebSocket message');
  return new Promise((resolve, reject) => {
    server.addEventListener(
      'message',
      (event) => {
        const chunk = new Uint8Array(event.data);
        logger.debug('UTILS:CHUNK', `First message received: ${chunk.byteLength} bytes`);
        resolve(chunk);
      },
      { once: true }
    );

    server.addEventListener(
      'close',
      () => {
        const error = 'WebSocket closed before first chunk';
        logger.error('UTILS:CHUNK', error);
        reject(new Error(error));
      },
      { once: true }
    );

    server.addEventListener(
      'error',
      (err) => {
        logger.error('UTILS:CHUNK', `WebSocket error: ${err?.message || 'Unknown error'}`);
        reject(err || new Error('WebSocket error'));
      },
      { once: true }
    );
  });
}

/**
 * Creates a ReadableStream from WebSocket messages.
 * Converts the event-based WebSocket API into a stream-based API for easier processing.
 * The stream will enqueue all incoming messages and close when the WebSocket closes.
 *
 * @param {WebSocket} server - The server-side WebSocket connection.
 * @returns {ReadableStream} A readable stream of Uint8Array chunks from WebSocket messages.
 */
export function createReadableStream(server) {
  logger.trace('UTILS:STREAM', 'Creating ReadableStream from WebSocket');
  
  return new ReadableStream({
    start(controller) {
      logger.trace('UTILS:STREAM', 'ReadableStream started, attaching event listeners');
      
      server.addEventListener('message', (event) => {
        const chunk = new Uint8Array(event.data);
        logger.trace('UTILS:STREAM', `Enqueueing message: ${chunk.byteLength} bytes`);
        controller.enqueue(chunk);
      });

      server.addEventListener('close', () => {
        logger.debug('UTILS:STREAM', 'WebSocket closed, closing ReadableStream');
        controller.close();
      });

      server.addEventListener('error', (err) => {
        logger.error('UTILS:STREAM', `WebSocket error: ${err?.message || 'Unknown error'}`);
        controller.error(err);
      });
    },
  });
}

/**
 * Creates a WritableStream that sends data to a WebSocket.
 * Converts the WebSocket send API into a stream-based API for easier processing.
 * All writes are sent directly to the WebSocket.
 *
 * @param {WebSocket} server - The server-side WebSocket connection.
 * @returns {WritableStream} A writable stream that sends Uint8Array chunks to WebSocket.
 */
export function createWritableStream(server) {
  logger.trace('UTILS:STREAM', 'Creating WritableStream for WebSocket');
  
  return new WritableStream({
    write(chunk) {
      logger.trace('UTILS:STREAM', `Writing to WebSocket: ${chunk.byteLength} bytes`);
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
      logger.debug('UTILS:WEBSOCKET', `Closing WebSocket (state: ${socket.readyState})`);
      socket.close();
    } else {
      logger.trace('UTILS:WEBSOCKET', `WebSocket already closing/closed (state: ${socket?.readyState})`);
    }
  } catch (error) {
    logger.warn('UTILS:WEBSOCKET', `Error closing WebSocket: ${error.message}`);
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
  logger.trace('UTILS:BASE64', `Decoding base64 string: ${base64Str.length} characters`);

  try {
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

    logger.trace('UTILS:BASE64', `Decoded to ${bytes.byteLength} bytes`);
    return bytes;
  } catch (error) {
    logger.error('UTILS:BASE64', `Failed to decode base64: ${error.message}`);
    throw error;
  }
}

/**
 * Converts a Uint8Array UUID (16 bytes) to its string representation.
 * Uses a pre-computed lookup table for efficient byte-to-hex conversion.
 *
 * Format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
 *
 * @param {Uint8Array} uuidBytes - The 16-byte UUID array.
 * @returns {string} The UUID string in standard format with hyphens.
 *
 * @example
 * const uuid = new Uint8Array([0x12, 0x34, 0x56, 0x78, ...]);
 * stringifyUUID(uuid); // "12345678-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
export function stringifyUUID(uuidBytes) {
  logger.trace('UTILS:UUID', 'Converting UUID bytes to string');

  // Build UUID string using pre-computed hex lookup table
  const uuidString =
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
    byteToHex[uuidBytes[15]];

  logger.trace('UTILS:UUID', `UUID: ${uuidString}`);
  return uuidString;
}
