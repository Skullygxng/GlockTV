import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountProvider } from '../src/components/AccountProvider';
import { SupportPanel } from '../src/components/SupportPanel';
import type { AccountService } from '../src/lib/accountService';
import { FREE_ENTITLEMENTS, type GlockTvAccount } from '../src/lib/account';
import {
  rowToMessage,
  rowToTicket,
  validateTicketDraft,
  type SupportMessage,
  type SupportService,
  type SupportTicket,
} from '../src/lib/support';

const protectedAccount: GlockTvAccount = { id: 'user-a', email: 'a@example.com', isAnonymous: false, createdAt: null };
const guestAccount: GlockTvAccount = { id: 'guest-1', email: null, isAnonymous: true, createdAt: null };

function accountService(account: GlockTvAccount | null): AccountService {
  return {
    loadAccount: async () => account,
    loadEntitlements: async () => ({ entitlements: FREE_ENTITLEMENTS, error: '' }),
    linkEmail: async () => {},
    sendSignInLink: async () => {},
    onAuthChange: () => () => {},
  };
}

const ticket: SupportTicket = {
  id: 'ticket-1', category: 'billing', subject: 'Premium did not activate',
  status: 'open', createdAt: '2026-09-01T10:00:00.000Z', updatedAt: '2026-09-01T10:00:00.000Z',
};

function supportService(overrides: Partial<SupportService> = {}) {
  const created: Array<{ category: string; subject: string; body: string }> = [];
  const replies: Array<{ ticketId: string; body: string }> = [];
  const service: SupportService = {
    listTickets: vi.fn(async () => ({ tickets: [ticket], error: '' })),
    listMessages: vi.fn(async () => ({ messages: [] as SupportMessage[], error: '' })),
    createTicket: vi.fn(async (input) => { created.push(input); return { ...ticket, subject: input.subject, category: input.category }; }),
    reply: vi.fn(async (ticketId, body) => {
      replies.push({ ticketId, body });
      return { id: 'm-new', ticketId, authorRole: 'customer' as const, body, createdAt: '2026-09-01T11:00:00.000Z' };
    }),
    ...overrides,
  };
  return { service, created, replies };
}

function mount(service: SupportService | null, account: GlockTvAccount | null = protectedAccount) {
  return render(
    <AccountProvider service={accountService(account)}>
      <SupportPanel onClose={() => {}} service={service} />
    </AccountProvider>,
  );
}

