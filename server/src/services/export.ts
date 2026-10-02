import { encodeEntry, flattenRow } from '../codec/encode';
import { buildColumns, buildPopulate, fieldPermitted, SYSTEM_COLUMNS } from '../codec/schema';
import { CONFIG_UID } from '../config';
import type { TransferConfig } from '../config';
import { HttpError } from '../errors';
import { FORMATS, MIME } from '../formats';
import type { Format } from '../formats';
import { toCsv } from '../formats/csv';
import { toJson } from '../formats/json';
import { toXlsx } from '../formats/xlsx';
import {
  assertCollectionType, computeStatus, fetchDrafts, fetchPublished, getChecker, hasDP, i18nOf, permissionPopulate, publicUrlOf,
} from './context';

export interface ExportResult {
  fileName: string;
  mimeType: string;
  contentBase64: string;
  rowCount: number;
  warnings: { longCells: number };
}

const stamp = (date: Date): string => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};

export const exportService = ({ strapi }: { strapi: any }) => ({
  async run(input: {
    uid: unknown;
    locale: string | null;
    documentIds: unknown;
    format: unknown;
    userAbility: unknown;
  }): Promise<ExportResult> {
    const model = assertCollectionType(strapi, input.uid);
    const uid = model.uid as string;
    const limits = strapi.config.get(CONFIG_UID) as TransferConfig;

    if (!FORMATS.includes(input.format as Format)) throw new HttpError(400, 'format must be csv, json or xlsx');
    const format = input.format as Format;
    const ids = input.documentIds;
    if (!Array.isArray(ids) || !ids.length || !ids.every((id) => typeof id === 'string' && id)) {
      throw new HttpError(400, 'documentIds must be a non-empty array of strings');
    }
    if (ids.length > limits.maxExportRows) {
      throw new HttpError(400, `${ids.length} entries selected; the export limit is ${limits.maxExportRows}`);
    }

    const checker = getChecker(strapi, uid, input.userAbility);
    if (checker.cannot.read()) throw new HttpError(403, 'You may not read this content type');

    const i18n = i18nOf(strapi);
    const localized = i18n.isLocalized(uid);
    const locale = localized ? (input.locale ?? (await i18n.defaultLocale())) : null;
    const getModel = (target: string) => strapi.getModel(target);

    const columns = buildColumns(model, {
      nonLocalized: localized ? i18n.nonLocalized(model) : [],
      allow: (field) => fieldPermitted((path) => checker.can.read(null, path), field, model.attributes[field], getModel),
    });
    const populate = await permissionPopulate(strapi, uid, checker, 'read', buildPopulate(model, getModel), model);
    const drafts = await fetchDrafts(strapi, uid, ids, locale, populate, checker);
    const published = hasDP(model) ? await fetchPublished(strapi, uid, ids, locale) : new Map<string, any>();

    const ctx = { getModel, isLocalized: i18n.isLocalized, publicUrl: publicUrlOf(strapi), sourceLocalized: localized };
    const rows = (ids as string[])
      .filter((id) => drafts.has(id))
      .map((id) => {
        const draft = drafts.get(id);
        const live = published.get(id);
        const row = encodeEntry(draft, columns, ctx, {
          status: computeStatus(model, draft, live),
          publishedAt: live?.publishedAt ?? null,
        });
        // A field readable on the type may be unreadable on THIS entry (conditional permission).
        for (const column of columns) {
          if (!fieldPermitted((path) => checker.can.read(draft, path), column.name, column.attribute, getModel)) {
            row[column.name] = null;
          }
        }
        return row;
      });

    const names = [...SYSTEM_COLUMNS, ...columns.map((column) => column.name)];
    let buffer: Buffer;
    let longCells = 0;
    if (format === 'json') {
      buffer = Buffer.from(toJson({ columns: names, rows }, { contentType: uid, locale }), 'utf8');
    } else {
      const flat = { columns: names, rows: rows.map((row) => flattenRow(row, columns)) };
      if (format === 'csv') buffer = Buffer.from(toCsv(flat), 'utf8');
      else {
        const workbook = await toXlsx(flat);
        buffer = workbook.buffer;
        longCells = workbook.longCells.length;
      }
    }

    return {
      fileName: `${model.info.singularName}-${locale ?? 'all'}-${stamp(new Date())}.${format}`,
      mimeType: MIME[format],
      contentBase64: buffer.toString('base64'),
      rowCount: rows.length,
      warnings: { longCells },
    };
  },
});
