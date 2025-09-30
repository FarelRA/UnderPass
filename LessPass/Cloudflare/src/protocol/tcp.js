// = a/protocols/tcp.js
import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';
import { safeCloseWebSocket, WS_READY_STATE } from '../lib/utils.js';
import { config } from '../lib/config.js';

/**
 * Pipes data from a remote socket to the client WebSocket.
 * It also monitors if any data was actually received.
 *
 * @param {Socket} remoteSocket - The remote TCP socket to read from.
 * @param {WebSocket} webSocket - The client WebSocket to write to.
 * @param {object} logContext - Logging context.
 * @returns {Promise<boolean>} A promise that resolves to `true` if data was received, `false` otherwise.
 */
async function pipeRemoteToClient(remoteSocket, webSocket, logContext) {
  let hasReceivedData = false;

  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        start() {
          logger.debug(
            logContext,
            'TCP:PIPE_REMOTE_CLIENT',
            `Starting pipe from ${logContext.remoteAddress}:${logContext.remotePort} to client.`
          );
        },
        write(chunk) {
          if (!hasReceivedData) {
            hasReceivedData = true;
            logger.debug(logContext, 'TCP:PIPE_REMOTE_CLIENT', 'First chunk of data received from remote.');
          }
          if (webSocket.readyState === WS_READY_STATE.OPEN) {
            webSocket.send(chunk);
          }
        },
        close() {
          logger.info(logContext, 'TCP:PIPE_REMOTE_CLIENT', `Remote socket readable stream closed. Data received: ${hasReceivedData}`);
        },
        abort(reason) {
          logger.warn(logContext, 'TCP:PIPE_REMOTE_CLIENT', 'Remote socket readable stream aborted:', reason);
        },
      })
    )
    .catch((error) => {
      logger.error(logContext, 'TCP:PIPE_REMOTE_CLIENT_ERROR', 'Error piping remote to client:', error);
    });

  return hasReceivedData;
}

/**
 * Pipes data from the client's stream to the currently active remote socket.
 * The destination socket can be changed externally via the `remoteSocketWrapper`.
 *
 * @param {ReadableStream} clientStream - The stream of data from the client.
 * @param {{ value: Socket | null }} remoteSocketWrapper - A mutable wrapper for the destination socket.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {object} logContext - Logging context.
 */
async function pipeClientToRemote(clientStream, remoteSocketWrapper, webSocket, logContext) {
  await clientStream
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (remoteSocketWrapper.value) {
            try {
              const writer = remoteSocketWrapper.value.writable.getWriter();
              await writer.write(chunk);
              writer.releaseLock();
            } catch (error) {
              logger.error(logContext, 'TCP:PIPE_CLIENT_REMOTE_ERROR', 'Error writing to remote socket:', error);
              // If writing fails, it's a fatal error for this connection.
              safeCloseWebSocket(webSocket, logContext);
            }
          } else {
            logger.warn(logContext, 'TCP:PIPE_CLIENT_REMOTE', 'No remote socket available to write to. Dropping chunk.');
          }
        },
        close() {
          logger.info(logContext, 'TCP:PIPE_CLIENT_REMOTE', 'Client stream closed.');
        },
        abort(reason) {
          logger.warn(logContext, 'TCP:PIPE_CLIENT_REMOTE_ABORT', 'Client stream aborted:', reason);
        },
      })
    )
    .catch((error) => {
      logger.error(logContext, 'TCP:PIPE_CLIENT_REMOTE_ERROR', 'Error piping client to remote:', error);
    });
}

/**
 * The main handler for TCP proxying. It implements the custom "retry on no data" logic.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {ReadableStream} consumableStream - The client data stream.
 * @param {string} address - Destination address.
 * @param {number} port - Destination port.
 * @param {Uint8Array} vlessVersion - The VLESS version bytes.
 * @param {object} logContext - Logging context.
 */
export async function handleTcpProxy(webSocket, consumableStream, address, port, vlessVersion, logContext) {
  const tcpLogContext = { ...logContext, section: 'TCP_PROXY' };
  const remoteSocketWrapper = { value: null };

  // This pipe runs in the background for the entire lifetime of the client connection.
  // It will write to whichever socket is currently in `remoteSocketWrapper`.
  pipeClientToRemote(consumableStream, remoteSocketWrapper, webSocket, tcpLogContext);

  try {
    // --- Primary Connection Attempt ---
    logger.info(tcpLogContext, 'TCP:PRIMARY_ATTEMPT', `Connecting to primary destination: ${address}:${port}`);
    const primarySocket = await connect({ hostname: address, port });
    remoteSocketWrapper.value = primarySocket;

    // Send the VLESS response header as soon as the first connection is established.
    const responseHeader = new Uint8Array([vlessVersion[0], 0]);
    if (webSocket.readyState === WS_READY_STATE.OPEN) {
      webSocket.send(responseHeader);
    }

    const primaryDataReceived = await pipeRemoteToClient(primarySocket, webSocket, tcpLogContext);

    // If we received data, the connection is successful. We're done with the logic.
    // The background pipes will continue to do their work.
    if (primaryDataReceived) {
      logger.info(tcpLogContext, 'TCP:PRIMARY_SUCCESS', 'Connection to primary destination successful.');
      return;
    }

    // --- Retry Logic ---
    // If the primary connection closed without sending any data, we proceed to retry.
    logger.warn(tcpLogContext, 'TCP:RETRY_TRIGGER', 'Primary connection closed without receiving data. Retrying with relay...');

    const [relayAddr, relayPortStr] = config.RELAY_ADDR.split(':');
    const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : port;
    tcpLogContext.remoteAddress = relayAddr; // Update log context for the new destination
    tcpLogContext.remotePort = relayPort;

    logger.info(tcpLogContext, 'TCP:RETRY_ATTEMPT', `Connecting to relay destination: ${relayAddr}:${relayPort}`);
    const relaySocket = await connect({ hostname: relayAddr, port: relayPort });
    remoteSocketWrapper.value = relaySocket; // Switch the active socket

    // Start a new pipe for the relay socket. The client-to-remote pipe will now send to this new socket.
    await pipeRemoteToClient(relaySocket, webSocket, tcpLogContext);

    logger.info(tcpLogContext, 'TCP:RETRY_COMPLETE', 'Relay connection process finished.');
  } catch (error) {
    logger.error(tcpLogContext, 'TCP:FATAL_ERROR', 'A connection attempt failed fatally:', error.stack || error);
    safeCloseWebSocket(webSocket, tcpLogContext);
  }
}
