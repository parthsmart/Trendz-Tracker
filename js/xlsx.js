/**
 * Trendz Tracker - Minimal dependency-free .xlsx writer and reader (js/xlsx.js)
 *
 * - Pure ES module (browser + Node 22): no DOM, no network.
 * - Writer: one worksheet per sheet, inline strings (never evaluated as formulas),
 *   frozen bold header row, optional DEFLATE via CompressionStream.
 * - Reader: parses workbooks written by this module and by Excel / LibreOffice
 *   (shared strings, inline strings, numbers, booleans; stored or deflated ZIP entries).
 */

import { crc32 } from './backupExport.js';

export const XLSX_MAX_CELL_CHARS = 32767;
export const XLSX_MAX_ROWS = 1048576;
export const XLSX_MAX_SHEET_NAME = 31;

const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ============================================================================
// XML text escaping (OOXML ST_Xstring rules)
// ============================================================================

const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000D\u000E-\u001F￾￿]/g;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Escapes a string for an OOXML text node. Literal `_xHHHH_` sequences are protected,
 * and characters XML 1.0 cannot carry (control characters, CR) are written as `_xHHHH_`
 * so they survive a round trip exactly.
 */
export function escapeXmlText(value) {
  let s = String(value);
  s = s.replace(/_x([0-9A-Fa-f]{4})_/g, '_x005F_x$1_');
  s = s.replace(INVALID_XML_CHARS, (ch) => `_x${ch.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`);
  s = s.replace(LONE_SURROGATE, '�');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(value) {
  return escapeXmlText(value).replace(/"/g, '&quot;');
}

/** Reverses XML entity escaping and OOXML `_xHHHH_` escaping. */
export function unescapeXmlText(xml) {
  const s = String(xml).replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (m, ent) => {
    if (ent === 'amp') return '&';
    if (ent === 'lt') return '<';
    if (ent === 'gt') return '>';
    if (ent === 'quot') return '"';
    if (ent === 'apos') return "'";
    const code = ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
    return String.fromCodePoint(code);
  });
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/** 0 -> A, 25 -> Z, 26 -> AA ... */
export function columnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function columnIndexFromLetters(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ============================================================================
// ZIP container (store or deflate)
// ============================================================================

/**
 * Compresses bytes with raw DEFLATE using the platform CompressionStream.
 * Returns null when the platform cannot compress (the entry is then stored).
 */
export async function deflateRaw(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This environment cannot read compressed ZIP entries (no DecompressionStream).');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toDosDateTime(d) {
  const year = Math.max(1980, d.getUTCFullYear());
  return {
    dosTime: ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | (Math.floor(d.getUTCSeconds() / 2) & 0x1f),
    dosDate: (((year - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0x0f) << 5) | (d.getUTCDate() & 0x1f),
  };
}

/**
 * Builds a ZIP archive. Each entry: { name, data: Uint8Array, compressed?: Uint8Array }.
 * `compressed` (raw deflate of `data`) is used when present and smaller.
 */
export function buildZip(entries, timestamp = new Date()) {
  const { dosTime, dosDate } = toDosDateTime(timestamp);
  const prepared = entries.map((e) => {
    const nameBytes = encoder.encode(String(e.name));
    const useDeflate = e.compressed instanceof Uint8Array && e.compressed.length < e.data.length;
    return {
      nameBytes,
      method: useDeflate ? 8 : 0,
      payload: useDeflate ? e.compressed : e.data,
      size: e.data.length,
      crc: crc32(e.data),
    };
  });

  let total = 22;
  for (const p of prepared) total += 30 + p.nameBytes.length + p.payload.length + 46 + p.nameBytes.length;
  if (total > 0xffffffff) throw new Error('Backup is larger than 4 GB; split it into smaller exports.');

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  const offsets = [];

  for (const p of prepared) {
    offsets.push(off);
    view.setUint32(off, 0x04034b50, true);
    view.setUint16(off + 4, 20, true);
    view.setUint16(off + 6, 0x0800, true);
    view.setUint16(off + 8, p.method, true);
    view.setUint16(off + 10, dosTime, true);
    view.setUint16(off + 12, dosDate, true);
    view.setUint32(off + 14, p.crc, true);
    view.setUint32(off + 18, p.payload.length, true);
    view.setUint32(off + 22, p.size, true);
    view.setUint16(off + 26, p.nameBytes.length, true);
    view.setUint16(off + 28, 0, true);
    off += 30;
    out.set(p.nameBytes, off);
    off += p.nameBytes.length;
    out.set(p.payload, off);
    off += p.payload.length;
  }

  const cdStart = off;
  prepared.forEach((p, i) => {
    view.setUint32(off, 0x02014b50, true);
    view.setUint16(off + 4, 20, true);
    view.setUint16(off + 6, 20, true);
    view.setUint16(off + 8, 0x0800, true);
    view.setUint16(off + 10, p.method, true);
    view.setUint16(off + 12, dosTime, true);
    view.setUint16(off + 14, dosDate, true);
    view.setUint32(off + 16, p.crc, true);
    view.setUint32(off + 20, p.payload.length, true);
    view.setUint32(off + 24, p.size, true);
    view.setUint16(off + 28, p.nameBytes.length, true);
    view.setUint16(off + 30, 0, true);
    view.setUint16(off + 32, 0, true);
    view.setUint16(off + 34, 0, true);
    view.setUint16(off + 36, 0, true);
    view.setUint32(off + 38, 0, true);
    view.setUint32(off + 42, offsets[i], true);
    off += 46;
    out.set(p.nameBytes, off);
    off += p.nameBytes.length;
  });

  view.setUint32(off, 0x06054b50, true);
  view.setUint16(off + 4, 0, true);
  view.setUint16(off + 6, 0, true);
  view.setUint16(off + 8, prepared.length, true);
  view.setUint16(off + 10, prepared.length, true);
  view.setUint32(off + 12, off - cdStart, true);
  view.setUint32(off + 16, cdStart, true);
  view.setUint16(off + 20, 0, true);
  return out;
}

/**
 * Reads every entry of a ZIP archive into a Map(name -> Uint8Array), verifying CRC-32.
 */
export async function readZip(bytes, { inflate = inflateRaw } = {}) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (ZIP directory not found).');

  const count = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const files = new Map();

  for (let i = 0; i < count; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.');
    const method = view.getUint16(ptr + 10, true);
    const crc = view.getUint32(ptr + 16, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = decoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflate(raw);
    else throw new Error(`Unsupported ZIP compression method ${method} in ${name}.`);
    if (crc32(data) !== crc) throw new Error(`Checksum mismatch in ${name}; the file is damaged.`);
    files.set(name, data);
  }
  return files;
}

// ============================================================================
// Workbook writer
// ============================================================================

function cellXml(ref, value, styleId) {
  const s = styleId ? ` s="${styleId}"` : '';
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return `<c r="${ref}" t="b"${s}><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number' && Number.isFinite(value)) return `<c r="${ref}"${s}><v>${value}</v></c>`;
  const text = String(value);
  if (text.length > XLSX_MAX_CELL_CHARS) {
    throw new Error(`Cell ${ref} has ${text.length} characters; Excel allows ${XLSX_MAX_CELL_CHARS}.`);
  }
  return `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${escapeXmlText(text)}</t></is></c>`;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function sheetXmlChunks(sheet, { yieldEvery, onRow }) {
  const chunks = [];
  const header = Array.isArray(sheet.header) ? sheet.header : null;
  const widths = Array.isArray(sheet.widths) ? sheet.widths : [];
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}">`;
  if (header) {
    xml += '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  }
  if (widths.length) {
    xml += '<cols>' + widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${Number(w) || 12}" customWidth="1"/>`).join('') + '</cols>';
  }
  xml += '<sheetData>';
  chunks.push(xml);

  let rowNum = 0;
  let buf = '';
  const writeRow = (cells, styleId) => {
    rowNum += 1;
    let rowXml = `<row r="${rowNum}">`;
    for (let c = 0; c < cells.length; c++) rowXml += cellXml(`${columnLetter(c)}${rowNum}`, cells[c], styleId);
    buf += rowXml + '</row>';
  };

  if (header) writeRow(header, 1);
  let n = 0;
  for (const row of sheet.rows || []) {
    writeRow(row, 0);
    n += 1;
    if (onRow) onRow();
    if (n % yieldEvery === 0) {
      chunks.push(buf);
      buf = '';
      await tick();
    }
  }
  if (rowNum > XLSX_MAX_ROWS) throw new Error(`Sheet "${sheet.name}" exceeds Excel's ${XLSX_MAX_ROWS} row limit.`);
  chunks.push(buf + '</sheetData></worksheet>');
  return chunks;
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * Builds an .xlsx workbook.
 *
 * @param {Array<{ name: string, header?: Array<string>, rows: Iterable<Array<string|number|boolean|null>>, widths?: number[] }>} sheets
 * @param {{ compress?: boolean, yieldEvery?: number, onRow?: () => void, onSheet?: (name: string, index: number) => void }} [opts]
 * @returns {Promise<Uint8Array>}
 */
export async function buildXlsx(sheets, opts = {}) {
  const { compress = true, yieldEvery = 1000, onRow, onSheet } = opts;
  const seen = new Set();
  for (const sheet of sheets) {
    const name = String(sheet.name || '');
    if (!name || name.length > XLSX_MAX_SHEET_NAME || /[\[\]:*?/\\]/.test(name)) {
      throw new Error(`Invalid sheet name "${name}".`);
    }
    const key = name.toLowerCase();
    if (seen.has(key)) throw new Error(`Duplicate sheet name "${name}".`);
    seen.add(key);
  }

  const files = [];
  const addFile = async (name, data) => {
    const compressed = compress ? await deflateRaw(data) : null;
    files.push({ name, data, compressed });
  };

  const sheetOverrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  await addFile(
    '[Content_Types].xml',
    encoder.encode(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        sheetOverrides +
        '</Types>'
    )
  );
  await addFile(
    '_rels/.rels',
    encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    )
  );
  await addFile(
    'xl/workbook.xml',
    encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
        sheets.map((s, i) => `<sheet name="${escapeXmlAttr(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        '</sheets></workbook>'
    )
  );
  await addFile(
    'xl/_rels/workbook.xml.rels',
    encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${NS_PKG_REL}">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/>` +
        '</Relationships>'
    )
  );
  await addFile(
    'xl/styles.xml',
    encoder.encode(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${NS_MAIN}">` +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>'
    )
  );

  for (let i = 0; i < sheets.length; i++) {
    if (onSheet) onSheet(sheets[i].name, i);
    const chunks = await sheetXmlChunks(sheets[i], { yieldEvery, onRow });
    const bytes = concatBytes(chunks.map((c) => encoder.encode(c)));
    await addFile(`xl/worksheets/sheet${i + 1}.xml`, bytes);
    await tick();
  }

  return buildZip(files);
}

// ============================================================================
// Workbook reader
// ============================================================================

function readAttr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? unescapeXmlText(m[1]) : null;
}

function collectText(xml) {
  // Ignore phonetic runs; join every <t> in order.
  const clean = String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').replace(/<t\b[^>]*\/>/g, '<t></t>');
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
  let m;
  while ((m = re.exec(clean))) out += unescapeXmlText(m[1]);
  return out;
}

function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/**
 * Parses an .xlsx file.
 * Each cell is `null` (blank) or `{ type: 's' | 'n' | 'b' | 'e', value }` where numbers keep their raw text.
 *
 * @returns {Promise<{ sheets: Array<{ name: string, rows: Array<Array<null | { type: string, value: any }>> }> }>}
 */
export async function readXlsx(bytes, opts = {}) {
  const files = await readZip(bytes, opts);
  const text = (name) => {
    const data = files.get(name);
    return data ? decoder.decode(data) : null;
  };

  const workbookXml = text('xl/workbook.xml');
  if (!workbookXml) throw new Error('Not an Excel workbook (xl/workbook.xml missing).');
  const relsXml = text('xl/_rels/workbook.xml.rels') || '';
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    rels.set(readAttr(m[1], 'Id'), readAttr(m[1], 'Target'));
  }

  const shared = [];
  const sstXml = text('xl/sharedStrings.xml');
  if (sstXml) {
    for (const m of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) shared.push(m[1] ? collectText(m[1]) : '');
  }

  const sheets = [];
  for (const m of workbookXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = readAttr(m[1], 'name');
    const rid = readAttr(m[1], 'r:id');
    const target = rels.get(rid);
    if (!target) continue;
    const xml = text(resolvePath('xl/workbook.xml', target)) || '';
    const rows = [];
    let nextRow = 0;
    for (const rm of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rAttr = readAttr(rm[1], 'r');
      const rowIndex = rAttr ? Number(rAttr) - 1 : nextRow;
      nextRow = rowIndex + 1;
      const cells = [];
      let nextCol = 0;
      for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = readAttr(cm[1], 'r');
        const col = ref ? columnIndexFromLetters(ref.replace(/\d+/g, '')) : nextCol;
        nextCol = col + 1;
        const t = readAttr(cm[1], 't') || 'n';
        const inner = cm[2] || '';
        const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
        const v = vMatch ? unescapeXmlText(vMatch[1]) : null;
        let cell = null;
        if (t === 'inlineStr') cell = { type: 's', value: collectText(inner) };
        else if (t === 's') cell = v === null ? null : { type: 's', value: shared[Number(v)] ?? '' };
        else if (t === 'str') cell = { type: 's', value: v ?? '' };
        else if (t === 'b') cell = v === null ? null : { type: 'b', value: v === '1' || v === 'true' };
        else if (t === 'e') cell = { type: 'e', value: v };
        else cell = v === null || v === '' ? null : { type: 'n', value: v };
        while (cells.length < col) cells.push(null);
        cells[col] = cell;
      }
      while (rows.length < rowIndex) rows.push([]);
      rows[rowIndex] = cells;
    }
    sheets.push({ name, rows });
  }
  return { sheets };
}
