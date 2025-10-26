// =================================================================
// File: protocol/tcp.js
// Description: TCP proxy handler with automatic retry mechanism.
//              Attempts primary connection, falls back to relay on failure.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';

// === Public API ===

/**
 * Proxies TCP connections with automatic retry mechanism.
 * Attempts a primary connection to the destination, and if it fails or is idle,
 * retries with a relay address as a fallback.
 *
 * @param {string} address - Destination hostname or IP address.
 * @param {number} port - Destination port number.
 * @param {{readable: ReadableStreamDefaultReader, writable: WritableStreamDefaultWriter}} clientStream - The client streams.
 * @param {Uint8Array} payload - The payload from VLESS header to send to remote.
 * @param {object} config - The request-scoped configuration.
 * @returns {Promise<void>}
 */
export async function proxyTcp(address, port, clientStream, payload, config) {
  logger.debug('TCP:PROXY', `Starting TCP proxy to ${address}:${port}`);
  logger.trace('TCP:PROXY', `Payload size: ${payload.byteLength} bytes`);

  // Attempt primary connection
  logger.info('TCP:CONNECT', `Attempting primary connection to ${address}:${port}`);
  let remoteStream = await connectAndTest(address, port, payload);

  if (remoteStream) {
    logger.info('TCP:PROXY', 'Primary connection established successfully');
    await proxyStreams(clientStream, remoteStream, remoteStream.firstChunk);
    logger.info('TCP:PROXY', 'Primary connection completed');
    return;
  }

  // Primary connection failed, try relay
  logger.warn('TCP:PROXY', 'Primary connection failed or idle, attempting relay');

  // Parse relay address
  const [relayAddress, relayPortString] = config.RELAY_ADDR.split(':');
  const relayPort = relayPortString ? parseInt(relayPortString, 10) : port;
  logger.info('TCP:CONNECT', `Attempting relay connection to ${relayAddress}:${relayPort}`);

  // Update logging context with relay address
  logger.updateLogContext({ remoteAddress: relayAddress, remotePort: relayPort });

  // Attempt relay connection
  remoteStream = await connectAndTest(relayAddress, relayPort, payload);

  if (remoteStream) {
    logger.info('TCP:PROXY', 'Relay connection established successfully');
    await proxyStreams(clientStream, remoteStream, remoteStream.firstChunk);
    logger.info('TCP:PROXY', 'Relay connection completed');
  } else {
    const error = 'Both primary and relay connections failed';
    logger.error('TCP:PROXY', error);
    throw new Error(error);
  }
}

// === Private Helper Functions ===

/**
 * Connects to a TCP server and tests responsiveness by sending payload and waiting for response.
 * Validates that the remote server is responsive before committing to the connection.
 *
 * @param {string} hostname - The destination hostname or IP address.
 * @param {number} port - The destination port number.
 * @param {Uint8Array} payload - The initial data to send to the remote server.
 * @returns {Promise<{readable: ReadableStreamDefaultReader, writable: WritableStreamDefaultWriter, firstChunk: Uint8Array}|null>}
 *          Connection streams if successful, or null if the connection is idle/unresponsive.
 * @throws {Error} If connection fails.
 */
async function connectAndTest(hostname, port, payload) {
  logger.debug('TCP:CONNECT', `Testing connection to ${hostname}:${port}`);

  try {
    // Establish TCP connection
    const socket = await connect({ hostname, port });
    const readable = socket.readable.getReader();
    const writable = socket.writable.getWriter();
    logger.trace('TCP:CONNECT', 'Socket created, readers/writers obtained');

    // Send payload
    logger.trace('TCP:CONNECT', `Sending payload: ${payload.byteLength} bytes`);
    await writable.write(payload);

    // Wait for first response to validate connection
    logger.trace('TCP:CONNECT', 'Waiting for first response from remote');
    const result = await readable.read();
    
    if (result.done) {
      logger.warn('TCP:CONNECT', 'Connection closed immediately by remote (no data)');
      return null;
    }

    logger.debug('TCP:CONNECT', `Received first response: ${result.value.byteLength} bytes`);
    return { readable, writable, firstChunk: result.value };
  } catch (error) {
    logger.error('TCP:CONNECT', `Connection failed: ${error.message}`);
    throw error;
  }
}

/**
 * Proxies bidirectional data between the client WebSocket and remote TCP socket.
 * Sets up two concurrent data pipes: client→remote and remote→client.
 *
 * @param {{readable: ReadableStreamDefaultReader, writable: WritableStreamDefaultWriter}} clientStream - The client streams.
 * @param {{readable: ReadableStreamDefaultReader, writable: WritableStreamDefaultWriter}} remoteStream - The remote socket streams.
 * @param {Uint8Array} firstChunk - The first response from remote socket (already read).
 * @returns {Promise<void>}
 */
async function proxyStreams(clientStream, remoteStream, firstChunk) {
  logger.debug('TCP:PROXY', 'Starting bidirectional proxy');

  // Send first response to client
  logger.trace('TCP:PROXY', `Sending first response to client: ${firstChunk.byteLength} bytes`);
  await clientStream.writable.write(firstChunk);

  // Set up bidirectional data piping
  logger.debug('TCP:PROXY', 'Setting up bidirectional data pipes');
  await Promise.all([
    pipeStream(clientStream.readable, remoteStream.writable, 'Client → Remote'),
    pipeStream(remoteStream.readable, clientStream.writable, 'Remote → Client'),
  ]);
  
  logger.debug('TCP:PROXY', 'Bidirectional proxy completed');
}

/**
 * Pipes data from a readable stream to a writable stream.
 * Continuously reads from source and writes to destination until stream ends.
 *
 * @param {ReadableStreamDefaultReader} reader - The source reader.
 * @param {WritableStreamDefaultWriter} writer - The destination writer.
 * @param {string} direction - Direction label for logging (e.g., "Client→Remote").
 * @returns {Promise<void>}
 */
async function pipeStream(reader, writer, direction) {
  logger.trace('TCP:PIPE', `Starting pipe: ${direction}`);
  let bytesTransferred = 0;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        logger.debug('TCP:PIPE', `${direction} stream ended (${bytesTransferred} bytes transferred)`);
        break;
      }
      
      await writer.write(value);
      bytesTransferred += value.byteLength;
      logger.trace('TCP:PIPE', `${direction} transferred ${value.byteLength} bytes (total: ${bytesTransferred})`);
    }
    
    await writer.close();
    logger.trace('TCP:PIPE', `${direction} writer closed`);
  } catch (error) {
    logger.error('TCP:PIPE', `${direction} error: ${error.message}`);
    await writer.abort(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
    logger.trace('TCP:PIPE', `${direction} reader released`);
  }
}
