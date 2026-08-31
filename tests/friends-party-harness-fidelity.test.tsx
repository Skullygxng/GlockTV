/*
 * Regressions for the friends-watch-party.b flake.
 *
 * The failure was never a product bug: the fake party service resolved every
 * read to a frozen room, so a background heartbeat or room refresh landing
 * after an optimistic control change silently reverted it, and the next change
 * was then sent with stale values. Whether that landed between two user
 * actions was a scheduling coin flip.
 *
 * These pin the fixture behaviour the component is entitled to assume, and
 * force the exact interleaving that used to break.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { App } from '../src/App';
import { tmdbClient, partyPlaybackConfig, makePartyService, room } from './friends-party-harness';

async function openRoomControls(partyService: ReturnType<typeof makePartyService>) {
  render(<App client={tmdbClient} partyService={partyService as never} partyPlaybackConfig={partyPlaybackConfig} />);
  await screen.findByRole('heading', { name: 'Heat' });
  fireEvent.click(within(screen.getByRole('navigation', { name: 'Primary navigation' })).getByRole('button', { name: 'Friends' }));
  fireEvent.change(await screen.findByLabelText('Your nickname'), { target: { value: 'Skully' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create private room' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Room controls' }));
}

describe('party service fake remembers writes', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
    sessionStorage.clear();
    localStorage.clear();
  });

  it('reads reflect a committed room-controls write', async () => {
    const partyService = makePartyService();
    expect((await partyService.getRoom('room-1')).isLocked).toBe(false);

    await partyService.setRoomControls('room-1', { isLocked: true, slowModeSeconds: 10 });

    expect((await partyService.getRoom('room-1')).isLocked).toBe(true);
    expect((await partyService.getRoom('room-1')).slowModeSeconds).toBe(10);
    expect((await partyService.heartbeatRoom('room-1', {})).isLocked).toBe(true);
    /* The exported fixture is untouched, so each service starts clean. */
    expect(room.isLocked).toBe(false);
    expect((await makePartyService().getRoom('room-1')).isLocked).toBe(false);
  });

  it('reads reflect committed host, server and episode writes', async () => {
    const partyService = makePartyService();
    await partyService.transferHost('room-1', 'user-2');
    await partyService.setRoomServer('room-1', 'othersrc');
    await partyService.updateEpisode('room-1', 2, 5);

    const current = await partyService.getRoom('room-1');
    expect(current.hostId).toBe('user-2');
    expect(current.serverId).toBe('othersrc');
    expect(current.seasonNumber).toBe(2);
    expect(current.episodeNumber).toBe(5);
  });

  it('a room refresh landing after an optimistic lock does not revert it', async () => {
    const partyService = makePartyService();

    /*
     * Hold the first heartbeat open and release it deliberately between the
     * lock and the slow-mode change - the interleaving the flake used to hit
     * by chance. The held call still resolves through the fake's current
     * state, so it carries the committed lock rather than a stale one.
     */
    let releaseHeartbeat: () => void = () => undefined;
    let heartbeats = 0;
    const heartbeatGate = new Promise<void>((resolve) => {
      releaseHeartbeat = resolve;
    });
    const liveRoom = () => partyService.getRoom('room-1');
    partyService.heartbeatRoom.mockImplementation(async () => {
      heartbeats += 1;
      if (heartbeats === 1) await heartbeatGate;
      return liveRoom();
    });

    await openRoomControls(partyService);
    fireEvent.click(screen.getByRole('button', { name: 'Lock new joins' }));
    await waitFor(() => expect(partyService.setRoomControls).toHaveBeenCalledWith('room-1', { isLocked: true, slowModeSeconds: 0 }));
    await screen.findByRole('button', { name: 'Unlock new joins' });

    releaseHeartbeat();
    /* Still locked after the refresh lands. */
    await screen.findByRole('button', { name: 'Unlock new joins' });

    fireEvent.change(screen.getByLabelText('Chat slow mode'), { target: { value: '10' } });
    await waitFor(() => expect(partyService.setRoomControls).toHaveBeenCalledTimes(2));
    expect(partyService.setRoomControls.mock.calls[1]).toEqual([
      'room-1',
      { isLocked: true, slowModeSeconds: 10 },
    ]);
    expect(heartbeats).toBeGreaterThan(0);
  });
});
