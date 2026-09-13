/*
 * Operator-supplied authorized links, per event.
 *
 * Every configured catalog provider leaves the authorized-embed identifiers
 * empty, so the authorized path never produces a source on its own. This is
 * where a person names the official broadcast they are entitled to watch and
 * makes it playable for that event.
 *
 * Two rules hold everything together:
 *
 *   1. Only what authorizedEmbedFromLink accepts is ever stored. Validation
 *      happens on the way in AND again on the way out, because stored data is
 *      untrusted input: localStorage is writable by anything running on the
 *      origin, and a list read back without re-checking is not an allowlist.
 *   2. This never touches ppvEmbedPolicy. The hosted-embed allowlist is a
 *      different surface with a different review, and nothing here widens it.
 *
 * Storage is per browser, in localStorage. That is deliberate: these are one
 * person's notes about where to watch something, not catalog data, and they
 * are worth nothing to anyone else's session.
 */

import {
  authorizedEmbedFromLink,
  isAllowedAuthorizedEmbedUrl,
  type PpvAuthorizedPlatformId,
} from './ppvAuthorizedEmbeds';

const STORAGE_KEY = 'glocktv.ppv.authorizedLinks.v1';
/* Enough for a main card plus prelims; small enough to stay a list, not a DB. */
export const PPV_USER_LINKS_PER_EVENT = 5;

export interface PpvUserLink {
  platformId: PpvAuthorizedPlatformId;
  label: string;
  url: string;
}

type Stored = Record<string, PpvUserLink[]>;

function storage(): Storage | null {
  try {
    /* Absent in SSR and tests, and throws outright in some privacy modes. */
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function readAll(): Stored {
  const store = storage();
  if (!store) return {};
  let raw: string | null;
  try {
    raw = store.getItem(STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Stored;
  } catch {
    return {};
  }
}

function writeAll(value: Stored): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    /* Quota or a blocked store. Losing a convenience list is not an error
       worth surfacing, and the in-memory list for this session still works. */
  }
}

/* Re-validated on the way out: stored rows are untrusted input. */
function sanitize(rows: unknown): PpvUserLink[] {
  if (!Array.isArray(rows)) return [];
  const seen = new Set<string>();
  const clean: PpvUserLink[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const candidate = row as Partial<PpvUserLink>;
    if (typeof candidate.url !== 'string' || !isAllowedAuthorizedEmbedUrl(candidate.url)) continue;
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    clean.push({
      platformId: (candidate.platformId ?? 'youtube') as PpvAuthorizedPlatformId,
      label: typeof candidate.label === 'string' && candidate.label ? candidate.label : 'Official',
      url: candidate.url,
    });
    if (clean.length >= PPV_USER_LINKS_PER_EVENT) break;
  }
  return clean;
}

export function loadUserLinks(eventKey: string): PpvUserLink[] {
  if (!eventKey) return [];
  return sanitize(readAll()[eventKey]);
}

export interface PpvAddLinkOutcome {
  ok: boolean;
  links: PpvUserLink[];
  /* Set only when ok is false. Already human-readable. */
  error: string;
}

export function addUserLink(
  eventKey: string,
  value: string,
  describe: (reason: ReturnType<typeof authorizedEmbedFromLink>['reason']) => string,
  hostname?: string,
): PpvAddLinkOutcome {
  const existing = loadUserLinks(eventKey);
  if (!eventKey) return { ok: false, links: existing, error: 'No event selected.' };

  const resolved = authorizedEmbedFromLink(value, hostname);
  if (!resolved.ok || !resolved.platform) {
    return { ok: false, links: existing, error: describe(resolved.reason) };
  }
  if (existing.some((entry) => entry.url === resolved.url)) {
    return { ok: false, links: existing, error: 'That link is already added.' };
  }
  if (existing.length >= PPV_USER_LINKS_PER_EVENT) {
    return {
      ok: false,
      links: existing,
      error: `Up to ${PPV_USER_LINKS_PER_EVENT} links per event. Remove one first.`,
    };
  }

  const links = [
    ...existing,
    { platformId: resolved.platform.id, label: resolved.platform.label, url: resolved.url },
  ];
  writeAll({ ...readAll(), [eventKey]: links });
  return { ok: true, links, error: '' };
}

export function removeUserLink(eventKey: string, url: string): PpvUserLink[] {
  const links = loadUserLinks(eventKey).filter((entry) => entry.url !== url);
  const all = readAll();
  if (links.length) all[eventKey] = links;
  else delete all[eventKey];
  writeAll(all);
  return links;
}
