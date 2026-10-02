import { ExportBulkAction } from './components/ExportBulkAction';
import { Initializer } from './components/Initializer';
import { ListActions } from './components/ListActions';
import { PLUGIN_ID } from './pluginId';
import { getTranslation } from './utils/getTranslation';

import type { StrapiApp } from '@strapi/strapi/admin';

const plugin: StrapiApp['appPlugins'][string] = {
  register(app) {
    app.registerPlugin({
      id: PLUGIN_ID,
      initializer: Initializer,
      isReady: false,
      name: PLUGIN_ID,
    });
  },

  bootstrap(app) {
    const contentManager = app.getPlugin('content-manager') as any;
    contentManager.injectComponent('listView', 'actions', {
      name: `${PLUGIN_ID}-list-actions`,
      Component: ListActions,
    });
    contentManager.apis.addBulkAction((actions: unknown[]) => [...actions, ExportBulkAction]);
  },

  registerTrads({ locales }) {
    return Promise.all(
      locales.map(async (locale) => {
        try {
          const { default: data } = (await import(`./translations/${locale}.json`)) as {
            default: Record<string, string>;
          };
          const newData: Record<string, string> = {};
          for (const key of Object.keys(data)) newData[getTranslation(key)] = data[key];
          return { data: newData, locale };
        } catch {
          return { data: {}, locale };
        }
      }),
    );
  },
};

export default plugin;
