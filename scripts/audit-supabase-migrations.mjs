#!/usr/bin/env node
// Read-only audit of local migration files against a project's real state.
//
// `supabase db push --dry-run` answers one question: which local versions the
// remote history does not record. It never says why, and the reasons need
// opposite treatment - a change never made needs pushing, while one made
// another way needs its history repaired, and pushing that re-runs DDL against
// live objects.
//
// It also cannot tell you WHICH project it just answered about, which matters
// when the answer contradicts what you see in the dashboard. So this prints the
// project's identity first, then the history, then what the schema actually
// contains.
//
// Read-only by construction: every statement it sends is a SELECT, and it
// refuses to send anything else.
//
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
//     node scripts/audit-supabase-migrations.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  artifactsDeclaredBy,
  assertReadOnly,
  classify,
  maskRef,
  nameOf,
  reconciliationPlan,
  remoteOnly,
  renameCandidates,
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

const set = (rows, key = 'name') => new Set(rows.map((row) => String(row[key]).toLowerCase()));

/* ------------------------------------------------------- project identity */

/*
 * Printed before anything else, because "the history says X" is meaningless
 * without knowing which database said it. A dry run that disagrees with the
 * dashboard is usually two different projects, and nothing below can reveal
 * that on its own.
 */
console.log('=== PROJECT IDENTITY ===');
console.log(`SUPABASE_PROJECT_REF (masked): ${maskRef(ref)}`);
try {
  const project = await fetch(`https://api.supabase.com/v1/projects/${ref}`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  console.log(`Project name:   ${project?.name ?? '(unknown)'}`);
  console.log(`Region:         ${project?.region ?? '(unknown)'}`);
  console.log(`Created:        ${project?.created_at ?? '(unknown)'}`);
  console.log(`Organization:   ${project?.organization_id ? maskRef(project.organization_id) : '(unknown)'}`);
} catch (reason) {
  console.log(`Project metadata unavailable: ${String(reason).slice(0, 160)}`);
}

const identity = await query('select current_database() as name, current_user as who, version() as server');
console.log(`Connected database: ${identity[0]?.name}  as ${identity[0]?.who}`);
console.log(`Server: ${String(identity[0]?.server ?? '').slice(0, 60)}`);
console.log('\nCompare the masked ref above with the project you queried by hand.');
console.log('If they differ, the workflow and your dashboard are looking at different');
console.log('databases and nothing below is comparable.\n');

/* ------------------------------------------------------------- history */

const local = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();

let history = [];
let historyReadable = true;
try {
  history = await query(
    "select version, name from supabase_migrations.schema_migrations order by version"
  );
} catch (reason) {
  historyReadable = false;
  console.log(`Remote migration history: UNREADABLE (${String(reason.message).slice(0, 160)})`);
}

const remoteVersions = history.map((row) => ({ version: String(row.version), name: row.name ?? '' }));

console.log('=== REMOTE MIGRATION HISTORY ===');
console.log(`${remoteVersions.length} row(s)`);
for (const entry of remoteVersions) console.log(`  ${entry.version}  ${entry.name}`);

console.log(`\n=== LOCAL MIGRATION FILES (${local.length}) ===`);
for (const file of local) console.log(`  ${versionOf(file)}  ${nameOf(file)}`);

const remoteVersionSet = new Set(remoteVersions.map((entry) => entry.version));
const exact = local.filter((file) => remoteVersionSet.has(versionOf(file)));

console.log('\n=== EXACT VERSION MATCHES (local ∩ remote) ===');
if (exact.length) {
  for (const file of exact) console.log(`  ${versionOf(file)}  ${nameOf(file)}`);
  console.log('\n  These are already recorded. `supabase db push` must not list them as');
  console.log('  pending. If it does, the push is reading a different history than this');
  console.log('  audit - most often a different project - and that must be resolved');
  console.log('  before anything is repaired or pushed.');
} else {
  console.log('  none');
}

const renamed = renameCandidates(local, remoteVersions);
console.log('\n=== SAME NAME, DIFFERENT VERSION ===');
if (renamed.length) {
  for (const entry of renamed) {
    console.log(`  local ${entry.version} ~ remote ${entry.remoteVersion}  ${entry.name}`);
  }
  console.log('\n  A lead, not a verdict. A shared name says somebody applied something');
  console.log('  with this purpose, not that they applied this content.');
} else {
  console.log('  none');
}

const orphans = remoteOnly(local, remoteVersions);
console.log('\n=== REMOTE ONLY (in the database, not in this repository) ===');
if (orphans.length) {
  for (const entry of orphans) console.log(`  ${entry.version}  ${entry.name}`);
  console.log('\n  ::warning:: The database has changes this repository does not. A push of');
  console.log('  a local migration touching the same objects could contradict them.');
} else {
  console.log('  none');
}

/* ------------------------------------------------------------ live schema */

const [relations, routines, policies, triggers, indexes, grants, functionAttrs] = await Promise.all([
  query("select table_name as name from information_schema.tables where table_schema = 'public'"),
  query("select routine_name as name from information_schema.routines where routine_schema = 'public'"),
  query("select tablename || ':' || policyname as name from pg_policies where schemaname = 'public'"),
  query("select tgname as name from pg_trigger where not tgisinternal"),
  query("select indexname as name from pg_indexes where schemaname = 'public'"),
  query("select distinct table_name || ':' || grantee as name from information_schema.role_table_grants where table_schema = 'public'"),
  query("select p.proname as name, p.prosecdef as definer, array_to_string(p.proconfig, ',') as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'"),
]);

const live = {
  relations: set(relations),
  functions: set(routines),
  policies: new Set(policies.map((row) => String(row.name))),
  triggers: set(triggers),
  indexes: set(indexes),
  grants: set(grants),
  securityDefiners: new Set(functionAttrs.filter((row) => row.definer === true || row.definer === 't').map((row) => String(row.name).toLowerCase())),
  pinnedSearchPath: new Set(functionAttrs.filter((row) => /search_path=(""|'')?$/.test(String(row.config ?? '')) || /search_path=$/.test(String(row.config ?? ''))).map((row) => String(row.name).toLowerCase())),
};

console.log('\n=== LIVE SCHEMA ===');
console.log(`relations ${live.relations.size}  functions ${live.functions.size}  policies ${live.policies.size}`);
console.log(`triggers ${live.triggers.size}  indexes ${live.indexes.size}  table grants ${live.grants.size}`);
console.log(`security definer functions ${live.securityDefiners.size}  pinned search_path ${live.pinnedSearchPath.size}`);

/* -------------------------------------------------------------- verdicts */

const rows = local.map((file) => {
  const version = versionOf(file);
  const declared = artifactsDeclaredBy(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  const verdict = classify(declared, live, { inHistory: remoteVersionSet.has(version) });
  return { file, version, name: nameOf(file), ...verdict };
});

const pad = (value, width) => String(value).padEnd(width);
console.log('\n=== PER-MIGRATION VERDICT ===');
console.log(`${pad('MIGRATION', 50)} ${pad('STATUS', 17)} DETAIL`);
for (const row of rows) {
  const detail = row.status === 'history_match'
    ? 'version already recorded'
    : row.status === 'equivalent'
      ? `all ${row.present.length} declared artifacts present`
      : row.status === 'unverifiable'
        ? 'declares nothing this audit can check'
        : `missing ${row.missing.length}: ${row.missing.slice(0, 4).join(', ')}`;
  console.log(`${pad(row.file, 50)} ${pad(row.status, 17)} ${detail.slice(0, 100)}`);
}

const plan = reconciliationPlan(rows);

console.log('\n=== RECONCILIATION ===\n');
console.log(`Already recorded (no action):        ${plan.historyMatch.length}`);
console.log(`Proven equivalent (repair offered):  ${plan.repairable.length}`);
console.log(`Schema candidates (NOT offered):     ${plan.schemaCandidates.length}`);
console.log(`Partially present (NOT offered):     ${plan.partial.length}`);
console.log(`Absent (push normally):              ${plan.pending.length}`);
console.log(`Unverifiable (NOT offered):          ${plan.unverifiable.length}\n`);

if (plan.repairable.length) {
  console.log('Every artifact these declare is present. Only these may be repaired:');
  for (const row of plan.repairable) console.log(`  ${row.version}  ${row.file}`);
  console.log('\n  supabase migration repair --status applied '
    + plan.repairable.map((row) => row.version).join(' '));
  console.log('\n  Nothing else is appended to that command. In particular, an unverifiable');
  console.log('  migration is not swept in behind a neighbour: "creates no object" means');
  console.log('  this audit cannot prove it, not that it follows another one safely.\n');
} else {
  console.log('No migration is proven equivalent. Nothing is offered for repair.\n');
}

for (const [label, bucket] of [
  ['SCHEMA CANDIDATES - objects exist, equivalence NOT proven', plan.schemaCandidates],
  ['PARTIALLY PRESENT - decide per migration', plan.partial],
  ['UNVERIFIABLE - policy/grant/index-only, or nothing checkable', plan.unverifiable],
]) {
  if (!bucket.length) continue;
  console.log(`${label}:`);
  for (const row of bucket) {
    console.log(`  ${row.version}  ${row.file}`);
    if (row.missing.length) console.log(`      missing: ${row.missing.join(', ').slice(0, 200)}`);
  }
  console.log();
}

console.log('ABSENT - these should be pushed normally:');
if (plan.pending.length) {
  for (const row of plan.pending) console.log(`  ${row.version}  ${row.file}`);
} else {
  console.log('  none');
}

if (!historyReadable) {
  console.log('\n::warning:: The migration history could not be read. Treat every verdict above');
  console.log('as provisional - "not in history" cannot be distinguished from "history unknown".');
}
