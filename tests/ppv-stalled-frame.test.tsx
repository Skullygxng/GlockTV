import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PpvPlayer } from '../src/components/PpvPlayer';
import type { PpvEvent } from '../src/lib/ppv';
import {
  PPV_SOURCE_LOAD_DEADLINE_MS,
  PPV_SWEEP_DWELL_MS,
  emptyIframeDiagnostics,
} from '../src/lib/ppvDiagnostics';
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

/*
 * The long-dead-list problem: fifteen sources, and finding out whether any of
 * them paints means clicking Next fifteen times and staring at each one.
 *
 * Nothing in the browser can tell a black cross-origin frame from a working
 * one, so the sweep does not try to. It mounts each source in turn and the
 * viewer - who can see the picture - stops it. These tests pin that the sweep
 * only ever moves the index, terminates, and never claims to know whether any
 * source played.
 */
describe('sweeping a long source list', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const many = (count: number): PpvEvent =>
    eventWith({
      embeds: Array.from({ length: count }, (_, position) => ({
        provider: 'streamed' as const,
        source: `s${position}`,
        url: `https://embed.st/embed/delta/garcia/${position}`,
      })),
    });

  function sweepButton() {
    return screen.getByRole('button', { name: 'Try all PPV sources' });
  }

  /*
   * One dwell per act call. Batching several dwells into a single advance
   * races the effect that schedules the next timer, which is a property of
   * the test clock, not of the sweep.
   */
  async function dwell(times = 1) {
    for (let step = 0; step < times; step += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PPV_SWEEP_DWELL_MS + 1);
      });
    }
  }

  it('walks every source in turn, one dwell apart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={many(4)} />);

    await act(async () => {
      fireEvent.click(sweepButton());
    });
    expect(frame()?.getAttribute('src')).toBe('https://embed.st/embed/delta/garcia/0');

    for (const expected of [1, 2, 3]) {
      await dwell();
      expect(frame()?.getAttribute('src')).toBe(`https://embed.st/embed/delta/garcia/${expected}`);
    }
  });

  it('stops after one pass instead of cycling forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={many(3)} />);
    await act(async () => {
      fireEvent.click(sweepButton());
    });

    await dwell(6);
    expect(frame()?.getAttribute('src')).toBe('https://embed.st/embed/delta/garcia/2');
    expect(screen.getByRole('button', { name: 'Try all PPV sources' })).toBeInTheDocument();
    expect(screen.getByText(/Tried all 3 sources/i)).toBeInTheDocument();
  });

  it('parks on the source showing when the viewer stops it', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={many(5)} />);
    await act(async () => {
      fireEvent.click(sweepButton());
    });
    await dwell(2);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop sweeping PPV sources' }));
    });

    const parked = frame()?.getAttribute('src');
    expect(parked).toBe('https://embed.st/embed/delta/garcia/2');
    await dwell(4);
    expect(frame()?.getAttribute('src')).toBe(parked);
  });

  it('never claims a swept source did or did not play', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={many(2)} />);
    await act(async () => {
      fireEvent.click(sweepButton());
    });
    const status = screen.getByText(/Trying source 1 of 2/i);
    expect(status.textContent).toMatch(/cannot detect that from inside the frame/i);
    expect(status.textContent).not.toMatch(/\b(playing|failed|dead|working|offline)\b/i);
  });

  it('jumps straight to any source through the picker', async () => {
    render(<PpvPlayer event={many(15)} />);
    const picker = screen.getByRole('combobox', { name: 'Choose PPV source' });
    expect(screen.getAllByRole('option')).toHaveLength(15);

    await act(async () => {
      fireEvent.change(picker, { target: { value: '11' } });
    });
    expect(frame()?.getAttribute('src')).toBe('https://embed.st/embed/delta/garcia/11');
    expect(screen.getByRole('button', { name: 'Next PPV source' }).textContent).toContain('12/15');
  });

  it('cancels an in-flight sweep when the viewer picks a source by hand', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={many(6)} />);
    await act(async () => {
      fireEvent.click(sweepButton());
    });
    await act(async () => {
      fireEvent.change(screen.getByRole('combobox', { name: 'Choose PPV source' }), {
        target: { value: '4' },
      });
    });

    expect(screen.queryByRole('button', { name: 'Stop sweeping PPV sources' })).toBeNull();
    await dwell(3);
    expect(frame()?.getAttribute('src')).toBe('https://embed.st/embed/delta/garcia/4');
  });

  it('offers no sweep or picker for a single source', () => {
    render(
      <PpvPlayer
        event={eventWith({
          embeds: [{ provider: 'streamed', source: 'delta', url: 'https://embed.st/only/1' }],
        })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Try all PPV sources' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Choose PPV source' })).toBeNull();
  });

  it('suppresses the stall notice while a sweep is running', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<PpvPlayer event={many(4)} />);
    await act(async () => {
      fireEvent.load(frame() as HTMLIFrameElement);
    });
    await passTheDeadline();
    expect(screen.getByText(STALL_NOTICE)).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(sweepButton());
    });
    expect(screen.queryByText(STALL_NOTICE)).not.toBeInTheDocument();
  });
});
