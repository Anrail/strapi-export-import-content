import { Workbook } from 'exceljs';
import { describe, expect, it } from 'vitest';

import { toXlsx } from '../server/src/formats/xlsx';
import { importService } from '../server/src/services/import';
import { articleModel } from './helpers/models';
import { makeStrapi } from './helpers/strapi';

const uid = articleModel.uid;
const T0 = '2026-09-01T10:00:00.000Z';
const seed = () => ({
  articles: [
    { id: 1, documentId: 'a', locale: 'en', publishedAt: null, updatedAt: T0, title: 'A', views: 1 },
    { id: 4, documentId: 'c', locale: 'uk', publishedAt: null, updatedAt: T0, title: 'C-uk', views: 9 },
  ],
});
const file = (entries: any[]) => Buffer.from(JSON.stringify(entries), 'utf8');
const rows = [
  { documentId: 'a', locale: 'en', updatedAt: T0, title: 'A2' },
  { documentId: null, locale: 'en', title: 'New' },
  { documentId: 'c', locale: 'en', title: 'C-en' },
];
const send = (strapi: any, over: Record<string, any> = {}) =>
  importService({ strapi }).run({
    uid, fileName: 'articles.json', buffer: file(rows), dryRun: false, allowClear: [], userAbility: {}, user: { id: 5 }, ...over,
  });
/** Applies the way the admin does: a dry run first, then apply with that dry run's fingerprint. */
const run = async (strapi: any, over: Record<string, any> = {}) => {
  if (over.dryRun === true || over.planHash !== undefined) return send(strapi, over);
  const { planHash } = await send(strapi, { ...over, dryRun: true });
  return send(strapi, { ...over, planHash });
};

