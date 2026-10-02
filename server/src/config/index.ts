export interface TransferConfig {
  /** Largest export, in rows. */
  maxExportRows: number;
  /** Largest import, in rows. */
  maxImportRows: number;
  /** Uploaded file size limit, in bytes. */
  maxImportBytes: number;
  /** Rows x columns limit after parsing. */
  maxCells: number;
  /** Longest single cell after parsing, in characters. */
  maxCellLength: number;
}

export const CONFIG_UID = 'plugin::export-import-content';

const defaults: TransferConfig = {
  maxExportRows: 5000,
  maxImportRows: 2000,
  maxImportBytes: 10 * 1024 * 1024,
  maxCells: 200000,
  maxCellLength: 1000000,
};

const validator = (config: TransferConfig) => {
  for (const key of Object.keys(defaults) as Array<keyof TransferConfig>) {
    const value = config[key];
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`[export-import-content] config.${key} must be a positive integer`);
    }
  }
};

export default { default: defaults, validator };
