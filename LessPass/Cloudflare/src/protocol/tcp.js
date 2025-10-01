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
 * @param {ReadableStream} consumableStream The client data stream.
 * @param {string} address Destination address.
 * @param {number} port Destination port.
 * @param {Uint8Array} vlessVersion The VLESS version bytes.
 * @param {object} config The request-scoped configuration.
 * @param {object} logContext Logging context.
 */
export async function handleTcpProxy(webSocket, consumableStream, address, port, vlessVersion, config, logContext) {
  const tcpLogContext = { ...logContext, section: 'TCP_PROXY' };
  let primaryConnectionSuccessful = false;

  const attemptConnection = async (host, portNum) => {
    logger.info(tcpLogContext, 'TCP:ATTEMPT', `Connecting to: ${host}:${portNum}`);
    const remoteSocket = await connect({ hostname: host, port: portNum });

    const clientReader = consumableStream.getReader();
    const remoteReader = remoteSocket.readable.getReader();
    const remoteWriter = remoteSocket.writable.getWriter();

    try {
      const [clientToRemote, remoteToClient] = [
        pumpClientToRemote(clientReader, remoteWriter),
        pumpRemoteToClient(remoteReader, webSocket),
      ];

      const [hasClientSentData, hasRemoteSentData] = await Promise.all([clientToRemote, remoteToClient]);
      return hasClientSentData && hasRemoteSentData;
    } finally {
      // Ensure the reader is always released, even if pumping fails.
      clientReader.releaseLock();
    }
  };

  try {
    webSocket.send(new Uint8Array([vlessVersion[0], 0]));

    // --- Primary Connection Attempt ---
    try {
      const primaryDataExchanged = await attemptConnection(address, port);
      if (primaryDataExchanged) {
        logger.info(tcpLogContext, 'TCP:PRIMARY_SUCCESS', 'Primary connection finished with data exchange.');
        primaryConnectionSuccessful = true;
      } else {
        logger.warn(tcpLogContext, 'TCP:PRIMARY_IDLE', 'Primary connection closed without data exchange.');
      }
    } catch (error) {
      logger.error(tcpLogContext, 'TCP:PRIMARY_FAIL', `Primary connection to ${address}:${port} failed:`, error.stack || error);
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
        logger.error(relayLogContext, 'TCP:RETRY_FAIL', `Relay connection to ${relayAddr}:${relayPort} failed:`, error.stack || error);
      }
    }
  } catch (err) {
    logger.error(tcpLogContext, 'TCP:FATAL_ERROR', 'An unexpected error occurred in the TCP handler:', err.stack || err);
  } finally {
    safeCloseWebSocket(webSocket, tcpLogContext);
  }
}

/**
 * Pumps data from a client's ReadableStream to a remote socket's WritableStream.
 * @returns {Promise<boolean>} A boolean indicating if any data was pumped.
 */
async function pumpClientToRemote(reader, writer) {
  let hasPumpedData = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        await writer.close();
        break;
      }
      if (!hasPumpedData) hasPumpedData = true;
      await writer.write(value);
    }
  } catch (error) {
    // Abort the writer on error to signal failure to the remote.
    await writer.abort(error).catch(() => {});
  }
  return hasPumpedData;
}

/**
 * Pumps data from a remote socket's ReadableStream to the client WebSocket.
 * @returns {Promise<boolean>} A boolean indicating if any data was pumped.
 */
async function pumpRemoteToClient(reader, webSocket) {
  let hasPumpedData = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        await reader.releaseLock();
        break;
      }
      if (!hasPumpedData) hasPumpedData = true;
      webSocket.send(value);
    }
  } catch (error) {
    // Abort the reader on error to stop further reads.
    await reader.cancel(error).catch(() => {});
  }
  return hasPumpedData;
}
