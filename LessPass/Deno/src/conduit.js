// conduit.js
import { processStreamHeader, safeCloseWebSocket, makeReadableWebSocketStream } from './utils.js';
import { WS_READY_STATE_OPEN } from './configs.js';
import { log } from './logs.js';

/**
 * Handles the WebSocket connection and VLESS protocol logic.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Request} request - The initial upgrade request.
 * @param {object} config - The application configuration.
 * @param {object} logContext - The logging context.
 */
export async function handleConduitRequest(webSocket, request, config, logContext) {
    const conduitLogContext = { ...logContext, section: 'CONDUIT' };
    const earlyDataHeader = request.headers.get('Sec-Websocket-Protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, conduitLogContext);

    let remoteSocket = null;
    let udpStreamWrite = null;
    let isDns = false;

    readableWebSocketStream
        .pipeTo(
            new WritableStream({
                async write(chunk) {
                    if (isDns && udpStreamWrite) {
                        return udpStreamWrite(chunk);
                    }
                    if (remoteSocket) {
                        const writer = remoteSocket.writable.getWriter();
                        await writer.write(chunk);
                        writer.releaseLock();
                        return;
                    }

                    const { hasError, message, portRemote = 443, addressRemote = '', rawDataIndex, streamVersion, isUDP } =
                        processStreamHeader(chunk, config.USER_ID);

                    conduitLogContext.remoteAddress = addressRemote;
                    conduitLogContext.remotePort = portRemote;
                    log.info(conduitLogContext, 'PROCESS', `Remote: ${isUDP ? 'UDP' : 'TCP'}://${addressRemote}:${portRemote}`);

                    if (hasError) {
                        throw new Error(message);
                    }

                    if (isUDP && portRemote !== 53) {
                        throw new Error('UDP transport is only enabled for DNS (port 53).');
                    }

                    const streamResponseHeader = new Uint8Array([streamVersion[0], 0]);
                    const rawClientData = chunk.slice(rawDataIndex);

                    if (isUDP) {
                        isDns = true;
                        const { write } = await handleUDPOutBound(webSocket, streamResponseHeader, config, conduitLogContext);
                        udpStreamWrite = write;
                        udpStreamWrite(rawClientData);
                    } else {
                        remoteSocket = await handleTCPOutBound(
                            addressRemote,
                            portRemote,
                            rawClientData,
                            webSocket,
                            streamResponseHeader,
                            conduitLogContext
                        );
                    }
                },
                close() {
                    log.info(conduitLogContext, 'CLOSE', 'Client WebSocket stream closed.');
                    if (remoteSocket) remoteSocket.close();
                },
                abort(reason) {
                    log.warn(conduitLogContext, 'ABORT', 'Client WebSocket stream aborted:', reason);
                    if (remoteSocket) remoteSocket.close();
                },
            })
        )
        .catch((err) => {
            log.error(conduitLogContext, 'ERROR', 'Stream pipe error:', err.stack || err);
            safeCloseWebSocket(webSocket, conduitLogContext);
            if (remoteSocket) remoteSocket.close();
        });
}

/**
 * Handles outbound TCP connections.
 * @param {string} addressRemote - The remote address.
 * @param {number} portRemote - The remote port.
 * @param {Uint8Array} rawClientData - Initial data to send.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} streamResponseHeader - The VLESS response header.
 * @param {object} logContext - The logging context.
 * @returns {Promise<Deno.Conn>} The established TCP socket.
 */
async function handleTCPOutBound(addressRemote, portRemote, rawClientData, webSocket, streamResponseHeader, logContext) {
    const tcpLogContext = { ...logContext, section: 'CONDUIT:TCP' };

    try {
        const tcpSocket = await Deno.connect({ hostname: addressRemote, port: portRemote });
        log.info(tcpLogContext, 'CONNECT', `Connected to ${addressRemote}:${portRemote}`);

        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();

        remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, tcpLogContext);
        return tcpSocket;
    } catch (error) {
        log.error(tcpLogContext, 'ERROR', `Failed to connect to ${addressRemote}:${portRemote}:`, error);
        safeCloseWebSocket(webSocket, tcpLogContext);
        throw error;
    }
}

/**
 * Pipes data from the remote TCP socket to the client WebSocket.
 * @param {Deno.Conn} remoteSocket - The remote TCP socket.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} streamResponseHeader - The VLESS response header.
 * @param {object} logContext - The logging context.
 */
async function remoteSocketToWS(remoteSocket, webSocket, streamResponseHeader, logContext) {
    const wsLogContext = { ...logContext, section: 'CONDUIT:WS' };
    let streamHeaderSent = false;

    remoteSocket.readable
        .pipeTo(
            new WritableStream({
                async write(chunk) {
                    if (webSocket.readyState === WS_READY_STATE_OPEN) {
                        if (!streamHeaderSent) {
                            const combinedData = new Uint8Array(streamResponseHeader.length + chunk.length);
                            combinedData.set(streamResponseHeader);
                            combinedData.set(chunk, streamResponseHeader.length);
                            webSocket.send(combinedData);
                            streamHeaderSent = true;
                        } else {
                            webSocket.send(chunk);
                        }
                    }
                },
                close() {
                    log.info(wsLogContext, 'CLOSE', 'Remote socket readable stream closed.');
                },
                abort(reason) {
                    log.error(wsLogContext, 'ABORT', 'Remote socket readable stream aborted:', reason);
                },
            })
        )
        .catch((error) => {
            log.error(wsLogContext, 'ERROR', 'Error piping remote socket to WebSocket:', error);
            safeCloseWebSocket(webSocket, wsLogContext);
        });
}

/**
 * Handles outbound UDP (DNS over HTTPS) requests.
 * @param {WebSocket} webSocket - The client WebSocket.
 * @param {Uint8Array} streamResponseHeader - The VLESS response header.
 * @param {object} config - The application configuration.
 * @param {object} logContext - The logging context.
 */
async function handleUDPOutBound(webSocket, streamResponseHeader, config, logContext) {
    const udpLogContext = { ...logContext, section: 'CONDUIT:UDP' };
    let isStreamHeaderSent = false;

    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
                index += 2 + udpPacketLength;
                controller.enqueue(udpData);
            }
        },
    });

    transformStream.readable.pipeTo(
        new WritableStream({
            async write(chunk) {
                try {
                    const resp = await fetch(config.DOH_URL, {
                        method: 'POST',
                        headers: { 'content-type': 'application/dns-message' },
                        body: chunk,
                    });

                    if (!resp.ok) {
                        log.error(udpLogContext, 'DOH:ERROR', `DoH request failed: ${resp.status}`);
                        return;
                    }

                    const dnsQueryResult = await resp.arrayBuffer();
                    const udpSize = dnsQueryResult.byteLength;
                    const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

                    if (webSocket.readyState === WS_READY_STATE_OPEN) {
                        const dataToSend = isStreamHeaderSent
                            ? new Blob([udpSizeBuffer, dnsQueryResult])
                            : new Blob([streamResponseHeader, udpSizeBuffer, dnsQueryResult]);

                        webSocket.send(await dataToSend.arrayBuffer());
                        isStreamHeaderSent = true;
                    }
                } catch (error) {
                    log.error(udpLogContext, 'DOH:ERROR', 'Error in DoH request:', error);
                }
            },
        })
    );

    const writer = transformStream.writable.getWriter();
    return {
        write: (chunk) => writer.write(chunk),
    };
}
