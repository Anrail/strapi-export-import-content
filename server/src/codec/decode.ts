import { CellError } from '../errors';
import type { EncodeCtx } from './encode';
import { isEmpty, normalizeScalar } from './scalars';
import { attributeEntries, isToMany } from './schema';
import type { Kind } from './schema';

export interface Resolvers {
  /** Looks a stored file URL up in the Media Library. */
  media(url: string): Promise<{ id: number } | 'missing' | 'ambiguous'>;
  /** True when the target document has a draft (in that locale, when given). */
  relationExists(targetUid: string, documentId: string, locale: string | null): Promise<boolean>;
}

export interface DecodeCtx extends EncodeCtx {
  rowLocale: string | null;
  defaultLocale: string | null;
  /** Create rows: component ids belong to another entry and must not be reused. */
  stripIds: boolean;
  /** Localization-creating rows: a relation without a version in the new locale is skipped. */
  skipMissingRelations: boolean;
  /** Update rows: ids of the components the entry already holds; any other id is refused. */
  knownComponentIds?: Set<number | string>;
  resolvers: Resolvers;
}

export interface Decoded {
  value: unknown;
  errors: string[];
  warnings: string[];
}

type Ref = string | { documentId: string; locale: string };

const isObject = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (cell: unknown): unknown => {
  if (typeof cell !== 'string') return cell;
  try {
    return JSON.parse(cell);
  } catch {
    throw new CellError('not valid JSON');
  }
};

const asRef = (value: unknown): Ref => {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (isObject(value) && typeof value.documentId === 'string' && value.documentId) {
    return value.locale ? { documentId: value.documentId, locale: String(value.locale) } : value.documentId;
  }
  throw new CellError('a relation must be a documentId or {"documentId", "locale"}');
};

