import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { transfer as controller } from '../server/src/controllers/transfer';
import { HttpError } from '../server/src/errors';

const makeStrapi = (services: Record<string, any>) =>
  ({
    plugin: vi.fn(() => ({ service: (name: string) => services[name] })),
    config: { get: () => ({ maxExportRows: 5000, maxImportBytes: 100 }) },
  }) as any;

const makeCtx = (over: Record<string, unknown> = {}) => ({
  request: { body: {}, files: {} },
  state: { userAbility: { ability: true }, user: { id: 5 } },
  body: undefined as unknown,
  badRequest: vi.fn((message: string) => { throw new Error(`400 ${message}`); }),
  forbidden: vi.fn((message: string) => { throw new Error(`403 ${message}`); }),
  ...over,
});

const created: string[] = [];
let counter = 0;
const upload = (name: string, content: string, extra: Record<string, unknown> = {}) => {
  const filepath = path.join(os.tmpdir(), `eic-${Date.now()}-${counter++}-${name}`);
  fs.writeFileSync(filepath, content);
  created.push(filepath);
  return { filepath, originalFilename: name, ...extra };
};

afterEach(() => {
  for (const filepath of created.splice(0)) fs.rmSync(filepath, { force: true });
});

describe('transfer controller', () => {
  it('limits returns the export cap', async () => {
    const ctx = makeCtx();
    await controller({ strapi: makeStrapi({}) }).limits(ctx as any);
    expect(ctx.body).toEqual({ maxExportRows: 5000 });
  });

  it('export passes the body and the user ability to the service', async () => {
    const run = vi.fn(async () => ({ fileName: 'x.csv' }));
    const ctx = makeCtx({ request: { body: { uid: 'api::a.a', locale: 'en', documentIds: ['a'], format: 'csv' } } });
    await controller({ strapi: makeStrapi({ export: { run } }) }).export(ctx as any);
    expect(run).toHaveBeenCalledWith({ uid: 'api::a.a', locale: 'en', documentIds: ['a'], format: 'csv', userAbility: { ability: true } });
    expect(ctx.body).toEqual({ fileName: 'x.csv' });
  });

  it('maps HttpError to the matching response and rethrows anything else', async () => {
    const forbidden = { run: vi.fn(async () => { throw new HttpError(403, 'nope'); }) };
    await expect(controller({ strapi: makeStrapi({ export: forbidden }) }).export(makeCtx() as any)).rejects.toThrow('403 nope');
    const bad = { run: vi.fn(async () => { throw new HttpError(400, 'bad'); }) };
    await expect(controller({ strapi: makeStrapi({ export: bad }) }).export(makeCtx() as any)).rejects.toThrow('400 bad');
    const broken = { run: vi.fn(async () => { throw new Error('boom'); }) };
    await expect(controller({ strapi: makeStrapi({ export: broken }) }).export(makeCtx() as any)).rejects.toThrow('boom');
  });

  it('import reads the uploaded file and defaults to a dry run', async () => {
    const run = vi.fn(async () => ({ dryRun: true }));
    const ctx = makeCtx({
      request: { body: { uid: 'api::a.a', allowClear: '["title"]' }, files: { file: upload('a.json', '[]') } },
    });
    await controller({ strapi: makeStrapi({ import: { run } }) }).import(ctx as any);
    const input = run.mock.calls[0][0];
    expect(input).toMatchObject({ uid: 'api::a.a', fileName: 'a.json', dryRun: true, allowClear: ['title'], user: { id: 5 } });
    expect(input.buffer.toString('utf8')).toBe('[]');
  });

  it('import applies only when dryRun is exactly "false"', async () => {
    const run = vi.fn(async () => ({}));
    const files = { file: [upload('a.json', '[]')] };
    await controller({ strapi: makeStrapi({ import: { run } }) }).import(makeCtx({ request: { body: { uid: 'u', dryRun: 'false' }, files } }) as any);
    expect(run.mock.calls[0][0].dryRun).toBe(false);
  });

  it('import rejects a missing file and a malformed allowClear', async () => {
    const strapi = makeStrapi({ import: { run: vi.fn() } });
    await expect(controller({ strapi }).import(makeCtx() as any)).rejects.toThrow(/400 file is required/);
    const ctx = makeCtx({ request: { body: { allowClear: '{"a":1}' }, files: { file: upload('a.json', '[]') } } });
    await expect(controller({ strapi }).import(ctx as any)).rejects.toThrow(/400 allowClear/);
  });

  describe('temp file cleanup', () => {
    const importCtx = (file: unknown, body: Record<string, unknown> = { uid: 'u' }) =>
      makeCtx({ request: { body, files: { file } } });

    it('removes the upload after a successful import', async () => {
      const file = upload('a.json', '[]');
      await controller({ strapi: makeStrapi({ import: { run: vi.fn(async () => ({})) } }) }).import(importCtx(file) as any);
      expect(fs.existsSync(file.filepath)).toBe(false);
    });

    it('removes the upload after a malformed allowClear', async () => {
      const file = upload('a.json', '[]');
      const ctx = importCtx(file, { allowClear: '{"a":1}' });
      await expect(controller({ strapi: makeStrapi({ import: { run: vi.fn() } }) }).import(ctx as any)).rejects.toThrow(/400/);
      expect(fs.existsSync(file.filepath)).toBe(false);
    });

    it('removes the upload when the service throws', async () => {
      const file = upload('a.json', '[]');
      const run = vi.fn(async () => { throw new Error('boom'); });
      await expect(controller({ strapi: makeStrapi({ import: { run } }) }).import(importCtx(file) as any)).rejects.toThrow('boom');
      expect(fs.existsSync(file.filepath)).toBe(false);
    });

    it('removes every upload of an array', async () => {
      const files = [upload('a.json', '[]'), upload('b.json', '[]')];
      await controller({ strapi: makeStrapi({ import: { run: vi.fn(async () => ({})) } }) }).import(importCtx(files) as any);
      expect(files.map((f) => fs.existsSync(f.filepath))).toEqual([false, false]);
    });

    it('removes the uploads of every field name, guarding entries without a filepath', async () => {
      const file = upload('a.json', '[]');
      const others = [upload('b.json', '[]'), upload('c.json', '[]')];
      const ctx = makeCtx({ request: { body: { uid: 'u' }, files: { file, other: others, broken: { filepath: 42 }, empty: null } } });
      await controller({ strapi: makeStrapi({ import: { run: vi.fn(async () => ({})) } }) }).import(ctx as any);
      expect([file, ...others].map((f) => fs.existsSync(f.filepath))).toEqual([false, false, false]);
    });

    it('rejects an oversized upload without reading it or calling the service', async () => {
      const run = vi.fn();
      const file = upload('a.json', '[]', { size: 101 });
      await expect(controller({ strapi: makeStrapi({ import: { run } }) }).import(importCtx(file) as any)).rejects.toThrow(/400 The file is larger/);
      expect(run).not.toHaveBeenCalled();
      expect(fs.existsSync(file.filepath)).toBe(false);
    });
  });
});

describe('import controller hardening', () => {
  it('passes the confirmed plan fingerprint to the service', async () => {
    const run = vi.fn(async () => ({}));
    const ctx = makeCtx({ request: { body: { uid: 'u', dryRun: 'false', planHash: 'abc' }, files: { file: upload('a.json', '[]') } } });
    await controller({ strapi: makeStrapi({ import: { run } }) }).import(ctx as any);
    expect(run.mock.calls[0][0]).toMatchObject({ dryRun: false, planHash: 'abc' });
  });

  it('still returns the report when a temp file cannot be removed', async () => {
    const run = vi.fn(async () => ({ applied: true }));
    // A directory cannot be removed by a non-recursive rm: the cleanup fails for this entry.
    const files = { file: upload('a.json', '[]'), other: { filepath: os.tmpdir() } };
    const ctx = makeCtx({ request: { body: { uid: 'u' }, files } });
    await controller({ strapi: makeStrapi({ import: { run } }) }).import(ctx as any);
    expect(ctx.body).toEqual({ applied: true });
  });
});
