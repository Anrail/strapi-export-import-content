import { HttpError } from '../errors';

export const hasDP = (model: any): boolean => model?.options?.draftAndPublish === true;

/** Only project collection types are exportable - never plugin or admin content types. */
export function assertCollectionType(strapi: any, uid: unknown): any {
  const model = typeof uid === 'string' && uid.startsWith('api::') ? strapi.contentTypes[uid] : undefined;
  if (!model || model.kind !== 'collectionType') {
    throw new HttpError(400, `"${String(uid)}" is not an exportable collection type`);
  }
  return model;
}

export const getChecker = (strapi: any, uid: string, userAbility: unknown): any =>
  strapi.plugin('content-manager').service('permission-checker').create({ userAbility, model: uid });

export const i18nOf = (strapi: any) => {
  const plugin = strapi.plugin('i18n');
  return {
    isLocalized: (uid: string): boolean =>
      plugin ? Boolean(plugin.service('content-types').isLocalizedContentType(strapi.getModel(uid))) : false,
    nonLocalized: (model: any): string[] =>
      plugin ? plugin.service('content-types').getNonLocalizedAttributes(model) : [],
    defaultLocale: async (): Promise<string | null> =>
      plugin ? plugin.service('locales').getDefaultLocale() : null,
    localeCodes: async (): Promise<string[]> =>
      plugin ? (await plugin.service('locales').find()).map((locale: any) => locale.code) : [],
  };
};

export const publicUrlOf = (strapi: any): string =>
  String(strapi.config.get('server.absoluteUrl') ?? '');

export const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const BATCH = 100;

/** Drafts the user may read, keyed by documentId. Unreadable or missing ids are simply absent. */
export async function fetchDrafts(
  strapi: any,
  uid: string,
  documentIds: string[],
  locale: string | null,
  populate: unknown,
  checker: any,
): Promise<Map<string, any>> {
  const drafts = new Map<string, any>();
  for (const ids of chunk(documentIds, BATCH)) {
    const query = await checker.sanitizedQuery.read({ filters: { documentId: { $in: ids } } });
    const rows = await strapi.documents(uid).findMany({
      ...query,
      populate,
      status: 'draft',
      limit: ids.length,
      ...(locale ? { locale } : {}),
    });
    for (const row of rows) drafts.set(row.documentId, row);
  }
  return drafts;
}

export async function fetchPublished(
  strapi: any,
  uid: string,
  documentIds: string[],
  locale: string | null,
): Promise<Map<string, any>> {
  const published = new Map<string, any>();
  for (const ids of chunk(documentIds, BATCH)) {
    const rows = await strapi.db.query(uid).findMany({
      where: { documentId: { $in: ids }, publishedAt: { $notNull: true }, ...(locale ? { locale } : {}) },
      select: ['documentId', 'updatedAt', 'publishedAt'],
    });
    for (const row of rows) published.set(row.documentId, row);
  }
  return published;
}

export function computeStatus(model: any, draft: any, published: any | undefined): 'draft' | 'modified' | 'published' | null {
  if (!hasDP(model)) return null;
  if (!published) return 'draft';
  return new Date(published.updatedAt).getTime() >= new Date(draft.updatedAt).getTime() ? 'published' : 'modified';
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Populate the permission conditions for `action` need, merged over the codec's populate. */
export async function permissionPopulate(
  strapi: any,
  uid: string,
  checker: any,
  action: 'read' | 'update',
  base: Record<string, unknown>,
  model: any,
): Promise<Record<string, unknown>> {
  const query = await checker.sanitizedQuery[action]({});
  const extra = await strapi.plugin('content-manager').service('populate-builder')(uid).populateFromQuery(query).build();
  if (!isPlain(extra)) return base;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in base)) merged[key] = value;
    else if (model?.attributes?.[key]?.type === 'relation') merged[key] = true;
  }
  return merged;
}
