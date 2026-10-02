const localized = { pluginOptions: { i18n: { localized: true } } };

export const seoModel = {
  uid: 'shared.seo',
  attributes: {
    metaTitle: { type: 'string' },
    shareImage: { type: 'media', multiple: false },
    related: { type: 'relation', relation: 'oneToOne', target: 'api::category.category' },
  },
};

export const quoteModel = {
  uid: 'shared.quote',
  attributes: { text: { type: 'text' } },
};

export const categoryModel = {
  uid: 'api::category.category',
  kind: 'collectionType',
  info: { singularName: 'category' },
  options: { draftAndPublish: true },
  pluginOptions: { i18n: { localized: true } },
  attributes: { name: { type: 'string', ...localized } },
};

export const articleModel = {
  uid: 'api::article.article',
  kind: 'collectionType',
  info: { singularName: 'article' },
  options: { draftAndPublish: true },
  pluginOptions: { i18n: { localized: true } },
  attributes: {
    title: { type: 'string', ...localized },
    slug: { type: 'uid', unique: true, ...localized },
    views: { type: 'integer' },
    body: { type: 'richtext', ...localized },
    meta: { type: 'json', ...localized },
    cover: { type: 'media', multiple: false, ...localized },
    gallery: { type: 'media', multiple: true, ...localized },
    category: { type: 'relation', relation: 'manyToOne', target: 'api::category.category', ...localized },
    tags: { type: 'relation', relation: 'manyToMany', target: 'api::category.category', ...localized },
    owner: { type: 'relation', relation: 'morphToOne' },
    seo: { type: 'component', component: 'shared.seo', repeatable: false, ...localized },
    quotes: { type: 'component', component: 'shared.quote', repeatable: true, ...localized },
    blocks: { type: 'dynamiczone', components: ['shared.quote', 'shared.seo'], ...localized },
    secret: { type: 'password' },
    createdBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
    updatedBy: { type: 'relation', relation: 'oneToOne', target: 'admin::user' },
    localizations: { type: 'relation', relation: 'oneToMany', target: 'api::article.article' },
    createdAt: { type: 'datetime' },
    updatedAt: { type: 'datetime' },
    publishedAt: { type: 'datetime' },
    locale: { type: 'string' },
  },
};

const models: Record<string, any> = {
  [articleModel.uid]: articleModel,
  [categoryModel.uid]: categoryModel,
  [seoModel.uid]: seoModel,
  [quoteModel.uid]: quoteModel,
};

export const getModel = (uid: string) => models[uid];

/** Mirrors the i18n plugin: an attribute is localized only when it says so. */
export const nonLocalizedOf = (model: any): string[] =>
  Object.entries<any>(model.attributes)
    .filter(([, attribute]) => attribute.pluginOptions?.i18n?.localized !== true)
    .map(([name]) => name);
