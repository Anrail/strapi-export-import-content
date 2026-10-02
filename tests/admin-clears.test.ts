import { describe, expect, it } from 'vitest';

import { clearChoices } from '../admin/src/utils/clears';

describe('clearChoices', () => {
  it('lists the candidate clears of the first dry run', () => {
    expect(clearChoices([], [{ field: 'count', rows: 1 }], [])).toEqual([{ field: 'count', rows: 1 }]);
  });

  it('keeps a ticked field listed after a dry run that no longer reports it, so it can be unticked', () => {
    // The server leaves fields in allowClear out of `clears`; the checkbox must not vanish.
    const shown = clearChoices([{ field: 'count', rows: 1 }, { field: 'title', rows: 2 }], [{ field: 'title', rows: 2 }], ['count']);
    expect(shown).toEqual([
      { field: 'count', rows: 1 },
      { field: 'title', rows: 2 },
    ]);
  });

  it('drops an unticked field the latest dry run no longer reports', () => {
    expect(clearChoices([{ field: 'count', rows: 1 }], [], [])).toEqual([]);
  });
});
