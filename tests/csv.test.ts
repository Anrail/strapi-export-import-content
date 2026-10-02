import { describe, expect, it } from 'vitest';

import { escapeCell, fromCsv, toCsv, unescapeCell } from '../server/src/formats/csv';
import { FileError } from '../server/src/errors';

describe('formula escaping', () => {
  it.each(['=1+1', '+1', '-1', '@x', '  =1', '\t=1', '\rx', "'quoted"])('escapes %j and restores it', (value) => {
    const escaped = escapeCell(value) as string;
    expect(escaped).toBe(`'${value}`);
    expect(unescapeCell(escaped)).toBe(value);
  });

  it('leaves ordinary strings, numbers and booleans alone', () => {
    expect(escapeCell('hello')).toBe('hello');
    expect(escapeCell(-5)).toBe(-5);
    expect(escapeCell(true)).toBe(true);
    expect(unescapeCell("'hello")).toBe("'hello");
    expect(unescapeCell('hello')).toBe('hello');
  });
});

describe('toCsv / fromCsv', () => {
  const table = {
    columns: ['documentId', 'title', 'views', 'body'],
    rows: [
      { documentId: 'doc1', title: '=SUM(A1)', views: -5, body: 'line1\nline2, "quoted"' },
      { documentId: 'doc2', title: null, views: 0, body: 'Привіт' },
    ],
  };

  it('writes a BOM and round-trips values as strings', () => {
    const csv = toCsv(table);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(fromCsv(csv)).toEqual({
      columns: ['documentId', 'title', 'views', 'body'],
      rows: [
        { documentId: 'doc1', title: '=SUM(A1)', views: '-5', body: 'line1\nline2, "quoted"' },
        { documentId: 'doc2', title: null, views: '0', body: 'Привіт' },
      ],
      rowNumbers: [1, 2],
    });
  });

  it('reads a semicolon-delimited file saved by Excel', () => {
    const csv = '\uFEFFdocumentId;title\r\ndoc1;Hello, world\r\ndoc2;\r\n';
    expect(fromCsv(csv)).toEqual({
      columns: ['documentId', 'title'],
      rows: [{ documentId: 'doc1', title: 'Hello, world' }, { documentId: 'doc2', title: null }],
      rowNumbers: [1, 2],
    });
  });

  it('reads a header-only and an empty file as zero rows', () => {
    expect(fromCsv('documentId,title\r\n')).toEqual({ columns: ['documentId', 'title'], rows: [], rowNumbers: [] });
    expect(fromCsv('')).toEqual({ columns: [], rows: [] });
  });

  it('rejects a row with more cells than the header', () => {
    expect(() => fromCsv('a,b\n1,2,3\n')).toThrow(FileError);
    expect(() => fromCsv('a,b\n1,2,3\n')).toThrow(/row 1 has more cells/);
  });

  it('ignores empty trailing cells in the header and in rows', () => {
    expect(fromCsv('a,b\n1,2,\n3,4,,\n').rows).toEqual([{ a: '1', b: '2' }, { a: '3', b: '4' }]);
    expect(fromCsv('a,b,,\n1,2,,\n')).toEqual({ columns: ['a', 'b'], rows: [{ a: '1', b: '2' }], rowNumbers: [1] });
  });

  it('skips blank lines and pads short rows', () => {
    expect(fromCsv('a,b\n1\n\n3,4\n').rows).toEqual([{ a: '1', b: null }, { a: '3', b: '4' }]);
  });

  it('numbers the data rows as they stand in the file, blank ones included', () => {
    expect(fromCsv('a,b\n1\n\n3,4\n,\n5,6\n').rowNumbers).toEqual([1, 3, 5]);
    expect(() => fromCsv('a,b\n1,2\n\n1,2,3\n')).toThrow(/row 3 has more cells/);
  });

  it('rejects duplicate and empty headers and broken quoting', () => {
    expect(() => fromCsv('a,a\n1,2\n')).toThrow(FileError);
    expect(() => fromCsv('a,,c\n1,2,3\n')).toThrow(/empty column name/);
    expect(() => fromCsv('a,b\n"unterminated,2\n')).toThrow(FileError);
  });
});
