import { describe, it, expect } from 'vitest';
import { ListMemoriesQuerySchema } from '@lorekit/schemas/memory';
import {
  DEFAULT_STATUS,
  EXPIRING_WITHIN_DAYS,
  MEMORY_STATUSES,
  STATUS_HINTS,
  STATUS_LABELS,
  expiringWithinDays,
  isArchivedView,
  resolveStatus,
  statusParamValue,
  statusToQueryParams,
  type MemoryStatus,
} from './status-filter';

describe('statusToQueryParams', () => {
  it('maps each state to the params the list route understands', () => {
    expect(statusToQueryParams('active')).toEqual({ archived: 'false' });
    expect(statusToQueryParams('archived')).toEqual({ archived: 'true' });
    expect(statusToQueryParams('expiring')).toEqual({
      archived: 'false',
      expiring_within_days: EXPIRING_WITHIN_DAYS,
    });
  });

  it('keeps "expiring" a LIVE view — it must never send archived=true', () => {
    // The discriminating property of the third state: an expiring memory is a
    // live one with a deadline. Sending archived=true here would list the one
    // population the view is useless for.
    expect(statusToQueryParams('expiring').archived).toBe('false');
  });

  it('emits only params GET /memories accepts, and values it accepts', () => {
    // The mapping is hand-written, so assert it against the schema rather than
    // against another hand-written string: a param renamed on the route fails
    // here instead of being dropped silently on the wire.
    for (const status of MEMORY_STATUSES) {
      const params = statusToQueryParams(status);
      for (const key of Object.keys(params)) {
        expect(Object.keys(ListMemoriesQuerySchema.shape), `"${key}"`).toContain(key);
      }
      expect(ListMemoriesQuerySchema.safeParse(params).success, JSON.stringify(params)).toBe(true);
    }
  });

  it('uses a horizon the route actually admits', () => {
    // PR-2 bounded the param to 1..365; a UI default outside it would be a 400
    // on every request in that view.
    expect(
      ListMemoriesQuerySchema.safeParse({ expiring_within_days: EXPIRING_WITHIN_DAYS }).success,
    ).toBe(true);
    expect(Number.isInteger(EXPIRING_WITHIN_DAYS)).toBe(true);
  });

  it('is exhaustive over the declared states', () => {
    // Anti-vacuity: a state added to the union without a mapping would return
    // undefined here rather than failing to compile in a spec that only tests
    // the three it knows about.
    for (const status of MEMORY_STATUSES) {
      expect(statusToQueryParams(status), status).toBeTruthy();
    }
  });
});

describe('resolveStatus', () => {
  it('defaults to active when nothing is in the URL', () => {
    expect(resolveStatus(null, false)).toBe('active');
    expect(resolveStatus(undefined, undefined)).toBe(DEFAULT_STATUS);
  });

  it('reads an explicit status', () => {
    for (const status of MEMORY_STATUSES) {
      expect(resolveStatus(status, false)).toBe(status);
    }
  });

  /**
   * `?archived=true` is a documented public param, `lorekit link --archived`
   * emits it, and links live in PRs and Slack. It is still READ, never written —
   * exactly the relationship `filters` has with the legacy `tags` shorthand.
   */
  it('falls back to the legacy ?archived= flag when no status is present', () => {
    expect(resolveStatus(null, true)).toBe('archived');
    expect(resolveStatus(undefined, true)).toBe('archived');
  });

  it('lets an explicit status OVERRIDE a stale legacy flag', () => {
    // Without this, a link carrying `archived=true` could never be turned back
    // off from the UI — the toggle would appear to do nothing.
    expect(resolveStatus('active', true)).toBe('active');
    expect(resolveStatus('expiring', true)).toBe('expiring');
  });

  it('ignores a hand-edited junk status rather than blanking the page', () => {
    // Total function, in normalizeFilters' tradition: `?status=` is
    // hand-editable and arrives from links of unknown age.
    for (const junk of ['ACTIVE', 'deleted', '', 0, 1, true, {}, [], NaN]) {
      expect(resolveStatus(junk, false), String(junk)).toBe('active');
    }
  });

  it('still honours the legacy flag when the status is junk', () => {
    // A malformed new param must not silently discard a valid old one.
    expect(resolveStatus('nonsense', true)).toBe('archived');
  });

  it('treats a non-true legacy value as absent', () => {
    for (const notTrue of ['true', 1, 'yes', {}, null]) {
      expect(resolveStatus(null, notTrue), String(notTrue)).toBe('active');
    }
  });
});

describe('isArchivedView', () => {
  it('is true only for the archived population', () => {
    expect(isArchivedView('archived')).toBe(true);
    expect(isArchivedView('active')).toBe(false);
  });

  it('is FALSE for expiring — it is a live view', () => {
    // Drives the facet catalog partition and the archive mutations' cache
    // predicate, so getting this wrong would catalogue the expiring view
    // against the archived population and quietly show the wrong counts.
    expect(isArchivedView('expiring')).toBe(false);
  });
});

describe('expiringWithinDays', () => {
  it('is set only for the expiring view', () => {
    expect(expiringWithinDays('expiring')).toBe(EXPIRING_WITHIN_DAYS);
    expect(expiringWithinDays('active')).toBeUndefined();
    expect(expiringWithinDays('archived')).toBeUndefined();
  });

  it('sends the literal horizon on the wire', () => {
    // Pinned to the number, not read back out of `expiringWithinDays`:
    // `expiringWithinDays` IS `statusToQueryParams(...).expiring_within_days`,
    // so comparing the two asserts the call against itself and survives any
    // change to the horizon — including one that puts it outside the 1–365 the
    // route admits.
    expect(statusToQueryParams('expiring').expiring_within_days).toBe(7);
    expect(statusToQueryParams('active').expiring_within_days).toBeUndefined();
    expect(statusToQueryParams('archived').expiring_within_days).toBeUndefined();
  });
});

describe('statusParamValue', () => {
  it('drops the param for the default, keeping a shared link clean', () => {
    expect(statusParamValue('active', false)).toBeNull();
  });

  it('writes the non-default states', () => {
    expect(statusParamValue('archived', false)).toBe('archived');
    expect(statusParamValue('expiring', false)).toBe('expiring');
  });

  it('writes status=active explicitly when a legacy flag would otherwise win', () => {
    // Dropping the param here would let `resolveStatus` fall back to
    // `archived=true` on reload — the selection would silently undo itself.
    expect(statusParamValue('active', true)).toBe('active');
  });

  it('round-trips every state through the URL', () => {
    for (const status of MEMORY_STATUSES) {
      for (const legacy of [false, true]) {
        const written = statusParamValue(status, legacy);
        expect(resolveStatus(written, legacy), `${status} / archived=${legacy}`).toBe(status);
      }
    }
  });
});

describe('presentation metadata', () => {
  it('labels and hints every state, so no state can ship unnamed', () => {
    for (const status of MEMORY_STATUSES) {
      expect(STATUS_LABELS[status]).toBeTruthy();
      expect(STATUS_HINTS[status]).toBeTruthy();
    }
  });

  it('names the horizon in the expiring hint rather than leaving it implicit', () => {
    // "Expiring" alone does not say over what period; the control is small, so
    // the horizon lives in the accessible description.
    expect(STATUS_HINTS.expiring).toContain(String(EXPIRING_WITHIN_DAYS));
  });

  it('orders the control least-to-most surprising', () => {
    const order: MemoryStatus[] = ['active', 'archived', 'expiring'];
    expect(MEMORY_STATUSES).toEqual(order);
    expect(MEMORY_STATUSES[0]).toBe(DEFAULT_STATUS);
  });
});
