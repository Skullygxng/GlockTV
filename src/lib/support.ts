import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient, type SupabaseConfig } from './supabaseClient';

/*
 * The support surface the browser is allowed.
 *
 * Note what is absent, and note that it is absent by more than convention: no
 * method sets a ticket's status, no method makes anybody staff, and no method
 * chooses who a message is from. Those are not omissions to be filled in from
 * the UI later - `authenticated` holds no update grant on support_tickets and
 * no grant at all on staff_members, and a trigger overwrites the author role on
 * every insert. Adding a method here would not make any of them work.
 */

export type SupportCategory =
  | 'account' | 'billing' | 'playback' | 'live_tv' | 'ppv' | 'friends' | 'bug' | 'other';

export type SupportStatus = 'open' | 'pending' | 'resolved' | 'closed';

/* Labelled once, in the product's own words. */
export const SUPPORT_CATEGORIES: Array<{ value: SupportCategory; label: string }> = [
  { value: 'account', label: 'Account' },
  { value: 'billing', label: 'Billing' },
  { value: 'playback', label: 'Playback' },
  { value: 'live_tv', label: 'Live TV' },
  { value: 'ppv', label: 'PPV' },
  { value: 'friends', label: 'Friends' },
  { value: 'bug', label: 'Bug report' },
  { value: 'other', label: 'Other' },
];

export const SUPPORT_STATUS_LABELS: Record<SupportStatus, string> = {
  open: 'Open',
  pending: 'Awaiting reply',
  resolved: 'Resolved',
  closed: 'Closed',
};

export const SUBJECT_MAX = 140;
export const BODY_MAX = 4000;

