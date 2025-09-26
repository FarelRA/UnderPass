// conduit.js
import { connect } from 'cloudflare:sockets';
import { processStreamHeader, safeCloseWebSocket, makeReadableWebSocketStream } from './utils.js';
import { WS_READY_STATE_OPEN } from './configs.js';
import { log } from './logs.js';

/**
 * Handles inbound WebSocket requests, establishes a connection, and processes
 * protocol headers. It manages both TCP and UDP DNS connections.
 *
 * @param {Request} request - The incoming WebSocket request.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The base logging context.
 * @returns {Promise<Response>} A WebSocket response.
 */
export async function handleConduitRequest(request, config, logContext) {
  // Add "CONDUIT" section to the log context.
  const conduitLogContext = { ...logContext, section: 'CONDUIT' };

  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);

  webSocket.accept();

  // Extract the early data header (Sec-WebSocket-Protocol).
  const earlyDataHeader = request.headers.get('Sec-Websocket-Protocol') || '';

  // Create a readable stream from the WebSocket.
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, conduitLogContext);

  // Wrapper for the remote socket (for TCP connections).
  let remoteSocketWrapper = { value: null };
  // Function to write to the UDP DNS stream (for DNS).
  let udpStreamWrite = null;
  // Flag to indicate if this is a UDP DNS connection.
  let isDns = false;

  // Pipe the WebSocket stream to a WritableStream. This stream processes
  // incoming data and directs it to either a TCP or UDP connection.
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (isDns && udpStreamWrite) {
            // If it's DNS and we have a UDP stream writer, write to it.
            log.debug(conduitLogContext, 'WRITE', 'Writing to UDP DNS stream.');
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWrapper.value) {
            // If we have a TCP socket, write to it.
            const writer = remoteSocketWrapper.value.writable.getWriter();
            try {
              log.debug(conduitLogContext, 'WRITE', 'Writing to remote TCP socket.');
              await writer.write(chunk);
            } finally {
              writer.releaseLock(); // Always release the lock.
            }
            return;
          }

          // If neither of the above, we're processing the initial stream header.
          const {
            hasError,
            message,
            portRemote = 443, // Default to port 443.
            addressRemote = '', // Default to an empty address.
            rawDataIndex,
            streamVersion = new Uint8Array([0, 0]), // Default stream version.
            isUDP,
          } = processStreamHeader(chunk, config.USER_ID);

          // Update log context with remote address and port.
          conduitLogContext.remoteAddress = addressRemote;
          conduitLogContext.remotePort = portRemote;
          log.info(
            conduitLogContext,
            'PROCESS',
            `Stream header processed. Remote: ${isUDP ? 'UDP' : 'TCP'}://${addressRemote}:${portRemote}`
          );

          if (hasError) {
            // Log the error and throw an exception to close the connection.
            log.error(conduitLogContext, 'ERROR', 'Error processing stream header:', message);
            throw new Error(message); // This will terminate the stream.
          }

          // Validate UDP requests: Only port 53 (DNS) is allowed.
          if (isUDP && portRemote !== 53) {
            log.warn(conduitLogContext, 'WARN', 'UDP requested for non-DNS port. Dropping connection.');
            throw new Error('UDP transport is only enabled for DNS (port 53).');
          }

          // Prepare the stream response header (version and a zero byte).
          const streamResponseHeader = new Uint8Array([streamVersion[0], 0]);
          // Extract the raw client data after the stream header.
          const rawClientData = chunk.slice(rawDataIndex);

          if (isUDP && portRemote === 53) {
            // Handle UDP DNS requests.
            isDns = true;
            log.info(conduitLogContext, 'UDP', 'Handling UDP DNS request.');
            const { write } = await handleUDPOutBound(webSocket, streamResponseHeader, config, { ...conduitLogContext });
            udpStreamWrite = write; // Store the write function for later use.
            udpStreamWrite(rawClientData); // Write the initial DNS query data.
            return;
          }

          // Handle TCP requests.
          log.info(conduitLogContext, 'TCP', 'Handling TCP request.');
          handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, streamResponseHeader, config, {
            ...conduitLogContext,
          });
        },
        close() {
          log.info(conduitLogContext, 'CLOSE', 'Client WebSocket stream closed.');
          safeCloseWebSocket(webSocket, conduitLogContext);
        },
        abort(reason) {
          log.warn(conduitLogContext, 'ABORT', 'Client WebSocket stream aborted:', reason);
          safeCloseWebSocket(webSocket, conduitLogContext);
        },
      })
    )
    .catch((err) => {
      log.error(conduitLogContext, 'ERROR', 'Error in readableWebSocketStream pipeTo:', err.stack || err);
      safeCloseWebSocket(webSocket, conduitLogContext); // Close the WebSocket on error.
    });

  // Return a WebSocket response to upgrade the connection.
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Handles outbound TCP connections. It establishes the connection, writes
 * the initial data, and sets up retries if necessary.
 *
 * @param {object} remoteSocketWrapper - A wrapper for the remote TCP socket.
 * @param {string} addressRemote - The remote address to connect to.
 * @param {number} portRemote - The remote port to connect to.
 * @param {Uint8Array} rawClientData - The initial data to send.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} streamResponseHeader - The stream protocol response header.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<void>}
 */
