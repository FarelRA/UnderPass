// tunnel.js
import { connect } from 'cloudflare:sockets';
import { processVlessHeader, safeCloseWebSocket, makeReadableWebSocketStream } from './utils.js';
import { WS_READY_STATE_OPEN } from './configs.js';
import { log } from './logs.js';

/**
 * Handles inbound WebSocket requests, establishes a tunnel, and processes
 * VLESS protocol headers. It manages both TCP and UDP DNS connections.
 *
 * @param {Request} request - The incoming WebSocket request.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The base logging context.
 * @returns {Promise<Response>} A WebSocket response.
 */
export async function handleTunnelRequest(request, config, logContext) {
    // Add "TUNNEL" section to the log context.
    const tunnelLogContext = {...logContext, section: 'TUNNEL' };

    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);

    webSocket.accept();

    // Extract the early data header (Sec-WebSocket-Protocol).
    const earlyDataHeader = request.headers.get('Sec-Websocket-Protocol') || '';

    // Create a readable stream from the WebSocket.
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, tunnelLogContext);

    // Wrapper for the remote socket (for TCP connections).
    let remoteSocketWrapper = { value: null };
    // Function to write to the UDP DNS stream (for DNS).
    let udpStreamWrite = null;
    // Flag to indicate if this is a UDP DNS connection.
    let isDns = false;

    // Pipe the WebSocket stream to a WritableStream. This stream processes
    // incoming data and directs it to either a TCP or UDP connection.
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) {
                // If it's DNS and we have a UDP stream writer, write to it.
                log.debug(tunnelLogContext, "WRITE", "Writing to UDP DNS stream.");
                return udpStreamWrite(chunk);
            }
            if (remoteSocketWrapper.value) {
                // If we have a TCP socket, write to it.
                const writer = remoteSocketWrapper.value.writable.getWriter();
                try {
                    log.debug(tunnelLogContext, "WRITE", "Writing to remote TCP socket.");
                    await writer.write(chunk);
                } finally {
                    writer.releaseLock(); // Always release the lock.
                }
                return;
            }

            // If neither of the above, we're processing the initial VLESS header.
            const {
                hasError,
                message,
                portRemote = 443,      // Default to port 443.
                addressRemote = '',    // Default to an empty address.
                rawDataIndex,
                vlessVersion = new Uint8Array([0, 0]), // Default VLESS version.
                isUDP,
            } = processVlessHeader(chunk, config.USER_ID);

            // Update log context with remote address and port.
            tunnelLogContext.remoteAddress = addressRemote;
            tunnelLogContext.remotePort = portRemote;
            log.info(tunnelLogContext, "PROCESS", `VLESS header processed. Remote: ${isUDP ? "UDP" : "TCP"}://${addressRemote}:${portRemote}`);

            if (hasError) {
                // Log the error and throw an exception to close the connection.
                log.error(tunnelLogContext, "ERROR", "Error processing VLESS header:", message);
                throw new Error(message); // This will terminate the stream.
            }

            // Validate UDP requests: Only port 53 (DNS) is allowed.
            if (isUDP && portRemote!== 53) {
                log.warn(tunnelLogContext, "WARN", "UDP requested for non-DNS port. Dropping connection.");
                throw new Error('UDP proxy is only enabled for DNS (port 53).');
            }

            // Prepare the VLESS response header (version and a zero byte).
            const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
            // Extract the raw client data after the VLESS header.
            const rawClientData = chunk.slice(rawDataIndex);

            if (isUDP && portRemote === 53) {
                // Handle UDP DNS requests.
                isDns = true;
                log.info(tunnelLogContext, "UDP", "Handling UDP DNS request.");
                const { write } = await handleUDPOutBound(webSocket, vlessResponseHeader, config, {...tunnelLogContext });
                udpStreamWrite = write; // Store the write function for later use.
                udpStreamWrite(rawClientData); // Write the initial DNS query data.
                return;
            }

            // Handle TCP requests.
            log.info(tunnelLogContext, "TCP", "Handling TCP request.");
            handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, config, {...tunnelLogContext });
        },
        close() {
            log.info(tunnelLogContext, "CLOSE", "Client WebSocket stream closed.");
            safeCloseWebSocket(webSocket, tunnelLogContext);
        },
        abort(reason) {
            log.warn(tunnelLogContext, "ABORT", "Client WebSocket stream aborted:", reason);
            safeCloseWebSocket(webSocket, tunnelLogContext);
        },
    })).catch((err) => {
        log.error(tunnelLogContext, "ERROR", "Error in readableWebSocketStream pipeTo:", err);
        safeCloseWebSocket(webSocket, tunnelLogContext); // Close the WebSocket on error.
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
 * @param {Uint8Array} vlessResponseHeader - The VLESS response header.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<void>}
 */
async function handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, config, logContext) {
    const tcpLogContext = {...logContext, section: 'TUNNEL:TCP' };

    /**
     * Connects to the specified address and port, and writes the initial data.
     * Updates the `remoteSocketWrapper` with the new socket.
     */
    async function connectAndWrite(address, port) {
        try {
            const tcpSocket = connect({ hostname: address, port: port });
            remoteSocketWrapper.value = tcpSocket; // Store the socket.
            log.info(tcpLogContext, "CONNECT", `Connecting to ${address}:${port}`);
            const writer = tcpSocket.writable.getWriter();
            await writer.write(rawClientData); // Write the initial client data.
            log.debug(tcpLogContext, "WRITE", "Initial data written to remote socket.");
            writer.releaseLock(); // Release the lock on the writer.
            return tcpSocket;
        } catch (error) {
            log.error(tcpLogContext, "ERROR", `Error connecting to ${address}:${port}:`, error);
            throw error; // Re-throw the error to be handled by the caller.
        }
    }

    /**
     * Retries the connection using the proxy address, if configured.
     */
    async function retry() {
        log.info(tcpLogContext, "TCP:RETRY", `Retrying connection with ${config.PROXY_ADDR}...`);

        // Parse PROXY_ADDR to get hostname and port
        const [proxyHostname, proxyPortStr] = config.PROXY_ADDR.split(':');
        const proxyPort = proxyPortStr ? parseInt(proxyPortStr, 10) : portRemote;
        const tcpSocket = await connectAndWrite(proxyHostname, proxyPort);

        // Handle the retry socket's close event.
        tcpSocket.closed.catch(error => {
            log.error(tcpLogContext, "TCP:ERROR", "Retry connection failed:", error);
        }).finally(() => {
            safeCloseWebSocket(webSocket, tcpLogContext); // Close WebSocket on failure.
        });

        // Pipe the retry socket to the WebSocket.
        remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, { ...tcpLogContext });
    }

    // Attempt the initial connection.
    const tcpSocket = await connectAndWrite(addressRemote, portRemote);

    // When the remote socket is ready, pipe it to the WebSocket.
    remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, {...tcpLogContext });
}

