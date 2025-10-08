// =================================================================
// File: protocol/tcp.js
// Description: Handles proxying TCP connections and the retry mechanism.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

/**
 * Main handler for TCP proxying. Attempts a primary connection and conditionally
 * retries with a relay address if the primary connection is idle.
 * @param {WebSocket} webSocket The client WebSocket.
 * @param {Uint8Array} initialPayload The payload from VLESS header parsing.
 * @param {ReadableStream} wsStream The WebSocket message stream (not yet consumed).
 * @param {string} address Destination address.
 * @param {number} port Destination port.
 * @param {Uint8Array} vlessVersion The VLESS version bytes.
 * @param {object} config The request-scoped configuration.
 * @returns {Promise<void>}
 * @throws {Error} If parameters are invalid or handshake fails.
 */
export async function handleTcpProxy(webSocket, initialPayload, wsStream, address, port, vlessVersion, config) {
  if (!webSocket) {
    throw new Error('WebSocket is required');
  }

  if (!initialPayload || !(initialPayload instanceof Uint8Array)) {
    throw new Error('initialPayload must be a Uint8Array');
  }

  if (!wsStream) {
    throw new Error('wsStream is required');
  }

  if (!address || typeof address !== 'string') {
    throw new Error('address must be a non-empty string');
  }

  if (typeof port !== 'number' || port < 1 || port > 65535) {
    throw new Error(`port must be a number between 1-65535, got ${port}`);
  }

  if (!vlessVersion || !(vlessVersion instanceof Uint8Array)) {
    throw new Error('vlessVersion must be a Uint8Array');
  }

  if (!config) {
    throw new Error('config is required');
  }

  try {
    try {
      webSocket.send(new Uint8Array([vlessVersion[0], 0]));
    } catch (sendError) {
      throw new Error(`Failed to send VLESS handshake: ${sendError.message}`);
    }

    // --- Primary Connection Attempt ---
    let connection = null;
    try {
      connection = await testConnection(address, port, initialPayload);
      if (connection) {
        logger.info('TCP_PROXY:PRIMARY_SUCCESS', 'Primary connection established.');
        try {
          await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsStream, webSocket);
        } catch (proxyError) {
          if (proxyError.message.includes('closed') || proxyError.message.includes('abort')) {
            logger.debug('TCP_PROXY:PROXY_CLOSED', `Connection closed: ${proxyError.message}`);
          } else {
            logger.error('TCP_PROXY:PROXY_ERROR', `Proxy failed: ${proxyError.message}`);
          }
        }
      } else {
        logger.warn('TCP_PROXY:PRIMARY_IDLE', 'Primary connection closed without data exchange.');
      }
    } catch (error) {
      logger.error('TCP_PROXY:PRIMARY_FAIL', `Primary connection to ${address}:${port} failed: ${error.message}`);
    } finally {
      if (connection && connection.remoteReader) {
        try {
          connection.remoteReader.releaseLock();
        } catch (lockError) {
          logger.warn('TCP_PROXY:LOCK_RELEASE_ERROR', `Failed to release reader lock: ${lockError.message}`);
        }
      }
    }

    // --- Retry Logic ---
    if (!connection) {
      logger.info('TCP_PROXY:RETRY_TRIGGER', 'Attempting connection to relay address.');
      
      if (!config.RELAY_ADDR) {
        logger.error('TCP_PROXY:NO_RELAY', 'No relay address configured');
        try {
          webSocket.close(1011, 'Connection failed: No relay');
        } catch (closeError) {
          logger.error('TCP_PROXY:CLOSE_ERROR', `Failed to close WebSocket: ${closeError.message}`);
        }
        return;
      }

      const [relayAddr, relayPortStr] = config.RELAY_ADDR.split(':');
      const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : port;
      
      if (!relayAddr) {
        logger.error('TCP_PROXY:INVALID_RELAY', 'Invalid relay address format');
        try {
          webSocket.close(1011, 'Connection failed: Invalid relay');
        } catch (closeError) {
          logger.error('TCP_PROXY:CLOSE_ERROR', `Failed to close WebSocket: ${closeError.message}`);
        }
        return;
      }

      logger.updateLogContext({ remoteAddress: relayAddr, remotePort: relayPort });

      try {
        connection = await testConnection(relayAddr, relayPort, initialPayload);
        if (connection) {
          logger.info('TCP_PROXY:RETRY_SUCCESS', 'Relay connection established.');
          try {
            await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsStream, webSocket);
          } catch (proxyError) {
            if (proxyError.message.includes('closed') || proxyError.message.includes('abort')) {
              logger.debug('TCP_PROXY:PROXY_CLOSED', `Connection closed: ${proxyError.message}`);
            } else {
              logger.error('TCP_PROXY:PROXY_ERROR', `Relay proxy failed: ${proxyError.message}`);
            }
          }
        } else {
          logger.error('TCP_PROXY:ALL_FAILED', 'Both primary and relay connections failed.');
          try {
            webSocket.close(1011, 'Connection failed');
          } catch (closeError) {
            logger.error('TCP_PROXY:CLOSE_ERROR', `Failed to close WebSocket: ${closeError.message}`);
          }
        }
      } catch (error) {
        logger.error('TCP_PROXY:RETRY_FAIL', `Relay connection to ${relayAddr}:${relayPort} failed: ${error.message}`);
        try {
          webSocket.close(1011, 'Connection failed');
        } catch (closeError) {
          logger.error('TCP_PROXY:CLOSE_ERROR', `Failed to close WebSocket: ${closeError.message}`);
        }
      } finally {
        if (connection && connection.remoteReader) {
          try {
            connection.remoteReader.releaseLock();
          } catch (lockError) {
            logger.warn('TCP_PROXY:LOCK_RELEASE_ERROR', `Failed to release reader lock: ${lockError.message}`);
          }
        }
      }
    }
  } catch (err) {
    logger.error('TCP_PROXY:FATAL_ERROR', `An unexpected error occurred in the TCP handler: ${err.message}`);
  } finally {
    safeCloseWebSocket(webSocket);
  }
}

