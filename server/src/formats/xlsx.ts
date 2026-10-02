import { Workbook } from 'exceljs';

import { FileError } from '../errors';
import type { Table } from './csv';

export const XLSX_CELL_LIMIT = 32767;
export const NOT_EDITABLE_MARKER = '#NOT_EDITABLE_IN_XLSX: edit this field in CSV or JSON#';

const DATA_SHEET = 'data';
const META_SHEET = '_meta';
const META_HEADER = ['documentId', 'locale', 'field', 'length'];

export interface LongCell {
  documentId: string;
  locale: string;
  field: string;
  length: number;
}

// What exceljs drops, rewrites or cannot write back: control characters, a lone CR (read back as
// LF), literal `_xHHHH_` text (decoded as an escape) and U+FFFE / U+FFFF (unreadable workbook).
const UNSAFE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|\r(?!\n)|_x[0-9A-Fa-f]{4}_/;
// A high surrogate not followed by a low one, or a low one not preceded by a high one (becomes U+FFFD).
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** False when an XLSX cell cannot carry the string faithfully: too long or holding such characters. */
const xlsxSafe = (text: string): boolean =>
  text.length <= XLSX_CELL_LIMIT &&
  !UNSAFE.test(text) &&
  !LONE_SURROGATE.test(text) &&
  // Content that literally equals the marker must be recorded in _meta, or import could not tell them apart.
  text !== NOT_EDITABLE_MARKER;

// Not keyed by locale: copying an exported file to another locale must keep its markers valid.
const metaKey = (documentId: unknown, field: string): string => `${documentId ?? ''}|${field}`;

export async function toXlsx(table: Table): Promise<{ buffer: Buffer; longCells: LongCell[] }> {
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet(DATA_SHEET);
  const longCells: LongCell[] = [];

  sheet.addRow(table.columns);
  for (const row of table.rows) {
    sheet.addRow(
      table.columns.map((column) => {
        const value = row[column];
        if (typeof value === 'string' && !xlsxSafe(value)) {
          longCells.push({
            documentId: String(row.documentId ?? ''),
            locale: String(row.locale ?? ''),
            field: column,
            length: value.length,
          });
          return NOT_EDITABLE_MARKER;
        }
        return value ?? null;
      }),
    );
  }

  if (longCells.length) {
    const meta = workbook.addWorksheet(META_SHEET);
    meta.addRow(META_HEADER);
    for (const cell of longCells) meta.addRow([cell.documentId, cell.locale, cell.field, cell.length]);
  }

  return { buffer: Buffer.from(await workbook.xlsx.writeBuffer()), longCells };
}

const EOCD_SIGNATURE = 0x06054b50;
const ENTRY_SIGNATURE = 0x02014b50;

/** Sum of the uncompressed sizes declared in the zip central directory; throws FileError if unreadable. */
export function xlsxUncompressedSize(buffer: Buffer): number {
  const unreadable = () => new FileError('The file is not a readable XLSX workbook');
  // The end-of-central-directory record is 22 bytes plus a comment of up to 65535 bytes.
  let eocd = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at -= 1) {
    if (buffer.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw unreadable();

  const entries = buffer.readUInt16LE(eocd + 10);
  let at = buffer.readUInt32LE(eocd + 16);
  let total = 0;
  for (let index = 0; index < entries; index += 1) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== ENTRY_SIGNATURE) throw unreadable();
    total += buffer.readUInt32LE(at + 24);
    at += 46 + buffer.readUInt16LE(at + 28) + buffer.readUInt16LE(at + 30) + buffer.readUInt16LE(at + 32);
  }
  return total;
}

/** Cell value -> plain value; `where` is used in the error message. */
const readCell = (value: unknown, where: string): unknown => {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'object') return value;

  const cell = value as Record<string, any>;
  if ('formula' in cell || 'sharedFormula' in cell) {
    throw new FileError(`${where}: formula cells are not allowed - paste values only`);
  }
  if ('error' in cell) throw new FileError(`${where}: the cell holds a spreadsheet error (${cell.error})`);
  if (Array.isArray(cell.richText)) return cell.richText.map((part: any) => part.text).join('');
  if ('text' in cell) return readCell(cell.text, where);
  throw new FileError(`${where}: unsupported cell content`);
};

export interface XlsxLimits {
  maxRows: number;
  maxCells: number;
}

export async function fromXlsx(buffer: Buffer, limits?: XlsxLimits): Promise<Table> {
  const workbook = new Workbook();
  try {
    await workbook.xlsx.load(buffer as any);
  } catch {
    throw new FileError('The file is not a readable XLSX workbook');
  }

  const sheet = workbook.getWorksheet(DATA_SHEET) ?? workbook.worksheets[0];
  if (!sheet) throw new FileError('The workbook has no sheets');

  const names: string[] = [];
  for (let c = 1; c <= sheet.columnCount; c += 1) {
    names.push(String(readCell(sheet.getRow(1).getCell(c).value, `header, column ${c}`) ?? '').trim());
  }
  while (names.length && names[names.length - 1] === '') names.pop(); // styled but empty trailing cells
  const columns: string[] = [];
  names.forEach((name, index) => {
    if (!name) throw new FileError(`XLSX has an empty column name in the header (column ${index + 1})`);
    if (columns.includes(name)) throw new FileError(`XLSX has the column "${name}" more than once`);
    columns.push(name);
  });

  const confirmed = new Set<string>();
  const meta = workbook.getWorksheet(META_SHEET);
  if (meta) {
    const header = META_HEADER.map((_, index) => readCell(meta.getRow(1).getCell(index + 1).value, '_meta header'));
    if (header.join('|') !== META_HEADER.join('|')) {
      throw new FileError('The _meta sheet is malformed - export the file again');
    }
    meta.eachRow((metaRow, r) => {
      if (r === 1) return;
      const [documentId, field] = [1, 3].map((c) => readCell(metaRow.getCell(c).value, '_meta'));
      if (field) confirmed.add(metaKey(documentId, String(field)));
    });
  }

  // Checked before walking the sheet: `rowCount` is the LAST used row, so one stray cell far down
  // must not make us visit a million empty rows. `eachRow` only yields rows that hold something.
  if (limits) {
    const dataRows = Math.max(0, sheet.actualRowCount - 1);
    if (dataRows > limits.maxRows) throw new FileError(`The file has ${dataRows} rows; the limit is ${limits.maxRows}`);
    if (dataRows * columns.length > limits.maxCells) {
      throw new FileError(`The file has ${dataRows * columns.length} cells; the limit is ${limits.maxCells}`);
    }
  }

  const rows: Array<Record<string, unknown>> = [];
  const rowNumbers: number[] = [];
  sheet.eachRow((sheetRow, r) => {
    if (r === 1) return;
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      row[column] = readCell(sheetRow.getCell(index + 1).value, `row ${r - 1}, column "${column}"`);
    });
    if (Object.values(row).every((value) => value === null)) return;
    for (const column of columns) {
      if (row[column] !== NOT_EDITABLE_MARKER) continue;
      if (!confirmed.has(metaKey(row.documentId, column))) {
        throw new FileError(
          `row ${r - 1}, column "${column}": the not-editable marker is not confirmed by the _meta sheet - export the file again, or clear this cell`,
        );
      }
      delete row[column];
    }
    rows.push(row);
    rowNumbers.push(r - 1);
  });
  return { columns, rows, rowNumbers };
}
