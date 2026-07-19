// A minimal zip reader over Node's zlib, enough for GTFS archives:
// stored and deflated entries, no zip64, no encryption. Parses the end
// of central directory record, walks the central directory, and
// inflates entries on demand.

import { inflateRawSync } from "node:zlib";

export interface ZipEntry {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
  method: number;
  offset: number;
}

export class ZipReader {
  private buf: Buffer;
  readonly entries: Map<string, ZipEntry>;

  constructor(buf: Buffer) {
    this.buf = buf;
    this.entries = new Map();
    // End of central directory: scan backward for PK\x05\x06 within the
    // final 64 KB (comment can pad the tail).
    const scanFrom = Math.max(0, buf.length - 65558);
    let eocd = -1;
    for (let i = buf.length - 22; i >= scanFrom; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) {
      throw new Error("zip: no end-of-central-directory record");
    }
    const count = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n++) {
      if (buf.readUInt32LE(p) !== 0x02014b50) {
        throw new Error("zip: bad central directory entry");
      }
      const method = buf.readUInt16LE(p + 10);
      const compressedSize = buf.readUInt32LE(p + 20);
      const uncompressedSize = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28);
      const extraLen = buf.readUInt16LE(p + 30);
      const commentLen = buf.readUInt16LE(p + 32);
      const offset = buf.readUInt32LE(p + 42);
      const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
      this.entries.set(name, {
        name,
        compressedSize,
        uncompressedSize,
        method,
        offset,
      });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  read(name: string): Buffer {
    const e = this.entries.get(name);
    if (!e) {
      throw new Error(`zip: no entry ${name}`);
    }
    const p = e.offset;
    if (this.buf.readUInt32LE(p) !== 0x04034b50) {
      throw new Error(`zip: bad local header for ${name}`);
    }
    // Local header name/extra lengths can differ from the central
    // directory's; trust the local record for the data offset.
    const nameLen = this.buf.readUInt16LE(p + 26);
    const extraLen = this.buf.readUInt16LE(p + 28);
    const start = p + 30 + nameLen + extraLen;
    const raw = this.buf.subarray(start, start + e.compressedSize);
    if (e.method === 0) {
      return Buffer.from(raw);
    }
    if (e.method === 8) {
      return inflateRawSync(raw);
    }
    throw new Error(`zip: unsupported compression method ${e.method} for ${name}`);
  }
}
