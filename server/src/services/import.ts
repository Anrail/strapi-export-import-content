import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { decodeValue, parseCell, stripRelations } from '../codec/decode';
import { diffRow } from '../codec/diff';
import { encodeEntry } from '../codec/encode';
import { sameInstant } from '../codec/scalars';
import { buildColumns, buildPopulate, fieldPermitted, SYSTEM_COLUMNS } from '../codec/schema';
import type { Column } from '../codec/schema';
import { CONFIG_UID } from '../config';
import type { TransferConfig } from '../config';
import { CellError, FileError, HttpError } from '../errors';
import { checkLimits, formatFromFileName, parseFile } from '../formats';
import type { Table } from '../formats/csv';
import { xlsxUncompressedSize } from '../formats/xlsx';
import {
  assertCollectionType, chunk, computeStatus, fetchDrafts, fetchPublished, getChecker, hasDP, i18nOf, permissionPopulate,
  publicUrlOf,
} from './context';
import { createResolvers } from './resolvers';

export type RowAction = 'create' | 'update' | 'localize';

export interface RowReport {
  /** 1-based data row number (the header is not counted). */
  row: number;
  documentId: string | null;
  action: RowAction | 'error';
  fields: string[];
  errors: string[];
  warnings: string[];
  outcome?: 'applied' | 'failed';
  message?: string;
}

export interface ImportReport {
  dryRun: boolean;
  applied: boolean;
  /** False for a type without Draft & Publish: its only entry is live, so writes go live at once. */
  draftAndPublish: boolean;
  /** `failed`: rows that failed while writing (always 0 in a dry run). */
  summary: { create: number; update: number; localize: number; unchanged: number; errors: number; failed: number };
  /** Empty cells over existing values, in fields the user has not allowed to clear. */
  clears: Array<{ field: string; rows: number }>;
  /** Changed non-localized fields: the write reaches every locale. */
  allLocales: Array<{ field: string; rows: number }>;
  willBecomeModified: number;
  fileErrors: string[];
  rows: RowReport[];
  /** Fingerprint of everything that would be written; apply must present the one the user saw. */
  planHash: string;
}

export interface PlannedRow extends RowReport {
  data: Record<string, unknown>;
  /** `updatedAt` of the draft the row was planned against (update rows). */
  baseUpdatedAt?: unknown;
}

/** JSON with object keys sorted, so equal plans hash equally. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

const hashPlan = (uid: string, locale: string | null, planned: PlannedRow[]): string =>
  createHash('sha256')
    .update(stable({ uid, locale, rows: planned.map(({ row, documentId, action, data }) => ({ row, documentId, action, data })) }))
    .digest('hex');

const SYSTEM = new Set<string>(SYSTEM_COLUMNS);

const text = (value: unknown): string | null =>
  value === null || value === undefined || value === '' ? null : String(value);

const counts = (map: Map<string, number>) => [...map.entries()].map(([field, rows]) => ({ field, rows }));
const bump = (map: Map<string, number>, field: string) => map.set(field, (map.get(field) ?? 0) + 1);

const validationMessages = (error: any): string[] => {
  const details = error?.details?.errors;
  if (Array.isArray(details) && details.length) {
    return details.map((item: any) => {
      const path = (item.path ?? []).join('.');
      return path ? `${path}: ${item.message}` : String(item.message);
    });
  }
  return [String(error?.message ?? error)];
};

/** Every "id" found anywhere inside an encoded value. */
const collectIds = (value: unknown, found = new Set<number | string>()): Set<number | string> => {
  if (Array.isArray(value)) for (const item of value) collectIds(item, found);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'id' && (typeof inner === 'number' || typeof inner === 'string')) found.add(inner);
      else collectIds(inner, found);
    }
  }
  return found;
};

const emptyReport = (model: any): ImportReport => ({
  dryRun: true,
  applied: false,
  draftAndPublish: hasDP(model),
  summary: { create: 0, update: 0, localize: 0, unchanged: 0, errors: 0, failed: 0 },
  clears: [],
  allLocales: [],
  willBecomeModified: 0,
  fileErrors: [],
  rows: [],
  planHash: '',
});

