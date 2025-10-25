// =================================================================
// File: protocol/tcp.js
// Description: Handles proxying TCP connections and the retry mechanism.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';

// === Public API ===

/**
 * Main handler for TCP proxying with automatic retry mechanism.
 * Attempts a primary connection to the destination, and if it fails or is idle,
 * retries with a relay address as a fallback.
 *
 * @param {string} destinationAddress - Destination hostname or IP address.
 * @param {number} destinationPort - Destination port number.
 * @param {ReadableStream} wsReadable - The WebSocket readable stream.
 * @param {WritableStream} wsWritable - The WebSocket writable stream.
 * @param {Uint8Array} initialPayload - The payload from VLESS header parsing to send to remote.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function handleTcpProxy(destinationAddress, destinationPort, wsReadable, wsWritable, initialPayload, config) {
  // === Attempt Primary Connection ===
  let connection = await testConnection(destinationAddress, destinationPort, initialPayload);

  if (connection) {
    logger.info('TCP:PROXY', 'Primary connection established successfully');
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsReadable, wsWritable);
    return;
  }

  logger.warn('TCP:PROXY', 'Primary connection closed without data exchange');

  // === Attempt Relay Connection (Fallback) ===
  logger.info('TCP:PROXY', `Attempting relay connection to ${config.RELAY_ADDR}`);

  const [relayAddress, relayPortString] = config.RELAY_ADDR.split(':');
  const relayPort = relayPortString ? parseInt(relayPortString, 10) : destinationPort;

  logger.updateLogContext({ remoteAddress: relayAddress, remotePort: relayPort });

  connection = await testConnection(relayAddress, relayPort, initialPayload);

  if (connection) {
    logger.info('TCP:PROXY', 'Relay connection established successfully');
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsReadable, wsWritable);
  } else {
    logger.error('TCP:PROXY', 'Both primary and relay connections failed');
  }
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
 * @param {ReadableStream} wsReadable - The WebSocket readable stream.
 * @param {WritableStream} wsWritable - The WebSocket writable stream.
 * @returns {Promise<void>}
 */
async function proxyConnection(remoteReader, remoteWriter, firstResponse, wsReadable, wsWritable) {
  // Send the first response back to client immediately
  const wsWriter = wsWritable.getWriter();
  await wsWriter.write(firstResponse);
  wsWriter.releaseLock();

  // Set up bidirectional data pumping
  await Promise.all([
    pumpReadableToWritable(wsReadable.getReader(), remoteWriter), // Client → Remote
    pumpReadableToWritable(remoteReader, wsWritable.getWriter()), // Remote → Client
  ]);
}

/**
 * Pumps data from a readable stream to a writable stream.
 *
 * @param {ReadableStreamDefaultReader} reader - The source reader.
 * @param {WritableStreamDefaultWriter} writer - The destination writer.
 * @returns {Promise<void>}
 */
async function pumpReadableToWritable(reader, writer) {
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
