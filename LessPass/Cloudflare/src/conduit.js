// conduit.js
import { connect } from 'cloudflare:sockets';
import { processStreamHeader, safeCloseWebSocket, makeReadableWebSocketStream } from './utils.js';
import { WS_READY_STATE_OPEN } from './configs.js';
import { log } from './logs.js';

/**
 * Handles inbound WebSocket requests, establishes a remote connection based on
 * the VLESS protocol, and pipes data between the client and the destination.
 *
 * @param {Request} request - The incoming WebSocket upgrade request.
 * @param {object} config - The configuration object.
 * @param {object} logContext - The base logging context.
 * @returns {Promise<Response>} A WebSocket response to complete the upgrade.
 */
export async function handleConduitRequest(request, config, logContext) {
  const conduitLogContext = { ...logContext, section: 'CONDUIT' };
  const webSocketPair = new WebSocketPair();
  const [client, webSocket] = Object.values(webSocketPair);
  webSocket.accept();
  const earlyDataHeader = request.headers.get('Sec-Websocket-Protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, conduitLogContext);
  let remoteSocketWrapper = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          if (isDns && udpStreamWrite) {
            log.debug(conduitLogContext, 'WRITE', 'Writing to UDP DNS stream.');
            return udpStreamWrite(chunk);
          }
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            try {
              log.debug(conduitLogContext, 'WRITE', 'Writing to remote TCP socket.');
              await writer.write(chunk);
            } finally {
              writer.releaseLock();
            }
            return;
          }
          const {
            hasError,
            message,
            portRemote = 443,
            addressRemote = '',
            rawDataIndex,
            streamVersion = new Uint8Array([0, 0]),
            isUDP,
          } = processStreamHeader(chunk, config.USER_ID);
          conduitLogContext.remoteAddress = addressRemote;
          conduitLogContext.remotePort = portRemote;
          log.info(conduitLogContext, 'PROCESS', `Stream processed. Remote: ${isUDP ? 'UDP' : 'TCP'}://${addressRemote}:${portRemote}`);
          if (hasError) {
            log.error(conduitLogContext, 'ERROR', 'Error processing stream header:', message);
            throw new Error(message);
          }
          if (isUDP && portRemote !== 53) {
            log.warn(conduitLogContext, 'WARN', 'UDP requested for non-DNS port. Dropping connection.');
            throw new Error('UDP transport is only enabled for DNS (port 53).');
          }
          const streamResponseHeader = new Uint8Array([streamVersion[0], 0]);
          const rawClientData = chunk.slice(rawDataIndex);
          if (isUDP && portRemote === 53) {
            isDns = true;
            log.info(conduitLogContext, 'UDP', 'Handling UDP DNS request.');
            const { write } = await handleUDPOutBound(webSocket, streamResponseHeader, config, { ...conduitLogContext });
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }
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
      safeCloseWebSocket(webSocket, conduitLogContext);
    });
  return new Response(null, { status: 101, webSocket: client });
}
/**
 * Handles outbound TCP connections. It establishes the connection, writes
 * the initial data, and sets up retries if necessary.
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
  async function connectAndWrite(address, port) {
    try {
      const tcpSocket = connect({ hostname: address, port: port });
      remoteSocketWrapper.value = tcpSocket;
      log.info(tcpLogContext, 'CONNECT', `Connecting to ${address}:${port}`);
      const writer = tcpSocket.writable.getWriter();
      await writer.write(rawClientData);
      log.debug(tcpLogContext, 'WRITE', 'Initial data written to remote socket.');
      writer.releaseLock();
      return tcpSocket;
    } catch (error) {
      log.error(tcpLogContext, 'ERROR', `Error connecting to ${address}:${port}:`, error);
      throw error;
    }
  }
  async function retry() {
    log.info(tcpLogContext, 'TCP:RETRY', `Retrying connection with ${config.RELAY_ADDR}...`);
    const [relayHostname, relayPortStr] = config.RELAY_ADDR.split(':');
    const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : portRemote;
    const tcpSocket = await connectAndWrite(relayHostname, relayPort);
    tcpSocket.closed
      .catch((error) => {
        log.error(tcpLogContext, 'TCP:ERROR', 'Retry connection failed:', error);
      })
      .finally(() => {
        safeCloseWebSocket(webSocket, tcpLogContext);
      });
    remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, null, { ...tcpLogContext });
  }
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, retry, { ...tcpLogContext });
}

/**
 * Pipes data from the remote socket to the WebSocket. This version uses
 * performant buffer concatenation for the initial data packet.
 */
