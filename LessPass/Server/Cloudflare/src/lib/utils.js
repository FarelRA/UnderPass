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
 * Reads the first chunk of data from a WebSocket connection.
 * Checks for early data in the Sec-WebSocket-Protocol header first (0-RTT optimization),
 * otherwise waits for the first WebSocket message using event listeners.
 *
 * @param {Request} request - The incoming HTTP request with WebSocket upgrade.
 * @param {WebSocket} serverSocket - The server-side WebSocket connection.
 * @returns {Promise<Uint8Array>} The first data chunk.
 * @throws {Error} If WebSocket closes or errors before receiving data.
 */
export async function readFirstChunk(request, serverSocket) {
  logger.trace('UTILS:CHUNK', 'Reading first chunk from WebSocket');

  // Check for early data in header (0-RTT optimization)
  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (earlyDataHeader) {
    logger.debug('UTILS:CHUNK', 'Early data found in Sec-WebSocket-Protocol header');
    const chunk = base64ToArray(earlyDataHeader);
    logger.trace('UTILS:CHUNK', `Early data decoded: ${chunk.byteLength} bytes`);
    return chunk;
  }

  // Wait for first WebSocket message using event listeners
  logger.debug('UTILS:CHUNK', 'Waiting for first WebSocket message');
  return new Promise((resolve, reject) => {
    serverSocket.addEventListener(
      'message',
      (event) => {
        const chunk = new Uint8Array(event.data);
        logger.debug('UTILS:CHUNK', `First message received: ${chunk.byteLength} bytes`);
        resolve(chunk);
      },
      { once: true }
    );

    serverSocket.addEventListener(
      'close',
      () => {
        const error = 'WebSocket closed before first chunk';
        logger.error('UTILS:CHUNK', error);
        reject(new Error(error));
      },
      { once: true }
    );

    serverSocket.addEventListener(
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
 * Creates ReadableStream and WritableStream from a WebSocket.
 * Converts the event-based WebSocket API into stream-based APIs for easier processing.
 *
 * @param {WebSocket} serverSocket - The server-side WebSocket connection.
 * @returns {{readable: ReadableStreamDefaultReader, writable: WritableStreamDefaultWriter}} Reader and writer for the WebSocket.
 */
export function createStreams(serverSocket) {
  logger.trace('UTILS:STREAM', 'Creating WebSocket streams');
  
  const readable = new ReadableStream({
    start(controller) {
      serverSocket.addEventListener('message', (event) => {
        const chunk = new Uint8Array(event.data);
        logger.trace('UTILS:STREAM', `Enqueueing message: ${chunk.byteLength} bytes`);
        controller.enqueue(chunk);
      });

      serverSocket.addEventListener('close', () => {
        logger.debug('UTILS:STREAM', 'WebSocket closed, closing ReadableStream');
        controller.close();
      });

      serverSocket.addEventListener('error', (err) => {
        logger.error('UTILS:STREAM', `WebSocket error: ${err?.message || 'Unknown error'}`);
        controller.error(err);
      });
    },
  });

  const writable = new WritableStream({
    write(chunk) {
      logger.trace('UTILS:STREAM', `Writing to WebSocket: ${chunk.byteLength} bytes`);
      serverSocket.send(chunk);
    },
  });

  return { readable: readable.getReader(), writable: writable.getWriter() };
}

/**
 * Closes a WebSocket connection.
 * Only attempts to close if the WebSocket is in an open or connecting state.
 *
 * @param {WebSocket} socket - The WebSocket to close.
 */
export function closeWebSocket(socket) {
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
export function base64ToArray(base64Str) {
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
 * @param {Uint8Array} bytes - The 16-byte UUID array.
 * @returns {string} The UUID string in standard format with hyphens.
 *
 * @example
 * const uuid = new Uint8Array([0x12, 0x34, 0x56, 0x78, ...]);
 * uuidToString(uuid); // "12345678-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
 */
export function uuidToString(bytes) {
  logger.trace('UTILS:UUID', 'Converting UUID bytes to string');

  // Build UUID string using pre-computed hex lookup table
  const uuidString =
    byteToHex[bytes[0]] +
    byteToHex[bytes[1]] +
    byteToHex[bytes[2]] +
    byteToHex[bytes[3]] +
    '-' +
    byteToHex[bytes[4]] +
    byteToHex[bytes[5]] +
    '-' +
    byteToHex[bytes[6]] +
    byteToHex[bytes[7]] +
    '-' +
    byteToHex[bytes[8]] +
    byteToHex[bytes[9]] +
    '-' +
    byteToHex[bytes[10]] +
    byteToHex[bytes[11]] +
    byteToHex[bytes[12]] +
    byteToHex[bytes[13]] +
    byteToHex[bytes[14]] +
    byteToHex[bytes[15]];

  logger.trace('UTILS:UUID', `UUID: ${uuidString}`);
  return uuidString;
}

/**
 * Concatenates two Uint8Array buffers into a single buffer.
 *
 * @param {Uint8Array} buffer1 - First buffer.
 * @param {Uint8Array} buffer2 - Second buffer.
 * @returns {Uint8Array} Combined buffer containing both inputs.
 */
export function concatBuffers(buffer1, buffer2) {
  logger.trace('UTILS:CONCAT', `Concatenating buffers: ${buffer1.byteLength} + ${buffer2.byteLength} bytes`);
  const result = new Uint8Array(buffer1.byteLength + buffer2.byteLength);
  result.set(buffer1, 0);
  result.set(buffer2, buffer1.byteLength);
  logger.trace('UTILS:CONCAT', `Result: ${result.byteLength} bytes`);
  return result;
}
