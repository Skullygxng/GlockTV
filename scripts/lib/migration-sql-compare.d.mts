/* Types for the recorded-SQL comparison. Plain .mjs so it runs under node in a
   workflow that has compiled nothing; declared here so the tests are checked
   rather than silently any. */

export type CompareVerdict = 'identical' | 'reordered' | 'differs';

export interface Comparison {
  verdict: CompareVerdict;
  onlyLocal: string[];
  onlyRemote: string[];
}

export function splitStatements(sql: string): string[];
export function normalizeStatement(statement: string): string;
export function normalizeRemoteStatements(statements: unknown): string[];
export function compareStatements(localStatements: string[], remoteStatements: string[]): Comparison;
export function compareSql(localSql: string, remoteStatements: unknown): Comparison;
