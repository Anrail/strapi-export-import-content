import { isDeepStrictEqual } from 'node:util';

import type { Column } from './schema';

export interface RowDiff {
  /** Fields whose file value differs from the current one and is not empty. */
  set: string[];
  /** Fields that are empty in the file but hold a value now - candidate clears. */
  clear: string[];
}

export function diffRow(
  fileRow: Record<string, unknown>,
  currentRow: Record<string, unknown>,
  columns: Column[],
): RowDiff {
  const diff: RowDiff = { set: [], clear: [] };
  for (const { name } of columns) {
    const value = fileRow[name];
    if (value === undefined) continue;
    if (isDeepStrictEqual(value, currentRow[name] ?? null)) continue;
    (value === null ? diff.clear : diff.set).push(name);
  }
  return diff;
}
