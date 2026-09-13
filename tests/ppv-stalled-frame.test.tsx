import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PpvPlayer } from '../src/components/PpvPlayer';
import type { PpvEvent } from '../src/lib/ppv';
import { PPV_SOURCE_LOAD_DEADLINE_MS, emptyIframeDiagnostics } from '../src/lib/ppvDiagnostics';
import ppvCss from '../src/ppv.css?raw';

/*
 * The reported failure: a hosted source is picked, the frame mounts, the
 * provider's page loads - and nothing ever plays. A cross-origin frame cannot
 * tell us that video failed, so the player must not claim it did. What it must
 * not do either is what it used to do: fire onLoad, record the source in
 * documentLoaded, let that short-circuit the load deadline, and leave a silent
 * black rectangle up forever with no message, no retry and no way to reach the
 * official destination.
 *
 * These tests pin the honest middle: no failover (the source may be fine), but
 * a notice that says only what is observable, and an official link that stays
 * reachable while the frame is mounted.
 */

const STALL_NOTICE = /GlockTV cannot see inside a third-party player/i;

function eventWith(overrides: Partial<PpvEvent> = {}): PpvEvent {
  return {
    provider: 'streamed',
    providerEventId: 'garcia-card',
    title: 'Garcia vs Opponent',
    category: 'boxing',
    startsAt: '2026-09-13T22:00:00.000Z',
    status: 'live',
    sourceRefs: [],
    embeds: [
      { provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/garcia/1' },
      { provider: 'sportsrc', source: 'echo', url: 'https://embed.streamapi.cc/sport/garcia/' },
    ],
    ...overrides,
  };
}

function frame(): HTMLIFrameElement | null {
  return document.querySelector('iframe.ppv-player__frame');
}

async function passTheDeadline() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(PPV_SOURCE_LOAD_DEADLINE_MS + 1);
  });
}

describe('PPV frame that loads a document and never plays', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fail over: a loaded document is not evidence that playback failed', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={eventWith()} />);

    const first = frame();
    expect(first?.getAttribute('src')).toBe('https://embed.st/embed/delta/garcia/1');
    await act(async () => {
      fireEvent.load(first as HTMLIFrameElement);
    });
    await passTheDeadline();

    // Still source 1 of 2. Advancing off a stream that may be playing fine
    // would be worse than saying nothing.
    expect(frame()?.getAttribute('src')).toBe('https://embed.st/embed/delta/garcia/1');
    expect(screen.getByRole('button', { name: 'Next PPV source' }).textContent).toContain('1/2');
    expect(screen.queryByText('No source loaded')).not.toBeInTheDocument();
    expect(screen.queryByText('Embed unavailable')).not.toBeInTheDocument();
  });

  it('tells the viewer what is observable once the deadline passes after a load', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={eventWith()} />);

    await act(async () => {
      fireEvent.load(frame() as HTMLIFrameElement);
    });
    expect(screen.queryByText(STALL_NOTICE)).not.toBeInTheDocument();

    await passTheDeadline();
    const notice = screen.getByText(STALL_NOTICE);
    expect(notice).toBeInTheDocument();
    // Wording is a claim about our own visibility, never about the stream.
    expect(notice.textContent).not.toMatch(/failed|offline|dead|not playing|error/i);
    expect(notice.textContent).toMatch(/This source loaded/i);
  });

  it('keeps the frame mounted while the notice is shown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={eventWith()} />);
    await act(async () => {
      fireEvent.load(frame() as HTMLIFrameElement);
    });
    await passTheDeadline();

    expect(frame()).not.toBeNull();
    expect(screen.getByText(STALL_NOTICE)).toBeInTheDocument();
  });

  it('clears the notice when the viewer switches source', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={eventWith()} />);
    await act(async () => {
      fireEvent.load(frame() as HTMLIFrameElement);
    });
    await passTheDeadline();
    expect(screen.getByText(STALL_NOTICE)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Next PPV source' }));
    });
    expect(frame()?.getAttribute('src')).toBe('https://embed.streamapi.cc/sport/garcia/');
    expect(screen.queryByText(STALL_NOTICE)).not.toBeInTheDocument();
  });

  it('never shows the notice while the source is still inside the deadline', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={eventWith()} />);
    await act(async () => {
      fireEvent.load(frame() as HTMLIFrameElement);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PPV_SOURCE_LOAD_DEADLINE_MS - 100);
    });
    expect(screen.queryByText(STALL_NOTICE)).not.toBeInTheDocument();
  });

  it('does not show the notice when the deadline passes with no load event - that path fails over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={eventWith()} />);
    await passTheDeadline();

    expect(frame()?.getAttribute('src')).toBe('https://embed.streamapi.cc/sport/garcia/');
    expect(screen.queryByText(STALL_NOTICE)).not.toBeInTheDocument();
  });
});

describe('official destination while a frame is mounted', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('offers the official page beside the playback controls, not only when idle', () => {
    render(<PpvPlayer event={eventWith({ officialInfoUrl: 'https://www.dazn.com/' })} />);

    expect(frame()).not.toBeNull();
    const link = screen.getByRole('link', { name: 'Open official page' });
    expect(link).toHaveAttribute('href', 'https://www.dazn.com/');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('labels a provider-supplied watch destination as a watch destination', () => {
    render(<PpvPlayer event={eventWith({ officialWatchUrl: 'https://www.ufc.com/events' })} />);

    expect(screen.getByRole('link', { name: 'Open official provider' })).toHaveAttribute(
      'href',
      'https://www.ufc.com/events',
    );
    expect(screen.queryByRole('link', { name: 'Open official page' })).toBeNull();
  });

  it('shows nothing when the event has no official destination at all', () => {
    render(<PpvPlayer event={eventWith()} />);
    expect(screen.queryByRole('link', { name: /Open official/ })).toBeNull();
  });

  it('does not duplicate the link once the run is exhausted and the idle panel takes over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(
      <PpvPlayer
        event={eventWith({
          embeds: [{ provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/garcia/1' }],
          officialInfoUrl: 'https://www.dazn.com/',
        })}
      />,
    );
    await passTheDeadline();

    expect(screen.getByText('No source loaded')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open official page' })).toHaveLength(1);
  });
});

describe('stall diagnostics and styling', () => {
  it('starts every source with the stall flag clear', () => {
    expect(emptyIframeDiagnostics().deadlineElapsedAfterLoad).toBe(false);
  });

  it('styles the notice so it cannot render as invisible text', () => {
    expect(ppvCss).toContain('.ppv-player__stall');
    expect(ppvCss).toContain('.ppv-player__official--inline');
  });

  /*
   * The action bar now carries three controls. On a phone an unwrapped flex
   * row pushes the meta section into a horizontal overflow, which is how a
   * previous PPV fix became invisible on the device that needed it.
   */
  it('lets the action bar wrap rather than overflow on a phone', () => {
    const block = ppvCss.slice(ppvCss.indexOf('.ppv-player__actions{'));
    expect(block.slice(0, block.indexOf('}'))).toContain('flex-wrap:wrap');
  });
});
