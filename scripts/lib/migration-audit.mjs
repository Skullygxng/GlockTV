/*
 * Evidence about migrations. Not authorization to repair one.
 *
 * This module has now twice been trusted with a stronger claim than it can
 * make. First it asked whether the tables and functions a migration creates
 * exist and called a yes "represented". Then it checked policies, triggers,
 * indexes, grants and function attributes too, and called a full house
 * "equivalent" - and printed a `migration repair` command from it.
 *
 * That is still wrong, and it is worth being precise about why, because the
 * gap is not going to close by adding more checks. Names and existence are
 * syntax; equivalence is semantics. This parser does not verify:
 *
 *   - ALTER TABLE ... ENABLE / FORCE ROW LEVEL SECURITY beyond the enable flag
 *   - REVOKE state in general, or column-level grants
 *   - constraints added or changed through ALTER TABLE
 *   - function bodies, or EXECUTE grants on them
 *   - object ownership
 *   - policy USING / WITH CHECK expressions
 *   - which function a trigger fires, or when
 *   - index definitions: the columns, order, uniqueness or predicate
 *
 * A policy with the right name and an inverted USING clause passes every check
 * here and grants the world read access. So no status derived from this parser
 * authorizes writing a migration out of the history, and nothing in this file
 * constructs a repair command. A person reads the evidence and decides.
 */

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

  /*
   * Grants as table:role. public and anon are emphatically NOT filtered out:
   * this repository's tables are secured by revoking from exactly those roles
   * and granting narrowly back, so dropping them from the evidence discards the
   * half that matters. An earlier version of this file filtered them.
   */
  const grants = unique(
    [...statements.matchAll(/grant\s+[^;]*?\s+on\s+(?:table\s+)?public\.([a-z0-9_]+)\s+to\s+([a-z0-9_, ]+)/gi)]
      .flatMap((match) => match[2].split(',').map((role) => `${match[1].toLowerCase()}:${role.trim().toLowerCase()}`)),
  );

  /*
   * Revokes, as table:role that should end up holding no table privilege.
   *
   * A role the same migration grants back to is excluded, because the
   * established pattern here is "revoke all from public, anon, authenticated"
   * followed by a narrow grant to authenticated - and the end state of that
   * role is granted, not revoked. Checking the revoke alone would report every
   * correctly-secured table in this repository as missing one.
   *
   * Weaker than it looks even so: it cannot see column-level grants, so it is
   * reported as evidence and labelled as such.
   */
  const granted = new Set(grants);
  const revokes = unique(
    [...statements.matchAll(/revoke\s+[^;]*?\s+on\s+(?:table\s+)?public\.([a-z0-9_]+)\s+from\s+([a-z0-9_, ]+)/gi)]
      .flatMap((match) => match[2].split(',').map((role) => `${match[1].toLowerCase()}:${role.trim().toLowerCase()}`)),
  ).filter((entry) => !granted.has(entry));

  /* Whether the migration turns row level security on for a table. The flag
     itself is checkable; what the policies then say is not. */
  const rlsEnabled = unique(
    [...statements.matchAll(/alter table (?:only )?public\.([a-z0-9_]+) enable row level security/gi)].map((m) => m[1].toLowerCase()),
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

  return {
    tables, views, functions, policies, triggers, indexes,
    grants, revokes, rlsEnabled, securityDefiners, pinnedSearchPath,
  };
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
 * What this audit is able to look for at all. Everything outside this list -
 * see the header - is simply not examined, which is why a full house here is
 * evidence rather than proof.
 */
export const CHECKED_KINDS = [
  'tables', 'views', 'functions', 'policies', 'triggers',
  'indexes', 'grants', 'revokes', 'rlsEnabled', 'securityDefiners', 'pinnedSearchPath',
];

/*
 * What this audit does NOT examine. Printed alongside every result, so a
 * "present" column is never mistaken for a clean bill of health.
 */
export const NOT_VERIFIED = [
  'policy USING / WITH CHECK expressions',
  'function bodies and EXECUTE grants',
  'column-level grants',
  'REVOKE state beyond a role holding no table privilege',
  'constraints added or changed by ALTER TABLE',
  'FORCE ROW LEVEL SECURITY',
  'object ownership',
  'which function a trigger fires, and when',
  'index columns, order, uniqueness and predicates',
];

/* Checked against the live schema. A label carries its own caveat where the
   check is weaker than its name suggests. */
function checkArtifacts(declared, live) {
  const present = [];
  const missing = [];
  const record = (ok, label) => (ok ? present : missing).push(label);

  for (const name of declared.tables) record(live.relations.has(name), `table ${name}`);
  for (const name of declared.views) record(live.relations.has(name), `view ${name}`);
  for (const name of declared.functions) record(live.functions.has(name), `function ${name} (name only)`);
  for (const name of declared.policies) record(live.policies.has(name), `policy ${name} (name only)`);
  for (const name of declared.triggers) record(live.triggers.has(name), `trigger ${name} (name only)`);
  for (const name of declared.indexes) record(live.indexes.has(name), `index ${name} (name only)`);
  for (const name of declared.grants) record(live.grants.has(name), `grant ${name}`);
  for (const name of declared.rlsEnabled) record(live.rlsEnabled.has(name), `rls enabled ${name}`);
  /* A revoke is satisfied when the role holds no table-level privilege. This
     cannot see column-level grants, so it is the weakest check here. */
  for (const name of declared.revokes) record(!live.grants.has(name), `revoked ${name} (table level only)`);
  for (const name of declared.securityDefiners) record(live.securityDefiners.has(name), `security definer ${name}`);
  for (const name of declared.pinnedSearchPath) record(live.pinnedSearchPath.has(name), `pinned search_path ${name}`);

  return { present, missing };
}

/* Whether a migration declares anything this audit knows how to look for. */
export function isVerifiable(declared) {
  return CHECKED_KINDS.some((kind) => (declared[kind] ?? []).length > 0);
}

/*
 * The verdict. Every one of these except history_match is a lead for a person,
 * not an instruction.
 *
 *   history_match            the exact version is already recorded; nothing to do
 *   same_name_candidate      a remote entry shares this migration's name under a
 *                            different version; needs manual equivalence review
 *   schema_present_candidate everything this audit can look for is present, which
 *                            suggests it may already be represented and proves
 *                            nothing - see NOT_VERIFIED
 *   partial                  some of its primary objects exist; investigate
 *   absent                   none of them do; clearly pending
 *   unverifiable             it declares nothing this audit can look for
 *
 * There is deliberately no status meaning "proven equivalent", because this
 * parser cannot establish that. An earlier version had one and printed a repair
 * command from it.
 */
export function classify(declared, live, { inHistory, sameNameRemoteVersion } = {}) {
  if (inHistory) return { status: 'history_match', present: [], missing: [] };

  const verifiable = isVerifiable(declared);
  const { present, missing } = verifiable ? checkArtifacts(declared, live) : { present: [], missing: [] };

  /*
   * A shared name is the strongest lead there is and the one that most needs a
   * human, so it wins over the schema reading - which is reported alongside it
   * either way.
   */
  if (sameNameRemoteVersion) {
    return { status: 'same_name_candidate', present, missing, sameNameRemoteVersion };
  }

  if (!verifiable) return { status: 'unverifiable', present: [], missing: [] };

  const primaries = [...declared.tables, ...declared.views, ...declared.functions];
  const presentPrimaries = primaries.filter((name) => live.relations.has(name) || live.functions.has(name));

  if (!missing.length) return { status: 'schema_present_candidate', present, missing };
  if (!primaries.length) return { status: 'partial', present, missing };
  if (!presentPrimaries.length) return { status: 'absent', present, missing };
  return { status: 'partial', present, missing };
}

/*
 * The findings, grouped. Note what this does not return: a repair list.
 *
 * Nothing here decides which versions may be written into the migration
 * history. The only bucket that implies an action is `pending`, and the action
 * is to push normally - which is what a migration that was never applied
 * needs anyway.
 */
export function auditSummary(rows) {
  const byStatus = (status) => rows.filter((row) => row.status === status);
  return {
    historyMatch: byStatus('history_match'),
    sameNameCandidates: byStatus('same_name_candidate'),
    schemaPresentCandidates: byStatus('schema_present_candidate'),
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