describe('import run', () => {
  it('writes nothing on a dry run', async () => {
    const strapi = makeStrapi(seed());
    const report = await run(strapi, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, applied: false, summary: { update: 1, create: 1, localize: 1, failed: 0 } });
    expect(strapi._documents.update).not.toHaveBeenCalled();
    expect(strapi._documents.create).not.toHaveBeenCalled();
  });

  it('applies update, create and localize to the draft with creator fields', async () => {
    const strapi = makeStrapi(seed());
    const report = await run(strapi);
    expect(report).toMatchObject({ dryRun: false, applied: true });
    expect(report.rows.map((row) => row.outcome)).toEqual(['applied', 'applied', 'applied']);
    expect(strapi._documents.update.mock.calls.map(([params]: any) => params)).toEqual([
      { documentId: 'a', locale: 'en', status: 'draft', data: { title: 'A2', updatedBy: 5 } },
      { documentId: 'c', locale: 'en', status: 'draft', data: { title: 'C-en', updatedBy: 5, createdBy: 5 } },
    ]);
    expect(strapi._documents.create).toHaveBeenCalledWith({
      locale: 'en', status: 'draft', data: { title: 'New', updatedBy: 5, createdBy: 5 },
    });
  });

  it('applies nothing when any row has an error', async () => {
    const strapi = makeStrapi(seed());
    const report = await run(strapi, { buffer: file([...rows, { documentId: 'ghost', locale: 'en', title: 'x' }]) });
    expect(report).toMatchObject({ applied: false, summary: { errors: 1 } });
    expect(strapi._documents.update).not.toHaveBeenCalled();
    expect(strapi._documents.create).not.toHaveBeenCalled();
    expect(strapi._documents.create).not.toHaveBeenCalled();
  });

  it('keeps going after a row fails at write time and reports it', async () => {
    const strapi = makeStrapi(seed());
    strapi._documents.update.mockRejectedValueOnce(new Error('unique violation'));
    const report = await run(strapi);
    expect(report.applied).toBe(true);
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', message: 'unique violation' });
    expect(report.rows[1].outcome).toBe('applied');
    expect(report.summary.failed).toBe(1);
  });

  it('counts every failed row, so applied with all rows failed is visible', async () => {
    const strapi = makeStrapi(seed());
    strapi._documents.update.mockRejectedValue(new Error('down'));
    strapi._documents.create.mockRejectedValue(new Error('down'));
    const report = await run(strapi);
    expect(report).toMatchObject({ applied: true, summary: { failed: 3 } });
  });

  it('reports a row whose document vanished before the write as failed', async () => {
    const strapi = makeStrapi(seed());
    strapi._documents.update.mockResolvedValueOnce(null);
    const report = await run(strapi);
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', message: 'the entry no longer exists' });
    expect(report.rows.slice(1).map((row) => row.outcome)).toEqual(['applied', 'applied']);
  });

  it('reports draftAndPublish of the model on a file that cannot be parsed', async () => {
    const strapi = makeStrapi(seed());
    strapi.contentTypes[uid] = { ...articleModel, options: { draftAndPublish: false } };
    const report = await run(strapi, { buffer: Buffer.from('{oops') });
    expect(report.fileErrors[0]).toMatch(/not valid JSON/);
    expect(report.draftAndPublish).toBe(false);
    expect((await run(makeStrapi(seed()), { buffer: Buffer.from('{oops') })).draftAndPublish).toBe(true);
  });

  it('refuses a workbook that expands to more than 20 times maxImportBytes before reading it', async () => {
    // Long repetitive strings compress about 80:1, so the file passes the byte limit but not the expansion one.
    const rows = Array.from({ length: 20 }, (_, index) => ({ title: `${index}${'x'.repeat(30000)}` }));
    const { buffer } = await toXlsx({ columns: ['title'], rows });
    const limit = 10000;
    expect(buffer.length).toBeLessThan(limit);
    const strapi = makeStrapi({ ...seed(), limits: { maxImportBytes: limit } });
    const report = await run(strapi, { fileName: 'articles.xlsx', buffer });
    expect(report.fileErrors).toEqual([`The workbook expands to more than ${limit * 20} bytes`]);
  });

  describe('row numbers count the blank rows the readers skip', () => {
    const lines = [
      ['documentId', 'locale', 'title', 'views'],
      ['', 'en', 'New', ''],
      [],
      ['a', 'en', '', 'many'],
    ];

    it('csv', async () => {
      const buffer = Buffer.from(lines.map((line) => line.join(',')).join('\n'), 'utf8');
      const report = await run(makeStrapi(seed()), { fileName: 'articles.csv', buffer, dryRun: true });
      expect(report.rows.find((row) => row.errors.length)).toMatchObject({ row: 3, errors: ['views: "many" is not a number'] });
    });

    it('xlsx', async () => {
      const workbook = new Workbook();
      const sheet = workbook.addWorksheet('data');
      for (const line of lines) sheet.addRow(line.map((cell) => cell || null));
      const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
      const report = await run(makeStrapi(seed()), { fileName: 'articles.xlsx', buffer, dryRun: true });
      expect(report.rows.find((row) => row.errors.length)).toMatchObject({ row: 3, errors: ['views: "many" is not a number'] });
    });

    it('in the limit errors too', async () => {
      const buffer = Buffer.from(['title', 'ok', '', 'too long'].join('\n'), 'utf8');
      const report = await run(makeStrapi({ ...seed(), limits: { maxCellLength: 5 } }), { fileName: 'articles.csv', buffer });
      expect(report.fileErrors).toEqual(['row 3, column "title": the value is longer than 5 characters']);
    });
  });

  it('turns file problems into file errors instead of throwing', async () => {
    const cases: Array<[Record<string, number> | undefined, Record<string, any>, RegExp]> = [
      [{ maxImportBytes: 10, maxImportRows: 1 }, {}, /larger than/],
      [{ maxImportRows: 1 }, {}, /3 rows; the limit is 1/],
      [undefined, { fileName: 'articles.pdf' }, /.csv, .json or .xlsx/],
      [undefined, { buffer: Buffer.from('{oops') }, /not valid JSON/],
    ];
    for (const [limits, over, pattern] of cases) {
      const strapi = makeStrapi({ ...seed(), ...(limits ? { limits } : {}) });
      expect((await run(strapi, over)).fileErrors[0]).toMatch(pattern);
      expect(strapi._documents.create).not.toHaveBeenCalled();
      expect(strapi._documents.update).not.toHaveBeenCalled();
    }
  });
});

