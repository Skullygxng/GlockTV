/*
 * The security-critical database boundaries, expressed as checks.
 *
 * Every rule this repository relies on lives in PostgreSQL - in a grant, a
 * policy, a trigger. None of it can be executed by the test suite, which reads
 * migration text and can only prove that a rule was *written*. It cannot prove
 * what the project actually did with it: a grant can be missing, over-broad, or
 * changed by hand months later, and every source-level assertion would still
 * pass.
 *
 * So these run against a real project. Nothing here is a unit test; each check
 * asks the database a question whose wrong answer is a privilege escalation.
 *
 * The checks take their clients as arguments rather than constructing them, so
 * the runner can be exercised with fixtures - which is how this file is tested
 * when no project credentials exist.
 */

/* A caller: an apikey, an optional user token, and a label for reporting. */
export function caller(label, apikey, accessToken) {
  return { label, apikey, accessToken: accessToken ?? apikey };
}

export const OK = (detail = '') => ({ ok: true, detail });
export const BAD = (detail) => ({ ok: false, detail });

/* PostgREST refuses in several shapes depending on whether the block is a
   missing grant, a failing policy or an unknown relation. Any non-2xx is a
   refusal; a 2xx is the finding. */
export function refused(response) {
  return response.status < 200 || response.status >= 300;
}

/*
 * A read that returns no rows is not the same as a read that was refused, and
 * for cross-user isolation both are acceptable answers: RLS filters rather than
 * errors, so "B's row is invisible to A" surfaces as an empty result.
 */
