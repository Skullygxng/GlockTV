import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PpvPlayer } from '../src/components/PpvPlayer';
import type { PpvEvent } from '../src/lib/ppv';
import {
  PPV_AUTHORIZED_EMBED_HOSTS,
  PPV_AUTHORIZED_PLATFORMS,
  authorizedEmbedFromLink,
  kickChannelFrom,
  kickEmbedUrl,
  rumbleEmbedUrl,
  rumbleVideoIdFrom,
  twitchChannelFrom,
  vimeoEmbedUrl,
  vimeoVideoIdFrom,
} from '../src/lib/ppvAuthorizedEmbeds';
import { PPV_EMBED_HOSTS } from '../src/lib/ppvEmbedPolicy';
import { addUserLink, loadUserLinks, removeUserLink } from '../src/lib/ppvUserLinks';

/*
 * Every configured catalog provider leaves the authorized identifiers empty,
 * so before this the authorized path could never produce a source. These
 * tests cover the two halves of making it real: parsing a platform's own
 * public link into that platform's own documented embed endpoint, and the
 * boundary that keeps anything else out.
 */

const KICK = 'https://kick.com/somefighter';
const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

function eventWith(overrides: Partial<PpvEvent> = {}): PpvEvent {
  return {
    provider: 'streamed',
    providerEventId: 'garcia-card',
    title: 'Garcia vs Benn',
    category: 'boxing',
    startsAt: '2026-09-13T22:00:00.000Z',
    status: 'live',
    sourceRefs: [],
    embeds: [],
    ...overrides,
  };
}

describe('platform link parsing', () => {
  it('turns a Kick channel link into Kick own documented player URL', () => {
    expect(kickChannelFrom(KICK)).toBe('somefighter');
    expect(kickEmbedUrl('somefighter')).toBe('https://player.kick.com/somefighter');
  });

  it('turns a Twitch channel link into the parent-scoped player URL', () => {
    expect(twitchChannelFrom('https://www.twitch.tv/somefighter')).toBe('somefighter');
    expect(twitchChannelFrom('https://www.twitch.tv/')).toBe('');
  });

  it('accepts a Rumble embed link but refuses to guess at a watch-page slug', () => {
    expect(rumbleVideoIdFrom('https://rumble.com/embed/v1a59rb/')).toBe('v1a59rb');
    expect(rumbleEmbedUrl('v1a59rb')).toBe('https://rumble.com/embed/v1a59rb/');
    /* A watch URL's slug is not the embed id, and inventing one would ship a
       dead source that looks deliberate. */
    expect(rumbleVideoIdFrom('https://rumble.com/v1a59rb-some-title.html')).toBe('');
  });

  it('reads a Vimeo id from either link shape', () => {
    expect(vimeoVideoIdFrom('https://vimeo.com/76979871')).toBe('76979871');
    expect(vimeoVideoIdFrom('https://player.vimeo.com/video/76979871')).toBe('76979871');
    expect(vimeoEmbedUrl('76979871')).toBe('https://player.vimeo.com/video/76979871');
  });

  it('resolves every platform in the table to an allowlisted host', () => {
    for (const url of [KICK, YT, 'https://rumble.com/embed/v1a59rb/', 'https://vimeo.com/76979871']) {
      const resolved = authorizedEmbedFromLink(url, 'skullygxng.github.io');
      expect(resolved.ok).toBe(true);
      expect(PPV_AUTHORIZED_EMBED_HOSTS).toContain(new URL(resolved.url).hostname);
    }
  });

  it('requires a full URL, because a bare word is ambiguous between platforms', () => {
    /* "somefighter" is a valid Twitch login AND a valid Kick slug; whichever
       table entry came first would silently win. */
    expect(authorizedEmbedFromLink('somefighter').ok).toBe(false);
    expect(authorizedEmbedFromLink('somefighter').reason).toBe('unsupported_platform');
  });

  it('refuses Twitch when this origin is not a declared parent', () => {
    const resolved = authorizedEmbedFromLink('https://www.twitch.tv/somefighter', 'evil.example');
    expect(resolved.ok).toBe(false);
    expect(resolved.reason).toBe('platform_unavailable_here');
  });
});

describe('the boundary this must not cross', () => {
  it('refuses every hosted-aggregator host', () => {
    for (const host of PPV_EMBED_HOSTS) {
      const resolved = authorizedEmbedFromLink(`https://${host}/embed/delta/x/1`);
      expect(resolved.ok).toBe(false);
      expect(resolved.reason).toBe('unsupported_platform');
    }
  });

  it('refuses an arbitrary restream host', () => {
    for (const url of [
      'https://nonstopservice.org/tgya10/',
      'https://v2.sportsurge.net/watch-64337-boxing/',
      'https://example.com/stream.m3u8',
      'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
    ]) {
      expect(authorizedEmbedFromLink(url).ok).toBe(false);
    }
  });

  it('refuses javascript: and data: payloads', () => {
    expect(authorizedEmbedFromLink('javascript:alert(1)').ok).toBe(false);
    expect(authorizedEmbedFromLink('data:text/html,<script>x</script>').ok).toBe(false);
  });

  it('refuses embedded credentials', () => {
    expect(authorizedEmbedFromLink('https://user:pass@kick.com/somefighter').ok).toBe(false);
  });

  it('does not widen the hosted-embed allowlist', () => {
    for (const host of PPV_AUTHORIZED_EMBED_HOSTS) {
      expect(PPV_EMBED_HOSTS).not.toContain(host);
    }
    expect(PPV_EMBED_HOSTS).toEqual(['embed.st', 'embed.streamapi.cc']);
  });
});

