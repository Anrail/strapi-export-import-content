import { promises as fs } from 'node:fs';

import { CONFIG_UID } from '../config';
import type { TransferConfig } from '../config';
import { HttpError } from '../errors';

const PLUGIN = 'export-import-content';

const parseAllowClear = (value: unknown): string[] | null => {
  if (value === undefined || value === null || value === '') return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : null;
  } catch {
    return null;
  }
};

export const transfer = ({ strapi }: { strapi: any }) => {
  const service = (name: string) => strapi.plugin(PLUGIN).service(name);

  const guarded = async (ctx: any, work: () => Promise<unknown>) => {
    try {
      ctx.body = await work();
    } catch (error) {
      if (!(error instanceof HttpError)) throw error;
      return error.status === 403 ? ctx.forbidden(error.message) : ctx.badRequest(error.message);
    }
  };

  return {
    async limits(ctx: any) {
      const { maxExportRows } = strapi.config.get(CONFIG_UID) as TransferConfig;
      ctx.body = { maxExportRows };
    },

    async export(ctx: any) {
      const { uid, locale, documentIds, format } = ctx.request.body ?? {};
      await guarded(ctx, () =>
        service('export').run({ uid, locale: locale || null, documentIds, format, userAbility: ctx.state.userAbility }),
      );
    },

    async import(ctx: any) {
      const uploaded = ctx.request.files?.file;
      const uploads: any[] = (Array.isArray(uploaded) ? uploaded : [uploaded]).filter(Boolean);
      // The body middleware only cleans up the field name "files"; remove the temp files of every field here.
      const temps: string[] = Object.values(ctx.request.files ?? {})
        .flatMap((entry: any) => (Array.isArray(entry) ? entry : [entry]))
        .map((entry: any) => entry?.filepath)
        .filter((filepath): filepath is string => typeof filepath === 'string');
      try {
        const file = uploads[0];
        if (!file) return ctx.badRequest('file is required');

        const { uid, dryRun, allowClear, planHash } = ctx.request.body ?? {};
        const fields = parseAllowClear(allowClear);
        if (!fields) return ctx.badRequest('allowClear must be a JSON array of field names');

        const { maxImportBytes } = strapi.config.get(CONFIG_UID) as TransferConfig;
        if (typeof file.size === 'number' && file.size > maxImportBytes) {
          return ctx.badRequest(`The file is larger than ${maxImportBytes} bytes`);
        }

        const buffer = await fs.readFile(file.filepath);
        await guarded(ctx, () =>
          service('import').run({
            uid,
            fileName: file.originalFilename ?? '',
            buffer,
            // Applying is opt-in: anything but the literal "false" is a dry run.
            dryRun: dryRun !== 'false' && dryRun !== false,
            allowClear: fields,
            planHash: typeof planHash === 'string' ? planHash : undefined,
            userAbility: ctx.state.userAbility,
            user: ctx.state.user,
          }),
        );
      } finally {
        // A locked temp file (antivirus, Windows) must never turn a finished import into an error:
        // the client would retry and create the new entries twice.
        await Promise.all(
          temps.map((filepath) =>
            fs.rm(filepath, { force: true }).catch((error) => strapi.log?.warn?.(`[export-import-content] could not remove ${filepath}: ${error?.message ?? error}`)),
          ),
        );
      }
    },
  };
};
