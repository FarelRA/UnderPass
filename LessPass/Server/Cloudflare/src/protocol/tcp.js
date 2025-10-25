// =================================================================
// File: protocol/tcp.js
// Description: TCP proxy handler with automatic retry mechanism.
//              Attempts primary connection, falls back to relay on failure.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';

// === Public API ===

/**
 * Handles TCP proxying with automatic retry mechanism.
 * Attempts a primary connection to the destination, and if it fails or is idle,
 * retries with a relay address as a fallback.
 *
 * @param {string} destinationAddress - Destination hostname or IP address.
 * @param {number} destinationPort - Destination port number.
 * @param {ReadableStream} wsReadable - The WebSocket readable stream.
 * @param {WritableStream} wsWritable - The WebSocket writable stream.
 * @param {Uint8Array} initialPayload - The payload from VLESS header to send to remote.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function handleTcpProxy(destinationAddress, destinationPort, wsReadable, wsWritable, initialPayload, config) {
  logger.debug('TCP:PROXY', `Starting TCP proxy to ${destinationAddress}:${destinationPort}`);
  logger.trace('TCP:PROXY', `Initial payload size: ${initialPayload.byteLength} bytes`);

  // Attempt primary connection
  logger.info('TCP:CONNECT', `Attempting primary connection to ${destinationAddress}:${destinationPort}`);
  let connection = await testConnection(destinationAddress, destinationPort, initialPayload);

  if (connection) {
    logger.info('TCP:PROXY', 'Primary connection established successfully');
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsReadable, wsWritable);
    logger.info('TCP:PROXY', 'Primary connection completed');
    return;
  }

  // Primary connection failed, try relay
  logger.warn('TCP:PROXY', 'Primary connection failed or idle, attempting relay');

  if (!config.RELAY_ADDR) {
    const error = 'No relay address configured';
    logger.error('TCP:PROXY', error);
    throw new Error(error);
  }

  // Parse relay address
  const [relayAddress, relayPortString] = config.RELAY_ADDR.split(':');
  const relayPort = relayPortString ? parseInt(relayPortString, 10) : destinationPort;
  logger.info('TCP:CONNECT', `Attempting relay connection to ${relayAddress}:${relayPort}`);

  // Update logging context with relay address
  logger.updateLogContext({ remoteAddress: relayAddress, remotePort: relayPort });

  // Attempt relay connection
  connection = await testConnection(relayAddress, relayPort, initialPayload);

  if (connection) {
    logger.info('TCP:PROXY', 'Relay connection established successfully');
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsReadable, wsWritable);
    logger.info('TCP:PROXY', 'Relay connection completed');
  } else {
    const error = 'Both primary and relay connections failed';
    logger.error('TCP:PROXY', error);
    throw new Error(error);
  }
}

// === Private Helper Functions ===

/**
 * Tests a TCP connection by sending the initial payload and waiting for a response.
 * Validates that the remote server is responsive before committing to the connection.
 *
 * @param {string} hostname - The destination hostname or IP address.
 * @param {number} port - The destination port number.
 * @param {Uint8Array} initialPayload - The initial data to send to the remote server.
 * @returns {Promise<{remoteSocket: Socket, remoteReader: ReadableStreamDefaultReader, remoteWriter: WritableStreamDefaultWriter, firstResponse: Uint8Array}|null>}
 *          Connection objects if successful, or null if the connection is idle/unresponsive.
 * @throws {Error} If connection fails.
 */
async function testConnection(hostname, port, initialPayload) {
  logger.debug('TCP:CONNECT', `Testing connection to ${hostname}:${port}`);

  try {
    // Establish TCP connection
    const remoteSocket = await connect({ hostname, port });
    const remoteReader = remoteSocket.readable.getReader();
    const remoteWriter = remoteSocket.writable.getWriter();
    logger.trace('TCP:CONNECT', 'Socket created, readers/writers obtained');

    // Send initial payload if present
    if (initialPayload.byteLength > 0) {
      logger.trace('TCP:CONNECT', `Sending initial payload: ${initialPayload.byteLength} bytes`);
      await remoteWriter.write(initialPayload);
    }

    // Wait for first response to validate connection
    logger.trace('TCP:CONNECT', 'Waiting for first response from remote');
    const firstResponse = await remoteReader.read();
    
    if (firstResponse.done) {
      logger.warn('TCP:CONNECT', 'Connection closed immediately by remote (no data)');
      return null;
    }

    logger.debug('TCP:CONNECT', `Received first response: ${firstResponse.value.byteLength} bytes`);
    return { remoteSocket, remoteReader, remoteWriter, firstResponse: firstResponse.value };
  } catch (error) {
    logger.error('TCP:CONNECT', `Connection failed: ${error.message}`);
    throw error;
  }
}

/**
 * Proxies bidirectional data between the client WebSocket and remote TCP socket.
 * Sets up two concurrent data pumps: client→remote and remote→client.
 *
 * @param {ReadableStreamDefaultReader} remoteReader - Reader for data from remote socket.
 * @param {WritableStreamDefaultWriter} remoteWriter - Writer for data to remote socket.
 * @param {Uint8Array} firstResponse - The first response from remote socket (already read).
 * @param {ReadableStream} wsReadable - The WebSocket readable stream.
 * @param {WritableStream} wsWritable - The WebSocket writable stream.
 * @returns {Promise<void>}
 */
async function proxyConnection(remoteReader, remoteWriter, firstResponse, wsReadable, wsWritable) {
  logger.debug('TCP:PROXY', 'Starting bidirectional proxy');

  // Send first response to client
  logger.trace('TCP:PROXY', `Sending first response to client: ${firstResponse.byteLength} bytes`);
  const wsWriter = wsWritable.getWriter();
  await wsWriter.write(firstResponse);
  wsWriter.releaseLock();

  // Set up bidirectional data pumping
  logger.debug('TCP:PROXY', 'Setting up bidirectional data pumps');
  await Promise.all([
    pumpReadableToWritable(wsReadable.getReader(), remoteWriter, 'Client→Remote'),
    pumpReadableToWritable(remoteReader, wsWritable.getWriter(), 'Remote→Client'),
  ]);
  
  logger.debug('TCP:PROXY', 'Bidirectional proxy completed');
}

/**
 * Pumps data from a readable stream to a writable stream.
 * Continuously reads from source and writes to destination until stream ends.
 *
 * @param {ReadableStreamDefaultReader} reader - The source reader.
 * @param {WritableStreamDefaultWriter} writer - The destination writer.
 * @param {string} direction - Direction label for logging (e.g., "Client→Remote").
 * @returns {Promise<void>}
 */
async function pumpReadableToWritable(reader, writer, direction) {
  logger.trace('TCP:PUMP', `Starting pump: ${direction}`);
  let bytesTransferred = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.debug('TCP:PUMP', `${direction} stream ended (${bytesTransferred} bytes transferred)`);
        break;
      }
      
      await writer.write(value);
      bytesTransferred += value.byteLength;
      logger.trace('TCP:PUMP', `${direction} transferred ${value.byteLength} bytes (total: ${bytesTransferred})`);
    }
    
    await writer.close();
    logger.trace('TCP:PUMP', `${direction} writer closed`);
  } catch (error) {
    logger.error('TCP:PUMP', `${direction} error: ${error.message}`);
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    logger.trace('TCP:PUMP', `${direction} reader released`);
  }
}