/**
 * Pipes data from the remote socket to the WebSocket. Handles sending the
 * VLESS response header and retries if no data is received.
 *
 * @param {object} remoteSocket - The remote TCP socket.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} vlessResponseHeader - The VLESS response header.
 * @param {Function | null} retry - The retry function (if applicable).
 * @param {object} logContext - The logging context.
 * @returns {Promise<void>}
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, logContext) {
    const wsLogContext = {...logContext, section: 'TUNNEL:WS' };
    let vlessHeaderSent = false; // Flag to track if the VLESS header has been sent.
    let hasIncomingData = false; // Flag to track if any data was received.

    // Pipe the remote socket's readable stream to a WritableStream.
    await remoteSocket.readable
      .pipeTo(
            new WritableStream({
                async write(chunk) {
                    hasIncomingData = true;
                    if (webSocket.readyState === WS_READY_STATE_OPEN) {
                        if (!vlessHeaderSent) {
                            // Send VLESS response header + initial chunk.
                            webSocket.send(await new Blob([vlessResponseHeader, chunk]).arrayBuffer());
                            vlessHeaderSent = true;
                            log.debug(wsLogContext, "WRITE", "VLESS response header sent.");
                        } else {
                            // Send subsequent chunks.
                            webSocket.send(chunk);
                        }
                        log.debug(wsLogContext, "WRITE", "Data sent to client via WebSocket.");
                    } else {
                        // Log an error if the WebSocket is not open.
                        log.error(wsLogContext, "ERROR", 'WebSocket is not open. Ready state:', webSocket.readyState);
                    }
                },
                close() {
                    log.info(wsLogContext, "CLOSE", `Remote socket readable stream closed. hasIncomingData: ${hasIncomingData}`);
                    // We doesn't need to close the websocket first,
                    // for some case it will casue a HTTP ERR_CONTENT_LENGTH_MISMATCH issue,
                    // client will send close event anyway.
                    //safeCloseWebSocket(webSocket, wsLogContext);
                },
                abort(reason) {
                    log.error(wsLogContext, "ABORT", "Remote socket readable stream aborted:", reason);
                    // We won't need to close the websocket, we still want to try retry.
                },
            })
        )
      .catch((error) => {
            log.error(wsLogContext, "ERROR", "Error piping remote socket to WebSocket:", error);
            safeCloseWebSocket(webSocket, wsLogContext); // Close the WebSocket on error.
        });

    // If no data was received and a retry function is provided, attempt to retry.
    if (!hasIncomingData && retry) {
        log.warn(wsLogContext, "RETRY", "No incoming data from remote. Retrying...");
        retry();
    }
}

/**
 * Handles outbound UDP connections (specifically for DNS over HTTPS). It
 * receives UDP packets, forwards them to a DoH endpoint, and sends the responses
 * back to the client over the WebSocket.
 *
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} vlessResponseHeader - The VLESS response header.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The logging context.
 * @returns {Promise<{ write: (chunk: Uint8Array) => void }>} An object with a `write` function to send data.
 */
