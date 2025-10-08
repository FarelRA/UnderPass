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
  if (!server) {
    throw new Error('WebSocket server is required');
  }
  if (!request) {
    throw new Error('Request object is required');
  }

  const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol');
  if (earlyDataHeader) {
    return base64ToUint8Array(earlyDataHeader);
  }

  return new Promise((resolve, reject) => {
    server.addEventListener('message', (event) => {
      resolve(event?.data ? new Uint8Array(event.data) : reject(new Error('No data in message')));
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
  logger.trace('UTILS', 'createConsumableStream called');

  if (!server) {
    logger.error('UTILS', 'WebSocket server is null/undefined for stream creation');
    throw new Error('WebSocket server is required for stream creation');
  }

  try {
    logger.debug('UTILS', 'Creating ReadableStream with WebSocket event listeners');
    return new ReadableStream({
      start(controller) {
        try {
          logger.trace('UTILS', 'Setting up WebSocket event listeners');
          server.addEventListener('message', (event) => {
            try {
              if (!event || !event.data) {
                logger.warn('STREAM', 'Received message event with no data');
                return;
              }
              const data = new Uint8Array(event.data);
              logger.trace('STREAM', `Enqueuing message: ${data.byteLength} bytes`);
              controller.enqueue(data);
            } catch (enqueueError) {
              logger.error('STREAM', `Failed to enqueue message: ${enqueueError.message}`);
              controller.error(enqueueError);
            }
          });

          server.addEventListener('close', () => {
            logger.debug('STREAM', 'WebSocket close event received');
            try {
              controller.close();
              logger.trace('STREAM', 'Stream controller closed');
            } catch (closeError) {
              logger.warn('STREAM', `Error closing stream controller: ${closeError.message}`);
            }
          });

          server.addEventListener('error', (err) => {
            logger.error('STREAM', `WebSocket error event: ${err}`);
            try {
              controller.error(err || new Error('WebSocket error'));
            } catch (errorHandlingError) {
              logger.error('STREAM', `Error handling WebSocket error: ${errorHandlingError.message}`);
            }
          });
          logger.trace('UTILS', 'WebSocket event listeners set up successfully');
        } catch (listenerError) {
          logger.error('UTILS', `Failed to set up WebSocket listeners: ${listenerError.message}`);
          throw new Error(`Failed to set up WebSocket listeners: ${listenerError.message}`);
        }
      },
    });
  } catch (error) {
    logger.error('UTILS', `createConsumableStream failed: ${error.message}`);
    throw new Error(`createConsumableStream failed: ${error.message}`);
  }
}

/**
 * Decodes a base64 string (URL-safe) to a Uint8Array.
 * @param {string} base64Str The base64-encoded string.
 * @returns {Uint8Array} The decoded data.
 * @throws {Error} If the base64 string is malformed.
 */
export function base64ToUint8Array(base64Str) {
  logger.trace('UTILS', `base64ToUint8Array called with string length: ${base64Str?.length}`);

  if (!base64Str || typeof base64Str !== 'string') {
    logger.error('UTILS', `Invalid base64 string: type=${typeof base64Str}`);
    throw new Error('base64Str must be a non-empty string');
  }

  try {
    const base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    logger.trace('UTILS', 'Base64 URL-safe characters replaced');
    
    const decoded = atob(base64);
    logger.trace('UTILS', `atob decoded length: ${decoded.length}`);
    
    if (!decoded) {
      logger.error('UTILS', 'atob returned empty result');
      throw new Error('atob returned empty result');
    }

    const uint8Array = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) {
      uint8Array[i] = decoded.charCodeAt(i);
    }
    logger.debug('UTILS', `Base64 decoded successfully: ${uint8Array.byteLength} bytes`);
    return uint8Array;
  } catch (error) {
    logger.error('UTILS', `Invalid base64 string: ${error.message}`);
    throw new Error(`Invalid base64 string for early data: ${error.message}`);
  }
}

/**
 * Safely closes a WebSocket connection.
 * @param {WebSocket} socket The WebSocket to close.
 */
export function safeCloseWebSocket(socket) {
  logger.trace('safeCloseWebSocket', 'Attempting to close WebSocket');

  if (!socket) {
    logger.warn('safeCloseWebSocket', 'Socket is null/undefined');
    return;
  }

  try {
    if (typeof socket.readyState === 'undefined') {
      logger.warn('safeCloseWebSocket', 'Socket has no readyState property');
      return;
    }

    logger.debug('safeCloseWebSocket', `WebSocket readyState: ${socket.readyState}`);

    if (socket.readyState < WS_READY_STATE.CLOSING) {
      try {
        socket.close();
        logger.debug('safeCloseWebSocket', 'WebSocket closed successfully');
      } catch (closeError) {
        logger.error('safeCloseWebSocket', `Failed to close WebSocket: ${closeError.message}`);
      }
    } else {
      logger.trace('safeCloseWebSocket', 'WebSocket already closing or closed');
    }
  } catch (error) {
    logger.error('safeCloseWebSocket', `Error in safeCloseWebSocket: ${error.message}`);
  }
}

/**
 * Converts a Uint8Array UUID to its string representation.
 * @param {Uint8Array} arr The 16-byte UUID array.
 * @returns {string} The UUID string in format xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.
 * @throws {Error} If the array is not a Uint8Array or not 16 bytes.
 */
export function stringifyUUID(arr) {
  logger.trace('UTILS', `stringifyUUID called with array length: ${arr?.length}`);

  if (!arr || !(arr instanceof Uint8Array)) {
    logger.error('UTILS', `Invalid UUID type: ${typeof arr}`);
    throw new Error('UUID must be a Uint8Array');
  }

  if (arr.length !== 16) {
    logger.error('UTILS', `Invalid UUID length: ${arr.length}, expected 16`);
    throw new Error(`UUID must be 16 bytes, got ${arr.length}`);
  }

  try {
    const uuid = (
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
    logger.debug('UTILS', `UUID stringified: ${uuid}`);
    return uuid;
  } catch (error) {
    logger.error('UTILS', `Failed to stringify UUID: ${error.message}`);
    throw new Error(`Failed to stringify UUID: ${error.message}`);
  }
}
