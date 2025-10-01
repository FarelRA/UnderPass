// =================================================================
// File: protocol/tcp.js
// Description: Handles proxying TCP connections and the retry mechanism.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';

/**
 * Pumps data from a client's ReadableStream to a remote socket's WritableStream.
 * @returns {Promise<boolean>} A boolean indicating if any data was pumped.
 */
async function pumpClientToRemote(reader, writer, logContext) {
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
    logger.error(logContext, 'PUMP:CLIENT_REMOTE_ERROR', 'Error pumping from client to remote:', error);
    await writer.abort(error).catch(() => {});
  }
  return hasPumpedData;
}

/**
 * Pumps data from a remote socket's ReadableStream to the client WebSocket.
 * @returns {Promise<boolean>} A boolean indicating if any data was pumped.
 */
async function pumpRemoteToClient(reader, webSocket, logContext) {
  let hasPumpedData = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        await reader.cancel();
        break;
      }
      if (!hasPumpedData) hasPumpedData = true;
      webSocket.send(value);
    }
  } catch (error) {
    logger.error(logContext, 'PUMP:REMOTE_CLIENT_ERROR', 'Error pumping from remote to client:', error);
    await reader.cancel(error).catch(() => {});
  }
  return hasPumpedData;
}

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

  const attemptConnection = async (host, portNum) => {
    logger.info(tcpLogContext, 'TCP:CONNECT_ATTEMPT', `Connecting to: ${host}:${portNum}`);
    const remoteSocket = await connect({ hostname: host, port: portNum });
    const [clientReader, remoteReader] = [consumableStream.getReader(), remoteSocket.readable.getReader()];
    const remoteWriter = remoteSocket.writable.getWriter();

    // Manual pumping is used here to detect if any data was transferred.
    // This is crucial for the "retry on no data" logic.
    const clientToRemote = pumpClientToRemote(clientReader, remoteWriter, tcpLogContext);
    const remoteToClient = pumpRemoteToClient(remoteReader, webSocket, tcpLogContext);

    const [hasClientSentData, hasRemoteSentData] = await Promise.all([clientToRemote, remoteToClient]);
    clientReader.releaseLock();

    return hasClientSentData || hasRemoteSentData;
  };

  try {
    // Send the VLESS response header (version, no-error).
    webSocket.send(new Uint8Array([vlessVersion[0], 0]));

    // --- Primary Connection Attempt ---
    const primaryDataExchanged = await attemptConnection(address, port);

    if (primaryDataExchanged) {
      logger.info(tcpLogContext, 'TCP:PRIMARY_SUCCESS', 'Primary connection finished, data exchanged.');
      return; // Success, we are done.
    }

    // --- Retry Logic ---
    logger.warn(tcpLogContext, 'TCP:RETRY_TRIGGER', 'Primary connection closed without data exchange. Retrying with relay...');
    const [relayAddr, relayPortStr] = config.RELAY_ADDR.split(':');
    const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : port;
    tcpLogContext.remoteAddress = relayAddr;
    tcpLogContext.remotePort = relayPort;

    await attemptConnection(relayAddr, relayPort);
    logger.info(tcpLogContext, 'TCP:RETRY_COMPLETE', 'Relay connection process finished.');
  } catch (error) {
    logger.error(tcpLogContext, 'TCP:FATAL_ERROR', 'A connection attempt failed fatally:', error.stack || error);
  } finally {
    safeCloseWebSocket(webSocket, tcpLogContext);
  }
}
