import { describe, expect, it } from 'vitest';

import config, { CONFIG_UID } from '../server/src/config';

describe('config', () => {
  it('has the documented defaults', () => {
    expect(CONFIG_UID).toBe('plugin::export-import-content');
    expect(config.default).toEqual({
      maxExportRows: 5000,
      maxImportRows: 2000,
      maxImportBytes: 10485760,
      maxCells: 200000,
      maxCellLength: 1000000,
    });
  });

  it('accepts the defaults', () => {
    expect(() => config.validator(config.default)).not.toThrow();
  });

  it.each([0, -1, 1.5, '10', null])('rejects maxImportRows = %s', (value) => {
    expect(() => config.validator({ ...config.default, maxImportRows: value as never })).toThrow(/maxImportRows/);
  });
});
