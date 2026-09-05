/*
 * Comparing a local migration file against the SQL a project actually ran.
 *
 * The audit next door reads what a migration *declares* - names of tables,
 * policies, functions - and is explicit that this is syntax, not semantics: a
 * policy with the right name and an inverted USING clause passes every check it
 * makes. That gap is why it refuses to authorize a repair.
 *
 * This closes the gap from the other side. Supabase records the statements it
 * executed in supabase_migrations.schema_migrations.statements, so the question
 * "is this local file what production ran?" has a real answer rather than an
 * inference from names. Where the text agrees, renaming a local file to the
 * version production recorded is bookkeeping. Where it disagrees, production is
 * the authority and the difference has to be read by a person.
 *
 * Nothing here talks to a database or writes a file. It takes two strings and
 * says how they differ.
 */

/*
 * Postgres statement splitting, which cannot be `sql.split(';')`: every
 * function body in this repository is dollar-quoted and full of semicolons.
 * Tracks single quotes, dollar-quoted strings with arbitrary tags, and both
 * comment forms, and splits only at top level.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = '';
  let index = 0;

  while (index < sql.length) {
    const rest = sql.slice(index);

    // Line comment: drop through end of line.
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', index);
      index = end === -1 ? sql.length : end + 1;
      current += ' ';
      continue;
    }

    // Block comment: drop through the terminator.
    if (rest.startsWith('/*')) {
      const end = sql.indexOf('*/', index + 2);
      index = end === -1 ? sql.length : end + 2;
      current += ' ';
      continue;
    }

    // Single-quoted literal, including the '' escape. Kept verbatim: the
    // contents are data, and normalizing them would hide real differences.
    if (rest.startsWith("'")) {
      let cursor = index + 1;
      while (cursor < sql.length) {
        if (sql[cursor] === "'" && sql[cursor + 1] === "'") { cursor += 2; continue; }
        if (sql[cursor] === "'") { cursor += 1; break; }
        cursor += 1;
      }
      current += sql.slice(index, cursor);
      index = cursor;
      continue;
    }

    // Dollar-quoted body, tag and all.
    const dollar = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, index + tag.length);
      const stop = end === -1 ? sql.length : end + tag.length;
      current += sql.slice(index, stop);
      index = stop;
      continue;
    }

    if (sql[index] === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += sql[index];
    index += 1;
  }

  statements.push(current);
  return statements.map(normalizeStatement).filter((statement) => statement.length > 0);
}

/*
 * Whitespace is the only thing normalized away. Case is NOT: identifiers and
 * keywords are case-insensitive to Postgres, but string literals are not, and
 * lowercasing everything would quietly equate two different default values.
 * A pair that differs only in keyword case is reported as differing and read by
 * a person, which is the safe direction to be wrong in.
 */
export function normalizeStatement(statement) {
  return statement.replace(/\s+/g, ' ').trim();
}

/*
 * What the project stored, rebuilt into something comparable. The column is
 * text[] - one entry per statement, without separators - so the same
 * normalization is applied and nothing is inferred about the original layout.
 */
export function normalizeRemoteStatements(statements) {
  const entries = Array.isArray(statements) ? statements : [];
  return entries.flatMap((entry) => splitStatements(String(entry)));
}

/*
 * The comparison itself. `identical` means every statement matched in order.
 * `reordered` means the same multiset arrived in a different sequence, which is
 * worth separating because a reordered DDL run is not always an equivalent one.
 * Anything else is `differs`, and the caller shows the person what.
 */
export function compareStatements(localStatements, remoteStatements) {
  const sameOrder =
    localStatements.length === remoteStatements.length &&
    localStatements.every((statement, position) => statement === remoteStatements[position]);

  if (sameOrder) {
    return { verdict: 'identical', onlyLocal: [], onlyRemote: [] };
  }

  const onlyLocal = difference(localStatements, remoteStatements);
  const onlyRemote = difference(remoteStatements, localStatements);

  if (onlyLocal.length === 0 && onlyRemote.length === 0) {
    return { verdict: 'reordered', onlyLocal: [], onlyRemote: [] };
  }

  return { verdict: 'differs', onlyLocal, onlyRemote };
}

/* Multiset difference: a statement repeated twice on one side and once on the
   other is a real difference, so counts are tracked rather than sets. */
function difference(from, against) {
  const counts = new Map();
  for (const statement of against) counts.set(statement, (counts.get(statement) ?? 0) + 1);

  const extra = [];
  for (const statement of from) {
    const remaining = counts.get(statement) ?? 0;
    if (remaining > 0) counts.set(statement, remaining - 1);
    else extra.push(statement);
  }
  return extra;
}

export function compareSql(localSql, remoteStatements) {
  return compareStatements(splitStatements(localSql), normalizeRemoteStatements(remoteStatements));
}