async function handleUDPOutBound(webSocket, vlessResponseHeader, config, logContext) {
    const udpLogContext = { ...logContext, section: 'TUNNEL' };
    let isVlessHeaderSent = false; // Tracks if VLESS header has been sent.

    // Create a TransformStream to process concatenated UDP packets.
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            log.debug(udpLogContext, "UDP:TRANSFORM", "Transforming UDP chunk.");
            // Iterate through the chunk to extract individual UDP packets.
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index = index + 2 + udpPakcetLength;
                // Enqueue each extracted UDP packet.
                controller.enqueue(udpData);
            }
        }
    });

    // Pipe the transformed UDP packets to a WritableStream.
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            try {
                log.debug(udpLogContext, "UDP:DOH", "Sending DNS query via DoH.");
                // Send the DNS query to the configured DoH endpoint.
                const resp = await fetch(config.DOH_URL, {
                    method: 'POST',
                    headers: { 'content-type': 'application/dns-message' },
                    body: chunk,
                });

                if (!resp.ok) {
                    log.error(udpLogContext, "UDP:DOH:ERROR", `DoH request failed with status: ${resp.status}`);
                    return;
                }

                // Process the DNS response from the DoH server.
                const dnsQueryResult = await resp.arrayBuffer();
                const udpSize = dnsQueryResult.byteLength;
                // Prepare the size prefix for the UDP response.
                const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

                if (webSocket.readyState === WS_READY_STATE_OPEN) {
                    log.info(udpLogContext, "UDP:DOH:SUCCESS", `DoH query successful. DNS message length: ${udpSize}`);
                    // Construct the data to send back to the client (prefixing with size).
                    const dataToSend = isVlessHeaderSent
                        ? new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer()
                        : new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer();

                    // Send the response over the WebSocket.
                    webSocket.send(await dataToSend);
                    isVlessHeaderSent = true; // Mark VLESS header as sent.
                }
            } catch (error) {
                log.error(udpLogContext, "UDP:ERROR", "Error in DoH request:", error);
            }
        }
    })).catch((error) => {
        log.error(udpLogContext, "UDP:ERROR", "Error piping UDP data to DoH endpoint:", error);
    });

    // Return an object with a `write` function to allow sending data to the transform stream.
    const writer = transformStream.writable.getWriter();
    return { write: (chunk) => { log.debug(udpLogContext, "UDP:WRITE", "Writing chunk to UDP transform stream."); writer.write(chunk); } };
}
