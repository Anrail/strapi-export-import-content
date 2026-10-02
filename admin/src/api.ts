import { getFetchClient } from '@strapi/strapi/admin';

import { PLUGIN_ID } from './pluginId';
import { stringifyQuery } from './utils/query';

export type Format = 'csv' | 'json' | 'xlsx';
export const FORMATS: Format[] = ['csv', 'json', 'xlsx'];

export const PERMISSIONS = {
  export: [{ action: `plugin::${PLUGIN_ID}.export`, subject: null }],
  import: [{ action: `plugin::${PLUGIN_ID}.import`, subject: null }],
};

/** Array form for useRBAC; the returned keys are canExport / canImport. */
export const PERMISSION_LIST = [...PERMISSIONS.export, ...PERMISSIONS.import];

export interface RowReport {
  row: number;
  documentId: string | null;
  action: 'create' | 'update' | 'localize' | 'error';
  fields: string[];
  errors: string[];
  warnings: string[];
  outcome?: 'applied' | 'failed';
  message?: string;
}

export interface ImportReport {
  dryRun: boolean;
  applied: boolean;
  draftAndPublish: boolean;
  summary: { create: number; update: number; localize: number; unchanged: number; errors: number; failed: number };
  clears: Array<{ field: string; rows: number }>;
  allLocales: Array<{ field: string; rows: number }>;
  willBecomeModified: number;
  fileErrors: string[];
  planHash: string;
  rows: RowReport[];
}

/** The list view keeps the locale under plugins.i18n; the API wants it at the top level. */
const listParams = (query: Record<string, any>): Record<string, any> => {
  const { plugins, page: _page, pageSize: _pageSize, ...rest } = query ?? {};
  const pluginParams = Object.values(plugins ?? {}).reduce<Record<string, any>>(
    (acc, params) => ({ ...acc, ...(params as Record<string, any>) }),
    {},
  );
  return { ...rest, ...pluginParams };
};

interface Limits {
  maxExportRows: number;
}

interface ListPage {
  results: Array<{ documentId: string }>;
  pagination: { pageCount: number; total: number };
}

interface ExportResponse {
  fileName: string;
  mimeType: string;
  contentBase64: string;
  rowCount: number;
  warnings: { longCells: number };
}

export const localeOf = (query: Record<string, any>): string | null => query?.plugins?.i18n?.locale ?? null;

/** Pages the Content Manager's own list endpoint, so every list filter applies exactly. */
export async function collectDocumentIds(uid: string, query: Record<string, any>): Promise<string[]> {
  const { get } = getFetchClient();
  const { data: limits } = await get<Limits>(`/${PLUGIN_ID}/limits`);
  const ids: string[] = [];
  let page = 1;
  let pageCount = 1;
  do {
    const { data } = await get<ListPage>(`/content-manager/collection-types/${uid}`, {
      params: stringifyQuery({ ...listParams(query), page, pageSize: 100 }),
    });
    if (data.pagination.total > limits.maxExportRows) {
      throw new Error(
        `${data.pagination.total} entries match; the export limit is ${limits.maxExportRows}. Narrow the filters.`,
      );
    }
    ids.push(...data.results.map((entry) => entry.documentId));
    pageCount = data.pagination.pageCount;
    page += 1;
  } while (page <= pageCount);
  return ids;
}

const saveFile = (fileName: string, mimeType: string, contentBase64: string) => {
  const bytes = Uint8Array.from(atob(contentBase64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

export const exportMessage = (rowCount: number, longCells: number): { type: 'success' | 'warning'; message: string } =>
  longCells
    ? {
        type: 'warning',
        message: `Exported ${rowCount} entries. ${longCells} value(s) cannot be edited in XLSX (too long or containing characters the format cannot hold) and are left untouched on import - use CSV or JSON for them.`,
      }
    : { type: 'success', message: `Exported ${rowCount} entries.` };

export async function exportEntries(
  uid: string,
  locale: string | null,
  documentIds: string[],
  format: Format,
): Promise<{ rowCount: number; longCells: number }> {
  const { post } = getFetchClient();
  const { data } = await post<ExportResponse>(`/${PLUGIN_ID}/export`, { uid, locale, documentIds, format });
  saveFile(data.fileName, data.mimeType, data.contentBase64);
  return { rowCount: data.rowCount, longCells: data.warnings.longCells };
}

export async function importFile(
  uid: string,
  file: File,
  dryRun: boolean,
  allowClear: string[],
  planHash?: string,
): Promise<ImportReport> {
  const { post } = getFetchClient();
  const form = new FormData();
  form.append('file', file);
  form.append('uid', uid);
  form.append('dryRun', String(dryRun));
  form.append('allowClear', JSON.stringify(allowClear));
  // Applying names the dry run the user confirmed; the server refuses if the plan is no longer the same.
  if (planHash) form.append('planHash', planHash);
  const { data } = await post<ImportReport>(`/${PLUGIN_ID}/import`, form);
  return data;
}
