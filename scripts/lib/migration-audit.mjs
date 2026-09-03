/*
 * Deciding, conservatively, whether a migration is already represented.
 *
 * The first version of this asked one question - do the tables, views and
 * functions this migration creates exist? - and treated a yes as proof. That is
 * not proof. A migration establishes far more than the objects it names: RLS
 * policies, grants and revokes, triggers, indexes, constraints, and whether a
 * function is SECURITY DEFINER with a pinned search_path. Every one of those
 * can be absent or wrong while the table sits there looking correct, and this
 * repository's security rests on exactly those parts rather than on the tables.
 *
 * Marking such a migration "applied" would write it out of the history while
 * its policies were still missing, and nothing would ever apply them.
 *
 * So the model is deliberately reluctant: only a migration whose every declared
 * artifact is present is offered for repair, and anything this file cannot
 * check is reported as unverifiable rather than assumed.
 */

const KIND_ORDER = ['table', 'view', 'function', 'policy', 'trigger', 'index', 'grant'];

/*
 * Everything a migration declares, read from the migration itself rather than
 * from a hand-kept list that would drift the first time somebody added a table.
 *
 * Comments are stripped first: these files explain at length what they
 * deliberately leave alone, and crediting a migration with the things it
 * promises to avoid is how a naive scan calls it represented against a database
 * holding none of its real objects.
 */
export function artifactsDeclaredBy(sql) {
  const statements = sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const unique = (values) => [...new Set(values)];

  const tables = unique([...statements.matchAll(/create table (?:if not exists )?public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase()));
  const views = unique([...statements.matchAll(/create (?:or replace )?view public\.([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase()));
  const functions = unique([...statements.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)\s*\(/gi)].map((m) => m[1].toLowerCase()));
  const policies = unique([...statements.matchAll(/create policy\s+"([^"]+)"\s+on\s+public\.([a-z0-9_]+)/gi)].map((m) => `${m[2].toLowerCase()}:${m[1]}`));
  const triggers = unique([...statements.matchAll(/create trigger\s+([a-z0-9_]+)/gi)].map((m) => m[1].toLowerCase()));
  const indexes = unique([...statements.matchAll(/create (?:unique )?index (?:if not exists )?([a-z0-9_]+)\s+on/gi)].map((m) => m[1].toLowerCase()));

  /* Grants as table:role, which is the granularity information_schema reports
     and enough to notice a role that was never granted anything at all. */
  const grants = unique(
    [...statements.matchAll(/grant\s+[^;]*?\s+on\s+(?:table\s+)?public\.([a-z0-9_]+)\s+to\s+([a-z0-9_, ]+)/gi)]
      .flatMap((match) => match[2].split(',').map((role) => `${match[1].toLowerCase()}:${role.trim().toLowerCase()}`))
      .filter((entry) => !/:(public|anon)$/.test(entry)),
  );

  /* Security attributes are per function, and their absence is the whole point
     of several migrations in this repository. */
  const securityDefiners = unique(
    [...statements.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)[\s\S]*?(?=create |$)/gi)]
      .filter((match) => /security definer/i.test(match[0]))
      .map((match) => match[1].toLowerCase()),
  );
  const pinnedSearchPath = unique(
    [...statements.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)[\s\S]*?(?=create |$)/gi)]
      .filter((match) => /set search_path\s*=\s*''/i.test(match[0]))
      .map((match) => match[1].toLowerCase()),
  );

  return { tables, views, functions, policies, triggers, indexes, grants, securityDefiners, pinnedSearchPath };
}

/* The version is the filename prefix, which is what the history table stores. */
export function versionOf(filename) {
  const match = /^(\d{14})_/.exec(filename);
  return match ? match[1] : null;
}

/* The name half, used only as evidence for a human comparing a renamed
   migration - never on its own as grounds for repair. */
export function nameOf(filename) {
  const match = /^\d{14}_(.+)\.sql$/.exec(filename);
  return match ? match[1] : null;
}

/*
 * How each declared artifact is checked against the live schema. Anything not
 * listed here cannot be checked and makes the migration unverifiable.
 */
function checkArtifacts(declared, live) {
  const present = [];
  const missing = [];
  const record = (ok, label) => (ok ? present : missing).push(label);

  for (const name of declared.tables) record(live.relations.has(name), `table ${name}`);
  for (const name of declared.views) record(live.relations.has(name), `view ${name}`);
  for (const name of declared.functions) record(live.functions.has(name), `function ${name}`);
  for (const name of declared.policies) record(live.policies.has(name), `policy ${name}`);
  for (const name of declared.triggers) record(live.triggers.has(name), `trigger ${name}`);
  for (const name of declared.indexes) record(live.indexes.has(name), `index ${name}`);
  for (const name of declared.grants) record(live.grants.has(name), `grant ${name}`);
  for (const name of declared.securityDefiners) record(live.securityDefiners.has(name), `security definer ${name}`);
  for (const name of declared.pinnedSearchPath) record(live.pinnedSearchPath.has(name), `pinned search_path ${name}`);

  return { present, missing };
}

