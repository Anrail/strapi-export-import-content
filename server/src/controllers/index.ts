import { transfer } from './transfer';

// Explicit annotation: avoids TS2742 (pnpm cannot portably name Core.Strapi in emitted d.ts).
const controllers: Record<string, unknown> = { transfer };

export default controllers;
