import { vi } from 'vitest';

import config, { CONFIG_UID } from '../../server/src/config';
import { articleModel, categoryModel, getModel, nonLocalizedOf } from './models';

export interface Seed {
  /** Rows of api::article.article - drafts have publishedAt null. */
  articles?: any[];
  categories?: any[];
  files?: any[];
  checker?: Record<string, any>;
  limits?: Record<string, number>;
  /** What the Content Manager's populate builder adds for the permission conditions. */
  permissionPopulate?: Record<string, unknown>;
}

const matches = (row: any, where: Record<string, any> = {}): boolean =>
  Object.entries(where).every(([key, condition]) => {
    const value = row[key] ?? null;
    if (condition && typeof condition === 'object') {
      if ('$in' in condition) return condition.$in.includes(value);
      if ('$notNull' in condition) return (value !== null) === condition.$notNull;
    }
    return value === condition;
  });

/** A permission checker that allows everything; override members per test. */
export const allowAll = () => {
  const can: any = () => true;
  const cannot: any = () => false;
  for (const action of ['read', 'create', 'update']) {
    can[action] = () => true;
    cannot[action] = () => false;
  }
  const sanitizedQuery: any = async (query: any) => query;
  sanitizedQuery.read = async (query: any) => query;
  sanitizedQuery.update = async (query: any) => query;
  return { can, cannot, sanitizedQuery };
};

export const makeStrapi = (seed: Seed = {}) => {
  const tables: Record<string, any[]> = {
    [articleModel.uid]: seed.articles ?? [],
    [categoryModel.uid]: seed.categories ?? [],
    'plugin::upload.file': seed.files ?? [],
  };
  const checker = { ...allowAll(), ...seed.checker };
  // The mocks are shared across uids; documents(uid) selects the table they read.
  let currentUid = articleModel.uid;
  const select = ({ filters, locale, status }: any) =>
    tables[currentUid].filter(
      (row) =>
        (status !== 'draft' || row.publishedAt == null) && matches(row, filters) && (!locale || row.locale === locale),
    );

  const documents = {
    findMany: vi.fn(async (params: any) => select(params)),
    findFirst: vi.fn(async (params: any) => select(params)[0] ?? null),
    create: vi.fn(async (params: any) => params),
    update: vi.fn(async (params: any) => params),
  };

  const i18nServices: Record<string, any> = {
    'content-types': {
      isLocalizedContentType: (model: any) => model?.pluginOptions?.i18n?.localized === true,
      getNonLocalizedAttributes: nonLocalizedOf,
    },
    locales: {
      getDefaultLocale: async () => 'en',
      find: async () => [{ code: 'en' }, { code: 'uk' }],
    },
  };

  const settings: Record<string, unknown> = {
    [CONFIG_UID]: { ...config.default, ...seed.limits },
    'server.absoluteUrl': 'http://localhost:3000',
  };

  return {
    contentTypes: { [articleModel.uid]: articleModel, [categoryModel.uid]: categoryModel } as Record<string, any>,
    getModel,
    config: { get: (key: string) => settings[key] },
    plugin: (name: string) => {
      if (name === 'i18n') return { service: (service: string) => i18nServices[service] };
      if (name === 'content-manager') {
        return {
          service: (service: string) =>
            service === 'populate-builder'
              ? () => ({ populateFromQuery: () => ({ build: async () => seed.permissionPopulate ?? {} }) })
              : { create: () => checker },
        };
      }
      return undefined;
    },
    documents: vi.fn((uid: string) => {
      currentUid = uid;
      return documents;
    }),
    db: {
      query: (uid: string) => ({
        findMany: async ({ where }: any = {}) => tables[uid].filter((row) => matches(row, where)),
        findOne: async ({ where }: any = {}) => tables[uid].find((row) => matches(row, where)) ?? null,
        count: async ({ where }: any = {}) => tables[uid].filter((row) => matches(row, where)).length,
      }),
      transaction: async (run: () => Promise<unknown>) => run(),
    },
    entityValidator: {
      validateEntityCreation: vi.fn(async () => undefined),
      validateEntityUpdate: vi.fn(async () => undefined),
    },
    _documents: documents,
  } as any;
};