async function handleTCPOutBound(
  remoteSocketWrapper,
  addressRemote,
  portRemote,
  rawClientData,
  webSocket,
  streamResponseHeader,
  config,
  logContext
) {
  const tcpLogContext = { ...logContext, section: 'CONDUIT:TCP' };

  /**
   * Connects to the specified address and port, and writes the initial data.
   * Updates the `remoteSocketWrapper` with the new socket.
   */
  async function connectAndWrite(address, port) {
    try {
      const tcpSocket = connect({ hostname: address, port: port });
      remoteSocketWrapper.value = tcpSocket; // Store the socket.
      log.info(tcpLogContext, 'CONNECT', `Connecting to ${address}:${port}`);
      const writer = tcpSocket.writable.getWriter();
      await writer.write(rawClientData); // Write the initial client data.
      log.debug(tcpLogContext, 'WRITE', 'Initial data written to remote socket.');
      writer.releaseLock(); // Release the lock on the writer.
      return tcpSocket;
    } catch (error) {
      log.error(tcpLogContext, 'ERROR', `Error connecting to ${address}:${port}:`, error);
      throw error; // Re-throw the error to be handled by the caller.
    }
  }

  /**
   * Retries the connection using the relay address, if configured.
   */
  async function retry() {
    log.info(tcpLogContext, 'TCP:RETRY', `Retrying connection with ${config.RELAY_ADDR}...`);

    // Parse RELAY_ADDR to get hostname and port
    const [relayHostname, relayPortStr] = config.RELAY_ADDR.split(':');
    const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : portRemote;
    const tcpSocket = await connectAndWrite(relayHostname, relayPort);

    // Handle the retry socket's close event.
    tcpSocket.closed
      .catch((error) => {
        log.error(tcpLogContext, 'TCP:ERROR', 'Retry connection failed:', error);
      })
      .finally(() => {
        safeCloseWebSocket(webSocket, tcpLogContext); // Close WebSocket on failure.
      });

    // Pipe the retry socket to the WebSocket.
    remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, null, { ...tcpLogContext });
  }

  // Attempt the initial connection.
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);

  // When the remote socket is ready, pipe it to the WebSocket.
  remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, retry, { ...tcpLogContext });
}

/**
 * Pipes data from the remote socket to the WebSocket. Handles sending the
 * stream response header and retries if no data is received.
 *
 * @param {object} remoteSocket - The remote TCP socket.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} streamResponseHeader - The stream protocol response header.
 * @param {Function | null} retry - The retry function (if applicable).
 * @param {object} logContext - The logging context.
 * @returns {Promise<void>}
 */
