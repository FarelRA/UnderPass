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
 * @param {object} logContext Logging context.
 */
export async function handleTcpProxy(webSocket, initialPayload, wsStream, address, port, vlessVersion, config, logContext) {
  const tcpLogContext = { ...logContext, section: 'TCP_PROXY' };
  let primaryConnectionSuccessful = false;

  const attemptConnection = async (host, portNum) => {
    logger.info(tcpLogContext, 'TCP:ATTEMPT', `Connecting to: ${host}:${portNum}`);
    const remoteSocket = await connect({ hostname: host, port: portNum });

    const remoteReader = remoteSocket.readable.getReader();
    const remoteWriter = remoteSocket.writable.getWriter();

    try {
      const [clientToRemote, remoteToClient] = [
        pumpClientToRemote(initialPayload, wsStream, remoteWriter),
        pumpRemoteToClient(remoteReader, webSocket),
      ];

      const [hasClientSentData, hasRemoteSentData] = await Promise.all([clientToRemote, remoteToClient]);
      return hasClientSentData && hasRemoteSentData;
    } finally {
      remoteReader.releaseLock();
    }
  };

  try {
    webSocket.send(new Uint8Array([vlessVersion[0], 0]));

    // --- Primary Connection Attempt ---
    try {
      primaryConnectionSuccessful = await attemptConnection(address, port);
      if (primaryConnectionSuccessful) {
        logger.info(tcpLogContext, 'TCP:PRIMARY_SUCCESS', 'Primary connection finished with data exchange.');
      } else {
        logger.warn(tcpLogContext, 'TCP:PRIMARY_IDLE', 'Primary connection closed without data exchange.');
      }
    } catch (error) {
      logger.error(tcpLogContext, 'TCP:PRIMARY_FAIL', `Primary connection to ${address}:${port} failed:`, error.message);
    }

    // --- Retry Logic ---
    if (!primaryConnectionSuccessful) {
      logger.info(tcpLogContext, 'TCP:RETRY_TRIGGER', 'Attempting connection to relay address.');
      const [relayAddr, relayPortStr] = config.RELAY_ADDR.split(':');
      const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : port;
      const relayLogContext = { ...tcpLogContext, remoteAddress: relayAddr, remotePort: relayPort };

      try {
        await attemptConnection(relayAddr, relayPort);
        logger.info(relayLogContext, 'TCP:RETRY_SUCCESS', 'Relay connection process finished.');
      } catch (error) {
        logger.error(relayLogContext, 'TCP:RETRY_FAIL', `Relay connection to ${relayAddr}:${relayPort} failed:`, error.message);
      }
    }
  } catch (err) {
    logger.error(tcpLogContext, 'TCP:FATAL_ERROR', 'An unexpected error occurred in the TCP handler:', err.message);
  } finally {
    safeCloseWebSocket(webSocket, tcpLogContext);
  }
}

/**
 * Pumps data from client to remote socket. Sends initialPayload first, then streams from WebSocket.
 * @returns {Promise<boolean>} True if any data was sent.
 */
async function pumpClientToRemote(initialPayload, wsStream, writer) {
  let hasSentData = false;
  try {
    if (initialPayload.byteLength > 0) {
      await writer.write(initialPayload);
      hasSentData = true;
    }

    const reader = wsStream.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        await writer.write(value);
        hasSentData = true;
      }
    } finally {
      reader.releaseLock();
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => {});
  }
  return hasSentData;
}

/**
 * Pumps data from remote socket to client WebSocket.
 * @returns {Promise<boolean>} True if any data was received.
 */
async function pumpRemoteToClient(reader, webSocket) {
  let hasReceivedData = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      webSocket.send(value);
      hasReceivedData = true;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
  }
  return hasReceivedData;
}
