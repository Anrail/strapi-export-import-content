import type { TransferConfig } from '../config';
import { FileError } from '../errors';
import { fromCsv } from './csv';
import type { Table } from './csv';
import { fromJson } from './json';
import { fromXlsx } from './xlsx';

export type Format = 'csv' | 'json' | 'xlsx';

export const FORMATS: Format[] = ['csv', 'json', 'xlsx'];

export const MIME: Record<Format, string> = {
  csv: 'text/csv; charset=utf-8',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function formatFromFileName(name: string): Format {
  const extension = /\.([a-z0-9]+)$/i.exec(name ?? '')?.[1]?.toLowerCase();
  if (!FORMATS.includes(extension as Format)) throw new FileError('The file must be .csv, .json or .xlsx');
  return extension as Format;
}

/** `flat` tells the codec whether complex values arrive as JSON text (CSV, XLSX) or as values. */
export async function parseFile(
  format: Format,
  buffer: Buffer,
  uid: string,
  limits?: Pick<TransferConfig, 'maxImportRows' | 'maxCells'>,
): Promise<{ table: Table; flat: boolean }> {
  if (format === 'xlsx') {
    const xlsxLimits = limits && { maxRows: limits.maxImportRows, maxCells: limits.maxCells };
    return { table: await fromXlsx(buffer, xlsxLimits), flat: true };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new FileError('The file is not valid UTF-8 - save it as "CSV UTF-8"');
  }
  return format === 'csv' ? { table: fromCsv(text), flat: true } : { table: fromJson(text, uid), flat: false };
}

const lengthOf = (value: unknown): number =>
  typeof value === 'string' ? value.length : typeof value === 'object' && value !== null ? JSON.stringify(value).length : 0;

/** Measured on the parsed table, i.e. after decompression. */
export function checkLimits(
  table: Table,
  limits: Pick<TransferConfig, 'maxImportRows' | 'maxCells' | 'maxCellLength'>,
): void {
  if (table.rows.length > limits.maxImportRows) {
    throw new FileError(`The file has ${table.rows.length} rows; the limit is ${limits.maxImportRows}`);
  }
  const cells = table.rows.length * table.columns.length;
  if (cells > limits.maxCells) throw new FileError(`The file has ${cells} cells; the limit is ${limits.maxCells}`);

  table.rows.forEach((row, index) => {
    for (const column of table.columns) {
      if (lengthOf(row[column]) > limits.maxCellLength) {
        throw new FileError(`row ${table.rowNumbers?.[index] ?? index + 1}, column "${column}": the value is longer than ${limits.maxCellLength} characters`);
      }
    }
  });
}