export function readBlocked(response, body) {
  if (refused(response)) return true;
  try {
    const parsed = JSON.parse(body);
    return Array.isArray(parsed) && parsed.length === 0;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ billing */

export function billingChecks({ rpc, payloadFor, service, anon, user }) {
  return [
    {
      id: 'billing.service-role-executes',
      name: 'service-role can execute apply_billing_provider_state',
      async run() {
        const response = await rpc(service, payloadFor());
        if (refused(response.response)) return BAD(`HTTP ${response.response.status} ${response.body.slice(0, 160)}`);
        /* A 2xx that did not apply would mean the function ran but the write
           path is broken, which is still a failure of this check. */
        if (!response.body.includes('applied')) return BAD(`ran but returned ${response.body.slice(0, 120)}`);
        return OK(`HTTP ${response.response.status}`);
      },
    },
    {
      id: 'billing.anon-refused',
      name: 'publishable key signed out cannot execute it',
      async run() {
        const { response, body } = await rpc(anon, payloadFor());
        return refused(response) ? OK(`HTTP ${response.status}`) : BAD(`EXECUTED: HTTP ${response.status} ${body.slice(0, 160)}`);
      },
    },
    {
      id: 'billing.user-refused',
      name: 'ordinary authenticated user cannot execute it',
      async run() {
        const { response, body } = await rpc(user, payloadFor());
        return refused(response) ? OK(`HTTP ${response.status}`) : BAD(`EXECUTED: HTTP ${response.status} ${body.slice(0, 160)}`);
      },
    },
  ];
}

/* ----------------------------------------------------------- watch progress */

export function watchProgressChecks({ rest, userA, userB, anonymous, progressRow }) {
  const own = () => progressRow({ mediaId: 550 });
  const key = 'media_type=eq.movie&media_id=eq.550&season_number=eq.0&episode_number=eq.0';

  return [
    {
      id: 'progress.owner-writes',
      name: 'a protected account can create its own progress',
      async run() {
        const { response, body } = await rest(userA, 'POST', 'watch_progress', own());
        return refused(response) ? BAD(`HTTP ${response.status} ${body.slice(0, 160)}`) : OK(`HTTP ${response.status}`);
      },
    },
    {
      id: 'progress.owner-reads',
      name: 'and read it back',
      async run() {
        const { response, body } = await rest(userA, 'GET', `watch_progress?${key}`);
        if (refused(response)) return BAD(`HTTP ${response.status}`);
        const rows = JSON.parse(body || '[]');
        return rows.length === 1 ? OK('1 row') : BAD(`expected its own row, got ${rows.length}`);
      },
    },
    {
      id: 'progress.owner-updates',
      name: 'and update it',
      async run() {
        const { response, body } = await rest(userA, 'PATCH', `watch_progress?${key}`, { position_seconds: 1234 });
        return refused(response) ? BAD(`HTTP ${response.status} ${body.slice(0, 160)}`) : OK(`HTTP ${response.status}`);
      },
    },
    {
      id: 'progress.database-stamps-updated-at',
      name: 'the database, not the browser, sets updated_at',
      async run() {
        /*
         * The defect this exists for: reconciliation treats cloud updated_at as
         * database time, so a browser that can write it can forge recency and
         * then win every comparison forever. The write above must have produced
         * a stamp of its own, near now - not the epoch, and not whatever a
         * client asked for.
         */
        const { response, body } = await rest(userA, 'GET', `watch_progress?${key}&select=updated_at,observed_at`);
        if (refused(response)) return BAD(`HTTP ${response.status}`);
        const row = JSON.parse(body || '[]')[0];
        if (!row) return BAD('no row to inspect');
        const drift = Math.abs(Date.now() - Date.parse(row.updated_at));
        return drift < 10 * 60 * 1000
          ? OK(`updated_at within ${Math.round(drift / 1000)}s of now`)
          : BAD(`updated_at is ${row.updated_at}, ${Math.round(drift / 1000)}s from now`);
      },
    },
    {
      id: 'progress.forged-timestamp-rejected',
      name: 'a forged future updated_at cannot be established',
      async run() {
        const forged = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
        const { response } = await rest(userA, 'PATCH', `watch_progress?${key}`, {
          position_seconds: 99,
          updated_at: forged,
        });

        /*
         * Either answer is correct and they are different mechanisms: the
         * column grant refuses the request outright, and the trigger overwrites
         * it if a request ever gets through. What must never happen is the
         * forged value being readable afterwards.
         */
        const { body } = await rest(userA, 'GET', `watch_progress?${key}&select=updated_at`);
        const stored = JSON.parse(body || '[]')[0]?.updated_at;
        if (stored && Date.parse(stored) > Date.now() + 60 * 60 * 1000) {
          return BAD(`forged timestamp was stored: ${stored}`);
        }
        return OK(refused(response) ? `refused, HTTP ${response.status}` : 'accepted but overwritten by the database');
      },
    },
    {
      id: 'progress.cross-user-read',
      name: "one account cannot read another's progress",
      async run() {
        const { response, body } = await rest(userB, 'GET', `watch_progress?${key}`);
        return readBlocked(response, body)
          ? OK(refused(response) ? `HTTP ${response.status}` : 'filtered to zero rows')
          : BAD(`READ ANOTHER USER: ${body.slice(0, 160)}`);
      },
    },
    {
      id: 'progress.cross-user-insert',
      name: "one account cannot insert progress for another",
      async run() {
        const { response, body } = await rest(userB, 'POST', 'watch_progress', progressRow({ mediaId: 551, forUser: 'A' }));
        return refused(response) ? OK(`HTTP ${response.status}`) : BAD(`INSERTED FOR ANOTHER USER: ${body.slice(0, 160)}`);
      },
    },
    {
      id: 'progress.cross-user-update',
      name: "one account cannot update another's progress",
      async run() {
        const { response } = await rest(userB, 'PATCH', `watch_progress?${key}`, { position_seconds: 1 });
        /* RLS filters rather than errors, so a 2xx affecting zero rows is a
           pass. Re-read as the owner to be sure nothing moved. */
        const { body } = await rest(userA, 'GET', `watch_progress?${key}&select=position_seconds`);
        const position = JSON.parse(body || '[]')[0]?.position_seconds;
        return position !== 1
          ? OK(refused(response) ? `HTTP ${response.status}` : `no rows affected, owner still at ${position}`)
          : BAD("another user's update landed");
      },
    },
    {
      id: 'progress.cross-user-delete',
      name: "one account cannot delete another's progress",
      async run() {
        await rest(userB, 'DELETE', `watch_progress?${key}`);
        const { body } = await rest(userA, 'GET', `watch_progress?${key}`);
        return JSON.parse(body || '[]').length === 1 ? OK('row survived') : BAD("another user's delete landed");
      },
    },
    {
      id: 'progress.anonymous-insert-refused',
      name: 'an anonymous session cannot write cloud progress',
      async run() {
        if (!anonymous) return BAD('no anonymous session available; enable anonymous sign-ins on the project');
        const { response, body } = await rest(anonymous, 'POST', 'watch_progress', progressRow({ mediaId: 552, forUser: 'anon' }));
        return refused(response) ? OK(`HTTP ${response.status}`) : BAD(`ANONYMOUS WROTE CLOUD PROGRESS: ${body.slice(0, 160)}`);
      },
    },
    {
      id: 'progress.owner-deletes',
      name: 'an account can forget its own progress',
      async run() {
        const { response } = await rest(userA, 'DELETE', `watch_progress?${key}`);
        if (refused(response)) return BAD(`HTTP ${response.status}`);
        const { body } = await rest(userA, 'GET', `watch_progress?${key}`);
        return JSON.parse(body || '[]').length === 0 ? OK('removed') : BAD('row survived its owner deleting it');
      },
    },
  ];
}

/* ------------------------------------------------------------------ support */

export function supportChecks({ rest, userA, userB, staff, state }) {
  return [
    {
      id: 'support.customer-opens-ticket',
      name: 'a customer can open a ticket',
      async run() {
        const { response, body } = await rest(userA, 'POST', 'support_tickets?select=id,status', {
          user_id: state.userAId, category: 'billing', subject: 'verifier fixture',
        }, { Prefer: 'return=representation' });
        if (refused(response)) return BAD(`HTTP ${response.status} ${body.slice(0, 160)}`);
        state.ticketId = JSON.parse(body)[0]?.id;
        return state.ticketId ? OK(`ticket ${state.ticketId}`) : BAD('no ticket id returned');
      },
    },
    {
      id: 'support.customer-reads-own',
      name: 'and read it back',
      async run() {
        const { response, body } = await rest(userA, 'GET', `support_tickets?id=eq.${state.ticketId}`);
        if (refused(response)) return BAD(`HTTP ${response.status}`);
        return JSON.parse(body || '[]').length === 1 ? OK('1 row') : BAD('own ticket not visible');
      },
    },
    {
      id: 'support.customer-reply-is-customer',
      name: "an ordinary customer's reply is stored as a customer message",
      async run() {
        /*
         * author_role is sent as 'staff' on purpose. The trigger derives it from
         * staff membership, so this proves the payload is not believed - which
         * is the whole reason a reply can be rendered as official.
         */
        const { response, body } = await rest(userA, 'POST', 'support_messages?select=id,author_role', {
          ticket_id: state.ticketId, author_id: state.userAId, author_role: 'staff', body: 'verifier fixture reply',
        }, { Prefer: 'return=representation' });
        if (refused(response)) return BAD(`HTTP ${response.status} ${body.slice(0, 160)}`);
        const stored = JSON.parse(body)[0];
        state.customerMessageId = stored?.id;
        return stored?.author_role === 'customer'
          ? OK("claimed 'staff', stored as 'customer'")
          : BAD(`CUSTOMER SPOKE AS ${stored?.author_role}`);
      },
    },
    {
      id: 'support.staff-reply-is-staff',
      name: "a trusted staff member's reply is stored as staff",
      async run() {
        if (!staff) return BAD('no staff fixture available');
        const { response, body } = await rest(staff, 'POST', 'support_messages?select=author_role', {
          ticket_id: state.ticketId, author_id: state.staffId, body: 'verifier fixture staff reply',
        }, { Prefer: 'return=representation' });
        if (refused(response)) return BAD(`HTTP ${response.status} ${body.slice(0, 160)}`);
        const stored = JSON.parse(body)[0];
        return stored?.author_role === 'staff'
          ? OK('stored as staff')
          : BAD(`staff reply stored as ${stored?.author_role}`);
      },
    },
    {
      id: 'support.customer-cannot-set-status',
      name: 'a customer cannot change ticket status',
      async run() {
        const { response } = await rest(userA, 'PATCH', `support_tickets?id=eq.${state.ticketId}`, { status: 'resolved' });
        const { body } = await rest(userA, 'GET', `support_tickets?id=eq.${state.ticketId}&select=status`);
        const status = JSON.parse(body || '[]')[0]?.status;
        return status !== 'resolved'
          ? OK(refused(response) ? `HTTP ${response.status}` : `no rows affected, still ${status}`)
          : BAD('CUSTOMER RESOLVED THEIR OWN TICKET');
      },
    },
    {
      id: 'support.customer-cannot-edit-transcript',
      name: 'a customer cannot edit or delete the transcript',
      async run() {
        const target = `support_messages?id=eq.${state.customerMessageId}`;
        const { response: patched } = await rest(userA, 'PATCH', target, { body: 'rewritten' });
        const { response: deleted } = await rest(userA, 'DELETE', target);
        const { body } = await rest(userA, 'GET', `${target}&select=body`);
        const stored = JSON.parse(body || '[]')[0];
        if (!stored) return BAD('MESSAGE WAS DELETED BY ITS AUTHOR');
        return stored.body === 'verifier fixture reply'
          ? OK(`edit HTTP ${patched.status}, delete HTTP ${deleted.status}, transcript intact`)
          : BAD('MESSAGE WAS REWRITTEN');
      },
    },
    {
      id: 'support.cross-user-ticket-read',
      name: "one customer cannot read another's ticket",
      async run() {
        const { response, body } = await rest(userB, 'GET', `support_tickets?id=eq.${state.ticketId}`);
        return readBlocked(response, body)
          ? OK(refused(response) ? `HTTP ${response.status}` : 'filtered to zero rows')
          : BAD(`READ ANOTHER CUSTOMER'S TICKET: ${body.slice(0, 160)}`);
      },
    },
    {
      id: 'support.cross-user-message-read',
      name: "one customer cannot read another's messages",
      async run() {
        const { response, body } = await rest(userB, 'GET', `support_messages?ticket_id=eq.${state.ticketId}`);
        return readBlocked(response, body)
          ? OK(refused(response) ? `HTTP ${response.status}` : 'filtered to zero rows')
          : BAD(`READ ANOTHER CUSTOMER'S MESSAGES: ${body.slice(0, 160)}`);
      },
    },
    {
      id: 'support.staff-table-unreadable',
      name: 'a customer cannot read staff_members',
      async run() {
        const { response, body } = await rest(userA, 'GET', 'staff_members');
        return readBlocked(response, body)
          ? OK(refused(response) ? `HTTP ${response.status}` : 'filtered to zero rows')
          : BAD(`STAFF TABLE READABLE: ${body.slice(0, 160)}`);
      },
    },
    {
      id: 'support.staff-table-unwritable',
      name: 'a customer cannot make themselves staff',
      async run() {
        const { response, body } = await rest(userA, 'POST', 'staff_members', {
          user_id: state.userAId, role: 'admin',
        });
        if (!refused(response)) return BAD(`SELF-PROMOTED TO STAFF: ${body.slice(0, 160)}`);

        /* And the write must not have landed even if the response was odd. */
        const { body: after } = await rest(staff ?? userA, 'GET', `staff_members?user_id=eq.${state.userAId}`);
        let rows = [];
        try { rows = JSON.parse(after || '[]'); } catch { rows = []; }
        return Array.isArray(rows) && rows.length === 0
          ? OK(`HTTP ${response.status}`)
          : BAD('customer appears in staff_members');
      },
    },
  ];
}
