import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import { encodeLoungeVote } from '../src/lib/lounge';
import { item, matrix, tmdbClient, partyPlaybackConfig, makePartyService, publicRoom } from './friends-party-harness';

function officialRoom(overrides: Record<string, unknown> = {}) {
  return {
    ...publicRoom,
    playbackState: 'paused' as const,
    playbackPosition: 0,
    playbackUpdatedAt: new Date(Date.now() - 90_000).toISOString(),
    ...overrides,
  };
}

function recentChat(minutesAgo: number, extra = 0) {
  return new Date(Date.now() - minutesAgo * 60_000 - extra).toISOString();
}

describe('Friends invite card and official lounge wiring', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it('keeps private-room chat intact and pins copy/share invite for the current room', async () => {
    const partyService = makePartyService();
    const oldChat = {
      id: 'old-private',
      roomId: 'room-1',
      userId: 'user-2',
      nickname: 'Date Night',
      body: 'old private hello',
      createdAt: '2026-08-26T12:00:00.000Z',
    };
    partyService.getMessages.mockResolvedValue([oldChat]);
    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));

    expect(await screen.findByText('old private hello')).toBeInTheDocument();
    const invite = await screen.findByRole('region', { name: 'Pinned room invite' });
    expect(within(invite).getByText('HEAT95')).toBeInTheDocument();
    fireEvent.click(within(invite).getByRole('button', { name: 'Copy invite' }));
    const writeText = vi.mocked(navigator.clipboard.writeText);
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(String(writeText.mock.calls.at(-1)?.[0])).toContain('room=HEAT95');
    fireEvent.click(within(invite).getByRole('button', { name: 'Share invite' }));
    expect(partyService.applyOfficialLoungeTitle).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Lounge next up ballot' })).not.toBeInTheDocument();
  });

  it('filters official lounge history, hides vote markers, and replaces a user vote', async () => {
    const partyService = makePartyService();
    const lounge = officialRoom();
    const se7en = { ...item, id: 807, title: 'Se7en' };
    vi.mocked(tmdbClient.getTrending).mockResolvedValue([item, matrix, se7en]);
    partyService.joinRoom.mockResolvedValue(lounge);
    partyService.getRoom.mockResolvedValue(lounge);
    partyService.heartbeatRoom.mockResolvedValue(lounge);
    partyService.getMessages.mockResolvedValue([
      { id: 'old', roomId: 'public-1', userId: 'user-2', nickname: 'A', body: 'old lounge hello', createdAt: recentChat(50) },
      { id: 'vote', roomId: 'public-1', userId: 'user-2', nickname: 'A', body: encodeLoungeVote(matrix), createdAt: recentChat(1, 20_000) },
      { id: 'fresh', roomId: 'public-1', userId: 'user-2', nickname: 'A', body: 'fresh lounge hello', createdAt: recentChat(1) },
    ]);
    partyService.sendMessage.mockImplementation(async (_roomId: string, nickname: string, body: string) => ({
      id: `vote-${body}`,
      roomId: 'public-1',
      userId: 'user-1',
      nickname,
      body,
      createdAt: new Date().toISOString(),
    }));

    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Join room' }));

    expect(await screen.findByText('fresh lounge hello')).toBeInTheDocument();
    expect(screen.queryByText('old lounge hello')).not.toBeInTheDocument();
    expect(screen.queryByText(encodeLoungeVote(matrix))).not.toBeInTheDocument();

    const ballot = await screen.findByRole('region', { name: 'Lounge next up ballot' });
    fireEvent.click(within(ballot).getByRole('button', { name: 'Vote for The Matrix' }));
    await waitFor(() => expect(partyService.sendMessage).toHaveBeenCalledWith('public-1', 'Guest', encodeLoungeVote(matrix)));
    fireEvent.click(within(ballot).getByRole('button', { name: 'Vote for Se7en' }));
    await waitFor(() => expect(partyService.sendMessage).toHaveBeenCalledWith('public-1', 'Guest', encodeLoungeVote(se7en)));
    const voteBodies = partyService.sendMessage.mock.calls.map((call) => String(call[2])).filter((body) => body.includes('VOTE|'));
    expect(voteBodies).toEqual([encodeLoungeVote(matrix), encodeLoungeVote(se7en)]);
    expect(screen.queryByText(encodeLoungeVote(matrix))).not.toBeInTheDocument();
    expect(screen.queryByText(encodeLoungeVote(se7en))).not.toBeInTheDocument();
    expect(within(ballot).getByText('Your vote')).toBeInTheDocument();
  });

  it('rotates the official lounge through applyOfficialLoungeTitle instead of host title updates', async () => {
    const partyService = makePartyService();
    const lounge = officialRoom({
      playbackState: 'playing',
      playbackPosition: 0,
      durationSeconds: 120,
      playbackUpdatedAt: new Date(Date.now() - 130_000).toISOString(),
    });
    vi.mocked(tmdbClient.getTrending).mockResolvedValue([item, matrix]);
    vi.mocked(tmdbClient.getTitleContext).mockImplementation(async (media) => ({
      trailer: { key: media.id === 603 ? 'matrix-trailer' : 'heat-trailer', site: 'YouTube', type: 'Trailer', official: true },
      providers: null,
      providerLink: null,
      details: media.id === 603 ? matrix : item,
    }));
    partyService.joinRoom.mockResolvedValue(lounge);
    partyService.getRoom.mockResolvedValue(lounge);
    partyService.heartbeatRoom.mockResolvedValue(lounge);
    partyService.applyOfficialLoungeTitle.mockResolvedValue({ ...lounge, titleId: 603, titleName: 'The Matrix' });

    render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
    await screen.findByRole('heading', { name: 'Heat' });
    fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
    fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Guest' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Join room' }));

    await waitFor(() => expect(partyService.applyOfficialLoungeTitle).toHaveBeenCalled());
    expect(partyService.updateTitle).not.toHaveBeenCalled();
    expect(partyService.applyOfficialLoungeTitle.mock.calls[0][0]).toBe('public-1');
    expect(partyService.applyOfficialLoungeTitle.mock.calls[0][1]).toEqual(expect.objectContaining({
      titleId: 603,
      titleName: 'The Matrix',
    }));
  });
});
