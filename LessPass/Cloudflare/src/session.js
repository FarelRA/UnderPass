// session.js
import { createClientTransport } from './transport.js';
import { processVlessHeader, createVlessResponseTransformStream } from './vless.js';
import { TCPHandler, UDPHandler } from './handlers.js';
import { pipeStreams } from './pipe.js';
import { log } from './logs.js';

/**
 * Handles the entire VLESS session from WebSocket upgrade to termination.
 * This is the main orchestrator.
 * @param {Request} request The incoming WebSocket upgrade request.
 * @param {object} config The application configuration.
 * @param {object} logContext The logging context.
 * @returns {Promise<Response>} A WebSocket response to complete the upgrade.
 */
export async function handleSession(request, config, logContext) {
  const sessionLogContext = { ...logContext, section: 'SESSION' };

  // 1. Create a transport from the client's WebSocket connection.
  const { client, transport: clientTransport } = createClientTransport(request, sessionLogContext);
  const clientReader = clientTransport.readable.getReader();

  try {
    // 2. Read the VLESS header from the first data chunk.
    const { done, value: firstChunk } = await clientReader.read();
    if (done || !firstChunk) {
      log.warn(sessionLogContext, 'HEADER', 'Client disconnected before sending header.');
      return new Response(null, { status: 101, webSocket: client }); // Still need to complete WS upgrade
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
          .catch((err) => controller.error(err));
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
    // Ensure the WebSocket is closed on error.
    log.error(sessionLogContext, 'ERROR', 'Session failed:', err.stack || err);
    if (client.readyState === 1) client.close(1011, err.message);
  }

  // Complete the WebSocket upgrade.
  return new Response(null, { status: 101, webSocket: client });
}
