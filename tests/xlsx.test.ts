import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';

import { FileError } from '../server/src/errors';
import { fromXlsx, NOT_EDITABLE_MARKER, toXlsx, XLSX_CELL_LIMIT, xlsxUncompressedSize } from '../server/src/formats/xlsx';

const long = 'x'.repeat(XLSX_CELL_LIMIT + 1);

const table = {
  columns: ['documentId', 'locale', 'title', 'views', 'active', 'body'],
  rows: [
    { documentId: 'doc1', locale: 'en', title: '=SUM(A1)', views: 5, active: true, body: long },
    { documentId: 'doc2', locale: 'en', title: null, views: null, active: false, body: 'short' },
  ],
};

const build = async (fill: (workbook: Workbook) => void): Promise<Buffer> => {
  const workbook = new Workbook();
  fill(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
};

describe('toXlsx / fromXlsx', () => {
  it('round-trips typed cells and keeps a formula-looking string a string', async () => {
    const { buffer } = await toXlsx(table);
    const back = await fromXlsx(buffer);
    expect(back.columns).toEqual(table.columns);
    expect(back.rows[0]).toMatchObject({ documentId: 'doc1', title: '=SUM(A1)', views: 5, active: true });
    expect(back.rows[1]).toEqual({ documentId: 'doc2', locale: 'en', title: null, views: null, active: false, body: 'short' });
  });

  it('replaces an over-long value by the marker, records it, and reads it back as untouched', async () => {
    const { buffer, longCells } = await toXlsx(table);
    expect(longCells).toEqual([{ documentId: 'doc1', locale: 'en', field: 'body', length: XLSX_CELL_LIMIT + 1 }]);
    const back = await fromXlsx(buffer);
    expect(back.rows[0]).not.toHaveProperty('body');
  });

  it('marks the marker string as the agreed text', () => {
    expect(NOT_EDITABLE_MARKER).toBe('#NOT_EDITABLE_IN_XLSX: edit this field in CSV or JSON#');
  });

  const one = (body: string) => ({ columns: ['documentId', 'locale', 'body'], rows: [{ documentId: 'doc1', locale: 'en', body }] });

  it.each(['a\u000bb', 'a\u0000b', 'line\rbreak', 'literal _x000D_ text', '\ud83d', '\ude00z', 'x\uffff'])(
    'treats %j, which XLSX cannot carry, as not editable',
    async (body) => {
      const { buffer, longCells } = await toXlsx(one(body));
      expect(longCells).toEqual([{ documentId: 'doc1', locale: 'en', field: 'body', length: body.length }]);
      const back = await fromXlsx(buffer);
      expect(back.rows[0]).toEqual({ documentId: 'doc1', locale: 'en' });
    },
  );

  it.each(['ok \ud83d\ude00 emoji', 'tab\there'])('round-trips %j unchanged', async (body) => {
    const { buffer, longCells } = await toXlsx(one(body));
    expect(longCells).toEqual([]);
    expect((await fromXlsx(buffer)).rows[0].body).toBe(body);
  });

  it('keeps CRLF editable; exceljs reads it back as LF, which the codec treats as the same string', async () => {
    const { buffer, longCells } = await toXlsx(one('a\r\nb'));
    expect(longCells).toEqual([]);
    expect((await fromXlsx(buffer)).rows[0].body).toBe('a\nb');
  });

  it('rejects a marker that the meta sheet does not confirm', async () => {
    const buffer = await build((workbook) => {
      const sheet = workbook.addWorksheet('data');
      sheet.addRow(['documentId', 'locale', 'body']);
      sheet.addRow(['doc1', 'en', NOT_EDITABLE_MARKER]);
    });
    await expect(fromXlsx(buffer)).rejects.toThrow(/not confirmed by the _meta sheet/);
  });

  it('rejects a marker when _meta lists a different field for that row', async () => {
    const buffer = await build((workbook) => {
      const sheet = workbook.addWorksheet('data');
      sheet.addRow(['documentId', 'locale', 'body']);
      sheet.addRow(['doc1', 'en', NOT_EDITABLE_MARKER]);
      const meta = workbook.addWorksheet('_meta');
      meta.addRow(['documentId', 'locale', 'field', 'length']);
      meta.addRow(['doc1', 'en', 'title', 40000]);
    });
    await expect(fromXlsx(buffer)).rejects.toThrow(/not confirmed by the _meta sheet/);
  });

  it('confirms a marker by documentId and field, so a row copied to another locale keeps it untouched', async () => {
    const { buffer } = await toXlsx(table);
    const workbook = new Workbook();
    await workbook.xlsx.load(buffer as any);
    workbook.getWorksheet('data')!.getRow(2).getCell(2).value = 'uk';
    const edited = Buffer.from(await workbook.xlsx.writeBuffer());
    const back = await fromXlsx(edited);
    expect(back.rows[0]).toMatchObject({ documentId: 'doc1', locale: 'uk' });
    expect(back.rows[0]).not.toHaveProperty('body');
  });

  it('names the way out in the unconfirmed-marker error', async () => {
    const buffer = await build((workbook) => {
      const sheet = workbook.addWorksheet('data');
      sheet.addRow(['documentId', 'locale', 'body']);
      sheet.addRow(['doc1', 'en', NOT_EDITABLE_MARKER]);
    });
    await expect(fromXlsx(buffer)).rejects.toThrow(
      'row 1, column "body": the not-editable marker is not confirmed by the _meta sheet - export the file again, or clear this cell',
    );
  });

  it('rejects a meta sheet with a wrong header', async () => {
    const buffer = await build((workbook) => {
      workbook.addWorksheet('data').addRow(['documentId']);
      workbook.addWorksheet('_meta').addRow(['doc', 'field']);
    });
    await expect(fromXlsx(buffer)).rejects.toThrow(/_meta/);
  });

  it('rejects formula cells, naming the cell', async () => {
    const buffer = await build((workbook) => {
      const sheet = workbook.addWorksheet('data');
      sheet.addRow(['documentId', 'views']);
      sheet.addRow(['doc1', { formula: '1+1', result: 2 }]);
    });
    await expect(fromXlsx(buffer)).rejects.toThrow(/row 1, column "views".*formula/);
  });

  it('reads hyperlink, rich-text and date cells as text', async () => {
    const buffer = await build((workbook) => {
      const sheet = workbook.addWorksheet('data');
      sheet.addRow(['cover', 'title', 'day']);
      sheet.addRow([
        { text: 'http://x/a.jpg', hyperlink: 'http://x/a.jpg' },
        { richText: [{ text: 'Hel' }, { text: 'lo' }] },
        new Date('2026-09-01T00:00:00.000Z'),
      ]);
    });
    expect((await fromXlsx(buffer)).rows[0]).toEqual({ cover: 'http://x/a.jpg', title: 'Hello', day: '2026-09-01T00:00:00.000Z' });
  });

  it('skips fully empty rows and reads a header-only sheet as zero rows', async () => {
    const buffer = await build((workbook) => {
      const sheet = workbook.addWorksheet('data');
      sheet.addRow(['a', 'b']);
      sheet.addRow([]);
      sheet.addRow([1, 2]);
    });
    expect(await fromXlsx(buffer)).toMatchObject({ rows: [{ a: 1, b: 2 }], rowNumbers: [2] });
    const headerOnly = await build((workbook) => void workbook.addWorksheet('data').addRow(['a']));
    expect(await fromXlsx(headerOnly)).toEqual({ columns: ['a'], rows: [], rowNumbers: [] });
  });

  it('ignores styled but empty trailing header cells, not an empty name between named ones', async () => {
    const buffer = await build((workbook) => {
      const sheet = workbook.addWorksheet('data');
      sheet.addRow(['a', 'b', null, null]);
      sheet.getRow(1).getCell(4).style = { font: { bold: true } };
      sheet.addRow([1, 2]);
    });
    expect(await fromXlsx(buffer)).toEqual({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }], rowNumbers: [1] });
    const gap = await build((workbook) => void workbook.addWorksheet('data').addRow(['a', null, 'c']));
    await expect(fromXlsx(gap)).rejects.toThrow(/empty column name in the header \(column 2\)/);
  });

  it('rejects something that is not a workbook', async () => {
    await expect(fromXlsx(Buffer.from('not a zip'))).rejects.toThrow(FileError);
  });
});

describe('xlsxUncompressedSize', () => {
  it('sums the sizes the zip central directory declares', async () => {
    const { buffer } = await toXlsx(table);
    const size = xlsxUncompressedSize(buffer);
    expect(size).toBeGreaterThan(buffer.length);
    expect(size).toBeLessThan(5 * 1024 * 1024);
  });

  it('throws FileError for something that is not a zip', () => {
    expect(() => xlsxUncompressedSize(Buffer.from('not a zip'))).toThrow(FileError);
    expect(() => xlsxUncompressedSize(Buffer.from('not a zip'))).toThrow('The file is not a readable XLSX workbook');
  });
});

describe('content equal to the marker', () => {
  it('is recorded in _meta, so an untouched export still imports', async () => {
    const table = { columns: ['documentId', 'locale', 'title'], rows: [{ documentId: 'doc1', locale: 'en', title: NOT_EDITABLE_MARKER }] };
    const { buffer, longCells } = await toXlsx(table);
    expect(longCells).toHaveLength(1);
    expect((await fromXlsx(buffer)).rows[0]).not.toHaveProperty('title');
  });
});
