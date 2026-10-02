import { normalizeScalar, toIso } from './scalars';
import { attributeEntries, isToMany } from './schema';
import type { Column, Kind } from './schema';

export interface EncodeCtx {
  getModel(uid: string): any;
  isLocalized(uid: string): boolean;
  /** Server public URL, used to make relative media URLs absolute. */
  publicUrl: string;
  /** Whether the exported content type itself is localized. */
  sourceLocalized: boolean;
}

export const absoluteUrl = (url: string, publicUrl: string): string =>
  /^https?:\/\//i.test(url) ? url : `${publicUrl.replace(/\/$/, '')}${url}`;

const listOrNull = <T>(items: T[]): T[] | null => (items.length ? items : null);

const encodeComponent = (uid: string, value: any, ctx: EncodeCtx, withUid: boolean): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: value.id };
  if (withUid) out.__component = uid;
  for (const [name, attribute, kind] of attributeEntries(ctx.getModel(uid))) {
    out[name] = encodeValue(attribute, kind, value[name], ctx);
  }
  return out;
};

/** Stored (populated) value -> native file value. Empty lists become null. */
export function encodeValue(attribute: any, kind: Kind, value: unknown, ctx: EncodeCtx): unknown {
  if (kind === 'scalar') return normalizeScalar(attribute.type, value);
  if (value === null || value === undefined) return null;

  switch (kind) {
    case 'json':
      return value;
    case 'media': {
      const url = (file: any) => absoluteUrl(file.url, ctx.publicUrl);
      return attribute.multiple ? listOrNull((value as any[]).map(url)) : url(value);
    }
    case 'relation': {
      // Localized -> localized relations always stay in the source locale (Strapi core rule),
      // so the locale only carries information from a non-localized source.
      const withLocale = ctx.isLocalized(attribute.target) && !ctx.sourceLocalized;
      const ref = (rel: any) => (withLocale ? { documentId: rel.documentId, locale: rel.locale } : rel.documentId);
      return isToMany(attribute) ? listOrNull((value as any[]).map(ref)) : ref(value);
    }
    case 'component':
      return attribute.repeatable
        ? listOrNull((value as any[]).map((item) => encodeComponent(attribute.component, item, ctx, false)))
        : encodeComponent(attribute.component, value, ctx, false);
    case 'dynamiczone':
      return listOrNull((value as any[]).map((item) => encodeComponent(item.__component, item, ctx, true)));
    default:
      return null;
  }
}

export function encodeEntry(
  entity: any,
  columns: Column[],
  ctx: EncodeCtx,
  meta: { status: string | null; publishedAt: unknown },
): Record<string, unknown> {
  const row: Record<string, unknown> = {
    documentId: entity.documentId ?? null,
    locale: entity.locale ?? null,
    updatedAt: toIso(entity.updatedAt),
    status: meta.status,
    createdAt: toIso(entity.createdAt),
    publishedAt: toIso(meta.publishedAt),
  };
  for (const column of columns) {
    row[column.name] = encodeValue(column.attribute, column.kind, entity[column.name], ctx);
  }
  return row;
}

/** Native row -> flat row for CSV/XLSX: objects, arrays and every json value become JSON text. */
export function flattenRow(row: Record<string, unknown>, columns: Column[]): Record<string, unknown> {
  const jsonColumns = new Set(columns.filter((c) => c.kind === 'json').map((c) => c.name));
  const flat: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(row)) {
    const stringify = value !== null && value !== undefined && (typeof value === 'object' || jsonColumns.has(name));
    flat[name] = stringify ? JSON.stringify(value) : value;
  }
  return flat;
}
