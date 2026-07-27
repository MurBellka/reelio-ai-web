// CRC-32C (Castagnoli) — контрольная сумма объектов Cloud Storage.
//
// GCS отдаёт crc32c в base64 (big-endian uint32). Считаем сами, чтобы (а) в
// local mode заполнять RenderResult.checksumCrc32c и (б) в cloud mode сверять
// то, что вернул GCS, с тем, что реально загрузили.

const POLY = 0x82f63b78;

const TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

/** Инкрементальный CRC-32C: подходит для потоковой загрузки больших MP4. */
export class Crc32c {
  constructor() {
    this.state = 0 ^ -1;
  }

  update(chunk) {
    let crc = this.state;
    for (let i = 0; i < chunk.length; i += 1) {
      crc = TABLE[(crc ^ chunk[i]) & 0xff] ^ (crc >>> 8);
    }
    this.state = crc;
    return this;
  }

  /** Беззнаковое 32-битное значение. */
  value() {
    return (this.state ^ -1) >>> 0;
  }

  /** Формат метаданных GCS: base64 от big-endian uint32. */
  base64() {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(this.value(), 0);
    return buf.toString('base64');
  }
}

export function crc32c(buffer) {
  return new Crc32c().update(buffer).value();
}

export function crc32cBase64(buffer) {
  return new Crc32c().update(buffer).base64();
}
