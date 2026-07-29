/**
 * Limit error constants for REST Edge Functions.
 * Matches the SQLSTATE codes used in mcp/limits.ts.
 */

/** Custom SQLSTATE raised by the enforce_memory_cap() trigger. */
export const MEMORY_CAP_SQLSTATE = 'LK001';
