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
// It is diagnostic only. It never prints or constructs a `supabase migration
// repair` command: names and existence are syntax, equivalence is semantics,
// and this reads only the first. A person reads the evidence and decides.
//
// Read-only by construction: every statement it sends is a SELECT, and it
// refuses to send anything else.
//
//   SUPABASE_ACCESS_TOKEN=... SUPABASE_PROJECT_REF=... \
//     node scripts/audit-supabase-migrations.mjs

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  NOT_VERIFIED,
  artifactsDeclaredBy,
  assertReadOnly,
  auditSummary,
  classify,
  maskRef,
  nameOf,
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

const [relations, routines, policies, triggers, indexes, grants, functionAttrs, rlsTables] = await Promise.all([
  query("select table_name as name from information_schema.tables where table_schema = 'public'"),
  query("select routine_name as name from information_schema.routines where routine_schema = 'public'"),
  query("select tablename || ':' || policyname as name from pg_policies where schemaname = 'public'"),
  query("select tgname as name from pg_trigger where not tgisinternal"),
  query("select indexname as name from pg_indexes where schemaname = 'public'"),
  query("select distinct table_name || ':' || grantee as name from information_schema.role_table_grants where table_schema = 'public'"),
  query("select p.proname as name, p.prosecdef as definer, array_to_string(p.proconfig, ',') as config from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'"),
  query("select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relrowsecurity"),
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
  rlsEnabled: set(rlsTables),
};

console.log('\n=== LIVE SCHEMA ===');
console.log(`relations ${live.relations.size}  functions ${live.functions.size}  policies ${live.policies.size}`);
console.log(`triggers ${live.triggers.size}  indexes ${live.indexes.size}  table grants ${live.grants.size}`);
console.log(`security definer functions ${live.securityDefiners.size}  pinned search_path ${live.pinnedSearchPath.size}`);
console.log(`tables with row level security enabled ${live.rlsEnabled.size}`);

/* -------------------------------------------------------------- verdicts */

const renamedByFile = new Map(renamed.map((entry) => [entry.file, entry.remoteVersion]));
const rows = local.map((file) => {
  const version = versionOf(file);
  const declared = artifactsDeclaredBy(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  const verdict = classify(declared, live, {
    inHistory: remoteVersionSet.has(version),
    sameNameRemoteVersion: renamedByFile.get(file),
  });
  return { file, version, name: nameOf(file), ...verdict };
});

const pad = (value, width) => String(value).padEnd(width);
console.log('\n=== PER-MIGRATION EVIDENCE ===');
console.log(`${pad('MIGRATION', 50)} ${pad('STATUS', 26)} DETAIL`);
for (const row of rows) {
  const detail = row.status === 'history_match'
    ? 'version already recorded'
    : row.status === 'same_name_candidate'
      ? `remote ${row.sameNameRemoteVersion} shares this name; ${row.missing.length ? `${row.missing.length} artifact(s) missing` : 'all checked artifacts present'}`
      : row.status === 'unverifiable'
        ? 'declares nothing this audit can look for'
        : row.missing.length
          ? `missing ${row.missing.length}: ${row.missing.slice(0, 3).join(', ')}`
          : `all ${row.present.length} checked artifacts present`;
  console.log(`${pad(row.file, 50)} ${pad(row.status, 26)} ${detail.slice(0, 90)}`);
}

const summary = auditSummary(rows);

console.log('\n=== SUMMARY ===\n');
console.log(`history_match             ${summary.historyMatch.length}   already recorded, no action`);
console.log(`same_name_candidate       ${summary.sameNameCandidates.length}   manual equivalence review required`);
console.log(`schema_present_candidate  ${summary.schemaPresentCandidates.length}   may already be represented; NOT proven`);
console.log(`partial                   ${summary.partial.length}   investigate`);
console.log(`absent                    ${summary.pending.length}   clearly pending`);
console.log(`unverifiable              ${summary.unverifiable.length}   cannot establish equivalence`);

for (const [label, bucket] of [
  ['SAME NAME, DIFFERENT VERSION - review each by hand', summary.sameNameCandidates],
  ['SCHEMA PRESENT - suggestive only, equivalence NOT established', summary.schemaPresentCandidates],
  ['PARTIAL - investigate', summary.partial],
  ['UNVERIFIABLE', summary.unverifiable],
]) {
  if (!bucket.length) continue;
  console.log(`\n${label}:`);
  for (const row of bucket) {
    const lead = row.sameNameRemoteVersion ? `  ~ remote ${row.sameNameRemoteVersion}` : '';
    console.log(`  ${row.version}  ${row.file}${lead}`);
    if (row.present.length) console.log(`      present: ${row.present.join(', ').slice(0, 240)}`);
    if (row.missing.length) console.log(`      missing: ${row.missing.join(', ').slice(0, 240)}`);
  }
}

console.log('\nABSENT - clearly pending, push these normally:');
if (summary.pending.length) {
  for (const row of summary.pending) console.log(`  ${row.version}  ${row.file}`);
} else {
  console.log('  none');
}

/*
 * The disclaimer is part of the output, not of the documentation. Anyone
 * reading a "schema present" line needs to see, in the same breath, the list of
 * things that were never looked at.
 */
console.log('\n=== WHAT THIS AUDIT DID NOT VERIFY ===\n');
for (const item of NOT_VERIFIED) console.log(`  - ${item}`);
console.log('\nNames and existence are syntax. Equivalence is semantics, and this reads');
console.log('only the first: a policy with the right name and an inverted USING clause');
console.log('passes every check above. So no repair command is printed here and none');
console.log('should be derived from this output alone. Decide each version by hand, then');
console.log("pass the reviewed list to the workflow's repair_versions input.");

if (!historyReadable) {
  console.log('\n::warning:: The migration history could not be read. Treat every line above');
  console.log('as provisional - "not in history" cannot be distinguished from "history unknown".');
}