/* Whether a migration declares anything this audit knows how to verify. */
export function isVerifiable(declared) {
  return KIND_ORDER.some((kind) => {
    const key = kind === 'index' ? 'indexes' : `${kind}s`;
    return (declared[key] ?? []).length > 0;
  });
}

/*
 * The verdict.
 *
 *   history_match     the exact version is already recorded; nothing to do
 *   equivalent        every declared artifact is present - the only status
 *                     that may be offered for history repair
 *   schema_candidate  its primary objects exist but something it declares does
 *                     not, so equivalence is NOT established
 *   partial           mixed presence of its primary objects
 *   absent            none of its primary objects exist; push it
 *   unverifiable      it declares nothing this audit can check
 *
 * Note what schema_candidate is not: it is not "probably fine". It is the
 * status for a migration whose table exists while a policy, grant, trigger or
 * function attribute it also establishes does not - which is precisely the
 * case where repairing would strand the missing half forever.
 */
export function classify(declared, live, { inHistory }) {
  if (inHistory) return { status: 'history_match', present: [], missing: [] };
  if (!isVerifiable(declared)) return { status: 'unverifiable', present: [], missing: [] };

  const { present, missing } = checkArtifacts(declared, live);
  if (!missing.length) return { status: 'equivalent', present, missing };

  const primaries = [...declared.tables, ...declared.views, ...declared.functions];
  if (!primaries.length) return { status: 'schema_candidate', present, missing };

  const presentPrimaries = primaries.filter((name) => live.relations.has(name) || live.functions.has(name));
  if (!presentPrimaries.length) return { status: 'absent', present, missing };
  if (presentPrimaries.length < primaries.length) return { status: 'partial', present, missing };

  /* Every primary object exists but something else it declares does not. */
  return { status: 'schema_candidate', present, missing };
}

/*
 * What may be acted on.
 *
 * Only `equivalent` is offered for repair, and nothing is appended to it.
 * unverifiable migrations are specifically NOT swept in behind a neighbour:
 * "creates no object" means this audit cannot prove it, not that it follows
 * another migration safely.
 */
export function reconciliationPlan(rows) {
  const byStatus = (status) => rows.filter((row) => row.status === status);
  return {
    historyMatch: byStatus('history_match'),
    repairable: byStatus('equivalent'),
    schemaCandidates: byStatus('schema_candidate'),
    partial: byStatus('partial'),
    pending: byStatus('absent'),
    unverifiable: byStatus('unverifiable'),
  };
}

/*
 * A local file and a remote history entry sharing a name but not a version.
 *
 * Reported as a lead for a human, never as grounds for repair on its own: a
 * matching name says somebody applied something with this purpose, not that
 * they applied this content.
 */
export function renameCandidates(localFiles, remoteVersions) {
  const remoteByName = new Map(remoteVersions.map((entry) => [entry.name, entry.version]));
  const remoteVersionSet = new Set(remoteVersions.map((entry) => entry.version));

  return localFiles
    .map((file) => ({ file, version: versionOf(file), name: nameOf(file) }))
    .filter((local) => local.version && !remoteVersionSet.has(local.version) && remoteByName.has(local.name))
    .map((local) => ({ ...local, remoteVersion: remoteByName.get(local.name) }));
}

/* History entries with no local counterpart: changes the database has that the
   repository does not, which a push could contradict. */
export function remoteOnly(localFiles, remoteVersions) {
  const localVersions = new Set(localFiles.map(versionOf));
  const localNames = new Set(localFiles.map(nameOf));
  return remoteVersions.filter((entry) => !localVersions.has(entry.version) && !localNames.has(entry.name));
}

/*
 * Only SELECTs leave the auditing process. A single statement, too - a
 * trailing semicolon is stripped, and anything that would let a second
 * statement ride along is refused rather than sanitised.
 */
export function assertReadOnly(sql) {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!/^select\b/i.test(trimmed) || trimmed.includes(';')) {
    throw new Error(`Refusing to send a non-SELECT statement: ${sql.slice(0, 80)}`);
  }
  return trimmed;
}

/* Enough of a project ref to compare two of them, not enough to use one. */
export function maskRef(ref) {
  if (!ref || ref.length < 8) return '(unset or too short to mask)';
  return `${ref.slice(0, 4)}…${ref.slice(-4)} (${ref.length} chars)`;
}
