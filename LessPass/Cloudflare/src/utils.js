// utils.js
import { byteToHex } from './configs.js';

export function createBufferReader(buffer) {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 0;
  return {
    get offset() {
      return offset;
    },
    readUint8() {
      const v = view.getUint8(offset);
      offset += 1;
      return v;
    },
    readUint16() {
      const v = view.getUint16(offset);
      offset += 2;
      return v;
    },
    readBytes(len) {
      const v = new Uint8Array(buffer.buffer, buffer.byteOffset + offset, len);
      offset += len;
      return v;
    },
    skip(len) {
      offset += len;
    },
  };
}

export function isValidUUID(uuid) {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

export function stringifyUUID(arr, offset = 0) {
  const uuid =
    byteToHex[arr[offset]] +
    byteToHex[arr[offset + 1]] +
    byteToHex[arr[offset + 2]] +
    byteToHex[arr[offset + 3]] +
    '-' +
    byteToHex[arr[offset + 4]] +
    byteToHex[arr[offset + 5]] +
    '-' +
    byteToHex[arr[offset + 6]] +
    byteToHex[arr[offset + 7]] +
    '-' +
    byteToHex[arr[offset + 8]] +
    byteToHex[arr[offset + 9]] +
    '-' +
    byteToHex[arr[offset + 10]] +
    byteToHex[arr[offset + 11]] +
    byteToHex[arr[offset + 12]] +
    byteToHex[arr[offset + 13]] +
    byteToHex[arr[offset + 14]] +
    byteToHex[arr[offset + 15]];
  if (!isValidUUID(uuid)) {
    throw TypeError('Stringified UUID is invalid');
  }
  return uuid;
}
