import { describe, expect, it } from 'vitest';

import { FileError } from '../server/src/errors';
import { checkLimits, formatFromFileName, parseFile } from '../server/src/formats';
import { toCsv } from '../server/src/formats/csv';
import { fromJson, toJson } from '../server/src/formats/json';

const uid = 'api::article.article';
const table = { columns: ['documentId', 'title', 'seo'], rows: [{ documentId: 'doc1', title: 'Hi', seo: { id: 3 } }] };

describe('json format', () => {
  it('round-trips native values inside an envelope', () => {
    const text = toJson(table, { contentType: uid, locale: 'en' });
    const parsed = JSON.parse(text);
    expect(parsed).toMatchObject({ contentType: uid, locale: 'en', entries: table.rows });
    expect(typeof parsed.exportedAt).toBe('string');
    expect(fromJson(text, uid)).toEqual(table);
  });

  it('accepts a bare array and unions the keys in first-seen order', () => {
    expect(fromJson('[{"a":1},{"b":2,"a":3}]', uid)).toEqual({ columns: ['a', 'b'], rows: [{ a: 1 }, { b: 2, a: 3 }] });
  });

  it('rejects broken JSON, another content type and non-object entries', () => {
    expect(() => fromJson('{oops', uid)).toThrow(FileError);
    expect(() => fromJson(JSON.stringify({ contentType: 'api::x.x', entries: [] }), uid)).toThrow(/api::x\.x/);
    expect(() => fromJson('{"entries":[1]}', uid)).toThrow(/object/);
    expect(() => fromJson('"text"', uid)).toThrow(FileError);
  });
});

describe('formatFromFileName', () => {
  it('reads the extension case-insensitively', () => {
    expect(formatFromFileName('Articles.CSV')).toBe('csv');
    expect(formatFromFileName('a.b.xlsx')).toBe('xlsx');
    expect(formatFromFileName('x.json')).toBe('json');
  });

  it('rejects anything else', () => {
    expect(() => formatFromFileName('x.xls')).toThrow(/\.csv, \.json or \.xlsx/);
    expect(() => formatFromFileName('noextension')).toThrow(FileError);
  });
});

describe('parseFile', () => {
  it('marks csv as flat and json as native', async () => {
    const csv = await parseFile('csv', Buffer.from(toCsv({ columns: ['a'], rows: [{ a: '1' }] }), 'utf8'), uid);
    expect(csv).toEqual({ table: { columns: ['a'], rows: [{ a: '1' }], rowNumbers: [1] }, flat: true });
    const json = await parseFile('json', Buffer.from('[{"a":1}]', 'utf8'), uid);
    expect(json).toEqual({ table: { columns: ['a'], rows: [{ a: 1 }] }, flat: false });
  });

  it('rejects CSV and JSON that are not valid UTF-8', async () => {
    await expect(parseFile('csv', Buffer.from([0x61, 0x0a, 0xcf, 0xf0, 0xe8]), uid)).rejects.toThrow(FileError);
    await expect(parseFile('csv', Buffer.from([0x61, 0x0a, 0xcf, 0xf0, 0xe8]), uid)).rejects.toThrow(/UTF-8/);
  });

  it('parses a JSON file saved with a BOM', async () => {
    const { table } = await parseFile('json', Buffer.from('\uFEFF[{"a":1}]', 'utf8'), uid);
    expect(table.rows).toEqual([{ a: 1 }]);
  });
});

describe('checkLimits', () => {
  const limits = { maxImportRows: 2, maxCells: 4, maxCellLength: 5 };

  it('accepts a table within the limits', () => {
    expect(() => checkLimits({ columns: ['a', 'b'], rows: [{ a: '1', b: '2' }] }, limits)).not.toThrow();
  });

  it('rejects too many rows, too many cells and an over-long cell', () => {
    const row = { a: '1', b: '2' };
    expect(() => checkLimits({ columns: ['a', 'b'], rows: [row, row, row] }, limits)).toThrow(/3 rows.*limit is 2/);
    expect(() => checkLimits({ columns: ['a', 'b', 'c'], rows: [row, row] }, limits)).toThrow(/6 cells/);
    expect(() => checkLimits({ columns: ['a'], rows: [{ a: '123456' }] }, limits)).toThrow(/row 1, column "a"/);
    expect(() => checkLimits({ columns: ['a'], rows: [{ a: { deep: '123456' } }] }, limits)).toThrow(/row 1, column "a"/);
  });
});
