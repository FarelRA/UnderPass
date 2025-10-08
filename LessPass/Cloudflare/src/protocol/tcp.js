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
 * @param {object} config The request-scoped configuration.
 * @returns {Promise<void>}
 * @throws {Error} If parameters are invalid or handshake fails.
 */
export async function handleTcpProxy(webSocket, initialPayload, wsStream, address, port, config) {
  let connection = await testConnection(address, port, initialPayload);
  if (connection) {
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsStream, webSocket);
    safeCloseWebSocket(webSocket);
    return;
  }

  if (!config.RELAY_ADDR) {
    logger.error('TCP:NO_RELAY', 'No relay configured');
    webSocket.close(1011, 'Connection failed');
    return;
  }

  const [relayAddr, relayPortStr] = config.RELAY_ADDR.split(':');
  const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : port;

  logger.updateLogContext({ remoteAddress: relayAddr, remotePort: relayPort });

  connection = await testConnection(relayAddr, relayPort, initialPayload);
  if (connection) {
    await proxyConnection(connection.remoteReader, connection.remoteWriter, connection.firstResponse, wsStream, webSocket);
  } else {
    logger.error('TCP:FAILED', 'All connections failed');
    webSocket.close(1011, 'Connection failed');
  }

  safeCloseWebSocket(webSocket);
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
  const remoteSocket = await connect({ hostname: host, port });
  const remoteReader = remoteSocket.readable.getReader();
  const remoteWriter = remoteSocket.writable.getWriter();

  if (initialPayload.byteLength > 0) {
    await remoteWriter.write(initialPayload);
  }

  const firstResponse = await remoteReader.read();
  if (firstResponse.done) {
    remoteReader.releaseLock();
    return null;
  }

  return { remoteSocket, remoteReader, remoteWriter, firstResponse: firstResponse.value };
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
  webSocket.send(firstResponse);

  await Promise.all([
    pump(wsStream.getReader(), remoteWriter),
    pump(remoteReader, webSocket),
  ]);
}

/**
 * Pumps data from a reader to a writer/WebSocket.
 * @param {ReadableStreamDefaultReader} reader The source reader.
 * @param {WritableStreamDefaultWriter|WebSocket} writer The destination writer or WebSocket.
 * @returns {Promise<void>}
 * @throws {Error} If pumping fails.
 */
async function pump(reader, writer) {
  const isWebSocket = writer.send !== undefined;
  
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      isWebSocket ? writer.send(value) : await writer.write(value);
    }
    if (!isWebSocket) await writer.close();
  } catch (error) {
    if (!isWebSocket) await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

