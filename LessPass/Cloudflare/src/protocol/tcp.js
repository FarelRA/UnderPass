// =================================================================
// File: protocol/tcp.js
// Description: The TCP Actor. Handles proxying TCP connections.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';
import { safeCloseWebSocket } from '../lib/utils.js';
import { config } from '../lib/config.js';

/**
 * Manually pumps data from a client's reader to a remote socket's writer.
 * It returns a boolean indicating if any data was successfully pumped.
 */
async function pumpClientToRemote(reader, writer, logContext) {
  let hasReceivedData = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        await writer.close();
        break;
      }

      if (!hasReceivedData) {
        hasReceivedData = true;
      }

      await writer.write(value);
    }
  } catch (error) {
    logger.error(logContext, 'PUMP:CLIENT_REMOTE_ERROR', 'Error pumping from client to remote:', error);
    await writer.abort(error);
  }
  return hasReceivedData;
}

/**
 * Manually pumps data from a remote socket's reader to the client WebSocket.
 * It returns a boolean indicating if any data was successfully pumped.
 */
async function pumpRemoteToClient(reader, webSocket, logContext) {
  let hasReceivedData = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        await reader.cancel();
        break;
      }

      if (!hasReceivedData) {
        hasReceivedData = true;
      }

      await webSocket.send(value);
    }
  } catch (error) {
    logger.error(logContext, 'PUMP:REMOTE_CLIENT_ERROR', 'Error pumping from remote to client:', error);
  }
  return hasReceivedData;
}

/**
 * The main handler for TCP proxying. Implements "retry on no data" symmetrically.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {ReadableStream} consumableStream - The client data stream.
 * @param {string} address - Destination address.
 * @param {number} port - Destination port.
 * @param {Uint8Array} vlessVersion - The VLESS version bytes.
 * @param {object} logContext - Logging context.
 */
export async function handleTcpProxy(webSocket, consumableStream, address, port, vlessVersion, logContext) {
  const tcpLogContext = { ...logContext, section: 'TCP_PROXY' };
  const clientReader = consumableStream.getReader();

  // This function attempts a connection and starts symmetric bidirectional pumps.
  const attemptConnection = async (host, portNum) => {
    logger.info(tcpLogContext, `TCP:CONNECT_ATTEMPT`, `Connecting to destination: ${host}:${portNum}`);
    const remoteSocket = await connect({ hostname: host, port: portNum });

    const remoteReader = remoteSocket.readable.getReader();
    const remoteWriter = remoteSocket.writable.getWriter();

    const clientToRemoteJob = pumpClientToRemote(clientReader, remoteWriter, tcpLogContext);
    const remoteToClientJob = pumpRemoteToClient(remoteReader, webSocket, tcpLogContext);

    // Run both pumps concurrently and wait for their results.
    const [clientToRemoteJobhasData, remoteToClientJobhasData] = await Promise.all([clientToRemoteJob, remoteToClientJob]);
    return clientToRemoteJobhasData && remoteToClientJobhasData ? true : false;
  };

  try {
    // Send the VLESS response header once before the first connection attempt.
    webSocket.send(new Uint8Array([vlessVersion[0], 0]));

    // --- Primary Connection Attempt ---
    const primaryDataReceived = await attemptConnection(address, port);

    if (primaryDataReceived) {
      logger.info(tcpLogContext, 'TCP:PRIMARY_SUCCESS', 'Primary connection finished successfully.');
      return; // Success, we are done.
    }

    // --- Retry Logic ---
    logger.warn(tcpLogContext, 'TCP:RETRY_TRIGGER', 'Primary connection closed without receiving data. Retrying with relay...');

    const [relayAddr, relayPortStr] = config.RELAY_ADDR.split(':');
    const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : port;
    tcpLogContext.remoteAddress = relayAddr;
    tcpLogContext.remotePort = relayPort;

    await attemptConnection(relayAddr, relayPort);
    logger.info(tcpLogContext, 'TCP:RETRY_COMPLETE', 'Relay connection process finished.');
  } catch (error) {
    logger.error(tcpLogContext, 'TCP:FATAL_ERROR', 'A connection attempt failed fatally:', error.stack || error);
  } finally {
    // Final cleanup.
    safeCloseWebSocket(webSocket, tcpLogContext);
  }
}
