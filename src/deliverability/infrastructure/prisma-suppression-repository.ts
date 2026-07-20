import { inject, injectable } from 'inversify';
import type { PrismaClient, Suppression as SuppressionRow } from '@prisma/client';
import { TYPES as SHARED_TYPES } from '../../shared/di/index.js';
import { SuppressionEntry, type SuppressionReason } from '../domain/suppression.js';
import type {
  ListSuppressionsOptions,
  SuppressionRepository,
} from '../application/suppression-repository.js';

/**
 * The Mongo-backed `SuppressionRepository` (ADR-007). Prisma stays sealed
 * inside this class: it maps rows to/from the domain aggregate and never lets
 * a Prisma type escape into `application/` or `domain/`. Pagination is an
 * address-ordered, exclusive-cursor sweep (`address > cursor`) — the portable
 * subset, no skip/offset. `add` upserts on the address primary key, which is
 * both the idempotency mechanism and the unique index (ADR-011).
 *
 * Unverified against a live Mongo until the deployment chunk (per the build
 * plan); the in-memory repository is the tested contract meanwhile.
 */
@injectable()
export class PrismaSuppressionRepository implements SuppressionRepository {
  constructor(@inject(SHARED_TYPES.PrismaClient) private readonly prisma: PrismaClient) {}

  async add(entry: SuppressionEntry): Promise<SuppressionEntry> {
    const row = await this.prisma.suppression.upsert({
      where: { address: entry.address },
      create: toRow(entry),
      // Idempotent: an existing row is left exactly as it was (ADR-011) — a
      // duplicate hard-bounce/complaint event must not overwrite the original
      // reason/timestamp.
      update: {},
    });
    return toDomain(row);
  }

  async findByAddress(address: string): Promise<SuppressionEntry | null> {
    const row = await this.prisma.suppression.findUnique({ where: { address } });
    return row === null ? null : toDomain(row);
  }

  async list(options: ListSuppressionsOptions): Promise<SuppressionEntry[]> {
    const rows = await this.prisma.suppression.findMany({
      where: options.cursor === undefined ? undefined : { address: { gt: options.cursor } },
      orderBy: { address: 'asc' },
      take: options.limit,
    });
    return rows.map(toDomain);
  }

  async remove(address: string): Promise<boolean> {
    const { count } = await this.prisma.suppression.deleteMany({ where: { address } });
    return count > 0;
  }

  async filterSuppressed(addresses: string[]): Promise<string[]> {
    if (addresses.length === 0) return [];
    const rows = await this.prisma.suppression.findMany({
      where: { address: { in: addresses } },
      select: { address: true },
    });
    return rows.map((row) => row.address);
  }
}

function toRow(entry: SuppressionEntry): SuppressionRow {
  return {
    address: entry.address,
    reason: entry.reason,
    createdAt: entry.createdAt,
  };
}

function toDomain(row: SuppressionRow): SuppressionEntry {
  // The reason is only ever written by `add` (a closed `SuppressionReason`),
  // so a stored row's `reason` is trusted at the repository boundary — same
  // stance as `newsletters`' Prisma repository re-validating VOs, not enums.
  return SuppressionEntry.reconstitute({
    address: row.address,
    reason: row.reason as SuppressionReason,
    createdAt: row.createdAt,
  });
}