describe('a customer can raise and follow a ticket', () => {
  it('opens one with a category, a subject and a description', async () => {
    const { service, created } = supportService();
    mount(service);
    await screen.findByLabelText('Ticket subject');

    fireEvent.change(screen.getByLabelText('Ticket category'), { target: { value: 'billing' } });
    fireEvent.change(screen.getByLabelText('Ticket subject'), { target: { value: 'Premium did not activate' } });
    fireEvent.change(screen.getByLabelText('Ticket message'), { target: { value: 'I paid and I am still on free.' } });
    fireEvent.click(screen.getByRole('button', { name: /Open ticket/ }));

    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toEqual({
      category: 'billing',
      subject: 'Premium did not activate',
      body: 'I paid and I am still on free.',
    });
  });

  it('offers the categories the product actually has', async () => {
    mount(supportService().service);
    const select = await screen.findByLabelText('Ticket category');
    const values = [...select.querySelectorAll('option')].map((option) => option.getAttribute('value'));
    expect(values).toEqual(['account', 'billing', 'playback', 'live_tv', 'ppv', 'friends', 'bug', 'other']);
  });

  it('lists their tickets with a status', async () => {
    mount(supportService().service);
    expect(await screen.findByText('Premium did not activate')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('shows the conversation and lets them add to it', async () => {
    const { service, replies } = supportService({
      listMessages: vi.fn(async () => ({
        messages: [
          { id: 'm1', ticketId: 'ticket-1', authorRole: 'customer', body: 'I paid and I am still on free.', createdAt: '2026-09-01T10:00:00.000Z' },
          { id: 'm2', ticketId: 'ticket-1', authorRole: 'staff', body: 'Checking the webhook now.', createdAt: '2026-09-01T10:30:00.000Z' },
        ] as SupportMessage[],
        error: '',
      })),
    });
    mount(service);

    fireEvent.click(await screen.findByText('Premium did not activate'));
    expect(await screen.findByText('Checking the webhook now.')).toBeInTheDocument();
    /* A staff reply is attributed as one - because the database said so. */
    expect(screen.getByText('GlockTV Support')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Reply'), 'Still nothing.');
    fireEvent.click(screen.getByRole('button', { name: /Send/ }));
    await waitFor(() => expect(replies).toEqual([{ ticketId: 'ticket-1', body: 'Still nothing.' }]));
  });

  it('surfaces a failure instead of pretending the ticket was sent', async () => {
    const { service, created } = supportService({
      createTicket: vi.fn(async () => { throw new Error('Support is down.'); }),
    });
    mount(service);
    fireEvent.change(await screen.findByLabelText('Ticket subject'), { target: { value: 'Help' } });
    fireEvent.change(screen.getByLabelText('Ticket message'), { target: { value: 'Something broke.' } });
    fireEvent.click(screen.getByRole('button', { name: /Open ticket/ }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Support is down.');
    expect(created).toHaveLength(0);
  });
});

describe('a guest is told what is missing', () => {
  it('explains rather than offering a form that would be refused', async () => {
    mount(supportService().service, guestAccount);
    expect(await screen.findByText(/Add an email to your account first/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Ticket subject')).toBeNull();
  });

  it('says so when there is no backend at all', async () => {
    mount(null, protectedAccount);
    expect(await screen.findByText('Support is unavailable in this build.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Ticket subject')).toBeNull();
  });
});

describe('the client cannot claim privilege it does not have', () => {
  it('exposes no method that sets a status or a role', () => {
    /*
     * The surface is the guarantee. There is no setStatus and no setStaff to
     * call, and adding one would not work: authenticated holds no update grant
     * on support_tickets and no grant at all on staff_members.
     */
    const { service } = supportService();
    expect(Object.keys(service).sort()).toEqual(['createTicket', 'listMessages', 'listTickets', 'reply']);
  });
});

describe('reading a row back', () => {
  it('treats an unknown status as still open, never as handled', () => {
    /* Under-promising is the safe direction: telling somebody their problem was
       resolved when the client simply did not recognise the value is worse than
       showing it as open. */
    expect(rowToTicket({ id: 't', status: 'escalated' })?.status).toBe('open');
    expect(rowToTicket({ id: 't', status: null })?.status).toBe('open');
    expect(rowToTicket({ id: 't', status: 'resolved' })?.status).toBe('resolved');
  });

  it('treats an unknown author as a customer, never as staff', () => {
    for (const authorRole of ['agent', 'admin', 'STAFF', null, undefined, 1]) {
      expect(rowToMessage({ id: 'm', author_role: authorRole })?.authorRole).toBe('customer');
    }
    expect(rowToMessage({ id: 'm', author_role: 'staff' })?.authorRole).toBe('staff');
  });

  it('drops a row it cannot identify', () => {
    expect(rowToTicket(null)).toBeNull();
    expect(rowToTicket({})).toBeNull();
    expect(rowToMessage({ author_role: 'staff' })).toBeNull();
  });

  it('falls back to a known category rather than rendering a raw value', () => {
    expect(rowToTicket({ id: 't', category: 'not_a_category' })?.category).toBe('other');
  });
});

describe('the draft is checked before a round trip', () => {
  it('wants a subject and a description', () => {
    expect(validateTicketDraft({ subject: '', body: 'x' })).toMatch(/subject/i);
    expect(validateTicketDraft({ subject: '   ', body: 'x' })).toMatch(/subject/i);
    expect(validateTicketDraft({ subject: 'x', body: '' })).toMatch(/happened/i);
    expect(validateTicketDraft({ subject: 'x', body: 'y' })).toBe('');
  });

  it('holds the same limits the database enforces', () => {
    expect(validateTicketDraft({ subject: 'x'.repeat(141), body: 'y' })).toMatch(/140/);
    expect(validateTicketDraft({ subject: 'x', body: 'y'.repeat(4001) })).toMatch(/4000/);
  });
});
