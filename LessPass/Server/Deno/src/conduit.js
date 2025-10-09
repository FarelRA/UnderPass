// conduit.js
import { processStreamHeader, safeCloseWebSocket, makeReadableWebSocketStream } from './utils.js';
import { WS_READY_STATE_OPEN } from './configs.js';
import { log } from './logs.js';

/**
 * Handles inbound WebSocket upgrade requests, the core of the VLESS data plane.
 */
export function handleConduitRequest(request, config, logContext) {
  const conduitLogContext = { ...logContext, section: 'CONDUIT' };
  const { socket: webSocket, response } = Deno.upgradeWebSocket(request); // Use Deno's native WebSocket upgrader.
  const earlyDataHeader = request.headers.get('Sec-Websocket-Protocol') || '';
  const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, conduitLogContext);
  let remoteSocketWrapper = { value: null };
  let udpStreamWrite = null;
  let isDns = false;
  readableWebSocketStream
    .pipeTo(
      new WritableStream({
        async write(chunk) {
          const buffer = chunk instanceof ArrayBuffer ? chunk : chunk.buffer;
          if (isDns && udpStreamWrite) {
            return udpStreamWrite(buffer);
          }
          if (remoteSocketWrapper.value) {
            const writer = remoteSocketWrapper.value.writable.getWriter();
            try {
              await writer.write(buffer);
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
          } = processStreamHeader(buffer, config.USER_ID);
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
          const rawClientData = buffer.slice(rawDataIndex);
          if (isUDP && portRemote === 53) {
            isDns = true;
            log.info(conduitLogContext, 'UDP', 'Handling UDP DNS request.');
            const { write } = await handleUDPOutBound(webSocket, streamResponseHeader, config, { ...conduitLogContext });
            udpStreamWrite = write;
            udpStreamWrite(rawClientData);
            return;
          }
          log.info(conduitLogContext, 'TCP', 'Handling TCP request.');

          // We MUST await the entire TCP setup process. Otherwise, this `write` function
          // returns immediately, creating a race condition where the client WebSocket
          // might close before the remote TCP connection is established, leading to a "BadResource" error.
          await handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, streamResponseHeader, config, {
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
  return response;
}
/**
 * Handles outbound TCP connections with improved, explicit error handling.
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
      const tcpSocket = await Deno.connect({ hostname: address, port: port });
      remoteSocketWrapper.value = tcpSocket;
      log.info(tcpLogContext, 'CONNECT', `Connecting to ${address}:${port}`);
      const writer = tcpSocket.writable.getWriter();
      await writer.write(rawClientData);
      log.debug(tcpLogContext, 'WRITE', 'Initial data written to remote socket.');
      writer.releaseLock();
      return tcpSocket;
    } catch (error) {
      log.error(tcpLogContext, 'ERROR', `Error connecting to ${address}:${port}:`, error.message);
      safeCloseWebSocket(webSocket, logContext);
      return null;
    }
  }
  const tcpSocket = await connectAndWrite(addressRemote, portRemote);
  if (!tcpSocket) {
    log.warn(tcpLogContext, 'ABORT', 'TCP connection failed, aborting pipe setup.');
    return;
  }
  // This function sets up the pipe but does not need to be awaited itself, as it
  // will run in the background for the lifetime of the connection. The important
  // part is that it's only called AFTER the connection is established.
  remoteSocketToWS(tcpSocket, webSocket, streamResponseHeader, { ...tcpLogContext });
}

/**
 * Pipes data from the remote Deno TCP socket to the client WebSocket, using
 * performant buffer concatenation. This version is cleaned of all retry logic.
 */
async function remoteSocketToWS(remoteSocket, webSocket, streamResponseHeader, logContext) {
  const wsLogContext = { ...logContext, section: 'CONDUIT:WS' };
  let streamHeaderSent = false;
  // Use a .catch() to prevent unhandled promise rejection on pipe failure.
  await remoteSocket.readable
    .pipeTo(
      new WritableStream({
        write(chunk) {
          if (webSocket.readyState === WS_READY_STATE_OPEN) {
            if (!streamHeaderSent) {
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
          log.info(wsLogContext, 'CLOSE', `Remote socket readable stream closed.`);
        },
        abort(reason) {
          log.error(wsLogContext, 'ABORT', 'Remote socket readable stream aborted:', reason);
        },
      })
    )
    .catch((error) => {
      log.error(wsLogContext, 'ERROR', 'Error piping remote socket to WebSocket:', error.stack || error);
      safeCloseWebSocket(webSocket, wsLogContext);
    });
}

/**
 * Handles outbound UDP (DNS) connections with optimized buffer handling.
 */
async function handleUDPOutBound(webSocket, streamResponseHeader, config, logContext) {
  const udpLogContext = { ...logContext, section: 'CONDUIT:UDP' };
  let isStreamHeaderSent = false;
  const transformStream = new TransformStream({
    transform(chunk, controller) {
      log.debug(udpLogContext, 'UDP:TRANSFORM', 'Transforming UDP chunk.');
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;
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
              log.info(udpLogContext, 'UDP:DOH:SUCCESS', `DoH query successful. Length: ${udpSize}`);
              let dataToSend;
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
                isStreamHeaderSent = true;
              }
              webSocket.send(dataToSend);
            }
          } catch (error) {
            log.error(udpLogContext, 'UDP:ERROR', 'Error in DoH request:', error.message);
          }
        },
      })
    )
    .catch((error) => {
      log.error(udpLogContext, 'UDP:ERROR', 'Error piping UDP data to DoH endpoint:', error.message);
    });
  const writer = transformStream.writable.getWriter();
  return {
    write: (chunk) => {
      log.debug(udpLogContext, 'UDP:WRITE', 'Writing chunk to UDP transform stream.');
      writer.write(chunk);
    },
  };
}
