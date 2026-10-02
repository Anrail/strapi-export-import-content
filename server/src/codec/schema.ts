export const SYSTEM_COLUMNS = ['documentId', 'locale', 'updatedAt', 'status', 'createdAt', 'publishedAt'] as const;

/** Attributes that are never a data column: system fields and Strapi's own bookkeeping. */
const SKIP = new Set<string>([...SYSTEM_COLUMNS, 'id', 'localizations', 'createdBy', 'updatedBy']);

export type Kind = 'scalar' | 'json' | 'media' | 'relation' | 'component' | 'dynamiczone';

export interface Column {
  name: string;
  kind: Kind;
  attribute: any;
  /** False for an i18n non-localized attribute: writing it changes every locale. */
  localized: boolean;
}

/** null = not exportable (passwords, polymorphic relations). */
export const kindOf = (attribute: any): Kind | null => {
  switch (attribute?.type) {
    case 'password':
      return null;
    case 'media':
      return 'media';
    case 'relation':
      return /morph/i.test(String(attribute.relation)) ? null : 'relation';
    case 'component':
      return 'component';
    case 'dynamiczone':
      return 'dynamiczone';
    case 'json':
    case 'blocks':
      return 'json';
    default:
      return 'scalar';
  }
};

export const isToMany = (attribute: any): boolean => /ToMany$/.test(String(attribute.relation));

/** Exportable attributes of a content type or component, in schema order. */
export const attributeEntries = (model: any): Array<[string, any, Kind]> => {
  const entries: Array<[string, any, Kind]> = [];
  for (const [name, attribute] of Object.entries<any>(model?.attributes ?? {})) {
    const kind = SKIP.has(name) ? null : kindOf(attribute);
    if (kind) entries.push([name, attribute, kind]);
  }
  return entries;
};

/** Permission paths Strapi stores for an attribute: leaf paths for components, the bare name otherwise. */
export function leafPaths(name: string, attribute: any, getModel: (uid: string) => any): string[] {
  if (attribute?.type !== 'component') return [name];
  return attributeEntries(getModel(attribute.component)).flatMap(([inner, innerAttribute]) =>
    leafPaths(`${name}.${inner}`, innerAttribute, getModel),
  );
}

/** True when the user may access the whole column. `can` receives a permission path. */
export function fieldPermitted(
  can: (path: string) => boolean,
  name: string,
  attribute: any,
  getModel: (uid: string) => any,
): boolean {
  if (can(name)) return true;
  const paths = leafPaths(name, attribute, getModel);
  return paths.length > 0 && paths.every(can);
}

export function buildColumns(
  model: any,
  opts: { nonLocalized: string[]; allow?: (field: string) => boolean },
): Column[] {
  return attributeEntries(model)
    .filter(([name]) => !opts.allow || opts.allow(name))
    .map(([name, attribute, kind]) => ({ name, kind, attribute, localized: !opts.nonLocalized.includes(name) }));
}

const RELATION_FIELDS = { fields: ['documentId', 'locale'] };

/** Populate object for the Document Service: everything the codec needs, nothing more. */
export function buildPopulate(model: any, getModel: (uid: string) => any): Record<string, unknown> {
  const nested = (uid: string): unknown => {
    const populate = buildPopulate(getModel(uid), getModel);
    return Object.keys(populate).length ? { populate } : true;
  };

  const populate: Record<string, unknown> = {};
  for (const [name, attribute, kind] of attributeEntries(model)) {
    if (kind === 'media') populate[name] = true;
    else if (kind === 'relation') populate[name] = RELATION_FIELDS;
    else if (kind === 'component') populate[name] = nested(attribute.component);
    else if (kind === 'dynamiczone') {
      populate[name] = { on: Object.fromEntries(attribute.components.map((uid: string) => [uid, nested(uid)])) };
    }
  }
  return populate;
}