export const importService = ({ strapi }: { strapi: any }) => {
  const plan = async (input: {
    uid: string;
    table: Table;
    flat: boolean;
    allowClear: string[];
    userAbility: unknown;
  }): Promise<{ report: ImportReport; planned: PlannedRow[]; locale: string | null }> => {
    const model = assertCollectionType(strapi, input.uid);
    const uid = model.uid as string;
    const checker = getChecker(strapi, uid, input.userAbility);
    if (checker.cannot.read()) throw new HttpError(403, 'You may not read this content type');

    const i18n = i18nOf(strapi);
    const localized = i18n.isLocalized(uid);
    const getModel = (target: string) => strapi.getModel(target);
    // Columns the user may not read do not exist for them: otherwise a dry run is an equality oracle.
    const columns = buildColumns(model, {
      nonLocalized: localized ? i18n.nonLocalized(model) : [],
      allow: (field) => fieldPermitted((path) => checker.can.read(null, path), field, model.attributes[field], getModel),
    });
    const byName = new Map(columns.map((column) => [column.name, column]));
    const report = emptyReport(model);
    const { table } = input;

    // ---- file-level checks -------------------------------------------------------------
    for (const name of table.columns) {
      if (!SYSTEM.has(name) && !byName.has(name)) report.fileErrors.push(`Unknown column "${name}"`);
    }
    const locales = [...new Set(table.rows.map((row) => text(row.locale)))];
    if (locales.length > 1) report.fileErrors.push('A file must hold one locale; split it by the "locale" column');
    const locale = locales[0] ?? null;
    if (table.rows.length) {
      if (localized && !locale) report.fileErrors.push('The "locale" column is required for this content type');
      else if (localized && !(await i18n.localeCodes()).includes(locale as string)) {
        report.fileErrors.push(`Locale "${locale}" is not configured in this project`);
      } else if (!localized && locale) report.fileErrors.push('This content type is not localized; leave "locale" empty');
    }
    const ids = table.rows.map((row) => text(row.documentId)).filter((id): id is string => id !== null);
    const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
    if (repeated) report.fileErrors.push(`documentId "${repeated}" appears more than once`);
    if (report.fileErrors.length) return { report, planned: [], locale };

    // ---- current state -----------------------------------------------------------------
    const populate = buildPopulate(model, getModel);
    // Entity conditions of both the update and the read permission are evaluated on these drafts.
    const updatePopulate = await permissionPopulate(strapi, uid, checker, 'update', populate, model);
    const draftPopulate = await permissionPopulate(strapi, uid, checker, 'read', updatePopulate, model);
    const drafts = await fetchDrafts(strapi, uid, ids, locale, draftPopulate, checker);
    const published = hasDP(model) ? await fetchPublished(strapi, uid, ids, locale) : new Map<string, any>();

    const otherLocales = new Map<string, Set<string | null>>();
    const absent = ids.filter((id) => !drafts.has(id));
    for (const batch of chunk(absent, 100)) {
      const where: Record<string, unknown> = { documentId: { $in: batch } };
      if (hasDP(model)) where.publishedAt = null;
      const found = await strapi.db.query(uid).findMany({ where, select: ['documentId', 'locale'] });
      for (const entry of found) {
        if (!otherLocales.has(entry.documentId)) otherLocales.set(entry.documentId, new Set());
        otherLocales.get(entry.documentId)!.add(entry.locale ?? null);
      }
    }

    const encodeCtx = { getModel, isLocalized: i18n.isLocalized, publicUrl: publicUrlOf(strapi), sourceLocalized: localized };
    const defaultLocale = await i18n.defaultLocale();
    const resolvers = createResolvers(strapi);
    const pendingClears = new Map<string, number>();
    const allLocales = new Map<string, number>();
    const planned: PlannedRow[] = [];
    const tracked: Array<{ rep: PlannedRow; current?: any }> = [];

    // ---- rows --------------------------------------------------------------------------
    for (const [index, raw] of table.rows.entries()) {
      const id = text(raw.documentId);
      const rep: PlannedRow = { row: table.rowNumbers?.[index] ?? index + 1, documentId: id, action: 'error', fields: [], errors: [], warnings: [], data: {} };

      const native: Record<string, unknown> = {};
      for (const column of columns) {
        if (raw[column.name] === undefined) continue;
        try {
          native[column.name] = parseCell(column, raw[column.name], input.flat);
        } catch (error) {
          if (!(error instanceof CellError)) throw error;
          rep.errors.push(`${column.name}: ${error.message}`);
        }
      }
      const filled = columns.filter((c) => native[c.name] !== undefined && native[c.name] !== null).map((c) => c.name);

      const current = id ? drafts.get(id) : undefined;
      let fields: string[] = [];
      let stripIds = false;
      let lenient = false;
      let now: Record<string, unknown> = {};
      // i18n scopes permissions by a condition on locale, so create is checked against the file locale.
      const createSubject = localized ? { locale } : null;

      if (!id) {
        rep.action = 'create';
        fields = filled;
        stripIds = true;
        if (checker.cannot.create(createSubject)) rep.errors.push('you may not create entries of this type');
      } else if (current) {
        // A field readable on the type may be unreadable on THIS entry (conditional permission):
        // such a cell is neither compared nor written.
        for (const column of columns) {
          if (native[column.name] === undefined) continue;
          if (fieldPermitted((path) => checker.can.read(current, path), column.name, column.attribute, getModel)) continue;
          // The export leaves such a cell empty; a value here was typed in by hand.
          if (native[column.name] !== null) rep.errors.push(`${column.name}: you may not read this field of this entry - clear the cell`);
          delete native[column.name];
        }
        now = encodeEntry(current, columns, encodeCtx, { status: null, publishedAt: null });
        const diff = diffRow(native, now, columns);
        for (const field of diff.clear) if (!input.allowClear.includes(field)) bump(pendingClears, field);
        fields = [...diff.set, ...diff.clear.filter((field) => input.allowClear.includes(field))];
        if (!fields.length && !rep.errors.length) {
          report.summary.unchanged += 1;
          continue;
        }
        rep.action = 'update';
        rep.baseUpdatedAt = current.updatedAt;
        if (fields.length) {
          if (text(raw.updatedAt) === null) rep.errors.push('updatedAt is required for a changed row - keep that column');
          else if (!sameInstant(raw.updatedAt, current.updatedAt)) {
            rep.errors.push('stale row: the entry was changed after this file was exported - export again');
          }
        }
        if (checker.cannot.update(current)) rep.errors.push('you may not update this entry');
      } else if (otherLocales.get(id)?.has(locale)) {
        rep.errors.push(`document "${id}" exists but you may not read it`);
      } else if (localized && otherLocales.get(id)?.size) {
        // Read under the read permission: otherwise the report reveals values of a document the
        // user may not read. Any locale the user can read will do.
        const query = await checker.sanitizedQuery.read({ filters: { documentId: id } });
        let sibling: any = null;
        for (const sourceLocale of otherLocales.get(id)!) {
          sibling = await strapi.documents(uid).findFirst({ ...query, locale: sourceLocale, status: 'draft', populate });
          if (sibling) break;
        }
        if (!sibling) rep.errors.push(`document "${id}" exists but you may not read it`);
        else {
          rep.action = 'localize';
          stripIds = true;
          lenient = true;
          const shared = encodeEntry(sibling, columns, encodeCtx, { status: null, publishedAt: null });
          // Non-localized fields belong to every locale: Strapi copies them into the new one, and a
          // "create" must never change the existing locales. A differing value is ignored, loudly.
          fields = filled.filter((name) => byName.get(name)!.localized);
          for (const name of filled) {
            if (!byName.get(name)!.localized && !isDeepStrictEqual(native[name], shared[name] ?? null)) {
              rep.warnings.push(`${name}: shared by all locales - ignored here; change it in a row of an existing locale`);
            }
          }
          if (checker.cannot.create(createSubject)) rep.errors.push('you may not create entries of this type');
        }
      } else {
        rep.errors.push(`document "${id}" does not exist`);
      }

      if (rep.action !== 'error') {
        const can = rep.action === 'update' ? checker.can.update : checker.can.create;
        const subject = rep.action === 'update' ? current : createSubject;
        const baseCtx = { ...encodeCtx, rowLocale: locale, defaultLocale, stripIds, skipMissingRelations: lenient, resolvers };
        for (const field of fields) {
          const column = byName.get(field) as Column;
          if (!fieldPermitted((path) => can(subject, path), field, column.attribute, getModel)) {
            rep.errors.push(`${field}: you may not change this field`);
          }
          const ctx = current && rep.action === 'update' ? { ...baseCtx, knownComponentIds: collectIds(now[field]) } : baseCtx;
          const decoded = await decodeValue(column.attribute, column.kind, native[field] ?? null, ctx);
          rep.errors.push(...decoded.errors.map((message) => `${field}: ${message}`));
          rep.warnings.push(...decoded.warnings.map((message) => `${field}: ${message}`));
          rep.data[field] = decoded.value;
        }
        rep.fields = fields;

        if (!rep.errors.length) {
          try {
            const plain = stripRelations(rep.data, model, getModel);
            // A type without Draft & Publish is written live, so it gets the full (non-draft) validation.
            const options = { isDraft: hasDP(model), locale };
            if (rep.action === 'update') await strapi.entityValidator.validateEntityUpdate(model, plain, options, current);
            else await strapi.entityValidator.validateEntityCreation(model, plain, options);
          } catch (error) {
            rep.errors.push(...validationMessages(error));
          }
        }
      }
      tracked.push({ rep, current });
    }

    // ---- uniqueness --------------------------------------------------------------------
    for (const column of columns.filter((c) => c.kind === 'scalar' && (c.attribute.unique || c.attribute.type === 'uid'))) {
      const holders = tracked.filter(({ rep }) => rep.data[column.name] !== undefined && rep.data[column.name] !== null);
      const seen = new Map<unknown, number>();
      for (const { rep } of holders) {
        const value = rep.data[column.name];
        if (seen.has(value)) rep.errors.push(`${column.name}: "${value}" is also used in row ${seen.get(value)}`);
        else seen.set(value, rep.row);
      }
      for (const batch of chunk([...seen.keys()], 100)) {
        const where: Record<string, unknown> = { [column.name]: { $in: batch } };
        if (hasDP(model)) where.publishedAt = null;
        if (localized && column.localized) where.locale = locale;
        const taken = await strapi.db.query(uid).findMany({ where, select: ['documentId', column.name] });
        for (const { rep } of holders) {
          if (taken.some((entry: any) => entry[column.name] === rep.data[column.name] && entry.documentId !== rep.documentId)) {
            rep.errors.push(`${column.name}: "${rep.data[column.name]}" is already used by another entry`);
          }
        }
      }
    }

    // ---- report ------------------------------------------------------------------------
    for (const { rep, current } of tracked) {
      const { data: _data, baseUpdatedAt: _base, ...row } = rep;
      report.rows.push(row);
      if (rep.errors.length) {
        report.summary.errors += 1;
        continue;
      }
      report.summary[rep.action as RowAction] += 1;
      if (localized) for (const field of rep.fields) if (!byName.get(field)!.localized && rep.action !== 'create') bump(allLocales, field);
      if (rep.action === 'update' && computeStatus(model, current, published.get(rep.documentId as string)) === 'published') {
        report.willBecomeModified += 1;
      }
      planned.push(rep);
    }
    report.clears = counts(pendingClears);
    report.allLocales = counts(allLocales);
    report.planHash = hashPlan(uid, locale, planned);
    return { report, planned, locale };
  };

  const run = async (input: {
    uid: string;
    fileName: string;
    buffer: Buffer;
    dryRun: boolean;
    allowClear: string[];
    /** `planHash` of the dry run the user confirmed; required to apply. */
    planHash?: string;
    userAbility: unknown;
    user: { id: number };
  }): Promise<ImportReport> => {
    const limits = strapi.config.get(CONFIG_UID) as TransferConfig;
    const model = assertCollectionType(strapi, input.uid);

    let parsed: { table: Table; flat: boolean };
    try {
      if (input.buffer.length > limits.maxImportBytes) {
        throw new FileError(`The file is larger than ${limits.maxImportBytes} bytes`);
      }
      const format = formatFromFileName(input.fileName);
      // exceljs inflates the whole archive before any limit runs.
      if (format === 'xlsx' && xlsxUncompressedSize(input.buffer) > limits.maxImportBytes * 20) {
        throw new FileError(`The workbook expands to more than ${limits.maxImportBytes * 20} bytes`);
      }
      parsed = await parseFile(format, input.buffer, model.uid, limits);
      checkLimits(parsed.table, limits);
    } catch (error) {
      if (!(error instanceof FileError)) throw error;
      return { ...emptyReport(model), dryRun: input.dryRun, fileErrors: [error.message] };
    }

    const { report, planned, locale } = await plan({
      uid: model.uid,
      table: parsed.table,
      flat: parsed.flat,
      allowClear: input.allowClear,
      userAbility: input.userAbility,
    });
    report.dryRun = input.dryRun;
    if (input.dryRun || report.fileErrors.length || report.summary.errors) return report;

    // Apply only what the user saw: the plan is recomputed from the file and the current content,
    // and anything that changed in between (an entry, a media file, a relation target, the ticks)
    // gives a different fingerprint. The fresh plan goes back as a new dry run.
    if (input.planHash !== report.planHash) {
      report.dryRun = true;
      report.fileErrors.push('The content changed since the dry run - nothing was written. Review this new dry run and apply again.');
      return report;
    }

    const draftWhere = (documentId: string | null) => ({
      documentId,
      ...(locale ? { locale } : {}),
      ...(hasDP(model) ? { publishedAt: null } : {}),
    });

    // Row by row, each in its own transaction: a later failure never undoes an earlier row.
    const outcomes = new Map<number, Pick<RowReport, 'outcome' | 'message'>>();
    for (const row of planned) {
      const data: Record<string, unknown> = { ...row.data, updatedBy: input.user.id };
      if (row.action !== 'update') data.createdBy = input.user.id;
      const scope = { status: 'draft', ...(locale ? { locale } : {}) };
      try {
        await strapi.db.transaction(async () => {
          if (row.action === 'update') {
            // Re-check the stale guard inside the row's transaction, right before the write.
            const fresh = await strapi.db.query(model.uid).findOne({ where: draftWhere(row.documentId), select: ['updatedAt'] });
            if (!fresh) throw new Error('the entry no longer exists');
            if (!sameInstant(fresh.updatedAt, row.baseUpdatedAt)) {
              throw new Error('stale row: the entry was changed during the import - export again');
            }
          } else if (row.action === 'localize') {
            // The locale must still be missing: otherwise this "create" would overwrite a new entry.
            if (await strapi.db.query(model.uid).findOne({ where: draftWhere(row.documentId), select: ['id'] })) {
              throw new Error('this locale was created during the import - export again');
            }
          }
          if (row.action === 'create') {
            if (!(await strapi.documents(model.uid).create({ ...scope, data }))) throw new Error('the entry was not created');
          } else if (!(await strapi.documents(model.uid).update({ documentId: row.documentId, ...scope, data }))) {
            // Strapi returns null (no throw) when the document was deleted after planning.
            throw new Error('the entry no longer exists');
          }
        });
        outcomes.set(row.row, { outcome: 'applied' });
      } catch (error: any) {
        outcomes.set(row.row, { outcome: 'failed', message: String(error?.message ?? error) });
      }
    }
    report.rows = report.rows.map((row) => ({ ...row, ...outcomes.get(row.row) }));
    report.summary.failed = report.rows.filter((row) => row.outcome === 'failed').length;
    report.applied = true;
    return report;
  };

  return { plan, run };
};