async function remoteSocketToWS(remoteSocket, webSocket, streamResponseHeader, retry, logContext) {
  const wsLogContext = { ...logContext, section: 'CONDUIT:WS' };
  let streamHeaderSent = false; // Flag to track if the stream header has been sent.
  let hasIncomingData = false; // Flag to track if any data was received.

  // Pipe the remote socket's readable stream to a WritableStream.
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          hasIncomingData = true;
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            if (!streamHeaderSent) {
              // Send stream response header + initial chunk.
              webSocket.send(await new Blob([streamResponseHeader, chunk]).arrayBuffer());
              streamHeaderSent = true;
              log.debug(wsLogContext, 'WRITE', 'Stream response header sent.');
            } else {
              // Send subsequent chunks.
              webSocket.send(chunk);
            }
            log.debug(wsLogContext, 'WRITE', 'Data sent to client via WebSocket.');
          } else {
            // Log an error if the WebSocket is not open.
            log.error(wsLogContext, 'ERROR', 'WebSocket is not open. Ready state:', webSocket.readyState);
          }
        },
        close() {
          log.info(wsLogContext, 'CLOSE', `Remote socket readable stream closed. hasIncomingData: ${hasIncomingData}`);
          // We doesn't need to close the websocket first,
          // for some case it will casue a HTTP ERR_CONTENT_LENGTH_MISMATCH issue,
          // client will send close event anyway.
          //safeCloseWebSocket(webSocket, wsLogContext);
        },
        abort(reason) {
          log.error(wsLogContext, 'ABORT', 'Remote socket readable stream aborted:', reason);
          // We won't need to close the websocket, we still want to try retry.
        },
      })
    )
    .catch((error) => {
      log.error(wsLogContext, 'ERROR', 'Error piping remote socket to WebSocket:', error);
      safeCloseWebSocket(webSocket, wsLogContext); // Close the WebSocket on error.
    });

  // If no data was received and a retry function is provided, attempt to retry.
  if (!hasIncomingData && retry) {
    log.warn(wsLogContext, 'RETRY', 'No incoming data from remote. Retrying...');
    retry();
  }
}

/**
 * Handles outbound UDP connections (specifically for DNS over HTTPS). It
 * receives UDP packets, forwards them to a DoH endpoint, and sends the responses
 * back to the client over the WebSocket.
 *
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} streamResponseHeader - The stream protocol response header.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<{ write: (chunk: Uint8Array) => void }>} An object with a `write` function to send data.
 */
async function handleUDPOutBound(webSocket, streamResponseHeader, config, logContext) {
  const udpLogContext = { ...logContext, section: 'CONDUIT' };
  let isStreamHeaderSent = false; // Tracks if stream header has been sent.

  // Create a TransformStream to process concatenated UDP packets.
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      log.debug(udpLogContext, 'UDP:TRANSFORM', 'Transforming UDP chunk.');
      // Iterate through the chunk to extract individual UDP packets.
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
        index = index + 2 + udpPakcetLength;
        // Enqueue each extracted UDP packet.
        controller.enqueue(udpData);
      }
    },
  });

  // Pipe the transformed UDP packets to a WritableStream.
  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          try {
            log.debug(udpLogContext, 'UDP:DOH', 'Sending DNS query via DoH.');
            // Send the DNS query to the configured DoH endpoint.
            const resp = await fetch(config.DOH_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: chunk,
            });

            if (!resp.ok) {
              log.error(udpLogContext, 'UDP:DOH:ERROR', `DoH request failed with status: ${resp.status}`);
              return;
            }

            // Process the DNS response from the DoH server.
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            // Prepare the size prefix for the UDP response.
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

            if (webSocket.readyState === WS_READY_STATE_OPEN) {
              log.info(udpLogContext, 'UDP:DOH:SUCCESS', `DoH query successful. DNS message length: ${udpSize}`);
              // Construct the data to send back to the client (prefixing with size).
              const dataToSend = isStreamHeaderSent
                ? new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer()
                : new Blob([streamResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer();

              // Send the response over the WebSocket.
              webSocket.send(await dataToSend);
              isStreamHeaderSent = true; // Mark stream header as sent.
            }
          } catch (error) {
            log.error(udpLogContext, 'UDP:ERROR', 'Error in DoH request:', error);
          }
        },
      })
    )
    .catch((error) => {
      log.error(udpLogContext, 'UDP:ERROR', 'Error piping UDP data to DoH endpoint:', error);
    });

  // Return an object with a `write` function to allow sending data to the transform stream.
  const writer = transformStream.writable.getWriter();
  return {
    write: (chunk) => {
      log.debug(udpLogContext, 'UDP:WRITE', 'Writing chunk to UDP transform stream.');
      writer.write(chunk);
    },
  };
}
