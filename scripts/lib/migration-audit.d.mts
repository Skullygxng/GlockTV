/* Types for the migration-history audit. Plain .mjs so it runs under node in a
   workflow that has compiled nothing; declared here so the tests are checked
   rather than silently any. */

export interface CreatedObjects {
  tables: string[];
  functions: string[];
  views: string[];
}

export interface RemoteSchema {
  relations: Set<string>;
  functions: Set<string>;
}

export type MigrationStatus = 'represented' | 'absent' | 'partial' | 'inconclusive';

export interface Verdict {
  status: MigrationStatus;
  missing: string[];
  present: string[];
}

export interface AuditRow {
  version: string | null;
  inHistory: boolean;
  status: MigrationStatus;
  file?: string;
  missing?: string[];
  present?: string[];
}

export function objectsCreatedBy(sql: string): CreatedObjects;
export function versionOf(filename: string): string | null;
export function classify(objects: CreatedObjects, remote: RemoteSchema): Verdict;
export function assertReadOnly(sql: string): string;
export function reconciliationPlan(rows: AuditRow[]): {
  repairable: AuditRow[];
  inconclusive: AuditRow[];
  genuinelyPending: AuditRow[];
  partial: AuditRow[];
};
