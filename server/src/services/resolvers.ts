import type { Resolvers } from '../codec/decode';
import { hasDP } from './context';

/** DB-backed lookups for one import run; each distinct question is asked once. */
export const createResolvers = (strapi: any): Resolvers => {
  const media = new Map<string, Promise<{ id: number } | 'missing' | 'ambiguous'>>();
  const relations = new Map<string, Promise<boolean>>();

  const once = <T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> => {
    if (!cache.has(key)) cache.set(key, load());
    return cache.get(key)!;
  };

  return {
    media: (url) =>
      once(media, url, async () => {
        const files = await strapi.db.query('plugin::upload.file').findMany({ where: { url }, select: ['id'], limit: 2 });
        if (!files.length) return 'missing';
        return files.length > 1 ? 'ambiguous' : { id: files[0].id };
      }),

    relationExists: (targetUid, documentId, locale) =>
      once(relations, `${targetUid}|${documentId}|${locale ?? ''}`, async () => {
        const where: Record<string, unknown> = { documentId };
        if (locale) where.locale = locale;
        if (hasDP(strapi.getModel(targetUid))) where.publishedAt = null;
        return (await strapi.db.query(targetUid).count({ where })) > 0;
      }),
  };
};
