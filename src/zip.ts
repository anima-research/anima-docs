// A zip archive of stored files, written as a stream: a folder of a collection,
// downloaded in one piece. Files are stored, not compressed (PDFs, photos and
// video gain nothing from it, and nothing is held in memory). Each file is read
// twice, once for its checksum and once for its bytes, so every header is exact
// and every unzip program can read the archive; ZIP64 where the archive needs it
// (more than 65,535 files, or past 4 GB).

import { createReadStream } from 'node:fs';
import { crc32 } from 'node:zlib';

export interface ZipEntry { name: string; file: string; size: number; mtime: number }

const U32 = 0xffffffff;

function dosTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
async function checksum(file: string): Promise<number> {
  let c = 0;
  for await (const chunk of createReadStream(file)) c = crc32(chunk as Buffer, c);
  return c >>> 0;
}

export async function* zipStream(entries: ZipEntry[]): AsyncGenerator<Buffer> {
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const crc = await checksum(e.file);
    const { time, date } = dosTime(e.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(0x0800, 6);        // names are UTF-8
    local.writeUInt16LE(0, 8);             // stored
    local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(e.size, 18); local.writeUInt32LE(e.size, 22);
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
    yield Buffer.concat([local, name]);
    if (e.size) for await (const chunk of createReadStream(e.file)) yield chunk as Buffer;

    // Past 4 GB the file's place in the archive goes in a ZIP64 field.
    const far = offset >= U32;
    const extra = far ? Buffer.alloc(12) : Buffer.alloc(0);
    if (far) { extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8, 2); extra.writeBigUInt64LE(BigInt(offset), 4); }
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE((3 << 8) | 45, 4);  // made on unix
    head.writeUInt16LE(far ? 45 : 20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(time, 12); head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(e.size, 20); head.writeUInt32LE(e.size, 24);
    head.writeUInt16LE(name.length, 28); head.writeUInt16LE(extra.length, 30);
    head.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    head.writeUInt32LE(far ? U32 : offset, 42);
    central.push(head, name, extra);
    offset += 30 + name.length + e.size;
  }
  const dir = Buffer.concat(central);
  yield dir;
  const zip64 = entries.length > 0xffff || offset >= U32 || dir.length >= U32;
  if (zip64) {
    const end64 = Buffer.alloc(56);
    end64.writeUInt32LE(0x06064b50, 0);
    end64.writeBigUInt64LE(44n, 4);
    end64.writeUInt16LE((3 << 8) | 45, 12); end64.writeUInt16LE(45, 14);
    end64.writeBigUInt64LE(BigInt(entries.length), 24); end64.writeBigUInt64LE(BigInt(entries.length), 32);
    end64.writeBigUInt64LE(BigInt(dir.length), 40); end64.writeBigUInt64LE(BigInt(offset), 48);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50, 0);
    locator.writeBigUInt64LE(BigInt(offset + dir.length), 8);
    locator.writeUInt32LE(1, 16);
    yield Buffer.concat([end64, locator]);
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Math.min(entries.length, 0xffff), 8); end.writeUInt16LE(Math.min(entries.length, 0xffff), 10);
  end.writeUInt32LE(Math.min(dir.length, U32), 12);
  end.writeUInt32LE(Math.min(offset, U32), 16);
  yield end;
}
