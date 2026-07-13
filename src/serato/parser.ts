/**
 * Serato binary format reader.
 *
 * Both "database V2" and ".crate" files are a flat sequence of records:
 *   [4-byte ASCII tag][4-byte uint32 big-endian length][payload of that length]
 *
 * Payload interpretation is keyed off the tag's first letter:
 *   o*  nested sequence of records (e.g. `otrk` = one track, `ovct` = a column)
 *   t*  UTF-16 big-endian text     (tsng title, tart artist, tbpm, tkey, ...)
 *   p*  UTF-16 big-endian text path (pfil file path, ptrk crate entry)
 *   u*  uint32 big-endian
 *   s*  int32 big-endian
 *   b*  single boolean byte
 *   vrsn  version string (UTF-16 BE)
 *
 * Verified against a real 55MB `database V2`: header `vrsn` then repeated `otrk`,
 * each holding `ttyp`,`pfil`,`tsng`,`tlen`,`tsiz`,`tbit`,... exactly as above.
 */

const utf16be = new TextDecoder("utf-16be");

export interface RawRecord {
  tag: string;
  /** For o*: the nested records. */
  children?: RawRecord[];
  /** For t* / p* / vrsn: decoded string. */
  text?: string;
  /** For u* / s*: numeric value. */
  num?: number;
  /** For b*: boolean. */
  bool?: boolean;
}

/** Parse a buffer region into a flat list of records (recursing into o* records). */
export function parseRecords(buf: Buffer, start = 0, end = buf.length): RawRecord[] {
  const records: RawRecord[] = [];
  let off = start;
  while (off + 8 <= end) {
    const tag = buf.toString("latin1", off, off + 4);
    const len = buf.readUInt32BE(off + 4);
    const payloadStart = off + 8;
    const payloadEnd = payloadStart + len;
    if (payloadEnd > end) break; // truncated / corrupt tail — stop cleanly

    const rec: RawRecord = { tag };
    const kind = tag[0];
    if (kind === "o") {
      rec.children = parseRecords(buf, payloadStart, payloadEnd);
    } else if (kind === "t" || kind === "p" || tag === "vrsn") {
      rec.text = utf16be.decode(buf.subarray(payloadStart, payloadEnd)).replace(/\0+$/, "");
    } else if (kind === "u") {
      rec.num = len >= 4 ? buf.readUInt32BE(payloadStart) : 0;
    } else if (kind === "s") {
      rec.num = len >= 4 ? buf.readInt32BE(payloadStart) : 0;
    } else if (kind === "b") {
      rec.bool = len >= 1 ? buf.readUInt8(payloadStart) !== 0 : false;
    }
    // unknown kinds: keep the tag, skip payload

    records.push(rec);
    off = payloadEnd;
  }
  return records;
}

/** Flatten an otrk's child records into a plain tag->value map. */
export function fieldsOf(track: RawRecord): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const c of track.children ?? []) {
    if (c.text !== undefined) out[c.tag] = c.text;
    else if (c.num !== undefined) out[c.tag] = c.num;
    else if (c.bool !== undefined) out[c.tag] = c.bool;
  }
  return out;
}

/** Extract the ordered list of ptrk paths from a parsed .crate. */
export function crateTrackPaths(records: RawRecord[]): string[] {
  const paths: string[] = [];
  for (const r of records) {
    if (r.tag === "otrk" && r.children) {
      for (const c of r.children) {
        if (c.tag === "ptrk" && c.text) paths.push(c.text);
      }
    }
  }
  return paths;
}
