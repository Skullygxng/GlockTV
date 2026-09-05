#!/usr/bin/env node
// Read-only comparison of local migration files against the SQL a project ran.
//
// The audit next door answers "does an object with this name exist?" and says
// plainly that this is not equivalence. This answers the stronger question,
// because Supabase keeps what it executed in
// supabase_migrations.schema_migrations.statements.
//
// Two things come out of it. For a local file paired with a differently
// versioned remote entry, a text verdict - so renaming the file to the recorded
// version is evidence-backed rather than an assumption from a shared name. For
// an entry the repository has no file for, the SQL itself, so it can be
// committed as a real migration instead of a stub.
//
// Read-only by construction: the one statement it sends is a SELECT, checked by
// the same guard the audit uses.
//
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
//     node scripts/compare-remote-migration-sql.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { assertReadOnly, maskRef, nameOf, versionOf } from './lib/migration-audit.mjs';
import { compareSql, normalizeRemoteStatements } from './lib/migration-sql-compare.mjs';

const token = process.env.SUPABASE_ACCESS_TOKEN ?? '';
const ref = process.env.SUPABASE_PROJECT_REF ?? '';
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? 'supabase/migrations';

if (!token || !ref) {
  console.error('Missing required environment: SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF');
  process.exit(2);
}

async function query(sql) {
  const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: assertReadOnly(sql) }),
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Query failed (HTTP ${response.status}): ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

console.log('=== PROJECT IDENTITY ===');
console.log(`SUPABASE_PROJECT_REF (masked): ${maskRef(ref)}`);
const identity = await query('select current_database() as name, current_user as who');
console.log(`Connected database: ${identity[0]?.name}  as ${identity[0]?.who}\n`);

const history = await query(
  'select version, name, statements from supabase_migrations.schema_migrations order by version'
);

const localFiles = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
const readLocal = (file) => readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

/*
 * Pairing, in the only order that is safe: an exact version match is the
 * project's own statement that this file is that entry. A shared name is a
 * lead, and is only accepted when the version match found nothing - otherwise
 * two files with the same name could each claim the same history row.
 */
const claimed = new Set();
const pairs = [];

for (const entry of history) {
  const version = String(entry.version);
  const byVersion = localFiles.find((file) => versionOf(file) === version);
  const byName = localFiles.find((file) => !claimed.has(file) && nameOf(file) === entry.name);
  const file = byVersion ?? byName ?? null;
  if (file) claimed.add(file);
  pairs.push({ version, name: entry.name ?? '', statements: entry.statements, file, matchedBy: byVersion ? 'version' : file ? 'name' : null });
}

const unpairedLocal = localFiles.filter((file) => !claimed.has(file));

/* --------------------------------------------------------------- verdicts */

console.log('=== LOCAL FILE vs RECORDED SQL ===');
console.log('REMOTE VERSION   PAIRED WITH                                    MATCHED BY  VERDICT');

const results = [];
for (const pair of pairs) {
  if (!pair.file) {
    results.push({ ...pair, verdict: 'remote_only' });
    console.log(`${pair.version}   ${'(no local file)'.padEnd(46)} ${'-'.padEnd(11)} remote_only`);
    continue;
  }
  const comparison = compareSql(readLocal(pair.file), pair.statements);
  results.push({ ...pair, ...comparison });
  console.log(`${pair.version}   ${pair.file.padEnd(46)} ${String(pair.matchedBy).padEnd(11)} ${comparison.verdict}`);
}

if (unpairedLocal.length) {
  console.log('\n=== LOCAL FILES WITH NO HISTORY ENTRY (pending, or applied under a name this cannot match) ===');
  for (const file of unpairedLocal) console.log(`  ${file}`);
}

/* ----------------------------------------------------- differences in full */

const differing = results.filter((result) => result.verdict === 'differs' || result.verdict === 'reordered');
if (differing.length) {
  console.log('\n=== DIFFERENCES, STATEMENT BY STATEMENT ===');
  for (const result of differing) {
    console.log(`\n--- ${result.version}  ${result.file}  (${result.verdict}) ---`);
    for (const statement of result.onlyLocal) console.log(`  LOCAL ONLY : ${statement}`);
    for (const statement of result.onlyRemote) console.log(`  REMOTE ONLY: ${statement}`);
  }
}

/* ------------------------------------------------- remote-only SQL in full */

const remoteOnlyRows = results.filter((result) => result.verdict === 'remote_only');
if (remoteOnlyRows.length) {
  console.log('\n=== SQL THIS REPOSITORY DOES NOT HAVE ===');
  console.log('Printed in full so it can be committed as a real migration. This is the');
  console.log('only copy outside the database: if the project were rebuilt from this');
  console.log('repository today, these changes would be lost.\n');
  for (const row of remoteOnlyRows) {
    console.log(`----- BEGIN ${row.version}_${row.name} -----`);
    for (const statement of normalizeRemoteStatements(row.statements)) console.log(`${statement};`);
    console.log(`----- END ${row.version}_${row.name} -----\n`);
  }
}

console.log('\n=== SUMMARY ===');
for (const verdict of ['identical', 'reordered', 'differs', 'remote_only']) {
  const count = results.filter((result) => result.verdict === verdict).length;
  if (count) console.log(`  ${verdict.padEnd(12)} ${count}`);
}
console.log(`  ${'local only'.padEnd(12)} ${unpairedLocal.length}`);
console.log('\nA verdict of `identical` means the recorded statements and the local file');
console.log('agree once comments and whitespace are set aside. It says nothing about');
console.log('whether the object was altered afterwards by something outside migrations.');
