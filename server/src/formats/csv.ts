import { parse, unparse } from 'papaparse';

import { FileError } from '../errors';

export interface Table {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** 1-based data-row number in the file (header excluded), parallel to `rows`; absent for JSON. */
  rowNumbers?: number[];
}

// A spreadsheet treats these as the start of a formula; TAB, CR and ' are escaped too so that
// the transformation stays reversible.
const needsEscape = (text: string): boolean => /^\s*[=+\-@]/.test(text) || /^[\t\r']/.test(text);

export const escapeCell = (value: unknown): unknown =>
  typeof value === 'string' && needsEscape(value) ? `'${value}` : value;

export const unescapeCell = (text: string): string =>
  text.startsWith("'") && needsEscape(text.slice(1)) ? text.slice(1) : text;

const BOM = '\uFEFF';

export function toCsv(table: Table): string {
  const data = table.rows.map((row) =>
    table.columns.map((column) => {
      const value = escapeCell(row[column]);
      return value === null || value === undefined ? '' : String(value);
    }),
  );
  return BOM + unparse({ fields: table.columns, data });
}

export function fromCsv(text: string): Table {
  const body = text.startsWith(BOM) ? text.slice(1) : text;
  if (!body.trim()) return { columns: [], rows: [] };

  // Blank records are skipped here, not by papaparse, so that rows keep their number in the file.
  // Blank records also skew papaparse's delimiter guess, so the delimiter is guessed without them.
  const { delimiter } = parse<string[]>(body, { skipEmptyLines: 'greedy', preview: 10 }).meta;
  const result = parse<string[]>(body, { delimiter });
  const fatal = result.errors.find((error) => error.type === 'Quotes');
  if (fatal) throw new FileError(`CSV is malformed near line ${(fatal.row ?? 0) + 1}: ${fatal.message}`);

  const blank = (record: string[]) => record.every((cell) => cell.trim() === '');
  const start = result.data.findIndex((record) => !blank(record));
  const header = start < 0 ? [] : result.data[start];
  const lines: string[][] = [];
  const rowNumbers: number[] = [];
  result.data.slice(start + 1).forEach((record, index) => {
    if (blank(record)) return;
    lines.push(record);
    rowNumbers.push(index + 1);
  });
  const columns = header.map((name) => name.trim());
  while (columns.length && columns[columns.length - 1] === '') columns.pop(); // Excel pads blank trailing columns
  if (columns.some((name) => !name)) throw new FileError('CSV has an empty column name in the header');
  const duplicate = columns.find((name, index) => columns.indexOf(name) !== index);
  if (duplicate) throw new FileError(`CSV has the column "${duplicate}" more than once`);

  const rows = lines.map((line, lineIndex) => {
    if (line.slice(columns.length).some((cell) => cell !== '')) throw new FileError(`CSV row ${rowNumbers[lineIndex]} has more cells than the header`);
    const row: Record<string, unknown> = {};
    columns.forEach((column, index) => {
      const cell = line[index];
      row[column] = cell === undefined || cell === '' ? null : unescapeCell(cell);
    });
    return row;
  });
  return { columns, rows, rowNumbers };
}
