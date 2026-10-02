const allow = (action: string) => [
  'admin::isAuthenticatedAdmin',
  { name: 'admin::hasPermissions', config: { actions: [`plugin::export-import-content.${action}`] } },
];

export default {
  type: 'admin',
  routes: [
    { method: 'GET', path: '/limits', handler: 'transfer.limits', config: { policies: allow('export') } },
    { method: 'POST', path: '/export', handler: 'transfer.export', config: { policies: allow('export') } },
    { method: 'POST', path: '/import', handler: 'transfer.import', config: { policies: allow('import') } },
  ],
};
