import { FileError } from '../errors';
import type { Table } from './csv';

export function toJson(table: Table, meta: { contentType: string; locale: string | null }): string {
  const envelope = { ...meta, exportedAt: new Date().toISOString(), entries: table.rows };
  return JSON.stringify(envelope, null, 2);
}

export function fromJson(text: string, uid: string): Table {
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FileError('The file is not valid JSON');
  }

  const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
  if (!Array.isArray(entries)) throw new FileError('JSON must be an array of entries or an object with "entries"');
  if (!Array.isArray(parsed) && parsed.contentType !== undefined && parsed.contentType !== uid) {
    throw new FileError(`This file was exported from ${parsed.contentType}, not ${uid}`);
  }

  const columns: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new FileError('Every JSON entry must be an object');
    }
    for (const key of Object.keys(entry)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
    }
  }
  return { columns, rows: entries };
}
