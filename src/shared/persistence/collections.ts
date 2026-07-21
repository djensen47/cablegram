/**
 * The MongoDB collection names (ADR-012). One place so the repositories and
 * `ensureIndexes` can never drift on a name. These are stable wire-level
 * identifiers — the same names Prisma's `@@map(...)` produced before the swap,
 * so an existing database keeps working unchanged.
 */
export const COLLECTIONS = {
  newsletters: 'newsletters',
  suppressions: 'suppressions',
  subscriptions: 'subscriptions',
  templates: 'templates',
  campaigns: 'campaigns',
  sendRecords: 'send_records',
} as const;
