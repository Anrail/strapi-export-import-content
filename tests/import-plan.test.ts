import { describe, expect, it } from 'vitest';

import { importService } from '../server/src/services/import';
import { articleModel } from './helpers/models';
import { allowAll, makeStrapi } from './helpers/strapi';

const uid = articleModel.uid;
const T0 = '2026-09-01T10:00:00.000Z';

const seed = () => ({
  articles: [
    { id: 1, documentId: 'a', locale: 'en', publishedAt: null, updatedAt: T0, title: 'A', slug: 'a', views: 1, cover: { id: 7, url: '/uploads/a.jpg' }, quotes: [{ id: 1, text: 'q1' }] },
    { id: 2, documentId: 'a', locale: 'en', publishedAt: T0, updatedAt: T0 },
    { id: 3, documentId: 'b', locale: 'en', publishedAt: null, updatedAt: T0, title: 'B', slug: 'b', views: 2 },
    { id: 4, documentId: 'c', locale: 'uk', publishedAt: null, updatedAt: T0, title: 'C-uk', slug: 'c', views: 9 },
  ],
  categories: [{ documentId: 'cat1', locale: 'en', publishedAt: null }],
  files: [{ id: 7, url: '/uploads/a.jpg' }],
});

const plan = async (rows: any[], over: Record<string, any> = {}) => {
  const strapi = over.strapi ?? makeStrapi({ ...seed(), ...over.seed });
  const columns = over.columns ?? [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const result = await importService({ strapi }).plan({
    uid,
    table: { columns, rows },
    flat: over.flat ?? false,
    allowClear: over.allowClear ?? [],
    userAbility: {},
  });
  return { ...result, strapi };
};

describe('file-level checks', () => {
  it('accepts an empty table', async () => {
    const { report } = await plan([], { columns: ['documentId', 'locale', 'title'] });
    expect(report.fileErrors).toEqual([]);
    expect(report.summary).toEqual({ create: 0, update: 0, localize: 0, unchanged: 0, errors: 0, failed: 0 });
  });

  it('rejects unknown columns, mixed locales, duplicate ids and an unknown locale', async () => {
    expect((await plan([{ documentId: 'a', locale: 'en', nope: 1 }])).report.fileErrors).toEqual(['Unknown column "nope"']);
    expect((await plan([{ documentId: 'a', locale: 'en' }, { documentId: 'b', locale: 'uk' }])).report.fileErrors[0]).toMatch(/one locale/);
    expect((await plan([{ documentId: 'a', locale: 'en' }, { documentId: 'a', locale: 'en' }])).report.fileErrors[0]).toMatch(/"a".*more than once/);
    expect((await plan([{ documentId: 'a', locale: 'fr' }])).report.fileErrors[0]).toMatch(/"fr"/);
    expect((await plan([{ documentId: 'a', title: 'x' }])).report.fileErrors[0]).toMatch(/locale/);
  });

  it('refuses without read permission', async () => {
    const checker = allowAll();
    checker.cannot.read = () => true;
    await expect(plan([], { seed: { checker } })).rejects.toMatchObject({ status: 403 });
  });
});

describe('update rows', () => {
  it('reports an untouched export as unchanged and plans nothing', async () => {
    const { report, planned } = await plan([
      { documentId: 'a', locale: 'en', updatedAt: T0, title: 'A', slug: 'a', views: 1, cover: 'http://localhost:3000/uploads/a.jpg', quotes: [{ id: 1, text: 'q1' }] },
      { documentId: 'b', locale: 'en', updatedAt: T0, title: 'B', views: 2 },
    ]);
    expect(report.summary).toMatchObject({ unchanged: 2, update: 0, errors: 0 });
    expect(report.rows).toEqual([]);
    expect(planned).toEqual([]);
  });

  it('plans only the changed fields and counts published entries that become modified', async () => {
    const { report, planned } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, title: 'A2', views: 1 }]);
    expect(report.summary).toMatchObject({ update: 1, errors: 0 });
    expect(report.willBecomeModified).toBe(1);
    expect(report.rows[0]).toMatchObject({ row: 1, documentId: 'a', action: 'update', fields: ['title'], errors: [] });
    expect(report.rows[0]).not.toHaveProperty('data');
    expect(report.rows[0]).not.toHaveProperty('baseUpdatedAt');
    expect(planned[0].data).toEqual({ title: 'A2' });
  });

  it('says whether the type has drafts at all', async () => {
    const rows = [{ documentId: 'a', locale: 'en', updatedAt: T0, title: 'A2' }];
    expect((await plan(rows)).report.draftAndPublish).toBe(true);
    const strapi = makeStrapi(seed());
    strapi.contentTypes[uid] = { ...articleModel, options: { draftAndPublish: false } };
    const { report } = await plan(rows, { strapi });
    expect(report.draftAndPublish).toBe(false);
    expect(report.willBecomeModified).toBe(0);
  });

  it('reports draftAndPublish false even when the file has file errors', async () => {
    const strapi = makeStrapi(seed());
    strapi.contentTypes[uid] = { ...articleModel, options: { draftAndPublish: false } };
    const { report } = await plan([{ documentId: 'a', locale: 'en', nope: 1 }], { strapi });
    expect(report.fileErrors).toEqual(['Unknown column "nope"']);
    expect(report.draftAndPublish).toBe(false);
  });

  it('rejects a stale row and a changed row without updatedAt, but not an unchanged one', async () => {
    const stale = await plan([{ documentId: 'a', locale: 'en', updatedAt: '2026-08-01T00:00:00.000Z', title: 'A2' }]);
    expect(stale.report.rows[0].errors[0]).toMatch(/stale row/);
    const missing = await plan([{ documentId: 'a', locale: 'en', title: 'A2' }]);
    expect(missing.report.rows[0].errors[0]).toMatch(/updatedAt is required/);
    const unchanged = await plan([{ documentId: 'a', locale: 'en', updatedAt: '2026-08-01T00:00:00.000Z', title: 'A' }]);
    expect(unchanged.report.summary.unchanged).toBe(1);
  });

  it('treats empty cells as candidate clears until the field is allowed', async () => {
    const rows = [{ documentId: 'a', locale: 'en', updatedAt: T0, title: null, views: 1 }];
    const pending = await plan(rows);
    expect(pending.report.clears).toEqual([{ field: 'title', rows: 1 }]);
    expect(pending.report.summary).toMatchObject({ unchanged: 1, update: 0 });
    const allowed = await plan(rows, { allowClear: ['title'] });
    expect(allowed.report.clears).toEqual([]);
    expect(allowed.planned[0].data).toEqual({ title: null });
  });

  it('flags changed non-localized fields as applying to all locales', async () => {
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, views: 100 }]);
    expect(report.allLocales).toEqual([{ field: 'views', rows: 1 }]);
  });

  it('reports cell, media and relation problems as row errors with the field name', async () => {
    const { report } = await plan(
      [{ documentId: 'a', locale: 'en', updatedAt: T0, views: 'many', cover: 'http://x/gone.jpg', category: 'nope', seo: '{broken' }],
      { flat: true },
    );
    expect(report.summary.errors).toBe(1);
    expect(report.rows[0].action).toBe('update');
    expect(report.rows[0].errors).toEqual([
      'views: "many" is not a number',
      'seo: not valid JSON',
      'cover: no Media Library file has the URL http://x/gone.jpg',
      'category: related entry nope (en) does not exist',
    ]);
  });

  it('enforces entity and field update permissions', async () => {
    const checker = allowAll();
    checker.cannot.update = () => true;
    checker.can.update = (_entity: unknown, field?: string) => field !== 'title';
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, title: 'A2' }], { seed: { checker } });
    expect(report.rows[0].errors).toEqual(['you may not update this entry', 'title: you may not change this field']);
  });

  it('accepts a component whose leaf paths are permitted, though the bare name is not', async () => {
    const leaves = new Set(['seo.metaTitle', 'seo.shareImage', 'seo.related']);
    const run = async (permitted: Set<string>) => {
      const checker = allowAll();
      checker.can.update = (_entity: unknown, field?: string) => permitted.has(field as string);
      return plan([{ documentId: 'a', locale: 'en', updatedAt: T0, seo: { metaTitle: 'x' } }], { seed: { checker } });
    };
    const ok = await run(leaves);
    expect(ok.report.rows[0].fields).toEqual(['seo']);
    expect(ok.report.rows[0].errors).toEqual([]);
    const partial = await run(new Set(['seo.metaTitle', 'seo.shareImage']));
    expect(partial.report.rows[0].errors).toEqual(['seo: you may not change this field']);
  });

  it('surfaces entity-validator failures', async () => {
    const strapi = makeStrapi(seed());
    strapi.entityValidator.validateEntityUpdate.mockRejectedValue(
      Object.assign(new Error('invalid'), { details: { errors: [{ path: ['views'], message: 'must be at most 10' }] } }),
    );
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, views: 100 }], { strapi });
    expect(report.rows[0].errors).toEqual(['views: must be at most 10']);
    expect(strapi.entityValidator.validateEntityUpdate.mock.calls[0][1]).toEqual({ views: 100 });
    expect(strapi.entityValidator.validateEntityUpdate.mock.calls[0][2]).toEqual({ isDraft: true, locale: 'en' });
  });
});

