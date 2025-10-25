// =================================================================
// File: protocol/tcp.js
// Description: Handles proxying TCP connections and the retry mechanism.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

// === Public API ===

/**
 * Main handler for TCP proxying with automatic retry mechanism.
 * Attempts a primary connection to the destination, and if it fails or is idle,
 * retries with a relay address as a fallback.
 *
 * @param {string} destinationAddress - Destination hostname or IP address.
 * @param {number} destinationPort - Destination port number.
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket connection.
 * @param {Uint8Array} initialPayload - The payload from VLESS header parsing to send to remote.
 * @param {ReadableStream} wsStream - The WebSocket message stream (not yet consumed).
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function handleTcpProxy(destinationAddress, destinationPort, clientWebSocket, initialPayload, wsStream, config) {
  // === Attempt Primary Connection ===
  let connection = await testConnection(destinationAddress, destinationPort, initialPayload);

  if (connection) {
    logger.info('TCP:PROXY', 'Primary connection established successfully');
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsStream, clientWebSocket);
    safeCloseWebSocket(clientWebSocket);
    return;
  }

  logger.warn('TCP:PROXY', 'Primary connection closed without data exchange');

  // === Attempt Relay Connection (Fallback) ===
  if (!config.RELAY_ADDR) {
    logger.error('TCP:PROXY', 'No relay address configured, connection failed');
    clientWebSocket.close(1011, 'Connection failed: No relay');
    return;
  }

  logger.info('TCP:PROXY', `Attempting relay connection to ${config.RELAY_ADDR}`);

  const [relayAddress, relayPortString] = config.RELAY_ADDR.split(':');
  const relayPort = relayPortString ? parseInt(relayPortString, 10) : destinationPort;

  logger.updateLogContext({ remoteAddress: relayAddress, remotePort: relayPort });

  connection = await testConnection(relayAddress, relayPort, initialPayload);

  if (connection) {
    logger.info('TCP:PROXY', 'Relay connection established successfully');
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsStream, clientWebSocket);
  } else {
    logger.error('TCP:PROXY', 'Both primary and relay connections failed');
    clientWebSocket.close(1011, 'Connection failed');
  }

  safeCloseWebSocket(clientWebSocket);
}

// === Private Helper Functions ===

/**
 * Tests a TCP connection by sending the initial payload and waiting for a response.
 * This validates that the remote server is responsive before committing to the connection.
 *
 * @param {string} hostname - The destination hostname or IP address.
 * @param {number} port - The destination port number.
 * @param {Uint8Array} initialPayload - The initial data to send to the remote server.
 * @returns {Promise<{remoteSocket: Socket, remoteReader: ReadableStreamDefaultReader, remoteWriter: WritableStreamDefaultWriter, firstResponse: Uint8Array}|null>}
 *          Connection objects if successful, or null if the connection is idle/unresponsive.
 * @throws {Error} If connection fails.
 */
async function testConnection(hostname, port, initialPayload) {
  logger.info('TCP:CONNECT', `Testing connection to ${hostname}:${port}`);

  // Establish TCP connection
  const remoteSocket = await connect({ hostname, port });
  const remoteReader = remoteSocket.readable.getReader();
  const remoteWriter = remoteSocket.writable.getWriter();

  // Send initial payload if present
  if (initialPayload.byteLength > 0) {
    await remoteWriter.write(initialPayload);
  }

  // Wait for first response to validate connection
  const firstResponse = await remoteReader.read();
  if (firstResponse.done) {
    // Connection closed immediately
    return null;
  }

  return {
    remoteSocket,
    remoteReader,
    remoteWriter,
    firstResponse: firstResponse.value,
  };
}

/**
 * Proxies bidirectional data between the client WebSocket and remote TCP socket.
 * Sets up two concurrent data pumps: client→remote and remote→client.
 *
 * @param {ReadableStreamDefaultReader} remoteReader - Reader for data from remote socket.
 * @param {WritableStreamDefaultWriter} remoteWriter - Writer for data to remote socket.
 * @param {Uint8Array} firstResponse - The first response from remote socket (already read).
 * @param {ReadableStream} wsStream - The WebSocket message stream from client.
 * @param {WebSocket} clientWebSocket - The client-facing WebSocket.
 * @returns {Promise<void>}
 */
async function proxyConnection(remoteReader, remoteWriter, firstResponse, wsStream, clientWebSocket) {
  // Send the first response back to client immediately
  clientWebSocket.send(firstResponse);

  // Set up bidirectional data pumping
  await Promise.all([
    pump(wsStream.getReader(), remoteWriter), // Client → Remote
    pump(remoteReader, clientWebSocket), // Remote → Client
  ]);
}

/**
 * Pumps data from a reader to a writer (or WebSocket).
 * Continuously reads from the source and writes to the destination until the stream ends.
 *
 * @param {ReadableStreamDefaultReader} reader - The source reader to read data from.
 * @param {WritableStreamDefaultWriter|WebSocket} writer - The destination writer or WebSocket.
 * @returns {Promise<void>}
 * @throws {Error} If pumping fails.
 */
async function pump(reader, writer) {
  const isWebSocket = writer.send !== undefined;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) break;

      // Send data to destination
      if (isWebSocket) {
        writer.send(value);
      } else {
        await writer.write(value);
      }
    }

    // Close writer if it's a stream (not WebSocket)
    if (!isWebSocket) {
      await writer.close();
    }
  } catch (error) {
    // Abort writer on error (if it's a stream)
    if (!isWebSocket) {
      await writer.abort(error).catch(() => {});
    }
    throw error;
  } finally {
    // Always release the reader lock
    reader.releaseLock();
  }
}
