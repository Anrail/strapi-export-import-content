export interface ClearChoice {
  field: string;
  rows: number;
}

/**
 * Checkboxes to show after a dry run. The server reports only clears that are NOT allowed yet,
 * so a ticked field is kept from the previous list; otherwise its checkbox would vanish and could
 * not be unticked.
 */
export function clearChoices(shown: ClearChoice[], reported: ClearChoice[], ticked: string[]): ClearChoice[] {
  const latest = new Map(reported.map((item) => [item.field, item]));
  const kept = shown
    .map((item) => latest.get(item.field) ?? (ticked.includes(item.field) ? item : null))
    .filter((item): item is ClearChoice => item !== null);
  const known = new Set(kept.map((item) => item.field));
  return [...kept, ...reported.filter((item) => !known.has(item.field))];
}
