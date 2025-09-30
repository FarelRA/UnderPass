// handlers.js
import { connect } from 'cloudflare:sockets';
import { log } from './logs.js';

/**
 * Actor for handling TCP outbound connections with a "retry on no data" mechanism.
 */
export class TCPHandler {
  constructor(config, logContext) {
    this.config = config;
    this.logContext = { ...logContext, section: 'HANDLER:TCP' };
  }

  async connect(options) {
    let primarySocket;
    try {
      log.info(this.logContext, 'CONNECT:PRIMARY', `Attempting primary connection to ${options.hostname}:${options.port}`);
      primarySocket = await connect(options);
    } catch (err) {
      log.warn(this.logContext, 'CONNECT:FAIL', `Primary connection failed immediately: ${err.message}.`);
      return this.attemptRelay(options, 'Initial connection error');
    }

    // Probe the connection: attempt to read the first chunk.
    const reader = primarySocket.readable.getReader();
    const { value, done } = await reader.read();

    if (done) {
      // The stream closed without sending any data. This is the silent failure case.
      log.warn(this.logContext, 'CONNECT:PROBE_FAIL', 'Primary connection closed without sending data.');
      reader.releaseLock(); // Not strictly necessary as the stream is closed, but good practice.
      return this.attemptRelay(options, 'Silent failure on primary');
    }

    // Success! Data was received. We need to return a new stream that includes the first chunk.
    log.info(this.logContext, 'CONNECT:PROBE_SUCCESS', 'Primary connection is healthy.');
    reader.releaseLock();

    // Reconstruct the readable stream, prepending the chunk we just read.
    const reconstitutedReadable = new ReadableStream({
      start(controller) {
        // Enqueue the first chunk that we already read.
        controller.enqueue(value);

        // Pipe the rest of the original stream's data.
        primarySocket.readable
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

    return {
      readable: reconstitutedReadable,
      writable: primarySocket.writable,
    };
  }

  /**
   * Attempts to connect to the configured RELAY_ADDR as a fallback.
   * @param {object} originalOptions The original connection options.
   * @param {string} reason The reason for the retry.
   * @returns {Promise<object>} A promise that resolves to a connected socket transport.
   */
  async attemptRelay(originalOptions, reason) {
    if (!this.config.RELAY_ADDR) {
      throw new Error(`Retry failed: No RELAY_ADDR configured. Original reason: ${reason}`);
    }

    const [relayHostname, relayPortStr] = this.config.RELAY_ADDR.split(':');
    const relayPort = relayPortStr ? parseInt(relayPortStr, 10) : originalOptions.port;

    log.info(this.logContext, 'CONNECT:RETRY', `Retrying with relay: ${relayHostname}:${relayPort}. Reason: ${reason}`);

    try {
      const relaySocket = await connect({ hostname: relayHostname, port: relayPort });
      return relaySocket;
    } catch (err) {
      log.error(this.logContext, 'CONNECT:RETRY_FAIL', `Relay connection to ${relayHostname}:${relayPort} also failed.`);
      throw err; // If the relay also fails, we give up and throw the error.
    }
  }
}

/**
 * Actor for handling UDP outbound connections via DNS-over-HTTPS.
 * This class cleverly mimics a standard socket's { readable, writable } interface.
 */
export class UDPHandler {
  constructor(config, logContext) {
    this.config = config;
    this.logContext = { ...logContext, section: 'HANDLER:UDP' };
    this.writable = this._createWritable();
    this.readable = this._createReadable();
  }

  _createReadable() {
    const handler = this;
    return new ReadableStream({
      start(controller) {
        handler.responseController = controller;
      },
    });
  }

  _createWritable() {
    const handler = this;
    return new WritableStream({
      async write(chunk) {
        // VLESS UDP packets are length-prefixed. We need to parse them.
        for (let offset = 0; offset < chunk.byteLength; ) {
          const view = new DataView(chunk.buffer, chunk.byteOffset + offset, 2);
          const length = view.getUint16(0);
          offset += 2;
          const dnsQuery = chunk.slice(offset, offset + length);
          offset += length;

          try {
            log.debug(handler.logContext, 'DOH', 'Sending DNS query via DoH.');
            const response = await fetch(handler.config.DOH_URL, {
              method: 'POST',
              headers: { 'content-type': 'application/dns-message' },
              body: dnsQuery,
            });

            if (!response.ok) {
              throw new Error(`DoH request failed with status: ${response.status}`);
            }

            const dnsResult = await response.arrayBuffer();
            const resultSize = dnsResult.byteLength;
            const sizeBuffer = new Uint8Array([(resultSize >> 8) & 0xff, resultSize & 0xff]);

            const packet = new Uint8Array(2 + resultSize);
            packet.set(sizeBuffer, 0);
            packet.set(new Uint8Array(dnsResult), 2);

            handler.responseController.enqueue(packet);
            log.info(handler.logContext, 'DOH:SUCCESS', `DoH query successful. Response size: ${resultSize}`);
          } catch (err) {
            log.error(handler.logContext, 'DOH:ERROR', `Error in DoH request:`, err);
          }
        }
      },
      close() {
        log.info(handler.logContext, 'CLOSE', 'UDP writable stream closed.');
        if (handler.responseController) handler.responseController.close();
      },
      abort(reason) {
        log.warn(handler.logContext, 'ABORT', 'UDP writable stream aborted:', reason);
        if (handler.responseController) handler.responseController.error(reason);
      },
    });
  }

  async connect(options) {
    if (options.port !== 53) {
      throw new Error('UDP transport is only enabled for DNS (port 53).');
    }
    // For UDP-over-DoH, the "connection" is virtual. We just return the streams.
    return { readable: this.readable, writable: this.writable };
  }
}