describe('update rows: permission populate, component ids, validator paths', () => {
  it('loads the drafts with the populate the permission conditions need', async () => {
    const { strapi } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, title: 'A2' }], {
      seed: { permissionPopulate: { createdBy: true } },
    });
    expect(strapi._documents.findMany.mock.calls[0][0].populate).toMatchObject({ createdBy: true });
  });

  it('rejects a component id that does not belong to the entry', async () => {
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, quotes: [{ id: 999, text: 'x' }] }]);
    expect(report.rows[0].errors).toEqual([
      'quotes: [0]: component id 999 does not belong to this entry - remove the "id" to add it as a new item',
    ]);
  });

  it('renders a validator error without a path as the bare message', async () => {
    const strapi = makeStrapi(seed());
    strapi.entityValidator.validateEntityUpdate.mockRejectedValue(
      Object.assign(new Error('invalid'), { details: { errors: [{ path: [], message: '1 relation(s) do not exist' }] } }),
    );
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, views: 100 }], { strapi });
    expect(report.rows[0].errors).toEqual(['1 relation(s) do not exist']);
  });
});

describe('locale-scoped create permissions and unreadable columns', () => {
  const ukOnly = () => {
    const checker = allowAll();
    checker.cannot.create = (entity: any) => entity?.locale !== 'uk';
    return checker;
  };

  it('tests create and localize rows against the file locale', async () => {
    const created = await plan([{ documentId: null, locale: 'en', title: 'New' }], { seed: { checker: ukOnly() } });
    expect(created.report.rows[0].errors).toEqual(['you may not create entries of this type']);
    const localized = await plan([{ documentId: 'c', locale: 'en', title: 'C-en', views: 9 }], { seed: { checker: ukOnly() } });
    expect(localized.report.rows[0].errors).toEqual(['you may not create entries of this type']);
    const allowed = await plan([{ documentId: null, locale: 'uk', title: 'New uk' }], { seed: { checker: ukOnly() } });
    expect(allowed.report.summary).toMatchObject({ create: 1, errors: 0 });
  });

  it('hides a column the user may not read behind the unknown-column error', async () => {
    const checker = allowAll();
    checker.can.read = (_entity: unknown, path?: string) => path !== 'body';
    const { report } = await plan([{ documentId: 'a', locale: 'en', body: 'x' }], { seed: { checker } });
    expect(report.fileErrors).toEqual(['Unknown column "body"']);
  });
});

