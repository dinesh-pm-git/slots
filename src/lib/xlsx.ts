/**
 * A very small .xlsx writer: enough for a single sheet of text and numbers.
 *
 * An .xlsx is a ZIP of XML parts. Writing those few parts by hand costs about
 * a hundred lines and keeps the dependency count at zero - the alternative
 * pulled in 96 packages and an advisory to produce one table.
 *
 * Entries are STORED rather than deflated. Spreadsheet readers accept that,
 * and it removes compression from the list of things that can be subtly wrong.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let bit = 0; bit < 8; bit += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Escapes the five XML entities, and drops characters XML 1.0 forbids.
 *
 * Tab, newline and carriage return are legal; every other control character
 * makes the file unreadable to Excel. Checked by code point rather than a
 * regex so the source carries no literal control characters of its own.
 */
function xmlEscape(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    const legal = code > 0x1f || code === 0x09 || code === 0x0a || code === 0x0d;
    if (legal) cleaned += char;
  }

  return cleaned
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 0 -> A, 25 -> Z, 26 -> AA */
function columnName(index: number): string {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

type ZipEntry = { name: string; data: Uint8Array };

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function dosDateTime(date: Date): { time: number; date: number } {
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date:
      ((date.getFullYear() - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate(),
  };
}

function buildZip(entries: ZipEntry[], now = new Date()): Uint8Array {
  const { time, date } = dosDateTime(now);
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = textBytes(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true); // local file header
    localView.setUint16(4, 20, true); // version needed
    localView.setUint16(6, 0, true); // flags
    localView.setUint16(8, 0, true); // method: stored
    localView.setUint16(10, time, true);
    localView.setUint16(12, date, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, size, true); // compressed
    localView.setUint32(22, size, true); // uncompressed
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true); // central directory header
    centralView.setUint16(4, 20, true); // version made by
    centralView.setUint16(6, 20, true); // version needed
    centralView.setUint16(8, 0, true);
    centralView.setUint16(10, 0, true); // stored
    centralView.setUint16(12, time, true);
    centralView.setUint16(14, date, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, size, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint16(30, 0, true); // extra
    centralView.setUint16(32, 0, true); // comment
    centralView.setUint16(34, 0, true); // disk number
    centralView.setUint16(36, 0, true); // internal attrs
    centralView.setUint32(38, 0, true); // external attrs
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true); // end of central directory
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);

  const total =
    locals.reduce((sum, part) => sum + part.length, 0) + centralSize + 22;
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of [...locals, ...centrals, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export type SheetCell = string | number | null | undefined;

export type Sheet = {
  name: string;
  headers: string[];
  rows: SheetCell[][];
};

const SHEET_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function sheetXml({ headers, rows }: Sheet): string {
  const allRows: SheetCell[][] = [headers, ...rows];

  const sheetRows = allRows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndex) => {
          const ref = `${columnName(columnIndex)}${rowIndex + 1}`;
          if (value === null || value === undefined || value === "") {
            return "";
          }
          if (typeof value === "number" && Number.isFinite(value)) {
            return `<c r="${ref}"><v>${value}</v></c>`;
          }
          const style = rowIndex === 0 ? ' s="1"' : "";
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
        })
        .join("");
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join("");

  const widths = headers
    .map((header, index) => {
      const longest = allRows.reduce(
        (max, row) => Math.max(max, String(row[index] ?? "").length),
        header.length,
      );
      return `<col min="${index + 1}" max="${index + 1}" width="${Math.min(Math.max(longest + 2, 10), 60)}" customWidth="1"/>`;
    })
    .join("");

  // An empty <cols/> is invalid, so a sheet without headers has none.
  const cols = widths ? `<cols>${widths}</cols>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${SHEET_NS}">${cols}<sheetData>${sheetRows}</sheetData></worksheet>`;
}

/**
 * Excel rejects a sheet name over 31 characters, one containing : \ / ? * [ ],
 * and two sheets whose names differ only in case.
 */
function sheetNames(sheets: Sheet[]): string[] {
  const seen = new Set<string>();
  return sheets.map((sheet, index) => {
    const base =
      sheet.name.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) ||
      `Sheet${index + 1}`;
    let name = base;
    for (let n = 2; seen.has(name.toLowerCase()); n += 1) {
      const suffix = ` (${n})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    seen.add(name.toLowerCase());
    return name;
  });
}

/**
 * Builds a workbook with one sheet per entry, in order. Numbers are written as
 * numbers so they sort and total correctly; everything else becomes an inline
 * string, which avoids a shared-strings part altogether.
 */
export function buildWorkbook(sheets: Sheet[]): Uint8Array {
  if (sheets.length === 0) throw new Error("A workbook needs a sheet.");

  const names = sheetNames(sheets);
  const numbers = sheets.map((_, index) => index + 1);
  const stylesId = sheets.length + 1;

  const entries: ZipEntry[] = [
    {
      name: "[Content_Types].xml",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${numbers
          .map(
            (n) =>
              `<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
          )
          .join(
            "",
          )}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
      ),
    },
    {
      name: "_rels/.rels",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/workbook.xml",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>${numbers
          .map(
            (n) =>
              `<sheet name="${xmlEscape(names[n - 1])}" sheetId="${n}" r:id="rId${n}"/>`,
          )
          .join("")}</sheets></workbook>`,
      ),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${numbers
          .map(
            (n) =>
              `<Relationship Id="rId${n}" Type="${REL_NS}/worksheet" Target="worksheets/sheet${n}.xml"/>`,
          )
          .join(
            "",
          )}<Relationship Id="rId${stylesId}" Type="${REL_NS}/styles" Target="styles.xml"/></Relationships>`,
      ),
    },
    {
      name: "xl/styles.xml",
      data: textBytes(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${SHEET_NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs></styleSheet>`,
      ),
    },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: textBytes(sheetXml(sheet)),
    })),
  ];

  return buildZip(entries);
}

/** A one-sheet workbook. */
export function buildXlsx(
  sheetName: string,
  headers: string[],
  rows: SheetCell[][],
): Uint8Array {
  return buildWorkbook([{ name: sheetName, headers, rows }]);
}

/** RFC 4180 CSV. Excel needs the BOM to read UTF-8 correctly. */
export function buildCsv(headers: string[], rows: SheetCell[][]): string {
  const escape = (value: SheetCell): string => {
    if (value === null || value === undefined) return "";
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return (
    "﻿" +
    [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")
  );
}
