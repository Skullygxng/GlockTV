import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/*
 * One Supabase client for the whole app.
 *
 * Account state and watch parties are the same signed-in user, so they must be
 * the same auth session. Two clients would each run their own token refresh
 * against the same stored session, which is how a refresh race turns into a
 * signed-out user mid-watch-party.
 */
let cached: SupabaseClient | null | undefined;

export interface SupabaseConfig {
  url?: string;
  publishableKey?: string;
}

/*
 * Returns null when the project is not configured, which is a supported state:
 * GlockTV still browses and plays without Supabase, it just has no account or
 * watch parties. Passing a config bypasses the cache, for tests.
 */
export function getSupabaseClient(config: SupabaseConfig = {}): SupabaseClient | null {
  if (config.url || config.publishableKey) {
    const url = config.url ?? import.meta.env.VITE_SUPABASE_URL;
    const key = config.publishableKey ?? import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    return url && key ? createClient(url, key) : null;
  }

  if (cached === undefined) {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
    cached = url && key ? createClient(url, key) : null;
  }
  return cached;
}
