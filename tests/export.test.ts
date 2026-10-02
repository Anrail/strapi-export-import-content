import { describe, expect, it } from 'vitest';

import { HttpError } from '../server/src/errors';
import { fromCsv } from '../server/src/formats/csv';
import { fromXlsx } from '../server/src/formats/xlsx';
import { exportService } from '../server/src/services/export';
import { articleModel } from './helpers/models';
import { allowAll, makeStrapi } from './helpers/strapi';

const uid = articleModel.uid;
const articles = [
  { documentId: 'a', locale: 'en', publishedAt: null, updatedAt: '2026-09-01T10:00:00.000Z', title: 'A', views: 1, body: 'x'.repeat(40000), seo: { id: 3, metaTitle: 'T' } },
  { documentId: 'b', locale: 'en', publishedAt: null, updatedAt: '2026-09-01T10:00:00.000Z', title: 'B', views: 2 },
  { documentId: 'a', locale: 'en', publishedAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z' },
];
const decode = (base64: string) => Buffer.from(base64, 'base64');
const run = (strapi: any, over: Record<string, unknown> = {}) =>
  exportService({ strapi }).run({ uid, locale: 'en', documentIds: ['b', 'a'], format: 'json', userAbility: {}, ...over });

describe('export service', () => {
  it('exports native JSON in the requested order with statuses', async () => {
    const result = await run(makeStrapi({ articles }));
    expect(result.fileName).toMatch(/^article-en-\d{8}-\d{4}\.json$/);
    expect(result.mimeType).toBe('application/json');
    expect(result.rowCount).toBe(2);
    const parsed = JSON.parse(decode(result.contentBase64).toString('utf8'));
    expect(parsed.contentType).toBe(uid);
    expect(parsed.entries.map((e: any) => [e.documentId, e.status])).toEqual([['b', 'draft'], ['a', 'published']]);
    expect(parsed.entries[1].seo).toEqual({ id: 3, metaTitle: 'T', shareImage: null, related: null });
  });

  it('exports flat CSV with complex values as JSON text', async () => {
    const result = await run(makeStrapi({ articles }), { format: 'csv' });
    const table = fromCsv(decode(result.contentBase64).toString('utf8'));
    expect(table.columns.slice(0, 7)).toEqual(['documentId', 'locale', 'updatedAt', 'status', 'createdAt', 'publishedAt', 'title']);
    expect(table.rows[1].seo).toBe('{"id":3,"metaTitle":"T","shareImage":null,"related":null}');
    expect(table.rows[1].views).toBe('1');
  });

  it('reports over-long cells in XLSX', async () => {
    const result = await run(makeStrapi({ articles }), { format: 'xlsx' });
    expect(result.warnings).toEqual({ longCells: 1 });
    const table = await fromXlsx(decode(result.contentBase64));
    expect(table.rows[1]).not.toHaveProperty('body');
  });

  it('leaves out ids that are not readable and columns the user may not read', async () => {
    const checker = allowAll();
    checker.can.read = (_entity: unknown, field: string) => field !== 'body';
    const result = await run(makeStrapi({ articles, checker }), { documentIds: ['a', 'ghost'] });
    const parsed = JSON.parse(decode(result.contentBase64).toString('utf8'));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).not.toHaveProperty('body');
  });

  describe('component permissions are stored as leaf paths', () => {
    const base = Object.entries(articleModel.attributes)
      .filter(([, attribute]: [string, any]) => attribute.type !== 'component')
      .map(([name]) => name);
    const exportedColumns = async (permitted: Set<string>) => {
      const checker = allowAll();
      checker.can.read = (_entity: unknown, path: string) => permitted.has(path);
      const result = await run(makeStrapi({ articles, checker }), { documentIds: ['a'] });
      return Object.keys(JSON.parse(decode(result.contentBase64).toString('utf8')).entries[0]);
    };

    it('exports components whose every leaf is permitted', async () => {
      const columns = await exportedColumns(new Set([...base, 'seo.metaTitle', 'seo.shareImage', 'seo.related', 'quotes.text']));
      expect(columns).toEqual(expect.arrayContaining(['seo', 'quotes']));
    });

    it('drops a partially permitted component but keeps the others', async () => {
      const columns = await exportedColumns(new Set([...base, 'seo.metaTitle', 'seo.shareImage', 'quotes.text']));
      expect(columns).not.toContain('seo');
      expect(columns).toContain('quotes');
    });
  });

  it('uses the default locale for a localized type when none is given', async () => {
    const strapi = makeStrapi({ articles });
    await run(strapi, { locale: null });
    expect(strapi._documents.findMany.mock.calls[0][0].locale).toBe('en');
  });

  it('refuses without read permission', async () => {
    const checker = allowAll();
    checker.cannot.read = () => true;
    await expect(run(makeStrapi({ articles, checker }))).rejects.toMatchObject({ status: 403 });
  });

  it.each([
    [{ format: 'pdf' }, /format/],
    [{ documentIds: [] }, /documentIds/],
    [{ documentIds: 'a' }, /documentIds/],
    [{ documentIds: [1, 2] }, /documentIds/],
    [{ uid: 'plugin::upload.file' }, /collection type/],
  ])('rejects bad input %j', async (over, message) => {
    await expect(run(makeStrapi({ articles }), over)).rejects.toThrow(message);
  });

  it('rejects more ids than maxExportRows', async () => {
    const strapi = makeStrapi({ articles, limits: { maxExportRows: 1 } });
    await expect(run(strapi)).rejects.toBeInstanceOf(HttpError);
  });
});

describe('fields readable on the type but not on one entry', () => {
  it('exports that cell empty and the others intact', async () => {
    const checker = allowAll();
    checker.can.read = (entity: any, path?: string) => !(entity?.documentId === 'a' && path === 'title');
    const result = await run(makeStrapi({ articles, checker }));
    const entries = JSON.parse(decode(result.contentBase64).toString('utf8')).entries;
    expect(entries.find((e: any) => e.documentId === 'a').title).toBeNull();
    expect(entries.find((e: any) => e.documentId === 'b').title).toBe('B');
  });
});
