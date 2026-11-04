/**
 * Trendz Tracker — Phase 17a: Zero-Dependency .xlsx Formula & Cell Inspector (scripts/inspectJmcwcWorkbooks.js)
 *
 * Parses .xlsx (OpenXML ZIP) workbooks using only Node.js built-in `node:fs` and `node:zlib`
 * (honoring the "No new dependency" constraint).
 *
 * Extracts:
 * - Ordered sheet list with visibility state (`visible` vs `hidden` / `veryHidden`)
 * - Shared string table (`xl/sharedStrings.xml`)
 * - Every populated cell's coordinate (e.g. `H7`, `B43`, `BD229`, `S51`), formula (`<f>`),
 *   resolved string/cached value (`<v>` / `<is>`), and error markers (`#REF!`, `#NAME?`, `#VALUE!`, `#N/A`).
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Parse a ZIP buffer and return a Map of `filename -> Buffer`.
 */
export function unzipBuffer(buf) {
  const entries = new Map();
  // Locate End of Central Directory (EOCD) signature 0x06054b50
  let eocdOffset = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid .xlsx ZIP archive: EOCD signature not found');
  }

  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const cdOffset = buf.readUInt32LE(eocdOffset + 16);

  let ptr = cdOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`Invalid Central Directory header at offset ${ptr}`);
    }
    const compressionMethod = buf.readUInt16LE(ptr + 10);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const fileNameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localHeaderOffset = buf.readUInt32LE(ptr + 42);
    const fileName = buf.subarray(ptr + 46, ptr + 46 + fileNameLen).toString('utf8');

    // Read Local File Header at localHeaderOffset
    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid Local File Header for ${fileName}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawSlice = buf.subarray(dataStart, dataStart + compressedSize);

    if (compressionMethod === 0) {
      entries.set(fileName, rawSlice);
    } else if (compressionMethod === 8) {
      entries.set(fileName, zlib.inflateRawSync(rawSlice));
    }

    ptr += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

function decodeXmlEntities(str) {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse an .xlsx file buffer into structured workbook metadata, sheets, and cells.
 */
export function parseXlsxBuffer(buf) {
  const files = unzipBuffer(buf);

  // 1. Shared Strings
  const sharedStrings = [];
  if (files.has('xl/sharedStrings.xml')) {
    const sstXml = files.get('xl/sharedStrings.xml').toString('utf8');
    const siMatches = sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g);
    for (const m of siMatches) {
      const inner = m[1];
      const tParts = [...inner.matchAll(/<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>/g)].map((tm) =>
        decodeXmlEntities(tm[1])
      );
      sharedStrings.push(tParts.join(''));
    }
  }

  // 2. Workbook Relationships (`xl/_rels/workbook.xml.rels`)
  const relMap = new Map();
  if (files.has('xl/_rels/workbook.xml.rels')) {
    const relsXml = files.get('xl/_rels/workbook.xml.rels').toString('utf8');
    for (const m of relsXml.matchAll(/<Relationship\b([^>]+)\/?>/g)) {
      const attrs = m[1];
      const idMatch = attrs.match(/\bId="([^"]+)"/);
      const targetMatch = attrs.match(/\bTarget="([^"]+)"/);
      if (idMatch && targetMatch) {
        let target = targetMatch[1].replace(/^\//, '');
        if (!target.startsWith('xl/')) {
          target = `xl/${target}`;
        }
        relMap.set(idMatch[1], target);
      }
    }
  }

  // 3. Workbook Sheet List (`xl/workbook.xml`)
  const sheets = [];
  if (files.has('xl/workbook.xml')) {
    const wbXml = files.get('xl/workbook.xml').toString('utf8');
    for (const m of wbXml.matchAll(/<sheet\b([^>]+)\/?>/g)) {
      const attrs = m[1];
      const name = decodeXmlEntities((attrs.match(/\bname="([^"]+)"/) || [])[1] || '');
      const sheetId = (attrs.match(/\bsheetId="([^"]+)"/) || [])[1] || '';
      const state = (attrs.match(/\bstate="([^"]+)"/) || [])[1] || 'visible';
      const rId = (attrs.match(/\br:id="([^"]+)"/) || [])[1] || '';
      const xmlPath = relMap.get(rId) || `xl/worksheets/sheet${sheetId}.xml`;
      sheets.push({ name, sheetId, state, rId, xmlPath });
    }
  }

  // 4. Parse cells and formulas in each worksheet
  const parsedSheets = sheets.map((sheet) => {
    const cells = {};
    const brokenCells = [];
    if (files.has(sheet.xmlPath)) {
      const wsXml = files.get(sheet.xmlPath).toString('utf8');
      for (const cm of wsXml.matchAll(/<c\b([^/>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cm[1];
        const inner = cm[2] || '';
        const ref = (attrs.match(/\br="([A-Z]+\d+)"/) || [])[1];
        if (!ref) continue;
        const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
        const fMatch = inner.match(/<f(?:\s+[^>]*)?>([\s\S]*?)<\/f>/);
        const vMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        const isMatch = inner.match(/<is>[\s\S]*?<t(?:\s+[^>]*)?>([\s\S]*?)<\/t>[\s\S]*?<\/is>/);

        const formula = fMatch ? decodeXmlEntities(fMatch[1]) : null;
        let value = vMatch ? decodeXmlEntities(vMatch[1]) : null;
        if (type === 's' && value !== null) {
          const idx = Number(value);
          value = sharedStrings[idx] ?? value;
        } else if (type === 'inlineStr' && isMatch) {
          value = decodeXmlEntities(isMatch[1]);
        }

        if (formula !== null || value !== null) {
          cells[ref] = { type, formula, value };
          const hasError =
            type === 'e' ||
            (formula && /#REF!|#NAME\?|#VALUE!|#N\/A|#DIV\/0!/i.test(formula)) ||
            (typeof value === 'string' && /^#(REF!|NAME\?|VALUE!|N\/A|DIV\/0!|NUM!)$/i.test(value));
          if (hasError) {
            brokenCells.push({ ref, type, formula, value });
          }
        }
      }
    }
    return {
      ...sheet,
      cellCount: Object.keys(cells).length,
      brokenCells,
      cells,
    };
  });

  return { sheets: parsedSheets };
}

export function inspectWorkbookFile(filePath) {
  const buf = fs.readFileSync(filePath);
  return parseXlsxBuffer(buf);
}
