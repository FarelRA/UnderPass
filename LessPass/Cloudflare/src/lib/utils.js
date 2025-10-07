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
  if (!server) {
    throw new Error('WebSocket server is required');
  }

  if (!request) {
    throw new Error('Request object is required');
  }

  try {
    const earlyDataHeader = request.headers.get('Sec-WebSocket-Protocol');
    
    if (earlyDataHeader) {
      let firstChunk;
      try {
        firstChunk = base64ToUint8Array(earlyDataHeader);
      } catch (decodeError) {
        throw new Error(`Failed to decode early data: ${decodeError.message}`);
      }

      let wsStream;
      try {
        wsStream = createConsumableStream(server);
      } catch (streamError) {
        throw new Error(`Failed to create WebSocket stream: ${streamError.message}`);
      }

      return { firstChunk, wsStream };
    }

    let wsStream;
    try {
      wsStream = createConsumableStream(server);
    } catch (streamError) {
      throw new Error(`Failed to create WebSocket stream: ${streamError.message}`);
    }

    const reader = wsStream.getReader();
    let firstChunk;
    
    try {
      const result = await reader.read();
      if (!result || result.done) {
        throw new Error('WebSocket closed before receiving first chunk');
      }
      firstChunk = result.value;
      if (!firstChunk || !(firstChunk instanceof Uint8Array)) {
        throw new Error('Invalid first chunk data type');
      }
    } catch (readError) {
      reader.releaseLock();
      throw new Error(`Failed to read first chunk: ${readError.message}`);
    }

    reader.releaseLock();
    
    return { firstChunk, wsStream };
  } catch (error) {
    throw new Error(`initializeWebSocketStream failed: ${error.message}`);
  }
}

/**
 * Creates a ReadableStream from WebSocket messages.
 * @param {WebSocket} server The server-side WebSocket.
 * @returns {ReadableStream}
 */
export function createConsumableStream(server) {
  if (!server) {
    throw new Error('WebSocket server is required for stream creation');
  }

  try {
    return new ReadableStream({
      start(controller) {
        try {
          server.addEventListener('message', (event) => {
            try {
              if (!event || !event.data) {
                logger.warn({}, 'STREAM', 'Received message event with no data');
                return;
              }
              controller.enqueue(new Uint8Array(event.data));
            } catch (enqueueError) {
              logger.error({}, 'STREAM', `Failed to enqueue message: ${enqueueError.message}`);
              controller.error(enqueueError);
            }
          });

          server.addEventListener('close', () => {
            try {
              controller.close();
            } catch (closeError) {
              logger.warn({}, 'STREAM', `Error closing stream controller: ${closeError.message}`);
            }
          });

          server.addEventListener('error', (err) => {
            try {
              controller.error(err || new Error('WebSocket error'));
            } catch (errorHandlingError) {
              logger.error({}, 'STREAM', `Error handling WebSocket error: ${errorHandlingError.message}`);
            }
          });
        } catch (listenerError) {
          throw new Error(`Failed to set up WebSocket listeners: ${listenerError.message}`);
        }
      },
    });
  } catch (error) {
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
  if (!base64Str || typeof base64Str !== 'string') {
    throw new Error('base64Str must be a non-empty string');
  }

  try {
    const base64 = base64Str.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = atob(base64);
    
    if (!decoded) {
      throw new Error('atob returned empty result');
    }

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
  if (!socket) {
    logger.warn(logContext, 'safeCloseWebSocket', 'Socket is null/undefined');
    return;
  }

  try {
    if (typeof socket.readyState === 'undefined') {
      logger.warn(logContext, 'safeCloseWebSocket', 'Socket has no readyState property');
      return;
    }

    if (socket.readyState < WS_READY_STATE.CLOSING) {
      try {
        socket.close();
      } catch (closeError) {
        logger.error(logContext, 'safeCloseWebSocket', `Failed to close WebSocket: ${closeError.message}`);
      }
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
  if (!arr || !(arr instanceof Uint8Array)) {
    throw new Error('UUID must be a Uint8Array');
  }

  if (arr.length !== 16) {
    throw new Error(`UUID must be 16 bytes, got ${arr.length}`);
  }

  try {
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
  } catch (error) {
    throw new Error(`Failed to stringify UUID: ${error.message}`);
  }
}
