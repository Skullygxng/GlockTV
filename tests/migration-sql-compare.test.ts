import { describe, expect, it } from 'vitest';
import {
  compareSql,
  compareStatements,
  normalizeRemoteStatements,
  normalizeStatement,
  splitStatements,
} from '../scripts/lib/migration-sql-compare.mjs';
import compareScript from '../scripts/compare-remote-migration-sql.mjs?raw';
import workflow from '../.github/workflows/apply-supabase-migrations.yml?raw';

describe('splitStatements', () => {
  it('does not split inside a dollar-quoted function body', () => {
    const sql = `
      create or replace function public.f() returns trigger language plpgsql as $$
      begin
        new.a := 1;
        new.b := 2;
        return new;
      end; $$;
      grant execute on function public.f() to authenticated;
    `;
    const statements = splitStatements(sql);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('new.a := 1; new.b := 2;');
    expect(statements[1]).toBe('grant execute on function public.f() to authenticated');
  });

  it('handles a tagged dollar quote', () => {
    const statements = splitStatements(`create function f() as $body$ select 1; select 2; $body$; select 3;`);
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain('select 1; select 2;');
  });

  it('does not split on a semicolon inside a string literal', () => {
    const statements = splitStatements(`insert into t values ('a;b'); select 1;`);
    expect(statements).toEqual(["insert into t values ('a;b')", 'select 1']);
  });

  it('keeps an escaped quote inside a literal', () => {
    const statements = splitStatements(`select 'it''s; fine'; select 2;`);
    expect(statements).toEqual([`select 'it''s; fine'`, 'select 2']);
  });

  it('drops line and block comments', () => {
    const statements = splitStatements(`
      -- a leading note; with a semicolon in it
      select 1;
      /* a block
         note; also with one */
      select 2;
    `);
    expect(statements).toEqual(['select 1', 'select 2']);
  });

  it('does not treat a comment marker inside a literal as a comment', () => {
    expect(splitStatements(`select '-- not a comment';`)).toEqual([`select '-- not a comment'`]);
  });

  it('drops empty trailing statements', () => {
    expect(splitStatements('select 1;\n\n')).toEqual(['select 1']);
  });
});

describe('normalizeStatement', () => {
  it('collapses whitespace but preserves case', () => {
    expect(normalizeStatement('create   TABLE\n  public.Foo')).toBe('create TABLE public.Foo');
  });
});

describe('compareStatements', () => {
  it('calls an exact sequence identical', () => {
    expect(compareStatements(['a', 'b'], ['a', 'b']).verdict).toBe('identical');
  });

  it('separates a reordering from a real difference', () => {
    expect(compareStatements(['a', 'b'], ['b', 'a']).verdict).toBe('reordered');
  });

  it('reports what each side has that the other does not', () => {
    const result = compareStatements(['a', 'b'], ['a', 'c']);
    expect(result.verdict).toBe('differs');
    expect(result.onlyLocal).toEqual(['b']);
    expect(result.onlyRemote).toEqual(['c']);
  });

  it('treats a repeated statement as a difference in count, not a set match', () => {
    const result = compareStatements(['a', 'a'], ['a']);
    expect(result.verdict).toBe('differs');
    expect(result.onlyLocal).toEqual(['a']);
  });
});

describe('compareSql', () => {
  it('ignores comment and whitespace differences between the file and the record', () => {
    const local = `
      -- this file explains itself at length
      create table if not exists public.t (id uuid primary key);

      grant select on public.t to authenticated;
    `;
    const recorded = [
      'create table if not exists public.t (id uuid primary key)',
      'grant select on public.t to authenticated',
    ];
    expect(compareSql(local, recorded).verdict).toBe('identical');
  });

  it('catches the difference that motivated this tool - an ON CONFLICT target', () => {
    const local = `insert into public.official_lounge_votes (a) values (1) on conflict (room_id, voter_id) do update set a = 1;`;
    const recorded = [
      'insert into public.official_lounge_votes (a) values (1) on conflict on constraint official_lounge_votes_pkey do update set a = 1',
    ];
    const result = compareSql(local, recorded);
    expect(result.verdict).toBe('differs');
    expect(result.onlyRemote[0]).toContain('on constraint official_lounge_votes_pkey');
  });

  it('does not equate two different string literals by lowercasing them', () => {
    expect(compareSql(`select 'Open';`, ["select 'open'"]).verdict).toBe('differs');
  });

  it('survives a null or missing statements column', () => {
    expect(normalizeRemoteStatements(null)).toEqual([]);
    expect(normalizeRemoteStatements(undefined)).toEqual([]);
  });
});

describe('the comparison script', () => {
  it('sends only a SELECT, through the shared read-only guard', () => {
    expect(compareScript).toContain('assertReadOnly');
    const queries = [...compareScript.matchAll(/await query\(\s*['"`]([^'"`]+)/g)].map((match) => match[1]);
    expect(queries.length).toBeGreaterThan(0);
    for (const sql of queries) expect(sql.trim().toLowerCase().startsWith('select')).toBe(true);
  });

  it('never writes to the database or the migrations directory', () => {
    expect(compareScript).not.toMatch(/\bwriteFileSync\b|\brmSync\b|\bunlinkSync\b/);
    expect(compareScript).not.toMatch(/migration repair|db push/);
  });

  it('prints remote-only SQL in full, because nothing else holds a copy', () => {
    expect(compareScript).toContain('SQL THIS REPOSITORY DOES NOT HAVE');
  });
});

describe('the workflow', () => {
  it('runs the comparison before the push step', () => {
    const compareAt = workflow.indexOf('compare-remote-migration-sql.mjs');
    const pushAt = workflow.indexOf('supabase db push --dry-run');
    expect(compareAt).toBeGreaterThan(-1);
    expect(pushAt).toBeGreaterThan(-1);
    expect(compareAt).toBeLessThan(pushAt);
  });

  it('still applies only when a dry run is explicitly unticked', () => {
    const applyAt = workflow.indexOf('- name: Apply migrations');
    expect(applyAt).toBeGreaterThan(-1);
    expect(workflow.slice(applyAt, applyAt + 200)).toContain('inputs.dry_run == false');
  });
});
