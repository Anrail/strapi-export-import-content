import { describe, expect, it } from 'vitest';

import { buildColumns, buildPopulate, fieldPermitted, isToMany, kindOf, leafPaths, SYSTEM_COLUMNS } from '../server/src/codec/schema';
import { articleModel, getModel, nonLocalizedOf } from './helpers/models';

describe('kindOf', () => {
  it('classifies attribute types', () => {
    expect(kindOf({ type: 'string' })).toBe('scalar');
    expect(kindOf({ type: 'json' })).toBe('json');
    expect(kindOf({ type: 'blocks' })).toBe('json');
    expect(kindOf({ type: 'media' })).toBe('media');
    expect(kindOf({ type: 'relation', relation: 'manyToOne' })).toBe('relation');
    expect(kindOf({ type: 'component' })).toBe('component');
    expect(kindOf({ type: 'dynamiczone' })).toBe('dynamiczone');
  });

  it('excludes passwords and polymorphic relations', () => {
    expect(kindOf({ type: 'password' })).toBeNull();
    expect(kindOf({ type: 'relation', relation: 'morphToMany' })).toBeNull();
  });
});

describe('isToMany', () => {
  it('reads the relation cardinality', () => {
    expect(isToMany({ relation: 'manyToMany' })).toBe(true);
    expect(isToMany({ relation: 'oneToMany' })).toBe(true);
    expect(isToMany({ relation: 'manyToOne' })).toBe(false);
    expect(isToMany({ relation: 'oneToOne' })).toBe(false);
  });
});

describe('buildColumns', () => {
  const columns = buildColumns(articleModel, { nonLocalized: nonLocalizedOf(articleModel) });

  it('lists exportable attributes in schema order and skips system, password and morph ones', () => {
    expect(columns.map((c) => c.name)).toEqual([
      'title', 'slug', 'views', 'body', 'meta', 'cover', 'gallery', 'category', 'tags', 'seo', 'quotes', 'blocks',
    ]);
  });

  it('never yields a column that collides with a system column', () => {
    for (const column of columns) expect(SYSTEM_COLUMNS).not.toContain(column.name);
  });

  it('marks localization per attribute', () => {
    expect(columns.find((c) => c.name === 'title')?.localized).toBe(true);
    expect(columns.find((c) => c.name === 'views')?.localized).toBe(false);
  });

  it('drops fields the user may not access', () => {
    const allowed = buildColumns(articleModel, { nonLocalized: [], allow: (field) => field !== 'body' });
    expect(allowed.map((c) => c.name)).not.toContain('body');
  });
});

describe('buildPopulate', () => {
  it('populates media whole, relations by key, components recursively', () => {
    expect(buildPopulate(articleModel, getModel)).toEqual({
      cover: true,
      gallery: true,
      category: { fields: ['documentId', 'locale'] },
      tags: { fields: ['documentId', 'locale'] },
      seo: { populate: { shareImage: true, related: { fields: ['documentId', 'locale'] } } },
      quotes: true,
      blocks: {
        on: {
          'shared.quote': true,
          'shared.seo': { populate: { shareImage: true, related: { fields: ['documentId', 'locale'] } } },
        },
      },
    });
  });
});

describe('leafPaths / fieldPermitted', () => {
  const attrs = articleModel.attributes as any;
  const nestedModels: Record<string, any> = {
    'x.outer': { attributes: { label: { type: 'string' }, inner: { type: 'component', component: 'x.inner' } } },
    'x.inner': { attributes: { title: { type: 'string' } } },
    'x.empty': { attributes: { pw: { type: 'password' } } },
  };
  const nested = (uid: string) => nestedModels[uid];

  it('lists leaf paths for components and the bare name otherwise', () => {
    expect(leafPaths('seo', attrs.seo, getModel)).toEqual(['seo.metaTitle', 'seo.shareImage', 'seo.related']);
    expect(leafPaths('title', attrs.title, getModel)).toEqual(['title']);
    expect(leafPaths('blocks', attrs.blocks, getModel)).toEqual(['blocks']);
    expect(leafPaths('o', { type: 'component', component: 'x.outer' }, nested)).toEqual(['o.label', 'o.inner.title']);
    expect(leafPaths('e', { type: 'component', component: 'x.empty' }, nested)).toEqual([]);
  });

  it('permits a column by bare name or by all of its leaves only', () => {
    const only = (...paths: string[]) => (path: string) => paths.includes(path);
    expect(fieldPermitted(only('seo'), 'seo', attrs.seo, getModel)).toBe(true);
    expect(fieldPermitted(only('seo.metaTitle', 'seo.shareImage', 'seo.related'), 'seo', attrs.seo, getModel)).toBe(true);
    expect(fieldPermitted(only('seo.metaTitle', 'seo.shareImage'), 'seo', attrs.seo, getModel)).toBe(false);
    expect(fieldPermitted(only(), 'title', attrs.title, getModel)).toBe(false);
    expect(fieldPermitted(only('title'), 'title', attrs.title, getModel)).toBe(true);
    expect(fieldPermitted(() => true, 'e', { type: 'component', component: 'x.empty' }, nested)).toBe(true);
  });
});