describe('apply is bound to the confirmed dry run', () => {
  it('writes nothing without the fingerprint of a dry run, or with a wrong one', async () => {
    for (const planHash of ['', 'not-the-plan']) {
      const strapi = makeStrapi(seed());
      const report = await send(strapi, { planHash });
      expect(report).toMatchObject({ applied: false, dryRun: true });
      expect(report.fileErrors[0]).toMatch(/content changed since the dry run/);
      expect(strapi._documents.update).not.toHaveBeenCalled();
      expect(strapi._documents.create).not.toHaveBeenCalled();
    }
  });

  it('refuses when the plan differs from the one that was confirmed', async () => {
    const strapi = makeStrapi(seed());
    const { planHash } = await send(strapi, { dryRun: true });
    // Someone renames the media / edits the file: the same request now plans different data.
    const changed = file([{ documentId: 'a', locale: 'en', updatedAt: T0, title: 'A3' }, rows[1], rows[2]]);
    const report = await send(strapi, { planHash, buffer: changed });
    expect(report.applied).toBe(false);
    expect(report.planHash).not.toBe(planHash);
    expect(strapi._documents.update).not.toHaveBeenCalled();
  });

  it('gives equal plans equal fingerprints and returns one on every dry run', async () => {
    const first = await send(makeStrapi(seed()), { dryRun: true });
    const second = await send(makeStrapi(seed()), { dryRun: true });
    expect(first.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(second.planHash).toBe(first.planHash);
  });
});

describe('the stale guard is re-checked inside the row transaction', () => {
  const racing = (strapi: any, found: any) => {
    const query = strapi.db.query;
    strapi.db.query = (target: string) => ({ ...query(target), findOne: async () => found });
  };

  it('fails an update row whose entry changed after planning, and a localize row whose locale appeared', async () => {
    const strapi = makeStrapi(seed());
    const { planHash } = await send(strapi, { dryRun: true });
    racing(strapi, { id: 9, updatedAt: '2026-09-02T00:00:00.000Z' });
    const report = await send(strapi, { planHash });
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/stale row/) });
    expect(report.rows[1].outcome).toBe('applied');
    expect(report.rows[2]).toMatchObject({ outcome: 'failed', message: expect.stringMatching(/locale was created/) });
    expect(strapi._documents.update).not.toHaveBeenCalled();
  });

  it('fails an update row whose entry is gone', async () => {
    const strapi = makeStrapi(seed());
    const { planHash } = await send(strapi, { dryRun: true });
    racing(strapi, null);
    const report = await send(strapi, { planHash });
    expect(report.rows[0]).toMatchObject({ outcome: 'failed', message: 'the entry no longer exists' });
  });
});

describe('xlsx sheet limits apply before the sheet is walked', () => {
  it('rejects a sheet with too many rows and accepts a stray far-away cell', async () => {
    const many = new Workbook();
    const sheet = many.addWorksheet('data');
    sheet.addRow(['documentId', 'locale', 'title']);
    for (let index = 0; index < 5; index += 1) sheet.addRow([null, 'en', `t${index}`]);
    const strapi = makeStrapi({ ...seed(), limits: { maxImportRows: 3 } });
    const report = await send(strapi, { fileName: 'a.xlsx', buffer: Buffer.from(await many.xlsx.writeBuffer()), dryRun: true });
    expect(report.fileErrors).toEqual(['The file has 5 rows; the limit is 3']);

    const stray = new Workbook();
    const far = stray.addWorksheet('data');
    far.addRow(['documentId', 'locale', 'title']);
    far.getCell('C900000').value = 'far away';
    far.getCell('B900000').value = 'en';
    const ok = await send(makeStrapi(seed()), { fileName: 'a.xlsx', buffer: Buffer.from(await stray.xlsx.writeBuffer()), dryRun: true });
    expect(ok.fileErrors).toEqual([]);
    expect(ok.rows[0]).toMatchObject({ row: 899999, action: 'create' });
  });
});
