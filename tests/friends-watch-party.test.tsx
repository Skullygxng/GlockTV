import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { tmdbClient, partyPlaybackConfig, makePartyService } from './friends-party-harness';
import friendsCss from '../src/friends.css?raw';

describe('Friends watch parties', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('replaces Channels with a focused Friends lobby', async () => {
    render(<App client={tmdbClient} partyService={makePartyService() as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    expect(screen.queryByRole('button', { name: 'Channels' })).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    expect(await screen.findByRole('heading', { name: /Movie night/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create private room' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Join' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Join room' })).toBeInTheDocument();
  });

  it('creates a room around the full active title and opens audience chat', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    await waitFor(() => expect(tmdbClient.getTitleContext).toHaveBeenCalled());
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    expect(await screen.findByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
    expect(partyService.createRoom).toHaveBeenCalledWith(expect.objectContaining({
      nickname: 'Skully',
      titleId: 1,
      titleName: 'Heat',
      backdropPath: '/heat-backdrop.jpg',
      durationSeconds: 10200,
    }));
    expect(screen.getByRole('textbox', { name: 'Message the room' })).toBeInTheDocument();
    expect(screen.getByTitle('Heat full movie')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Play room' })).not.toBeInTheDocument();
    expect(screen.getByText(/Use the player controls/i)).toBeInTheDocument();
  });

  it('prevents an accidental exit and lets the host return to the same room', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    await screen.findByRole('region', { name: 'Watch party HEAT95' });
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(screen.getByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stay in room' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave room' }));
    await waitFor(() => expect(partyService.leaveRoom).toHaveBeenCalledWith('room-1', 'user-1'));
    const resume = await screen.findByRole('button', { name: 'Resume hosting Heat' });
    fireEvent.click(resume);
    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Skully'));
    expect(await screen.findByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
  });

  it('joins a room code and sends a live message', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Guest'));
    const messageBox = await screen.findByRole('textbox', { name: 'Message the room' });
    fireEvent.change(messageBox, { target: { value: 'Ready?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(partyService.sendMessage).toHaveBeenCalledWith('room-1', 'Guest', 'Ready?'));
    expect(await screen.findByText('Ready?')).toBeInTheDocument();
  });

  it('notifies readers about new chat and jumps back to the latest message', async () => {
    const partyService = makePartyService();
    let onMessage: ((message: { id: string; roomId: string; userId: string; nickname: string; body: string; createdAt: string }) => void) | undefined;
    partyService.subscribe.mockImplementation((_roomId, handlers) => {
      onMessage = handlers.onMessage;
      return () => undefined;
    });
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    const chat = await screen.findByRole('log', { name: 'Chat messages' });
    await waitFor(() => expect(partyService.subscribe).toHaveBeenCalledWith('room-1', expect.any(Object)));
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });
    fireEvent.scroll(chat);
    act(() => onMessage?.({
      id: 'message-2', roomId: 'room-1', userId: 'user-2', nickname: 'Date Night', body: 'Pick the next movie?', createdAt: '2026-08-11T00:02:00.000Z',
    }));
    const jump = await screen.findByRole('button', { name: 'Jump to latest message' });
    expect(jump).toHaveTextContent('1 new');
    expect(jump).toHaveAttribute('title', 'Date Night: Pick the next movie?');
    expect(screen.getByText('Pick the next movie?')).toBeInTheDocument();
    fireEvent.click(jump);
    expect(chat.scrollTop).toBe(900);
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).not.toBeInTheDocument();
  });

  it('keeps a reader in place while unread messages pile up and jumps back on demand', async () => {
    const partyService = makePartyService();
    let onMessage: ((message: { id: string; roomId: string; userId: string; nickname: string; body: string; createdAt: string }) => void) | undefined;
    partyService.subscribe.mockImplementation((_roomId, handlers) => {
      onMessage = handlers.onMessage;
      return () => undefined;
    });
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    const chat = await screen.findByRole('log', { name: 'Chat messages' });
    await waitFor(() => expect(partyService.subscribe).toHaveBeenCalledWith('room-1', expect.any(Object)));
    Object.defineProperties(chat, {
      scrollHeight: { configurable: true, value: 900 },
      clientHeight: { configurable: true, value: 300 },
      scrollTop: { configurable: true, value: 120, writable: true },
    });
    fireEvent.scroll(chat);
    act(() => onMessage?.({
      id: 'message-2', roomId: 'room-1', userId: 'user-2', nickname: 'Date Night', body: 'Grabbing snacks', createdAt: '2026-08-11T00:02:00.000Z',
    }));
    act(() => onMessage?.({
      id: 'message-3', roomId: 'room-1', userId: 'user-3', nickname: 'Rowdy', body: 'Back in two minutes', createdAt: '2026-08-11T00:03:00.000Z',
    }));
    expect(screen.getByText('Grabbing snacks')).toBeInTheDocument();
    expect(screen.getByText('Back in two minutes')).toBeInTheDocument();
    expect(chat.scrollTop).toBe(120);
    const jump = await screen.findByRole('button', { name: 'Jump to latest message' });
    expect(jump).toHaveTextContent('2 new');
    fireEvent.click(jump);
    expect(chat.scrollTop).toBe(900);
    expect(screen.queryByRole('button', { name: 'Jump to latest message' })).not.toBeInTheDocument();
  });

  it('gives the chat message history the flexible space instead of a fixed panel', () => {
    expect(friendsCss).toMatch(/aside\.party-chat \{[^}]*flex-direction: column;/);
    expect(friendsCss).toMatch(/aside\.party-chat > \.party-messages-shell \{[^}]*flex: 1 1 auto;/);
    expect(friendsCss).toContain('height: min(1080px, calc(100svh - 175px))');
    expect(friendsCss).not.toContain('height: 720px');
    expect(friendsCss).toContain('height: 72svh');
  });

  it('waits for an explicit join click when opening an invite link', async () => {
    const partyService = makePartyService();
    sessionStorage.setItem('glocktv-nickname', 'Returning guest');
    window.history.replaceState({}, '', '/?room=heat95');
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('button', { name: 'Join invite' });
    expect(partyService.joinRoom).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your nickname'), { target: { value: 'R' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(partyService.joinRoom).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Your nickname'), { target: { value: 'Returning guest' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join invite' }));
    await waitFor(() => expect(partyService.joinRoom).toHaveBeenCalledWith('HEAT95', 'Returning guest'));
    expect(await screen.findByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
  });

  it('opens a named roster from the audience count', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));
    const roster = screen.getByRole('dialog', { name: 'People in this room' });
    expect(within(roster).getByText('Skully')).toBeInTheDocument();
    expect(within(roster).getByText('Date Night')).toBeInTheDocument();
    expect(within(roster).getByText('Host')).toBeInTheDocument();
  });

  it('lets the host mute and remove a guest from the roster', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Mute Date Night' }));
    await waitFor(() => expect(partyService.setMemberMuted).toHaveBeenCalledWith('room-1', 'user-2', true));
    fireEvent.click(screen.getByRole('button', { name: 'Remove Date Night' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm remove Date Night' }));
    await waitFor(() => expect(partyService.removeMember).toHaveBeenCalledWith('room-1', 'user-2'));
  });

  it('keeps room membership alive and exposes real sync health', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0.4, serverId: 'cinesrc' },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false, isCohost: true, lastSeenAt: new Date().toISOString(), syncStatus: 'drifting', syncOffsetSeconds: -7, serverId: 'backup' },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    await waitFor(() => expect(partyService.heartbeatRoom).toHaveBeenCalledWith('room-1', expect.objectContaining({ syncStatus: expect.any(String) })));
    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));
    const roster = screen.getByRole('dialog', { name: 'People in this room' });
    expect(within(roster).getByText(/Synced/)).toBeInTheDocument();
    expect(within(roster).getByText('7s behind')).toBeInTheDocument();
    expect(within(roster).getByText('Co-host')).toBeInTheDocument();
  });
});
