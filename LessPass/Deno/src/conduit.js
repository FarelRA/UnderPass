// conduit.js
import { processStreamHeader, safeCloseWebSocket, makeReadableWebSocketStream } from './utils.js';
import { WS_READY_STATE_OPEN } from './configs.js';
import { log } from './logs.js';

/**
 * Handles the WebSocket upgrade and orchestrates the entire VLESS proxy session.
 * This refactored version avoids the flawed WritableStream pattern and instead
 * sets up two dedicated, concurrent pipes for robust, bidirectional data flow.
 */
export function handleConduitRequest(request, config, logContext) {
  const { socket: webSocket, response } = Deno.upgradeWebSocket(request);

  (async () => {
    const conduitLogContext = { ...logContext, section: 'CONDUIT' };
    const earlyDataHeader = request.headers.get('Sec-Websocket-Protocol') || '';
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, conduitLogContext);
    const reader = readableWebSocketStream.getReader();

    try {
      // 1. Read the first chunk to get the VLESS header
      const { value: firstChunk, done } = await reader.read();
      if (done || !firstChunk) {
        log.warn(conduitLogContext, 'CLOSE', 'Connection closed before VLESS header was received.');
        return;
      }

      const buffer = firstChunk instanceof ArrayBuffer ? firstChunk : firstChunk.buffer;

      // 2. Process the header
      const { hasError, message, portRemote, addressRemote, rawDataIndex, streamVersion, isUDP } = processStreamHeader(
        buffer,
        config.USER_ID
      );
      conduitLogContext.remoteAddress = addressRemote;
      conduitLogContext.remotePort = portRemote;
      log.info(conduitLogContext, 'PROCESS', `Stream processed. Remote: ${isUDP ? 'UDP' : 'TCP'}://${addressRemote}:${portRemote}`);

      if (hasError) {
        throw new Error(message);
      }

      // 3. Handle UDP (DNS) or TCP
      const rawClientData = buffer.slice(rawDataIndex);
      const streamResponseHeader = new Uint8Array([streamVersion[0], 0]);

      if (isUDP) {
        // DNS logic can remain as it is since it's a request/response pattern, not a long-lived pipe.
        if (portRemote !== 53) throw new Error('UDP transport is only enabled for DNS (port 53).');
        await handleUDPOutBound(webSocket, reader, streamResponseHeader, rawClientData, config, conduitLogContext);
      } else {
        // 4. For TCP, set up the bidirectional pipes
        await handleTCPOutBound(webSocket, reader, streamResponseHeader, rawClientData, addressRemote, portRemote, conduitLogContext);
      }
    } catch (err) {
      log.error(conduitLogContext, 'ERROR', 'Error in conduit connection handler:', err.stack || err);
      safeCloseWebSocket(webSocket, conduitLogContext);
    }
  })();

  return response;
}

/**
 * For TCP, creates two concurrent pipes:
 * - WebSocket Reader -> TCP Socket Writable
 * - TCP Socket Readable -> WebSocket
 * and runs them until one closes, then cleans up.
 */
async function handleTCPOutBound(webSocket, wsReader, streamResponseHeader, rawClientData, address, port, logContext) {
  log.info(logContext, 'TCP', 'Handling TCP request.');
  const tcpSocket = await Deno.connect({ hostname: address, port });
  log.info(logContext, 'TCP:CONNECT', `Connected to ${address}:${port}`);

  const clientToTarget = pipeFromWsToTcp(wsReader, tcpSocket, rawClientData, logContext);
  const targetToClient = pipeFromTcpToWs(tcpSocket, webSocket, streamResponseHeader, logContext);

  // Wait for either pipe to finish, which indicates the connection is closing.
  await Promise.race([clientToTarget, targetToClient]);

  // Clean up both resources
  safeCloseWebSocket(webSocket, logContext);
  try {
    tcpSocket.close();
  } catch (e) {
    log.warn(logContext, 'TCP:CLOSE', 'Error closing TCP socket:', e.message);
  }
}

/**
 * Pipes data from the client WebSocket to the target TCP socket.
 */
async function pipeFromWsToTcp(wsReader, tcpSocket, initialData, logContext) {
  const writer = tcpSocket.writable.getWriter();
  try {
    // Write the initial data that came with the header
    await writer.write(initialData);

    // Continue piping subsequent data from the WebSocket
    while (true) {
      const { value, done } = await wsReader.read();
      if (done) {
        break;
      }
      await writer.write(value);
    }
  } catch (e) {
    log.warn(logContext, 'PIPE:WS->TCP', 'Pipe from client to target closed with error:', e.message);
  } finally {
    // This will signal the other pipe that the connection is closing.
    await tcpSocket.writable.close();
  }
}

/**
 * Pipes data from the target TCP socket back to the client WebSocket.
 */
async function pipeFromTcpToWs(tcpSocket, webSocket, streamResponseHeader, logContext) {
  let streamHeaderSent = false;
  await tcpSocket.readable.pipeTo(
    new WritableStream({
      write(chunk) {
        if (webSocket.readyState === WS_READY_STATE_OPEN) {
          if (!streamHeaderSent) {
            const combinedBuffer = new Uint8Array(streamResponseHeader.length + chunk.length);
            combinedBuffer.set(streamResponseHeader, 0);
            combinedBuffer.set(chunk, streamResponseHeader.length);
            webSocket.send(combinedBuffer);
            streamHeaderSent = true;
          } else {
            webSocket.send(chunk);
          }
        }
      },
    })
  );
}

/**
 * Handles UDP (DNS) requests. This function is now simpler as it doesn't need
 * to manage a long-lived bidirectional pipe.
 */
async function handleUDPOutBound(webSocket, wsReader, streamResponseHeader, rawClientData, config, logContext) {
  log.info(logContext, 'UDP', 'Handling UDP DNS request.');
  let isStreamHeaderSent = false;

  const processChunk = async (chunk) => {
    try {
      for (let index = 0; index < chunk.byteLength; ) {
        const lengthBuffer = chunk.slice(index, index + 2);
        const udpPacketLength = new DataView(lengthBuffer).getUint16(0);
        const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPacketLength));
        index = index + 2 + udpPacketLength;

        // Send DNS query via DoH
        const resp = await fetch(config.DOH_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/dns-message' },
          body: udpData,
        });

        if (!resp.ok) {
          log.error(logContext, 'UDP:DOH:ERROR', `DoH request failed with status: ${resp.status}`);
          continue;
        }

        const dnsQueryResult = await resp.arrayBuffer();
        const udpSize = dnsQueryResult.byteLength;
        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);

        if (webSocket.readyState === WS_READY_STATE_OPEN) {
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
      }
    } catch (e) {
      log.error(logContext, 'UDP:ERROR', 'Error processing UDP packet:', e.message);
    }
  };

  // Process initial data
  await processChunk(rawClientData);

  // Process subsequent data chunks from the WebSocket for this DNS session
  while (true) {
    const { value, done } = await wsReader.read();
    if (done) break;
    await processChunk(value);
  }
}
