import bootstrap from './bootstrap';
import config from './config';
import controllers from './controllers';
import routes from './routes';
import services from './services';

// Explicit annotation: avoids TS2742 (pnpm cannot portably name Core.Strapi in emitted d.ts).
const plugin: Record<string, unknown> = {
  bootstrap,
  config,
  controllers,
  routes,
  services,
};

export default plugin;
