export function encodeCursor(id: string, updatedAt: string): string {
  return btoa(JSON.stringify({ id, updated_at: updatedAt })).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
}

export function decodeCursor(c: string): { id: string; updated_at: string } | null {
  try {
    const p = c.replace(/-/g,'+').replace(/_/g,'/');
    const pad = (4 - (p.length % 4)) % 4;
    const d = JSON.parse(atob(p + '='.repeat(pad)));
    if (typeof d.id !== 'string' || typeof d.updated_at !== 'string') return null;
    // Validate updated_at is a safe ISO timestamp — blocks PostgREST filter injection
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(d.updated_at)) return null;
    return d as { id: string; updated_at: string };
  } catch { return null; }
}

export interface PageResult<T> { entries: T[]; hasMore: boolean; nextCursor: string | null; }

export function buildPage<T extends { id: string; updated_at: string }>(rows: T[], limit: number): PageResult<T> {
  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  return { entries, hasMore, nextCursor: hasMore && last ? encodeCursor(last.id, last.updated_at) : null };
}
