#!/usr/bin/env node
// Read-only audit of local migration files against a project's real state.
//
// `supabase db push --dry-run` answers one question: which local versions are
// absent from the remote migration history. It cannot tell you *why*. A project
// whose schema was applied by hand, or through the dashboard, or under
// different version strings, has a history table that does not mention the
// local files - so every migration looks pending even though the objects
// already exist. Pushing then re-runs DDL against live objects.
//
// This asks the two questions that actually decide what is safe:
//
//   1. what versions does the remote history record?
//   2. do the objects each local migration creates already exist?
//
// A migration whose objects are all present is already represented, whatever
// version string recorded it - and the safe reconciliation is to write its
// version into the history with `supabase migration repair`, which touches no
// schema and no data.
//
// Read-only by construction: every statement it sends is a SELECT, and it
// refuses to send anything else.
//
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
//     node scripts/audit-supabase-migrations.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  assertReadOnly,
  classify,
  objectsCreatedBy,
  reconciliationPlan,
  versionOf,
} from './lib/migration-audit.mjs';

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

const local = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();

console.log(`Local migrations: ${local.length}\n`);

let history = [];
try {
  history = await query(
    "select version from supabase_migrations.schema_migrations order by version"
  );
} catch (reason) {
  /* A project that has never been pushed to has no such table. That is itself
     the answer, not an error. */
  console.log(`Remote migration history: unreadable (${reason.message.slice(0, 120)})`);
}

const remoteVersions = history.map((row) => String(row.version));
console.log(`Remote migration history: ${remoteVersions.length} row(s)`);
for (const version of remoteVersions) console.log(`  ${version}`);
console.log();

const relations = await query(
  "select table_name as name from information_schema.tables where table_schema = 'public'"
);
const routines = await query(
  "select routine_name as name from information_schema.routines where routine_schema = 'public'"
);
const remote = {
  relations: new Set(relations.map((row) => row.name)),
  functions: new Set(routines.map((row) => row.name)),
};

console.log(`Remote public relations: ${remote.relations.size}, functions: ${remote.functions.size}\n`);

const known = new Set(remoteVersions);
const rows = [];
for (const file of local) {
  const version = versionOf(file);
  const sql = readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const objects = objectsCreatedBy(sql);
  const verdict = classify(objects, remote);
  rows.push({ file, version, inHistory: known.has(version), ...verdict });
}

const pad = (value, width) => String(value).padEnd(width);
console.log(`${pad('MIGRATION', 52)} ${pad('IN HISTORY', 11)} ${pad('SCHEMA', 13)} DETAIL`);
for (const row of rows) {
  const detail = row.status === 'represented'
    ? row.present.join(', ')
    : row.status === 'inconclusive'
      ? 'creates no new object; follows the migration above'
      : `missing: ${row.missing.join(', ')}`;
  console.log(`${pad(row.file, 52)} ${pad(row.inHistory ? 'yes' : 'no', 11)} ${pad(row.status, 13)} ${detail.slice(0, 90)}`);
}

/*
 * The reconciliation, stated as the exact command rather than a description of
 * one. Only migrations whose objects already exist and whose version the
 * history does not record are candidates: writing their version in makes the
 * history describe the database that is actually there.
 */
const { repairable, inconclusive, genuinelyPending, partial } = reconciliationPlan(rows);

console.log('\n--- Reconciliation ---\n');
if (repairable.length) {
  console.log('Already represented in the database, absent from its history:');
  for (const row of repairable) console.log(`  ${row.version}  ${row.file}`);
  const versions = [...repairable, ...inconclusive].map((row) => row.version).join(' ');
  console.log('\nMark them applied without touching schema or data:');
  console.log(`  supabase migration repair --status applied ${versions}`);
  if (inconclusive.length) {
    console.log('\n  (includes the versions below, which create no object of their own and');
    console.log('   only make sense alongside the migration they follow:)');
    for (const row of inconclusive) console.log(`     ${row.version}  ${row.file}`);
  }
} else {
  console.log('Nothing to repair: no migration is present in the database but missing from its history.');
}

console.log('\nGenuinely pending - these should be the only ones a corrected dry run lists:');
if (genuinelyPending.length) {
  for (const row of genuinelyPending) console.log(`  ${row.version}  ${row.file}  (${row.missing.join(', ')})`);
} else {
  console.log('  none');
}

if (partial.length) {
  console.log('\n::warning::Some migrations are PARTIALLY present. Do not repair or push these');
  console.log('without deciding, per migration, what is actually missing:');
  for (const row of partial) console.log(`  ${row.file}: present ${row.present.join(', ')} / missing ${row.missing.join(', ')}`);
}
