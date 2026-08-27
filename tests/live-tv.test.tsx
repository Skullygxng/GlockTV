import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LiveTvRoute } from '../src/components/LiveTvRoute';
import type { LiveChannel, LiveTvCatalog } from '../src/lib/iptvOrg';

const channels: LiveChannel[] = [
  { id: 'News.us', name: 'News Network', logo: null, category: 'News', country: 'US', streams: [{ url: 'https://example.com/news.m3u8', quality: null, label: null }] },
  { id: 'Movies.us', name: 'Movie Channel', logo: null, category: 'Movies', country: 'US', streams: [{ url: 'https://example.com/movies.m3u8', quality: null, label: null }] },
];
const catalog: LiveTvCatalog = { channels, source: 'iptv-org', loadedAt: '2026-08-27T00:00:00.000Z' };

function StubPlayer({ channel }: { channel: LiveChannel }) {
  return <div aria-label="stub live player">Playing {channel.name}</div>;
}

describe('Live TV route', () => {
  it('loads channels, searches, filters, and selects a channel', async () => {
    const loadCatalog = vi.fn().mockResolvedValue(catalog);
    render(<LiveTvRoute loadCatalog={loadCatalog} PlayerComponent={StubPlayer} />);

    expect(await screen.findByText('Playing News Network')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search live channels'), { target: { value: 'movie' } });
    expect(screen.getByRole('button', { name: 'Watch Movie Channel' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Watch News Network' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Watch Movie Channel' }));
    expect(screen.getByText('Playing Movie Channel')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search live channels'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'News' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Watch News Network' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Watch Movie Channel' })).not.toBeInTheDocument();
  });
});
