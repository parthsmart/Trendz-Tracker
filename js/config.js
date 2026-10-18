/**
 * Trendz Tracker - Client Configuration
 * 
 * In production (Vercel):
 * Supabase URL and anon key are read at build time from:
 * - import.meta.env.VITE_SUPABASE_URL
 * - import.meta.env.VITE_SUPABASE_ANON_KEY
 * The browser makes zero runtime requests to /api/config in production.
 * 
 * In Studio preview only (localhost and *.run.app):
 * If VITE_* variables are empty, /api/config is fetched once and cached in sessionStorage.
 * 
 * NEVER use a VITE_ prefix for the service role key!
 */

function normalizeSupabaseUrl(url) {
  if (!url) return '';
  return url.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

// 1. Read build-time environment variables injected by Vite
const buildUrl = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_URL ? import.meta.env.VITE_SUPABASE_URL : '';
const buildAnonKey = typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_ANON_KEY ? import.meta.env.VITE_SUPABASE_ANON_KEY : '';

let resolvedUrl = normalizeSupabaseUrl(buildUrl);
let resolvedAnonKey = (buildAnonKey || '').trim();

/**
 * Checks if current host is allowed to run Demo Mode or use preview fallbacks.
 * Allowed strictly on localhost, 127.0.0.1, or *.run.app hosts.
 */
export function isDemoAllowedHost() {
  if (typeof window === 'undefined') return false;
  const hostname = window.location.hostname;
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname.endsWith('.run.app');
}

// 2. For Studio preview only (localhost and *.run.app): check sessionStorage cache if build variables are empty
if (!resolvedUrl && typeof window !== 'undefined' && isDemoAllowedHost()) {
  try {
    const cachedUrl = sessionStorage.getItem('trendz_supabase_url');
    const cachedKey = sessionStorage.getItem('trendz_supabase_anon_key');
    if (cachedUrl && cachedKey) {
      resolvedUrl = normalizeSupabaseUrl(cachedUrl);
      resolvedAnonKey = cachedKey.trim();
    }
  } catch {
    // sessionStorage not available
  }
}

export const SUPABASE_CONFIG = {
  url: resolvedUrl,
  anonKey: resolvedAnonKey,
};

// 3. For Studio preview only: if credentials are still empty, fetch /api/config once and cache in sessionStorage.
// This is never executed in production (isDemoAllowedHost is false on production hostnames).
let previewConfigPromise = null;

if (!resolvedUrl && typeof window !== 'undefined' && isDemoAllowedHost()) {
  previewConfigPromise = (async () => {
    try {
      const res = await fetch('/api/config');
      if (res.ok) {
        const text = await res.text();
        if (text && text.trim()) {
          const data = JSON.parse(text);
          if (data && data.supabaseUrl && data.supabaseAnonKey) {
            resolvedUrl = normalizeSupabaseUrl(data.supabaseUrl);
            resolvedAnonKey = String(data.supabaseAnonKey).trim();
            SUPABASE_CONFIG.url = resolvedUrl;
            SUPABASE_CONFIG.anonKey = resolvedAnonKey;
            try {
              sessionStorage.setItem('trendz_supabase_url', resolvedUrl);
              sessionStorage.setItem('trendz_supabase_anon_key', resolvedAnonKey);
            } catch {
              // sessionStorage not available
            }
          }
        }
      }
    } catch {
      // preview server unreachable or empty response
    }
  })();
}

/**
 * Ensures preview configuration fetch has completed before client initialization.
 * Resolves synchronously in production or when credentials are already present.
 */
export async function ensurePreviewConfigLoaded() {
  if (previewConfigPromise) {
    await previewConfigPromise;
  }
  return SUPABASE_CONFIG;
}

/**
 * Checks if real Supabase credentials have been configured.
 */
export function isSupabaseConfigured() {
  const url = SUPABASE_CONFIG.url;
  const key = SUPABASE_CONFIG.anonKey;
  return Boolean(
    url && 
    key && 
    url !== 'YOUR_SUPABASE_URL' && 
    key !== 'YOUR_SUPABASE_ANON_KEY' &&
    !url.includes('your-project-ref') &&
    !key.includes('YOUR_') &&
    url.startsWith('https://')
  );
}

/**
 * Email domain used for student accounts.
 * Student ID "STU-101" is mapped to "stu-101@trendz.local"
 */
export const AUTH_EMAIL_DOMAIN = 'trendz.local';
