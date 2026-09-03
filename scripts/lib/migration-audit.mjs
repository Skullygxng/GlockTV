/*
 * Deciding whether a migration is already represented in a database.
 *
 * `supabase db push --dry-run` answers only "which local versions does the
 * remote history not mention". It cannot say why they are missing. A project
 * whose schema was applied by hand, through the dashboard, or under different
 * version strings has a history that mentions none of the local files - so
 * every migration looks pending even though its objects already exist, and a
 * push would re-run DDL against live objects.
 *
 * These functions answer the question that actually decides what is safe: do
 * the things this migration creates already exist? Pure, so they can be tested
 * against the real migration files with no project and no credentials.
 */

/*
 * The objects a migration is responsible for, read from the migration itself
 * rather than from a hand-kept list that would drift the first time somebody
 * added a table.
 *
 * Comments are stripped first: several of these files explain at length which
 * tables they deliberately do NOT touch, and a naive scan would credit them
 * with creating exactly the things they promise to leave alone.
 */
export function objectsCreatedBy(sql) {
  const statements = sql.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const tables = [...statements.matchAll(/create table (?:if not exists )?public\.([a-z0-9_]+)/gi)].map((m) => m[1]);
  const functions = [...statements.matchAll(/create (?:or replace )?function public\.([a-z0-9_]+)\s*\(/gi)].map((m) => m[1]);
  const views = [...statements.matchAll(/create (?:or replace )?view public\.([a-z0-9_]+)/gi)].map((m) => m[1]);
  return {
    tables: [...new Set(tables)],
    functions: [...new Set(functions)],
    views: [...new Set(views)],
  };
}

/* The version is the filename prefix, which is what the history table stores. */
export function versionOf(filename) {
  const match = /^(\d{14})_/.exec(filename);
  return match ? match[1] : null;
}

/*
 * represented   every object it introduces already exists
 * absent        none of them do
 * partial       some do - never safe to repair or push blindly
 * inconclusive  it creates nothing of its own; it only adds policies, grants
 *               or indexes to a table an earlier migration made, so its
 *               standing follows that migration's rather than being guessable
 *               from the schema alone
 */
export function classify(objects, remote) {
  const wanted = [
    ...objects.tables.map((name) => ['table', name]),
    ...objects.views.map((name) => ['view', name]),
    ...objects.functions.map((name) => ['function', name]),
  ];
  if (!wanted.length) return { status: 'inconclusive', missing: [], present: [] };

  const present = [];
  const missing = [];
  for (const [kind, name] of wanted) {
    const exists = kind === 'function' ? remote.functions.has(name) : remote.relations.has(name);
    (exists ? present : missing).push(`${kind} ${name}`);
  }

  if (!missing.length) return { status: 'represented', missing, present };
  if (!present.length) return { status: 'absent', missing, present };
  return { status: 'partial', missing, present };
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

/*
 * What to repair, and what is genuinely new.
 *
 * A migration is a repair candidate only when the database already contains
 * what it creates and the history does not record it - writing its version in
 * then makes the history describe the database that is actually there, which is
 * the whole of the fix and touches no schema and no data.
 */
export function reconciliationPlan(rows) {
  const pending = rows.filter((row) => !row.inHistory);
  return {
    repairable: pending.filter((row) => row.status === 'represented'),
    inconclusive: pending.filter((row) => row.status === 'inconclusive'),
    genuinelyPending: pending.filter((row) => row.status === 'absent'),
    partial: pending.filter((row) => row.status === 'partial'),
  };
}
