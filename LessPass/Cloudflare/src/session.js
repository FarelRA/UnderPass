// session.js
import { createWebSocketTransport } from './transport.js';
import { processVlessHeader, createVlessResponseTransformStream } from './vless.js';
import { TCPHandler, UDPHandler } from './handlers.js';
import { pipeStreams } from './pipe.js';
import { log } from './logs.js';

/**
 * Creates the WebSocket pair, immediately returns the 101 Response,
 * and launches the asynchronous session processing in the background.
 *
 * @param {Request} request The incoming WebSocket upgrade request.
 * @param {object} config The application configuration.
 * @param {object} logContext The logging context.
 * @returns {Response} A WebSocket upgrade response.
 */
export function handleSession(request, config, logContext) {
  const sessionLogContext = { ...logContext, section: 'SESSION' };

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Launch the async processing, but do not await it.
  // This is the "fire-and-forget" pattern. The runtime will keep the
  // worker alive because of the active server socket.
  processSession(server, request, config, sessionLogContext).catch((err) => {
    log.error(sessionLogContext, 'PROCESS_SESSION_UNHANDLED', 'Unhandled error in session processing:', err.stack || err);
    // Attempt to gracefully close the socket on a catastrophic failure.
    if (server.readyState === 1) {
      server.close(1011, 'Internal Server Error');
    }
  });

  // Return the 101 response immediately to complete the handshake.
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Handles the server-side of the WebSocket, running asynchronously.
 * This contains the core VLESS session logic.
 */
async function processSession(server, request, config, sessionLogContext) {
  server.accept();

  // 1. Create a transport from the server-side WebSocket.
  const clientTransport = createWebSocketTransport(server, request, sessionLogContext);
  const clientReader = clientTransport.readable.getReader();

  try {
    // 2. Read the VLESS header from the first data chunk.
    const { done, value: firstChunk } = await clientReader.read();
    if (done || !firstChunk) {
      log.warn(sessionLogContext, 'HEADER', 'Client disconnected before sending header.');
      return; // Exit peacefully
    }

    const { hasError, message, addressRemote, portRemote, rawDataIndex, isUDP, streamVersion } = processVlessHeader(
      firstChunk,
      config.USER_ID
    );

    if (hasError) {
      throw new Error(message);
    }

    sessionLogContext.remoteAddress = addressRemote;
    sessionLogContext.remotePort = portRemote;
    log.info(sessionLogContext, 'CONNECT', `Request to ${isUDP ? 'UDP' : 'TCP'}://${addressRemote}:${portRemote}`);

    // Re-constitute the readable stream with the leftover data from the first chunk.
    const remainingData = firstChunk.slice(rawDataIndex);
    const reconstitutedReadable = new ReadableStream({
      start(controller) {
        if (remainingData.byteLength > 0) {
          controller.enqueue(remainingData);
        }
        clientReader.releaseLock();
        clientTransport.readable
          .pipeTo(
            new WritableStream({
              write: (chunk) => controller.enqueue(chunk),
              close: () => controller.close(),
              abort: (reason) => controller.error(reason),
            })
          )
          .catch((err) => {
            log.error(sessionLogContext, 'PIPE_RECONSTITUTE', 'Error piping leftover stream', err);
            controller.error(err);
          });
      },
    });
    clientTransport.readable = reconstitutedReadable;

    // 3. Select the appropriate handler (Actor) based on the protocol.
    const handler = isUDP ? new UDPHandler(config, sessionLogContext) : new TCPHandler(config, sessionLogContext);

    // 4. Instruct the handler to establish the remote connection.
    const remoteTransport = await handler.connect({
      hostname: addressRemote,
      port: portRemote,
    });

    // Add VLESS response header to the remote's readable stream
    const vlessResponseStream = createVlessResponseTransformStream(streamVersion, sessionLogContext);
    remoteTransport.readable = remoteTransport.readable.pipeThrough(vlessResponseStream);

    // 5. Symmetrically pipe the client and remote transports together.
    log.info(sessionLogContext, 'PIPE', 'Establishing bidirectional pipe.');
    pipeStreams(clientTransport, remoteTransport, sessionLogContext);
  } catch (err) {
    log.error(sessionLogContext, 'ERROR', 'Session failed:', err.stack || err);
    // Ensure the WebSocket is closed on error.
    if (server.readyState === 1) server.close(1011, err.message);
  }
}