async function remoteSocketToWS(remoteSocket, webSocket, streamResponseHeader, retry, logContext) {
  const wsLogContext = { ...logContext, section: 'CONDUIT:WS' };
  let streamHeaderSent = false;
  let hasIncomingData = false;
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        write(chunk) {
          hasIncomingData = true;
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            if (!streamHeaderSent) {
              // IMPROVEMENT: Use direct Uint8Array.set for efficient buffer concatenation.
              // This avoids the overhead of creating an intermediate Blob.
              const combinedBuffer = new Uint8Array(streamResponseHeader.length + chunk.length);
              combinedBuffer.set(streamResponseHeader, 0);
              combinedBuffer.set(chunk, streamResponseHeader.length);
              webSocket.send(combinedBuffer);
              streamHeaderSent = true;
              log.debug(wsLogContext, 'WRITE', 'Stream response header sent.');
            } else {
              webSocket.send(chunk);
            }
            log.debug(wsLogContext, 'WRITE', 'Data sent to client via WebSocket.');
          } else {
            log.error(wsLogContext, 'ERROR', 'WebSocket is not open. Ready state:', webSocket.readyState);
          }
        },
        close() {
          log.info(wsLogContext, 'CLOSE', `Remote socket readable stream closed. hasIncomingData: ${hasIncomingData}`);
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
  if (!hasIncomingData && retry) {
    log.warn(wsLogContext, 'RETRY', 'No incoming data from remote. Retrying...');
    retry();
  }
}

/**
 * Handles outbound UDP connections (specifically for DNS). It forwards UDP
 * packets to a DoH endpoint and sends responses back to the client. This
 * version uses performant buffer concatenation for DNS responses.
 */
async function handleUDPOutBound(webSocket, streamResponseHeader, config, logContext) {
  const udpLogContext = { ...logContext, section: 'CONDUIT' };
  let isStreamHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      log.debug(udpLogContext, 'UDP:TRANSFORM', 'Transforming UDP chunk.');
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
        index = index + 2 + udpPakcetLength;
        controller.enqueue(udpData);
      }
    },
  });
  transformStream.readable
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          try {
            log.debug(udpLogContext, 'UDP:DOH', 'Sending DNS query via DoH.');
            const resp = await fetch(config.DOH_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: chunk,
            });
            if (!resp.ok) {
              log.error(udpLogContext, 'UDP:DOH:ERROR', `DoH request failed with status: ${resp.status}`);
              return;
            }
            const dnsQueryResult = await resp.arrayBuffer();
            const udpSize = dnsQueryResult.byteLength;
            const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
              log.info(udpLogContext, 'UDP:DOH:SUCCESS', `DoH query successful. DNS message length: ${udpSize}`);
              let dataToSend;
              // IMPROVEMENT: Use direct Uint8Array.set for efficient buffer concatenation.
              if (isStreamHeaderSent) {
                dataToSend = new Uint8Array(udpSizeBuffer.length + dnsQueryResult.byteLength);
                dataToSend.set(udpSizeBuffer, 0);
                dataToSend.set(new Uint8Array(dnsQueryResult), udpSizeBuffer.length);
              } else {
                const combinedLength = streamResponseHeader.length + udpSizeBuffer.length + dnsQueryResult.byteLength;
                dataToSend = new Uint8Array(combinedLength);
                dataToSend.set(streamResponseHeader, 0);
                dataToSend.set(udpSizeBuffer, streamResponseHeader.length);
                dataToSend.set(new Uint8Array(dnsQueryResult), streamResponseHeader.length + udpSizeBuffer.length);
              }
              webSocket.send(dataToSend);
              isStreamHeaderSent = true;
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
  const writer = transformStream.writable.getWriter();
  return {
    write: (chunk) => {
      log.debug(udpLogContext, 'UDP:WRITE', 'Writing chunk to UDP transform stream.');
      writer.write(chunk);
    },
  };
}
