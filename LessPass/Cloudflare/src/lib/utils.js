// =================================================================
// File: lib/utils.js
// Description: Shared utilities for VLESS parsing, stream manipulation, and WebSockets.
// =================================================================

import { byteToHex, WS_READY_STATE } from './config.js';
import { logger } from './logger.js';

/**
 * Gets the first chunk and creates a stream for subsequent messages.
 * @param {WebSocket} server The server-side WebSocket.
 * @param {Request} request The incoming request.
 * @returns {Promise<{firstChunk: Uint8Array, wsStream: ReadableStream}>}
 */
export async function initializeWebSocketStream(server, request) {
  logger.trace('UTILS', 'initializeWebSocketStream called');

  if (!server) {
    logger.error('UTILS', 'WebSocket server is null/undefined');
    throw new Error('WebSocket server is required');
  }

  if (!request) {
    logger.error('UTILS', 'Request object is null/undefined');
    throw new Error('Request object is required');
  }

  try {
    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol');
    logger.debug('UTILS', `Early data header present: ${!!earlyDataHeader}`);
    
    if (earlyDataHeader) {
      logger.trace('UTILS', `Early data header length: ${earlyDataHeader.length}`);
      let firstChunk;
      try {
        firstChunk = base64ToUint8Array(earlyDataHeader);
        logger.debug('UTILS', `Decoded early data: ${firstChunk.byteLength} bytes`);
      } catch (decodeError) {
        logger.error('UTILS', `Failed to decode early data: ${decodeError.message}`);
        throw new Error(`Failed to decode early data: ${decodeError.message}`);
      }

      let wsStream;
      try {
        wsStream = createConsumableStream(server);
        logger.trace('UTILS', 'WebSocket stream created for early data path');
      } catch (streamError) {
        logger.error('UTILS', `Failed to create WebSocket stream: ${streamError.message}`);
        throw new Error(`Failed to create WebSocket stream: ${streamError.message}`);
      }

      logger.debug('UTILS', 'Returning early data path result');
      return { firstChunk, wsStream };
    }

    logger.debug('UTILS', 'No early data, creating stream and waiting for first message');
    let wsStream;
    try {
      wsStream = createConsumableStream(server);
      logger.trace('UTILS', 'WebSocket stream created');
    } catch (streamError) {
      logger.error('UTILS', `Failed to create WebSocket stream: ${streamError.message}`);
      throw new Error(`Failed to create WebSocket stream: ${streamError.message}`);
    }

    const reader = wsStream.getReader();
    logger.trace('UTILS', 'Got stream reader, waiting for first chunk');
    let firstChunk;
    
    try {
      const result = await reader.read();
      logger.trace('UTILS', `Read result: done=${result?.done}, hasValue=${!!result?.value}`);
      if (!result || result.done) {
        logger.warn('UTILS', 'WebSocket closed before receiving first chunk');
        throw new Error('WebSocket closed before receiving first chunk');
      }
      firstChunk = result.value;
      if (!firstChunk || !(firstChunk instanceof Uint8Array)) {
        logger.error('UTILS', `Invalid first chunk data type: ${typeof firstChunk}`);
        throw new Error('Invalid first chunk data type');
      }
      logger.debug('UTILS', `Received first chunk: ${firstChunk.byteLength} bytes`);
    } catch (readError) {
      reader.releaseLock();
      logger.error('UTILS', `Failed to read first chunk: ${readError.message}`);
      throw new Error(`Failed to read first chunk: ${readError.message}`);
    }

    reader.releaseLock();
    logger.trace('UTILS', 'Reader lock released');
    
    logger.debug('UTILS', 'Returning standard path result');
    return { firstChunk, wsStream };
  } catch (error) {
    logger.error('UTILS', `initializeWebSocketStream failed: ${error.message}`);
    throw new Error(`initializeWebSocketStream failed: ${error.message}`);
  }
}

/**
 * Creates a ReadableStream from WebSocket messages.
 * @param {WebSocket} server The server-side WebSocket.
 * @returns {ReadableStream}
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
 * @param {object} logContext Logging context.
 */
export function safeCloseWebSocket(socket, logContext) {
  logger.trace(logContext, 'safeCloseWebSocket', 'Attempting to close WebSocket');

  if (!socket) {
    logger.warn(logContext, 'safeCloseWebSocket', 'Socket is null/undefined');
    return;
  }

  try {
    if (typeof socket.readyState === 'undefined') {
      logger.warn(logContext, 'safeCloseWebSocket', 'Socket has no readyState property');
      return;
    }

    logger.debug(logContext, 'safeCloseWebSocket', `WebSocket readyState: ${socket.readyState}`);

    if (socket.readyState < WS_READY_STATE.CLOSING) {
      try {
        socket.close();
        logger.debug(logContext, 'safeCloseWebSocket', 'WebSocket closed successfully');
      } catch (closeError) {
        logger.error(logContext, 'safeCloseWebSocket', `Failed to close WebSocket: ${closeError.message}`);
      }
    } else {
      logger.trace(logContext, 'safeCloseWebSocket', 'WebSocket already closing or closed');
    }
  } catch (error) {
    logger.error(logContext, 'safeCloseWebSocket', `Error in safeCloseWebSocket: ${error.message}`);
  }
}

/**
 * Converts a Uint8Array UUID to its string representation.
 * @param {Uint8Array} arr
 * @returns {string}
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
