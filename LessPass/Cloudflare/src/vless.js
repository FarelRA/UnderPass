// vless.js
import { stringifyUUID, createBufferReader } from './utils.js';
import { log } from './logs.js';

/**
 * Processes the VLESS protocol header from a buffer.
 * @param {Uint8Array} buffer The buffer containing the protocol header.
 * @param {string} userID The expected user ID for validation.
 * @returns {object} An object containing the extracted destination info, or an error.
 */
export function processVlessHeader(buffer, userID) {
  if (buffer.byteLength < 24) {
    return { hasError: true, message: 'Invalid data: insufficient length for VLESS header.' };
  }

  const reader = createBufferReader(buffer);
  const streamVersion = reader.readBytes(1); // Reading 1 byte for stream version
  const userIdBuffer = reader.readBytes(16);

  if (stringifyUUID(userIdBuffer) !== userID) {
    return { hasError: true, message: 'Invalid user ID.' };
  }

  const optLength = reader.readUint8();
  reader.skip(optLength);

  const command = reader.readUint8();
  const portRemote = reader.readUint16();
  const addressType = reader.readUint8();

  let addressRemote = '';
  switch (addressType) {
    case 1: // IPv4
      addressRemote = reader.readBytes(4).join('.');
      break;
    case 2: // Domain
      const domainLength = reader.readUint8();
      addressRemote = new TextDecoder().decode(reader.readBytes(domainLength));
      break;
    case 3: // IPv6
      const ipv6Bytes = reader.readBytes(16);
      addressRemote = `[${Array.from(ipv6Bytes)
        .map((b, i) => (i % 2 === 0 ? b.toString(16).padStart(2, '0') + ipv6Bytes[i + 1].toString(16).padStart(2, '0') : ''))
        .filter(Boolean)
        .join(':')}]`;
      break;
    default:
      return { hasError: true, message: `Invalid address type: ${addressType}.` };
  }

  return {
    hasError: false,
    addressRemote,
    portRemote,
    isUDP: command === 2,
    streamVersion: new Uint8Array([streamVersion[0], 0]),
    rawDataIndex: reader.offset,
  };
}

/**
 * Creates a TransformStream that prepends the VLESS response header
 * (version and success code) to the first chunk of data that passes through it.
 * @param {Uint8Array} streamVersion The VLESS version from the initial request.
 * @param {object} logContext The logging context.
 */
export function createVlessResponseTransformStream(streamVersion, logContext) {
  let headerSent = false;
  const transformLogContext = { ...logContext, section: 'VLESS:RESPONSE' };

  return new TransformStream({
    transform(chunk, controller) {
      if (!headerSent) {
        const responseHeader = streamVersion; // [version, 0x00]
        const combined = new Uint8Array(responseHeader.length + chunk.length);
        combined.set(responseHeader, 0);
        combined.set(chunk, responseHeader.length);
        controller.enqueue(combined);
        headerSent = true;
        log.debug(transformLogContext, 'HEADER', 'VLESS response header sent.');
      } else {
        controller.enqueue(chunk);
      }
    },
  });
}