/**
 * Tests a TCP connection by sending payload and waiting for first response.
 * @param {string} host The destination hostname or IP address.
 * @param {number} port The destination port number.
 * @param {Uint8Array} initialPayload The initial data to send.
 * @returns {Promise<{remoteSocket: Socket, remoteReader: ReadableStreamDefaultReader, remoteWriter: WritableStreamDefaultWriter, firstResponse: Uint8Array}|null>} Connection objects or null if connection is idle.
 * @throws {Error} If connection fails or parameters are invalid.
 */
async function testConnection(host, port, initialPayload) {
  if (!host || typeof host !== 'string') {
    throw new Error('host must be a non-empty string');
  }
  if (typeof port !== 'number' || port < 1 || port > 65535) {
    throw new Error(`port must be between 1-65535, got ${port}`);
  }
  if (!initialPayload || !(initialPayload instanceof Uint8Array)) {
    throw new Error('initialPayload must be a Uint8Array');
  }

  logger.info('TCP:TEST', `Testing connection to: ${host}:${port}`);
  
  let remoteSocket, remoteReader, remoteWriter;
  try {
    remoteSocket = await connect({ hostname: host, port });
    if (!remoteSocket || !remoteSocket.readable || !remoteSocket.writable) {
      throw new Error('Invalid remote socket');
    }
    remoteReader = remoteSocket.readable.getReader();
    remoteWriter = remoteSocket.writable.getWriter();
  } catch (connectError) {
    throw new Error(`Failed to connect: ${connectError.message}`);
  }

  try {
    if (initialPayload.byteLength > 0) {
      await remoteWriter.write(initialPayload);
    }

    const firstResponse = await remoteReader.read();
    if (!firstResponse || firstResponse.done) {
      return null;
    }
    if (!firstResponse.value || !(firstResponse.value instanceof Uint8Array)) {
      throw new Error('Invalid response data');
    }

    return { remoteSocket, remoteReader, remoteWriter, firstResponse: firstResponse.value };
  } catch (error) {
    try {
      remoteReader.releaseLock();
    } catch (lockError) {
      logger.warn('TCP:LOCK_ERROR', `Failed to release lock: ${lockError.message}`);
    }
    throw error;
  }
}

/**
 * Proxies bidirectional data between WebSocket and remote socket.
 * @param {ReadableStreamDefaultReader} remoteReader Reader for remote socket data.
 * @param {WritableStreamDefaultWriter} remoteWriter Writer for remote socket data.
 * @param {Uint8Array} firstResponse The first response from remote socket.
 * @param {ReadableStream} wsStream The WebSocket message stream.
 * @param {WebSocket} webSocket The client WebSocket.
 * @returns {Promise<void>}
 * @throws {Error} If proxying fails or parameters are invalid.
 */
async function proxyConnection(remoteReader, remoteWriter, firstResponse, wsStream, webSocket) {
  if (!remoteReader || !remoteWriter || !firstResponse || !wsStream || !webSocket) {
    throw new Error('All parameters are required for proxyConnection');
  }
  if (!(firstResponse instanceof Uint8Array)) {
    throw new Error('firstResponse must be a Uint8Array');
  }

  try {
    webSocket.send(firstResponse);
  } catch (sendError) {
    throw new Error(`Failed to send first response: ${sendError.message}`);
  }

  const [clientToRemote, remoteToClient] = [
    pumpWebSocketToRemote(wsStream, remoteWriter),
    pumpRemoteToClient(remoteReader, webSocket),
  ];

  await Promise.all([clientToRemote, remoteToClient]);
}

/**
 * Pumps data from WebSocket stream to remote socket.
 * @param {ReadableStream} wsStream The WebSocket message stream.
 * @param {WritableStreamDefaultWriter} writer The remote socket writer.
 * @returns {Promise<void>}
 * @throws {Error} If pumping fails or parameters are invalid.
 */
async function pumpWebSocketToRemote(wsStream, writer) {
  if (!wsStream || !writer) {
    throw new Error('wsStream and writer are required');
  }

  let reader;
  try {
    reader = wsStream.getReader();
  } catch (readerError) {
    throw new Error(`Failed to get reader: ${readerError.message}`);
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value instanceof Uint8Array) {
        await writer.write(value);
      }
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch (lockError) {
      logger.warn('TCP:LOCK', `Failed to release lock: ${lockError.message}`);
    }
  }
}

/**
 * Pumps data from remote socket to client WebSocket.
 * @param {ReadableStreamDefaultReader} reader The remote socket reader.
 * @param {WebSocket} webSocket The client WebSocket.
 * @returns {Promise<void>}
 * @throws {Error} If pumping fails or parameters are invalid.
 */
async function pumpRemoteToClient(reader, webSocket) {
  if (!reader || !webSocket) {
    throw new Error('reader and webSocket are required');
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value instanceof Uint8Array) {
        webSocket.send(value);
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
}