export interface SupportTicket {
  id: string;
  category: SupportCategory;
  subject: string;
  status: SupportStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessage {
  id: string;
  ticketId: string;
  /* Derived by the database from staff membership. A payload claiming 'staff'
     is overwritten before the row is written, so this can be rendered as an
     official reply without the client having decided it. */
  authorRole: 'customer' | 'staff';
  body: string;
  createdAt: string;
}

export interface SupportService {
  listTickets(): Promise<{ tickets: SupportTicket[]; error: string }>;
  listMessages(ticketId: string): Promise<{ messages: SupportMessage[]; error: string }>;
  /* Resolves the new ticket, or throws with a message worth showing. */
  createTicket(input: { category: SupportCategory; subject: string; body: string }): Promise<SupportTicket>;
  reply(ticketId: string, body: string): Promise<SupportMessage>;
}

const TICKETS = 'support_tickets';
const MESSAGES = 'support_messages';

/* Trimmed and length-checked here so an obviously bad submission is refused
   before a round trip. The database repeats both checks, and it is the one
   that decides. */
export function validateTicketDraft(input: { subject: string; body: string }): string {
  if (!input.subject.trim()) return 'Give the ticket a subject.';
  if (input.subject.trim().length > SUBJECT_MAX) return `Keep the subject under ${SUBJECT_MAX} characters.`;
  if (!input.body.trim()) return 'Describe what happened.';
  if (input.body.trim().length > BODY_MAX) return `Keep the message under ${BODY_MAX} characters.`;
  return '';
}

interface TicketRow {
  id?: unknown; category?: unknown; subject?: unknown;
  status?: unknown; created_at?: unknown; updated_at?: unknown;
}

const CATEGORIES = new Set(SUPPORT_CATEGORIES.map((entry) => entry.value));
const STATUSES = new Set<SupportStatus>(['open', 'pending', 'resolved', 'closed']);

export function rowToTicket(row: TicketRow | null | undefined): SupportTicket | null {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  const category = typeof row.category === 'string' && CATEGORIES.has(row.category as SupportCategory)
    ? row.category as SupportCategory
    : 'other';
  /*
   * An unrecognised status reads as open, not as resolved. A client that has
   * drifted from the schema should show somebody their ticket is still being
   * dealt with rather than telling them it was handled.
   */
  const status = typeof row.status === 'string' && STATUSES.has(row.status as SupportStatus)
    ? row.status as SupportStatus
    : 'open';
  return {
    id: row.id,
    category,
    subject: typeof row.subject === 'string' ? row.subject : '',
    status,
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
    updatedAt: typeof row.updated_at === 'string' ? row.updated_at : '',
  };
}

interface MessageRow {
  id?: unknown; ticket_id?: unknown; author_role?: unknown;
  body?: unknown; created_at?: unknown;
}

export function rowToMessage(row: MessageRow | null | undefined): SupportMessage | null {
  if (!row || typeof row.id !== 'string' || !row.id) return null;
  return {
    id: row.id,
    ticketId: typeof row.ticket_id === 'string' ? row.ticket_id : '',
    /*
     * Anything but an explicit 'staff' renders as a customer. The database
     * decides this, but a reader that cannot recognise the value should
     * under-attribute rather than present an unknown author as official.
     */
    authorRole: row.author_role === 'staff' ? 'staff' : 'customer',
    body: typeof row.body === 'string' ? row.body : '',
    createdAt: typeof row.created_at === 'string' ? row.created_at : '',
  };
}

export function createSupportService(client: SupabaseClient): SupportService {
  async function currentUserId(): Promise<string | null> {
    const { data } = await client.auth.getSession();
    return data.session?.user?.id ?? null;
  }

  return {
    async listTickets() {
      try {
        if (!(await currentUserId())) return { tickets: [], error: '' };
        /* No user_id filter: RLS returns the caller's own tickets, and a staff
           caller's wider view is the database's decision, not a query's. */
        const { data, error } = await client
          .from(TICKETS)
          .select('id, category, subject, status, created_at, updated_at')
          .order('updated_at', { ascending: false })
          .limit(50);
        if (error) return { tickets: [], error: error.message };
        return {
          tickets: (data ?? []).map((row) => rowToTicket(row as TicketRow))
            .filter((ticket): ticket is SupportTicket => ticket !== null),
          error: '',
        };
      } catch (reason) {
        return { tickets: [], error: reason instanceof Error ? reason.message : 'Support is unavailable right now.' };
      }
    },

    async listMessages(ticketId: string) {
      try {
        const { data, error } = await client
          .from(MESSAGES)
          .select('id, ticket_id, author_role, body, created_at')
          .eq('ticket_id', ticketId)
          .order('created_at', { ascending: true })
          .limit(200);
        if (error) return { messages: [], error: error.message };
        return {
          messages: (data ?? []).map((row) => rowToMessage(row as MessageRow))
            .filter((message): message is SupportMessage => message !== null),
          error: '',
        };
      } catch (reason) {
        return { messages: [], error: reason instanceof Error ? reason.message : 'That conversation could not be loaded.' };
      }
    },

    async createTicket(input) {
      const userId = await currentUserId();
      if (!userId) throw new Error('Sign in to open a ticket.');

      /*
       * status is not sent. The column defaults to open and the insert policy
       * requires it, so naming it here would be the client having an opinion
       * about a value it does not control.
       */
      const { data, error } = await client
        .from(TICKETS)
        .insert({
          user_id: userId,
          category: input.category,
          subject: input.subject.trim(),
        })
        .select('id, category, subject, status, created_at, updated_at')
        .single();
      if (error) throw new Error(error.message);

      const ticket = rowToTicket(data as TicketRow);
      if (!ticket) throw new Error('The ticket could not be opened.');

      /* The first message is the description. If it fails the ticket still
         exists, so the customer is told rather than silently losing it. */
      const { error: messageError } = await client
        .from(MESSAGES)
        .insert({ ticket_id: ticket.id, author_id: userId, body: input.body.trim() });
      if (messageError) throw new Error(messageError.message);

      return ticket;
    },

    async reply(ticketId: string, body: string) {
      const userId = await currentUserId();
      if (!userId) throw new Error('Sign in to reply.');

      /* author_role is deliberately not sent: the database derives it. */
      const { data, error } = await client
        .from(MESSAGES)
        .insert({ ticket_id: ticketId, author_id: userId, body: body.trim() })
        .select('id, ticket_id, author_role, body, created_at')
        .single();
      if (error) throw new Error(error.message);

      const message = rowToMessage(data as MessageRow);
      if (!message) throw new Error('That reply could not be sent.');
      return message;
    },
  };
}

/* Null when Supabase is not configured; the support surface then explains that
   rather than offering a form that cannot submit. */
export function createDefaultSupportService(config: SupabaseConfig = {}): SupportService | null {
  const client = getSupabaseClient(config);
  return client ? createSupportService(client) : null;
}
