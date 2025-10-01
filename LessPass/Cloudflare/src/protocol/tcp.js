// =================================================================
// File: protocol/tcp.js
// Description: The TCP Actor. Handles proxying TCP connections.
// =================================================================

import { connect } from 'cloudflare:sockets';
import { logger } from '../lib/logger.js';
import { safeCloseWebSocket, WS_READY_STATE } from '../lib/utils.js';
import { config } from '../lib/config.js';

/**
 * The main handler for TCP proxying. Implements the "retry on no data" logic in a race-free and robust way.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {ReadableStream} consumableStream - The client data stream.
 * @param {string} address - Destination address.
 * @param {number} port - Destination port.
 * @param {Uint8Array} vlessVersion - The VLESS version bytes.
 * @param {object} logContext - Logging context.
 */
export async function handleTcpProxy(webSocket, consumableStream, address, port, vlessVersion, logContext) {
  const tcpLogContext = { ...logContext, section: 'TCP_PROXY' };

  let remoteSocket;
  let hasReceivedData = false;

  // A controller for the client-to-remote pipe.
  // We won't start this pipe until we have a socket.
  const clientWriterController = {
    writer: null,
    acquire(socket) {
      this.writer = socket.writable.getWriter();
    },
    release() {
      if (this.writer) {
        this.writer.releaseLock();
        this.writer = null;
      }
    },
    async write(chunk) {
      if (this.writer) {
        await this.writer.write(chunk);
      } else {
        // This case should not happen with the new logic.
        logger.warn(tcpLogContext, 'TCP:CLIENT_PIPE', 'No active writer, dropping chunk.');
      }
    },
  };

  // Start the client->remote pump in the background. It will wait for a writer to be acquired.
  const clientToRemoteJob = consumableStream
    .pipeTo(
      new WritableStream({
        write: (chunk) => clientWriterController.write(chunk),
        close: () => clientWriterController.release(),
      })
    )
    .catch((error) => {
      // Ignore errors here; they are handled by the main connection logic.
    });

  try {
    // --- Primary Connection Attempt ---
    logger.info(tcpLogContext, 'TCP:PRIMARY_ATTEMPT', `Connecting to primary destination: ${address}:${port}`);
    remoteSocket = await connect({ hostname: address, port });
    clientWriterController.acquire(remoteSocket);

    // Send the VLESS response header now that we have a live socket.
    webSocket.send(new Uint8Array([vlessVersion[0], 0]));

    // Start the remote->client pipe and monitor if data is received.
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          hasReceivedData = true;
          if (webSocket.readyState === WS_READY_STATE.OPEN) webSocket.send(chunk);
        },
      })
    );

    // If we reach here, the primary remote closed the connection.
    // Check if we ever received data.
    if (hasReceivedData) {
      logger.info(tcpLogContext, 'TCP:PRIMARY_SUCCESS', 'Primary connection finished successfully.');
      return; // Success, we are done.
    }

    // --- Retry Logic ---
    logger.warn(tcpLogContext, 'TCP:RETRY_TRIGGER', 'Primary connection closed without receiving data. Retrying with relay...');
    clientWriterController.release(); // Release the lock on the closed/failed socket.

    const [relayAddr, relayPortStr] = config.RELAY_ADDR.split(':');
    const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : port;
    tcpLogContext.remoteAddress = relayAddr;
    tcpLogContext.remotePort = relayPort;

    logger.info(tcpLogContext, 'TCP:RETRY_ATTEMPT', `Connecting to relay destination: ${relayAddr}:${relayPort}`);
    remoteSocket = await connect({ hostname: relayAddr, port: relayPort });
    clientWriterController.acquire(remoteSocket); // Acquire the new writer. The background pipe will now use this one.

    // Start the remote->client pipe for the relay connection.
    await remoteSocket.readable.pipeTo(
      new WritableStream({
        write(chunk) {
          if (webSocket.readyState === WS_READY_STATE.OPEN) webSocket.send(chunk);
        },
      })
    );

    logger.info(tcpLogContext, 'TCP:RETRY_COMPLETE', 'Relay connection process finished.');
  } catch (error) {
    logger.error(tcpLogContext, 'TCP:FATAL_ERROR', 'A connection attempt failed fatally:', error.stack || error);
  } finally {
    // Final cleanup.
    safeCloseWebSocket(webSocket, tcpLogContext);
    clientWriterController.release();
    if (remoteSocket) {
      try {
        await remoteSocket.close();
      } catch (e) {}
    }
  }
}
