import { describe, expect, it } from 'vitest';

import { parseCell } from '../server/src/codec/decode';
import { diffRow } from '../server/src/codec/diff';
import { encodeEntry, flattenRow } from '../server/src/codec/encode';
import type { EncodeCtx } from '../server/src/codec/encode';
import { buildColumns } from '../server/src/codec/schema';
import { parseFile } from '../server/src/formats';
import type { Format } from '../server/src/formats';
import { toCsv } from '../server/src/formats/csv';
import { toJson } from '../server/src/formats/json';
import { toXlsx } from '../server/src/formats/xlsx';
import { articleModel, getModel, nonLocalizedOf } from './helpers/models';

// The article model plus every scalar type and a repeatable component with nested media/relation.
const model = {
  ...articleModel,
  attributes: {
    ...articleModel.attributes,
    price: { type: 'decimal' },
    big: { type: 'biginteger' },
    active: { type: 'boolean' },
    day: { type: 'date' },
    at: { type: 'time' },
    happenedAt: { type: 'datetime' },
    note: { type: 'json' },
    seos: { type: 'component', component: 'shared.seo', repeatable: true },
  },
};
const columns = buildColumns(model, { nonLocalized: nonLocalizedOf(model) });

const image = (id: number) => ({ id, url: `/uploads/${id}.jpg` });
const category = (documentId: string) => ({ documentId, locale: 'en' });
const seo = (id: number) => ({ id, metaTitle: `T${id}`, shareImage: image(id), related: category('cat1') });

const full = {
  id: 1,
  documentId: 'doc1',
  locale: 'en',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T17:36:00.000Z',
  title: 'line one\r\nline two',
  slug: 'hello',
  views: 5,
  body: 'a\u000bb',
  meta: { nested: { list: [1, 'two', null] } },
  note: 'a json string',
  price: '10.50',
  big: '9007199254740993',
  active: false,
  day: '2026-09-01',
  at: '10:30:00.000',
  happenedAt: '2026-09-01T17:36:00.000Z',
  cover: image(7),
  gallery: [image(8), image(7)],
  category: category('cat1'),
  tags: [category('cat2'), category('cat1')],
  seo: seo(3),
  seos: [seo(4), seo(5)],
  quotes: [{ id: 1, text: 'q1' }],
  blocks: [{ __component: 'shared.quote', id: 9, text: 'z' }, { __component: 'shared.seo', ...seo(6) }],
};

const empty = {
  id: 2,
  documentId: 'doc2',
  locale: 'en',
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T17:36:00.000Z',
  title: null,
  slug: null,
  views: null,
  body: null,
  meta: null,
  note: null,
  price: null,
  big: null,
  active: null,
  day: null,
  at: null,
  happenedAt: null,
  cover: null,
  gallery: [],
  category: null,
  tags: [],
  seo: null,
  seos: [],
  quotes: [],
  blocks: [],
};

const write = async (format: Format, rows: Array<Record<string, unknown>>): Promise<Buffer> => {
  const names = Object.keys(rows[0]);
  if (format === 'json') return Buffer.from(toJson({ columns: names, rows }, { contentType: model.uid, locale: 'en' }), 'utf8');
  const table = { columns: names, rows: rows.map((row) => flattenRow(row, columns)) };
  return format === 'csv' ? Buffer.from(toCsv(table), 'utf8') : (await toXlsx(table)).buffer;
};

describe.each([true, false])('export -> file -> import is a no-op (sourceLocalized %s)', (sourceLocalized) => {
  const ctx: EncodeCtx = { getModel, isLocalized: (uid) => uid.startsWith('api::'), publicUrl: 'http://localhost:3000', sourceLocalized };
  const encode = (entity: any) => encodeEntry(entity, columns, ctx, { status: 'draft', publishedAt: null });

  it.each<Format>(['csv', 'json', 'xlsx'])('%s', async (format) => {
    const entities = [full, empty];
    const { table, flat } = await parseFile(format, await write(format, entities.map(encode)), model.uid);
    expect(table.rows).toHaveLength(2);

    table.rows.forEach((raw, index) => {
      const native: Record<string, unknown> = {};
      for (const column of columns) {
        if (raw[column.name] !== undefined) native[column.name] = parseCell(column, raw[column.name], flat);
      }
      expect(diffRow(native, encode(entities[index]), columns)).toEqual({ set: [], clear: [] });
    });
  });
});
