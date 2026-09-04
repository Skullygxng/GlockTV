/* Types for the migration-history audit. Plain .mjs so it runs under node in a
   workflow that has compiled nothing; declared here so the tests are checked
   rather than silently any. */

export interface DeclaredArtifacts {
  tables: string[];
  views: string[];
  functions: string[];
  policies: string[];
  triggers: string[];
  indexes: string[];
  grants: string[];
  revokes: string[];
  rlsEnabled: string[];
  securityDefiners: string[];
  pinnedSearchPath: string[];
}

export interface LiveSchema {
  relations: Set<string>;
  functions: Set<string>;
  policies: Set<string>;
  triggers: Set<string>;
  indexes: Set<string>;
  grants: Set<string>;
  rlsEnabled: Set<string>;
  securityDefiners: Set<string>;
  pinnedSearchPath: Set<string>;
}

export type MigrationStatus =
  | 'history_match'
  | 'same_name_candidate'
  | 'schema_present_candidate'
  | 'partial'
  | 'absent'
  | 'unverifiable';

export interface Verdict {
  status: MigrationStatus;
  missing: string[];
  present: string[];
  sameNameRemoteVersion?: string;
}

export interface AuditRow extends Verdict {
  version: string | null;
  file?: string;
  name?: string | null;
}

export interface RemoteEntry {
  version: string;
  name: string;
}

export function artifactsDeclaredBy(sql: string): DeclaredArtifacts;
export function versionOf(filename: string): string | null;
export function nameOf(filename: string): string | null;
export function isVerifiable(declared: DeclaredArtifacts): boolean;
export const CHECKED_KINDS: string[];
export const NOT_VERIFIED: string[];
export function classify(
  declared: DeclaredArtifacts,
  live: LiveSchema,
  options: { inHistory: boolean; sameNameRemoteVersion?: string },
): Verdict;
/* Deliberately returns no repair list: this parser cannot authorize one. */
export function auditSummary(rows: AuditRow[]): {
  historyMatch: AuditRow[];
  sameNameCandidates: AuditRow[];
  schemaPresentCandidates: AuditRow[];
  partial: AuditRow[];
  pending: AuditRow[];
  unverifiable: AuditRow[];
};
export function renameCandidates(
  localFiles: string[],
  remoteVersions: RemoteEntry[],
): Array<{ file: string; version: string | null; name: string | null; remoteVersion?: string }>;
export function remoteOnly(localFiles: string[], remoteVersions: RemoteEntry[]): RemoteEntry[];
export function assertReadOnly(sql: string): string;
export function maskRef(ref: string): string;
