import { exportService } from './export';
import { importService } from './import';

// Explicit annotation: avoids TS2742 (pnpm cannot portably name Core.Strapi in emitted d.ts).
const services: Record<string, unknown> = { export: exportService, import: importService };

export default services;