describe('create and localize rows', () => {
  it('creates a row without documentId, stripping component ids', async () => {
    const { report, planned } = await plan([{ documentId: null, locale: 'en', title: 'New', quotes: [{ id: 1, text: 'q' }], views: null }]);
    expect(report.summary).toMatchObject({ create: 1, errors: 0 });
    expect(planned[0]).toMatchObject({ action: 'create', documentId: null, data: { title: 'New', quotes: [{ text: 'q' }] } });
  });

  it('creates a localization for a document that exists only in another locale', async () => {
    const { report, planned } = await plan([
      { documentId: 'c', locale: 'en', updatedAt: T0, title: 'C-en', views: 9, category: 'catX' },
    ]);
    expect(report.summary).toMatchObject({ localize: 1, errors: 0 });
    expect(planned[0].action).toBe('localize');
    expect(planned[0].data).toEqual({ title: 'C-en', category: { set: [] } });
    expect(report.rows[0].warnings[0]).toMatch(/catX has no en version/);
    expect(report.allLocales).toEqual([]);
  });

  it('never changes a field shared by all locales through a new localization', async () => {
    const { report, planned } = await plan([{ documentId: 'c', locale: 'en', title: 'C-en', views: 10 }]);
    expect(planned[0].data).toEqual({ title: 'C-en' });
    expect(report.rows[0].warnings).toEqual(['views: shared by all locales - ignored here; change it in a row of an existing locale']);
    expect(report.allLocales).toEqual([]);
  });

  it('localizes from any sibling locale the user may read', async () => {
    const checker = allowAll();
    // Only the uk sibling is readable; the fr one comes first in the table.
    checker.sanitizedQuery.read = async (query: any) => ({ ...query, filters: { ...query.filters, title: 'C-uk' } });
    const base = seed();
    const articles = [{ id: 9, documentId: 'c', locale: 'fr', publishedAt: null, updatedAt: T0, title: 'C-fr', views: 9 }, ...base.articles];
    const strapi = makeStrapi({ ...base, articles, checker });
    strapi._documents.findMany.mockResolvedValue([]);
    const { report } = await plan([{ documentId: 'c', locale: 'en', title: 'C-en' }], { strapi });
    expect(report.summary).toMatchObject({ localize: 1, errors: 0 });
  });

  it('compares a localization only with a sibling the user may read', async () => {
    const checker = allowAll();
    checker.sanitizedQuery.read = async (query: any) => ({ ...query, filters: { documentId: { $in: [] } } });
    const { report, strapi } = await plan([{ documentId: 'c', locale: 'en', title: 'C-en', views: 10 }], { seed: { checker } });
    expect(report.rows[0]).toMatchObject({ action: 'error', fields: [], errors: ['document "c" exists but you may not read it'] });
    expect(strapi._documents.findFirst).toHaveBeenCalledWith(expect.objectContaining({ filters: { documentId: { $in: [] } } }));
  });

  it('rejects a documentId that exists nowhere', async () => {
    const { report } = await plan([{ documentId: 'ghost', locale: 'en', title: 'x' }]);
    expect(report.rows[0]).toMatchObject({ action: 'error', errors: ['document "ghost" does not exist'] });
  });

  it('rejects a document that exists in this locale but is not readable', async () => {
    const strapi = makeStrapi(seed());
    strapi._documents.findMany.mockResolvedValue([]);
    const { report } = await plan([{ documentId: 'a', locale: 'en', title: 'x' }], { strapi });
    expect(report.rows[0].errors).toEqual(['document "a" exists but you may not read it']);
  });

  it('requires create permission', async () => {
    const checker = allowAll();
    checker.cannot.create = () => true;
    const { report } = await plan([{ documentId: null, locale: 'en', title: 'New' }], { seed: { checker } });
    expect(report.rows[0].errors).toEqual(['you may not create entries of this type']);
  });
});

