/**
 * Trendz Tracker - social RPC client (js/socialApi.js)
 *
 * One small wrapper shared by the Friends page, the dashboard "My class" card and
 * the staff Community page. Without a database (demo sign-in) it uses the demo
 * stand-in in js/socialDemo.js. Challenges go through POST /api/drill, which
 * checks same level, daily limits and blocks on the server.
 */

import { getSupabase } from './supabaseClient.js';
import { isSupabaseConfigured } from './config.js';

export async function socialRpc(name, args = {}) {
  if (!isSupabaseConfigured()) {
    const { demoSocialRpc } = await import('./socialDemo.js');
    return demoSocialRpc(name, args);
  }
  try {
    const supabase = await getSupabase();
    if (!supabase) return { data: null, error: 'The database is not connected.' };
    const { data, error } = await supabase.rpc(name, args);
    if (error) return { data: null, error: error.message || 'Something went wrong.' };
    return { data, error: null };
  } catch (err) {
    return { data: null, error: err?.message || 'Something went wrong.' };
  }
}

export async function drillApi(body) {
  if (!isSupabaseConfigured()) throw new Error('Challenges need the online database.');
  const supabase = await getSupabase();
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  const resp = await fetch('/api/drill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || 'Something went wrong.');
  return json;
}

/** Signed avatar URLs keyed by path (empty in demo mode). */
export async function avatarMap(rows) {
  const paths = (rows || []).map((r) => r?.avatar_path).filter(Boolean);
  if (!paths.length) return new Map();
  const { signAvatarUrls } = await import('./avatars.js');
  return signAvatarUrls(paths);
}
