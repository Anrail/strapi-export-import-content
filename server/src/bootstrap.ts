import type { Core } from '@strapi/strapi';

const RBAC_ACTIONS = [
  { section: 'plugins', displayName: 'Export', uid: 'export', pluginName: 'export-import-content' },
  { section: 'plugins', displayName: 'Import', uid: 'import', pluginName: 'export-import-content' },
];

const bootstrap = async ({ strapi }: { strapi: Core.Strapi }) => {
  await strapi.service('admin::permission').actionProvider.registerMany(RBAC_ACTIONS);
};

export default bootstrap;