describe('uniqueness', () => {
  it('finds duplicates inside the file and against other documents', async () => {
    const { report } = await plan([
      { documentId: null, locale: 'en', title: 'N1', slug: 'same' },
      { documentId: null, locale: 'en', title: 'N2', slug: 'same' },
      { documentId: 'a', locale: 'en', updatedAt: T0, slug: 'b' },
    ]);
    expect(report.rows[1].errors).toEqual(['slug: "same" is also used in row 1']);
    expect(report.rows[2].errors).toEqual(['slug: "b" is already used by another entry']);
  });

  it('treats a uid attribute as unique even without the unique flag', async () => {
    const strapi = makeStrapi(seed());
    const slug = { ...(articleModel.attributes as any).slug };
    delete slug.unique;
    strapi.contentTypes[uid] = { ...articleModel, attributes: { ...articleModel.attributes, slug } };
    const { report } = await plan(
      [{ documentId: null, locale: 'en', title: 'N1', slug: 'same' }, { documentId: null, locale: 'en', title: 'N2', slug: 'same' }],
      { strapi },
    );
    expect(report.rows[1].errors).toEqual(['slug: "same" is also used in row 1']);
  });

  it('lets a row keep its own unique value', async () => {
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, slug: 'a', title: 'A2' }]);
    expect(report.summary.errors).toBe(0);
  });
});

describe('fields readable on the type but not on this entry', () => {
  const checker = () => {
    const c = allowAll();
    c.can.read = (entity: any, path?: string) => !(entity?.documentId === 'a' && path === 'title');
    return c;
  };

  it('ignores the empty cell the export produced and never reports a clear', async () => {
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, title: null, views: 1 }], { seed: { checker: checker() } });
    expect(report.summary).toMatchObject({ unchanged: 1, errors: 0 });
    expect(report.clears).toEqual([]);
  });

  it('rejects a value typed into such a cell without comparing it', async () => {
    const { report } = await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, title: 'A' }], { seed: { checker: checker() } });
    expect(report.rows[0].errors).toEqual(['title: you may not read this field of this entry - clear the cell']);
  });
});

describe('validation mode', () => {
  it('validates as a draft only when the type has Draft & Publish', async () => {
    const withDp = makeStrapi(seed());
    await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, views: 7 }], { strapi: withDp });
    expect(withDp.entityValidator.validateEntityUpdate.mock.calls[0][2]).toEqual({ isDraft: true, locale: 'en' });

    const live = makeStrapi(seed());
    const model = { ...articleModel, options: { draftAndPublish: false } };
    live.contentTypes[uid] = model;
    const getModel = live.getModel;
    live.getModel = (target: string) => (target === uid ? model : getModel(target));
    live._documents.findMany.mockImplementation(async () => [{ id: 1, documentId: 'a', locale: 'en', updatedAt: T0, title: 'A', views: 1 }]);
    await plan([{ documentId: 'a', locale: 'en', updatedAt: T0, views: 7 }], { strapi: live });
    expect(live.entityValidator.validateEntityUpdate.mock.calls[0][2]).toEqual({ isDraft: false, locale: 'en' });
  });
});
