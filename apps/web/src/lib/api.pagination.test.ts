/**
 * Regression test for the list envelope shape.
 *
 * The API returns pagination at the TOP level of the envelope — `{ ok, data, meta }` —
 * not inside `data`. A previous version of unwrapList() looked inside `data`, found
 * nothing, and fell back to `items.length`, which made every paginated page believe it
 * had exactly one page and silently hid all pagination links. This test pins the contract.
 *
 * It needs a live API; when none is reachable (a CI job without services) it skips
 * instead of failing, so the suite stays runnable everywhere.
 */

import { describe, expect, it } from 'vitest';
import { listGames } from './api';

const API = process.env.API_INTERNAL_URL ?? 'http://127.0.0.1:4000';

async function apiIsUp(): Promise<boolean> {
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

describe('listGames pagination', () => {
  it('reads total/totalPages from meta.pagination, not from the item count', async () => {
    if (!(await apiIsUp())) return; // no API in this environment: nothing to pin

    const result = await listGames({ perPage: 2, page: 1 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBeGreaterThan(2);
    expect(result.totalPages).toBe(Math.ceil(result.total / 2));
    expect(result.page).toBe(1);
    expect(result.perPage).toBe(2);
  });
});
