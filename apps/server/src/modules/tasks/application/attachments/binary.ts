/** Validate canonical padded Base64 without decoding and re-encoding the file.
 * General files need a size bound, not a second copy of every byte in JS strings.
 */
export function base64ByteLength(value: string): number | undefined {
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  if (padding) {
    const last = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value[value.length - padding - 1]);
    if (last < 0 || (last & ((1 << (padding * 2)) - 1)) !== 0) return undefined;
  }
  return value.length / 4 * 3 - padding;
}

/** Portable byte operations for bounded attachment validation. */
export function decodeBase64(value: string): Uint8Array {
  try {
    const decoded = atob(value);
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
    return bytes;
  }
  catch { return new Uint8Array(); }
}
export function encodeBase64(bytes: Uint8Array): string {
  let value = "";
  for (let offset = 0; offset < bytes.length; offset += 32768) value += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(value);
}
export function ascii(bytes: Uint8Array, start = 0, end = bytes.length): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}
export function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((value, index) => bytes[index] === value);
}
export function contains(bytes: Uint8Array, sequence: number[]): boolean {
  for (let offset = 0; offset <= bytes.length - sequence.length; offset++) if (startsWith(bytes.subarray(offset), sequence)) return true;
  return false;
}
export function readNumber(bytes: Uint8Array, offset: number, size: number, little = false): number {
  if (offset < 0 || offset + size > bytes.length) throw new RangeError("Truncated attachment header");
  let value = 0;
  for (let index = 0; index < size; index++) value = value * 256 + bytes[offset + (little ? size - 1 - index : index)];
  return value;
}
