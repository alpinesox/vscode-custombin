import { Endianness } from "./model";

export class BinaryReader {
  constructor(private readonly bytes: Uint8Array) {}

  get length(): number { return this.bytes.byteLength; }

  slice(offset: number, length: number): Uint8Array {
    this.assertRange(offset, length);
    return this.bytes.subarray(offset, offset + length);
  }

  read(offset: number, type: string, endianness: Endianness): { value: string | number | bigint; length: number; raw: Uint8Array } {
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
    const le = endianness === "little";
    switch (type) {
      case "u8": this.assertRange(offset, 1); return { value: view.getUint8(offset), length: 1, raw: this.slice(offset, 1) };
      case "i8": this.assertRange(offset, 1); return { value: view.getInt8(offset), length: 1, raw: this.slice(offset, 1) };
      case "u16": this.assertRange(offset, 2); return { value: view.getUint16(offset, le), length: 2, raw: this.slice(offset, 2) };
      case "i16": this.assertRange(offset, 2); return { value: view.getInt16(offset, le), length: 2, raw: this.slice(offset, 2) };
      case "u32": this.assertRange(offset, 4); return { value: view.getUint32(offset, le), length: 4, raw: this.slice(offset, 4) };
      case "i32": this.assertRange(offset, 4); return { value: view.getInt32(offset, le), length: 4, raw: this.slice(offset, 4) };
      case "u64": this.assertRange(offset, 8); return { value: view.getBigUint64(offset, le), length: 8, raw: this.slice(offset, 8) };
      case "i64": this.assertRange(offset, 8); return { value: view.getBigInt64(offset, le), length: 8, raw: this.slice(offset, 8) };
      case "f32": this.assertRange(offset, 4); return { value: view.getFloat32(offset, le), length: 4, raw: this.slice(offset, 4) };
      case "f64": this.assertRange(offset, 8); return { value: view.getFloat64(offset, le), length: 8, raw: this.slice(offset, 8) };
      default: throw new Error(`Unsupported primitive type: ${type}`);
    }
  }

  assertRange(offset: number, length: number): void {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      throw new RangeError(`Invalid read range offset=${offset} length=${length}`);
    }
    if (offset + length > this.bytes.byteLength) {
      throw new RangeError(`Read beyond end of file at offset ${offset} length ${length}; file is ${this.bytes.byteLength} bytes.`);
    }
  }
}

export function bytesToHex(bytes: Uint8Array, separator = ""): string {
  return Array.from(bytes).map(byte => byte.toString(16).padStart(2, "0").toUpperCase()).join(separator);
}