/** File cell -> native value (the form `encodeValue` produces). Throws CellError. */
export function parseCell(column: { attribute: any; kind: Kind }, cell: unknown, flat: boolean): unknown {
  const { attribute, kind } = column;
  if (kind === 'scalar') return normalizeScalar(attribute.type, cell);
  // In a JSON file "" is a real json value; only a flat cell uses the empty string for "no value".
  if (kind === 'json' && !flat) return cell ?? null;
  if (isEmpty(cell)) return null;
  if (kind === 'json') return parseJson(cell);

  const value = typeof cell === 'string' && /^\s*[[{]/.test(cell) ? parseJson(cell) : cell;

  if (kind === 'media') {
    const list = Array.isArray(value) ? value : [value];
    if (!list.every((url) => typeof url === 'string' && url.trim())) {
      throw new CellError('media must be a URL or a JSON array of URLs');
    }
    if (!list.length) return null;
    if (attribute.multiple) return list;
    if (list.length !== 1) throw new CellError('this field takes one URL');
    return list[0];
  }

  if (kind === 'relation') {
    const list = (Array.isArray(value) ? value : [value]).map(asRef);
    if (!list.length) return null;
    if (isToMany(attribute)) return list;
    if (list.length !== 1) throw new CellError('this field takes one reference');
    return list[0];
  }

  if (kind === 'dynamiczone' || attribute.repeatable) {
    if (!Array.isArray(value) || !value.every(isObject)) throw new CellError('expected a JSON array of objects');
    if (kind === 'dynamiczone' && !value.every((item) => typeof item.__component === 'string')) {
      throw new CellError('every dynamic-zone item needs a "__component"');
    }
    return value.length ? value : null;
  }

  if (!isObject(value)) throw new CellError('expected a JSON object');
  return value;
}

const stripPublic = (url: string, publicUrl: string): string => {
  const base = publicUrl.replace(/\/$/, '');
  return base && url.startsWith(`${base}/`) ? url.slice(base.length) : url;
};

/** Native value -> Document Service input. Never throws for bad content: it reports. */
export async function decodeValue(
  attribute: any,
  kind: Kind,
  native: unknown,
  ctx: DecodeCtx,
  path = '',
): Promise<Decoded> {
  const out: Decoded = { value: null, errors: [], warnings: [] };
  const at = (message: string) => (path ? `${path}: ${message}` : message);

  if (kind === 'scalar' || kind === 'json') {
    out.value = native ?? null;
    return out;
  }

  if (kind === 'media') {
    const urls = native == null ? [] : Array.isArray(native) ? native : [native];
    const ids: number[] = [];
    for (const url of urls) {
      const hit = await ctx.resolvers.media(stripPublic(String(url), ctx.publicUrl));
      if (hit === 'missing') out.errors.push(at(`no Media Library file has the URL ${url}`));
      else if (hit === 'ambiguous') out.errors.push(at(`several Media Library files have the URL ${url}`));
      else ids.push(hit.id);
    }
    out.value = attribute.multiple ? ids : (ids[0] ?? null);
    return out;
  }

  if (kind === 'relation') {
    const refs = (native == null ? [] : Array.isArray(native) ? native : [native]) as Ref[];
    const targetLocalized = ctx.isLocalized(attribute.target);
    const set: Array<Record<string, string>> = [];
    for (const ref of refs) {
      const documentId = typeof ref === 'string' ? ref : ref.documentId;
      let locale: string | null = null;
      if (targetLocalized) {
        locale = ctx.sourceLocalized ? ctx.rowLocale : typeof ref === 'string' ? ctx.defaultLocale : ref.locale;
      }
      if (await ctx.resolvers.relationExists(attribute.target, documentId, locale)) {
        set.push(locale && !ctx.sourceLocalized ? { documentId, locale } : { documentId });
      } else if (ctx.skipMissingRelations) {
        out.warnings.push(at(`related entry ${documentId} has no ${locale ?? 'matching'} version - skipped`));
      } else {
        out.errors.push(at(`related entry ${documentId}${locale ? ` (${locale})` : ''} does not exist`));
      }
    }
    out.value = { set };
    return out;
  }

  const decodeItem = async (item: Record<string, any>, index: number | null) => {
    const itemPath = `${path}${index === null ? '' : `[${index}]`}`;
    const uid = kind === 'dynamiczone' ? item.__component : attribute.component;
    if (kind === 'dynamiczone' && !attribute.components.includes(uid)) {
      out.errors.push(`${itemPath}: component "${uid}" is not allowed here`);
      return null;
    }
    const result: Record<string, unknown> = {};
    if (kind === 'dynamiczone') result.__component = uid;
    if (!ctx.stripIds && item.id != null) {
      if (ctx.knownComponentIds && !ctx.knownComponentIds.has(item.id)) {
        out.errors.push(
          `${itemPath || 'item'}: component id ${item.id} does not belong to this entry - remove the "id" to add it as a new item`,
        );
      } else result.id = item.id;
    }

    const known = new Map(attributeEntries(ctx.getModel(uid)).map(([name, a, k]) => [name, { attribute: a, kind: k }]));
    for (const [name, raw] of Object.entries(item)) {
      if (name === 'id' || name === '__component') continue;
      const fieldPath = `${itemPath}${itemPath ? '.' : ''}${name}`;
      const column = known.get(name);
      if (!column) {
        out.errors.push(`${fieldPath}: unknown field`);
        continue;
      }
      try {
        const nested = await decodeValue(column.attribute, column.kind, parseCell(column, raw, false), ctx, fieldPath);
        out.errors.push(...nested.errors);
        out.warnings.push(...nested.warnings);
        result[name] = nested.value;
      } catch (error) {
        if (!(error instanceof CellError)) throw error;
        out.errors.push(`${fieldPath}: ${error.message}`);
      }
    }
    return result;
  };

  if (kind === 'dynamiczone' || attribute.repeatable) {
    const items: unknown[] = [];
    for (const [index, item] of ((native as any[]) ?? []).entries()) {
      const decoded = await decodeItem(item, index);
      if (decoded) items.push(decoded);
    }
    out.value = items;
  } else {
    out.value = native == null ? null : await decodeItem(native as Record<string, any>, null);
  }
  return out;
}

/** Copy of decoded data without relation attributes - the entity validator cannot take refs. */
export function stripRelations(
  data: Record<string, unknown>,
  model: any,
  getModel: (uid: string) => any,
): Record<string, unknown> {
  const known = new Map(attributeEntries(model).map(([name, attribute, kind]) => [name, { attribute, kind }]));
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(data)) {
    const info = known.get(name);
    if (info?.kind === 'relation') continue;
    if (info?.kind === 'component' && value) {
      const strip = (item: any) => stripRelations(item, getModel(info.attribute.component), getModel);
      out[name] = Array.isArray(value) ? value.map(strip) : strip(value);
    } else if (info?.kind === 'dynamiczone' && Array.isArray(value)) {
      out[name] = value.map((item: any) => stripRelations(item, getModel(item.__component), getModel));
    } else {
      out[name] = value;
    }
  }
  return out;
}
