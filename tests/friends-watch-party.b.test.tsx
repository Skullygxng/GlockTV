import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { item, matrix, tmdbClient, partyPlaybackConfig, makePartyService } from './friends-party-harness';

describe('Friends watch party moderation and official lounge', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('lets the host promote a co-host and transfer host control', async () => {
    const partyService = makePartyService();
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' },
      { userId: 'user-2', nickname: 'Date Night', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Show people in this room' }));

    fireEvent.click(screen.getByRole('button', { name: 'Make Date Night co-host' }));
    await waitFor(() => expect(partyService.setCohost).toHaveBeenCalledWith('room-1', 'user-2', true));
    fireEvent.click(screen.getByRole('button', { name: 'Transfer host to Date Night' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm transfer host to Date Night' }));
    await waitFor(() => expect(partyService.transferHost).toHaveBeenCalledWith('room-1', 'user-2'));
  });

  it('gives the host room lock, slow mode, chat clear, and ban controls', async () => {
    const partyService = makePartyService();
    partyService.getBannedMembers.mockResolvedValue([{ userId: 'user-9', nickname: 'Removed Guest', createdAt: '2026-08-11T00:02:00.000Z' }]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Room controls' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lock new joins' }));
    await waitFor(() => expect(partyService.setRoomControls).toHaveBeenCalledWith('room-1', { isLocked: true, slowModeSeconds: 0 }));
    /*
     * The service call having been made is not the same as the room being
     * locked on screen. Slow mode is sent alongside the current lock state, so
     * wait for the control itself to say the room is locked before changing it
     * - otherwise this asserts a value the UI has not committed to yet.
     */
    await screen.findByRole('button', { name: 'Unlock new joins' });
    fireEvent.change(screen.getByLabelText('Chat slow mode'), { target: { value: '10' } });
    await waitFor(() => expect(partyService.setRoomControls).toHaveBeenCalledWith('room-1', { isLocked: true, slowModeSeconds: 10 }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear room chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm clear room chat' }));
    await waitFor(() => expect(partyService.clearChat).toHaveBeenCalledWith('room-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Allow Removed Guest to rejoin' }));
    await waitFor(() => expect(partyService.unbanMember).toHaveBeenCalledWith('room-1', 'user-9'));
  });

  it('lets viewers block a member, report abuse, and request a resync', async () => {
    const partyService = makePartyService();
    partyService.ensureUser.mockResolvedValue({ id: 'user-2' });
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'synced', syncOffsetSeconds: 0, serverId: 'cinesrc' },
      { userId: 'user-2', nickname: 'Guest', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false, isCohost: false, lastSeenAt: new Date().toISOString(), syncStatus: 'drifting', syncOffsetSeconds: 8, serverId: 'cinesrc' },
    ]);
    partyService.getMessages.mockResolvedValue([{ id: 'message-2', roomId: 'room-1', userId: 'user-1', nickname: 'Skully', body: 'Spoiler spam', createdAt: '2026-08-11T00:03:00.000Z' }]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Resync me' }));
    expect(screen.getByText(/Resync requested/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Report message from Skully' }));
    await waitFor(() => expect(partyService.reportMessage).toHaveBeenCalledWith('message-2', 'spam'));
    fireEvent.click(screen.getByRole('button', { name: 'Show people in this room' }));
    fireEvent.click(screen.getByRole('button', { name: 'Block Skully' }));
    await waitFor(() => expect(partyService.blockUser).toHaveBeenCalledWith('room-1', 'user-1', true));
  });

  it('disables chat for a guest muted by the host', async () => {
    const partyService = makePartyService();
    partyService.ensureUser.mockResolvedValue({ id: 'user-2' });
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Guest', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: true },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    expect(await screen.findByRole('textbox', { name: 'Message the room' })).toBeDisabled();
    expect(screen.getByText('Muted by host')).toBeInTheDocument();
  });

  it('returns a removed guest to the lobby', async () => {
    const partyService = makePartyService();
    partyService.ensureUser.mockResolvedValue({ id: 'user-2' });
    let onMembersChanged: (() => void) | undefined;
    partyService.subscribe.mockImplementation((_roomId, handlers) => {
      onMembersChanged = handlers.onMembersChanged;
      return () => undefined;
    });
    partyService.getMembers.mockResolvedValue([
      { userId: 'user-1', nickname: 'Skully', joinedAt: '2026-08-11T00:00:00.000Z', isMuted: false },
      { userId: 'user-2', nickname: 'Guest', joinedAt: '2026-08-11T00:01:00.000Z', isMuted: false },
    ]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));
    await screen.findByRole('region', { name: 'Watch party HEAT95' });

    partyService.getMembers.mockResolvedValue([]);
    /*
     * The optional call made a missing subscription a silent no-op: nothing
     * would happen, and the test would fail a second later on the lobby
     * assertion, blaming the removal instead of the handler that was never
     * there. Assert the component actually subscribed, then call it
     * unconditionally so a missing handler fails here and says so.
     */
    await waitFor(() => expect(onMembersChanged).toBeTypeOf('function'));
    onMembersChanged!();

    expect(await screen.findByRole('heading', { name: /Movie night/i })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('The host removed you from this room.');
  });

  it('checks room state on entry when realtime delivery is delayed', async () => {
    const partyService = makePartyService();
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.change(screen.getByLabelText('Room code'), { target: { value: 'heat95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Join' }));

    await waitFor(() => expect(partyService.getRoom).toHaveBeenCalledWith('room-1'));
    expect(partyService.getMembershipStatus).toHaveBeenCalledWith('room-1');
    expect(await screen.findByRole('region', { name: 'Watch party HEAT95' })).toBeInTheDocument();
  });

  it('lets the host search for a different title and changes it for the room', async () => {
    const partyService = makePartyService();
    vi.mocked(tmdbClient.search).mockResolvedValueOnce([matrix]);
    vi.mocked(tmdbClient.getTitleContext).mockImplementationOnce(async () => ({
      trailer: { key: 'heat-trailer', site: 'YouTube', type: 'Trailer', official: true },
      providers: null,
      providerLink: null,
      details: item,
    })).mockImplementationOnce(async () => ({
      trailer: { key: 'matrix-trailer', site: 'YouTube', type: 'Trailer', official: true },
      providers: null,
      providerLink: null,
      details: matrix,
    }));

    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    fireEvent.click(await screen.findByRole('button', { name: 'Change title' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Search watch party titles' }), { target: { value: 'Matrix' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search titles' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Choose The Matrix' }));

    await waitFor(() => expect(partyService.updateTitle).toHaveBeenCalledWith('room-1', {
      titleId: 603,
      mediaType: 'movie',
      titleName: 'The Matrix',
      backdropPath: '/matrix-backdrop.jpg',
      durationSeconds: 10200,
    }));
    expect(await screen.findByRole('heading', { name: 'The Matrix' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave room' }));
    expect(await screen.findByRole('button', { name: 'Resume hosting The Matrix' })).toBeInTheDocument();
  });

  it('explains that the public lounge is synchronized by an automated GlockTV host', async () => {
    const partyService = makePartyService();
    partyService.joinRoom.mockResolvedValueOnce({
      id: 'public-1',
      code: 'GLOCK1',
      hostId: null,
      titleId: 1,
      mediaType: 'movie' as const,
      titleName: 'Heat',
      playbackState: 'paused' as const,
      playbackPosition: 0,
      playbackUpdatedAt: '2026-08-11T00:00:00.000Z',
      seasonNumber: 1,
      episodeNumber: 1,
      backdropPath: '/heat-backdrop.jpg',
      durationSeconds: 10200,
      isPublic: true,
      isOfficial: true,
      audienceCount: 4,
      serverId: 'cinesrc',
      isLocked: false,
      slowModeSeconds: 0,
    });
    partyService.getRoom.mockResolvedValue({
      id: 'public-1',
      code: 'GLOCK1',
      hostId: null,
      titleId: 1,
      mediaType: 'movie' as const,
      titleName: 'Heat',
      playbackState: 'paused' as const,
      playbackPosition: 0,
      playbackUpdatedAt: '2026-08-11T00:00:00.000Z',
      seasonNumber: 1,
      episodeNumber: 1,
      backdropPath: '/heat-backdrop.jpg',
      durationSeconds: 10200,
      isPublic: true,
      isOfficial: true,
      audienceCount: 4,
      serverId: 'cinesrc',
      isLocked: false,
      slowModeSeconds: 0,
    });
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Join room' }));

    expect(await screen.findByText(/Automated GlockTV host/i)).toBeInTheDocument();
  });
});
