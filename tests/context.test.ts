import { describe, expect, it } from 'vitest';

import { HttpError } from '../server/src/errors';
import {
  assertCollectionType, chunk, computeStatus, fetchDrafts, fetchPublished, hasDP, i18nOf, permissionPopulate, publicUrlOf,
} from '../server/src/services/context';
import { createResolvers } from '../server/src/services/resolvers';
import { articleModel, categoryModel } from './helpers/models';
import { allowAll, makeStrapi } from './helpers/strapi';

const draft = (documentId: string, locale: string, extra: any = {}) => ({ documentId, locale, publishedAt: null, ...extra });

describe('assertCollectionType', () => {
  const strapi = makeStrapi();

  it('returns the model of an api collection type', () => {
    expect(assertCollectionType(strapi, articleModel.uid)).toBe(articleModel);
  });

  it.each(['api::nope.nope', 'plugin::upload.file', 'admin::user', undefined, 42])('rejects %s', (uid) => {
    expect(() => assertCollectionType(strapi, uid)).toThrow(HttpError);
  });

  it('rejects a single type', () => {
    strapi.contentTypes['api::home.home'] = { uid: 'api::home.home', kind: 'singleType', attributes: {} };
    expect(() => assertCollectionType(strapi, 'api::home.home')).toThrow(/collection type/);
  });
});

describe('small helpers', () => {
  it('chunk splits a list', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 2)).toEqual([]);
  });

  it('hasDP and publicUrlOf read the model and the config', () => {
    expect(hasDP(articleModel)).toBe(true);
    expect(hasDP({ options: {} })).toBe(false);
    expect(publicUrlOf(makeStrapi())).toBe('http://localhost:3000');
  });

  it('i18nOf wraps the i18n plugin and survives its absence', async () => {
    const i18n = i18nOf(makeStrapi());
    expect(i18n.isLocalized(articleModel.uid)).toBe(true);
    expect(await i18n.defaultLocale()).toBe('en');
    expect(await i18n.localeCodes()).toEqual(['en', 'uk']);
    const none = i18nOf({ plugin: () => undefined, getModel: () => articleModel });
    expect(none.isLocalized(articleModel.uid)).toBe(false);
    expect(await none.localeCodes()).toEqual([]);
  });

  it('computeStatus follows the Content Manager statuses', () => {
    const d = { updatedAt: '2026-09-01T10:00:00.000Z' };
    expect(computeStatus(articleModel, d, undefined)).toBe('draft');
    expect(computeStatus(articleModel, d, { updatedAt: '2026-09-01T10:00:00.000Z' })).toBe('published');
    expect(computeStatus(articleModel, d, { updatedAt: '2026-09-01T09:00:00.000Z' })).toBe('modified');
    expect(computeStatus({ options: {} }, d, undefined)).toBeNull();
  });
});

describe('fetchDrafts / fetchPublished', () => {
  const strapi = makeStrapi({
    articles: [
      draft('a', 'en'),
      draft('a', 'uk'),
      draft('b', 'en'),
      { documentId: 'a', locale: 'en', publishedAt: '2026-09-01T12:00:00.000Z', updatedAt: '2026-09-01T12:00:00.000Z' },
    ],
  });

  it('reads drafts of one locale keyed by documentId', async () => {
    const map = await fetchDrafts(strapi, articleModel.uid, ['a', 'b', 'zzz'], 'en', {}, allowAll());
    expect([...map.keys()]).toEqual(['a', 'b']);
    expect(map.get('a').locale).toBe('en');
  });

  it('asks the Document Service for drafts with the sanitized filters', async () => {
    strapi._documents.findMany.mockClear();
    await fetchDrafts(strapi, articleModel.uid, ['a', 'b'], 'en', { cover: true }, allowAll());
    expect(strapi._documents.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'draft', limit: 2, locale: 'en', populate: { cover: true }, filters: { documentId: { $in: ['a', 'b'] } },
      }),
    );
  });

  it('serves each uid from its own table', async () => {
    const two = makeStrapi({ articles: [draft('a', 'en')], categories: [draft('cat1', 'en')] });
    const rows = await two.documents(categoryModel.uid).findMany({ status: 'draft' });
    expect(rows.map((row: any) => row.documentId)).toEqual(['cat1']);
  });

  it('reads published versions keyed by documentId', async () => {
    const map = await fetchPublished(strapi, articleModel.uid, ['a', 'b'], 'en');
    expect([...map.keys()]).toEqual(['a']);
  });
});

describe('createResolvers', () => {
  const strapi = makeStrapi({
    files: [{ id: 7, url: '/uploads/a.jpg' }, { id: 8, url: '/uploads/dup.jpg' }, { id: 9, url: '/uploads/dup.jpg' }],
    categories: [draft('cat1', 'en'), { documentId: 'cat2', locale: 'en', publishedAt: '2026-09-01T12:00:00.000Z' }],
  });
  const resolvers = createResolvers(strapi);

  it('matches a media URL exactly, and tells missing from ambiguous', async () => {
    expect(await resolvers.media('/uploads/a.jpg')).toEqual({ id: 7 });
    expect(await resolvers.media('/uploads/a.jpg?v=2')).toBe('missing');
    expect(await resolvers.media('/uploads/dup.jpg')).toBe('ambiguous');
  });

  it('finds relation targets by draft, in the requested locale', async () => {
    expect(await resolvers.relationExists(categoryModel.uid, 'cat1', 'en')).toBe(true);
    expect(await resolvers.relationExists(categoryModel.uid, 'cat1', 'uk')).toBe(false);
    expect(await resolvers.relationExists(categoryModel.uid, 'cat2', 'en')).toBe(false);
    expect(await resolvers.relationExists(categoryModel.uid, 'nope', null)).toBe(false);
  });
});

describe('permissionPopulate', () => {
  const base = { category: { fields: ['documentId', 'locale'] }, seo: { populate: { shareImage: true } } };
  const run = (extra: unknown) =>
    permissionPopulate(makeStrapi({ permissionPopulate: extra as any }), articleModel.uid, allowAll(), 'update', base, articleModel);

  it('adds what only the permission conditions need', async () => {
    expect(await run({ createdBy: true })).toEqual({ ...base, createdBy: true });
  });

  it('loads a relation fully when both sides want it, but lets the codec win for components', async () => {
    const merged = await run({ category: true, seo: true });
    expect(merged.category).toBe(true);
    expect(merged.seo).toEqual(base.seo);
  });

  it('returns the base when the builder yields no object', async () => {
    expect(await run(null)).toEqual(base);
  });
});