describe('stored links', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const describeReason = () => 'rejected';

  it('stores an accepted link and reads it back', () => {
    const added = addUserLink('streamed:e1', KICK, describeReason);
    expect(added.ok).toBe(true);
    expect(loadUserLinks('streamed:e1').map((link) => link.url)).toEqual([
      'https://player.kick.com/somefighter',
    ]);
  });

  it('never stores a rejected link', () => {
    expect(addUserLink('streamed:e1', 'https://embed.st/embed/delta/x/1', describeReason).ok).toBe(
      false,
    );
    expect(loadUserLinks('streamed:e1')).toEqual([]);
  });

  it('re-validates on read, so a tampered store cannot inject a host', () => {
    localStorage.setItem(
      'glocktv.ppv.authorizedLinks.v1',
      JSON.stringify({
        'streamed:e1': [
          { platformId: 'kick', label: 'Kick', url: 'https://embed.st/embed/delta/x/1' },
          { platformId: 'kick', label: 'Kick', url: 'https://player.kick.com/somefighter' },
        ],
      }),
    );
    expect(loadUserLinks('streamed:e1').map((link) => link.url)).toEqual([
      'https://player.kick.com/somefighter',
    ]);
  });

  it('survives unparseable stored data', () => {
    localStorage.setItem('glocktv.ppv.authorizedLinks.v1', '{not json');
    expect(loadUserLinks('streamed:e1')).toEqual([]);
  });

  it('rejects a duplicate and caps the list', () => {
    addUserLink('streamed:e1', KICK, describeReason);
    expect(addUserLink('streamed:e1', KICK, describeReason).error).toMatch(/already added/i);
  });

  it('removes a link', () => {
    addUserLink('streamed:e1', KICK, describeReason);
    expect(removeUserLink('streamed:e1', 'https://player.kick.com/somefighter')).toEqual([]);
    expect(loadUserLinks('streamed:e1')).toEqual([]);
  });

  it('keeps events separate', () => {
    addUserLink('streamed:e1', KICK, describeReason);
    expect(loadUserLinks('streamed:e2')).toEqual([]);
  });
});

describe('adding a link in the player', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  async function openForm() {
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add an official stream link' }));
    });
    return screen.getByLabelText('Official stream link');
  }

  it('plays an added link on an event that had no sources at all', async () => {
    render(<PpvPlayer event={eventWith()} loadEmbeds={async () => []} />);
    expect(await screen.findByText('Embed unavailable')).toBeInTheDocument();

    const input = await openForm();
    await act(async () => {
      fireEvent.change(input, { target: { value: KICK } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });

    const frame = document.querySelector('iframe.ppv-player__frame');
    expect(frame?.getAttribute('src')).toBe('https://player.kick.com/somefighter');
    expect(screen.queryByText('Embed unavailable')).not.toBeInTheDocument();
  });

  it('shows a reason and mounts nothing for a refused link', async () => {
    render(<PpvPlayer event={eventWith()} loadEmbeds={async () => []} />);
    await screen.findByText('Embed unavailable');
    const input = await openForm();

    await act(async () => {
      fireEvent.change(input, { target: { value: 'https://nonstopservice.org/tgya10/' } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });

    expect(screen.getByRole('alert').textContent).toMatch(/Only official/i);
    expect(document.querySelector('iframe.ppv-player__frame')).toBeNull();
  });

  it('puts an added link ahead of the aggregator sources', async () => {
    render(
      <PpvPlayer
        event={eventWith({
          embeds: [
            { provider: 'streamed', source: 'delta', url: 'https://embed.st/embed/delta/a/1' },
          ],
        })}
      />,
    );
    const input = await openForm();
    await act(async () => {
      fireEvent.change(input, { target: { value: KICK } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });

    const options = screen.getAllByRole('option').map((option) => option.textContent ?? '');
    expect(options[0]).toContain('Kick');
    expect(document.querySelector('iframe.ppv-player__frame')?.getAttribute('src')).toBe(
      'https://player.kick.com/somefighter',
    );
  });

  it('restores an added link when the event is reopened', async () => {
    const { unmount } = render(<PpvPlayer event={eventWith()} loadEmbeds={async () => []} />);
    await screen.findByText('Embed unavailable');
    const input = await openForm();
    await act(async () => {
      fireEvent.change(input, { target: { value: KICK } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });
    unmount();

    render(<PpvPlayer event={eventWith()} loadEmbeds={async () => []} />);
    await act(async () => {});
    expect(document.querySelector('iframe.ppv-player__frame')?.getAttribute('src')).toBe(
      'https://player.kick.com/somefighter',
    );
  });

  it('removes an added link from the player', async () => {
    render(<PpvPlayer event={eventWith()} loadEmbeds={async () => []} />);
    await screen.findByText('Embed unavailable');
    const input = await openForm();
    await act(async () => {
      fireEvent.change(input, { target: { value: KICK } });
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Remove added Kick link' }));
    });
    expect(document.querySelector('iframe.ppv-player__frame')).toBeNull();
  });

  it('names every accepted platform in the hint', async () => {
    render(<PpvPlayer event={eventWith()} loadEmbeds={async () => []} />);
    await screen.findByText('Embed unavailable');
    await openForm();
    for (const platform of PPV_AUTHORIZED_PLATFORMS) {
      expect(screen.getByText(new RegExp(platform.label))).toBeInTheDocument();
    }
  });
});
