/**
 * Trendz Tracker - Supabase Client Initialization
 * Initializes pinned @supabase/supabase-js (v2.49.1).
 * Also provides an interactive demo fallback when placeholders are unconfigured.
 */

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG, isSupabaseConfigured, ensurePreviewConfigLoaded } from './config.js';

let supabase = null;

export { DemoDB, DEFAULT_ROUND_CATEGORIES, DEFAULT_BASICS_CATEGORIES } from './demoDb.js';

// Auto-detect production environment (Vercel deployment or custom domain)
// Production NEVER uses the reverse proxy.
const isProduction = typeof window !== 'undefined' && !(
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname.endsWith('.run.app')
);

// Restricted sandbox environments (AI Studio preview iframe or Cloud Run sandbox)
// Never active in production
const isRestrictedEnv = !isProduction && typeof window !== 'undefined' && (
  window.self !== window.top ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1' ||
  window.location.hostname.endsWith('.run.app')
);

let useProxy = isRestrictedEnv;

/**
 * Removes any expired or invalid Supabase session tokens from localStorage
 * to prevent repetitive AuthApiError loops.
 */
export function clearStaleSupabaseSession() {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToRemove = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('sb-') || k.includes('auth-token') || k.includes('supabase.auth'))) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch (e) {
    console.warn('Could not clear Supabase auth tokens:', e);
  }
}

// Global protection against stale or invalid refresh token unhandled rejections
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const msg = event?.reason?.message || (typeof event?.reason === 'string' ? event.reason : '');
    const isInvalidRefreshToken =
      msg.includes('Invalid Refresh Token') ||
      msg.includes('Refresh Token Not Found') ||
      msg.includes('refresh_token_not_found');

    if (isInvalidRefreshToken) {
      console.warn('Caught unhandled invalid refresh token rejection. Purging stale session.', msg);
      event.preventDefault();
      clearStaleSupabaseSession();
    }
  });
}

/**
 * Proxies request through /api/supabase-proxy to bypass browser cross-origin,
 * adblocker, or network/firewall blocking.
 */
async function proxyFetch(input, init = {}) {
  let url = '';
  let method = 'GET';
  const headers = {};
  let body = undefined;

  if (typeof input === 'string') {
    url = input;
  } else if (input && typeof input === 'object') {
    if (typeof input.url === 'string') {
      url = input.url;
    } else if (typeof input.href === 'string') {
      url = input.href;
    } else if (typeof input.toString === 'function') {
      const s = input.toString();
      if (s !== '[object Object]') url = s;
    }
    method = input.method || 'GET';
    if (input.headers && typeof input.headers.forEach === 'function') {
      input.headers.forEach((v, k) => { headers[k] = v; });
    }
  }

  if (init) {
    if (init.method) method = init.method;
    if (init.headers) {
      if (typeof init.headers.forEach === 'function') {
        init.headers.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(init.headers)) {
        init.headers.forEach(([k, v]) => { headers[k] = v; });
      } else if (typeof init.headers === 'object') {
        Object.assign(headers, init.headers);
      }
    }
    if (init.body !== undefined && init.body !== null) {
      body = init.body;
    }
  }

  // If body is in Request but not in init
  if (body === undefined && input && typeof input === 'object' && typeof input.clone === 'function' && !['GET', 'HEAD'].includes(method.toUpperCase())) {
    try {
      body = await input.clone().text();
    } catch {
      // ignore
    }
  }

  if (body !== undefined && body !== null && typeof body !== 'string') {
    try {
      body = typeof body.text === 'function' ? await body.text() : JSON.stringify(body);
    } catch {
      body = String(body);
    }
  }

  let proxyRes;
  try {
    proxyRes = await fetch('/api/supabase-proxy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, method, headers, body })
    });
  } catch (netErr) {
    console.warn('Network call to /api/supabase-proxy failed:', netErr);
    if (!isRestrictedEnv) {
      try {
        return await fetch(input, init);
      } catch {
        // Fall through to synthetic response
      }
    }
    return new Response(JSON.stringify({
      message: 'Proxy connection failed: ' + (netErr?.message || 'offline'),
      code: 503,
      error_code: 'proxy_offline'
    }), {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'application/json' }
    });
  }

  let proxyData = null;
  try {
    const rawEnvelope = await proxyRes.text();
    if (rawEnvelope && rawEnvelope.trim()) {
      proxyData = JSON.parse(rawEnvelope);
    }
  } catch (jsonErr) {
    console.warn('Failed to parse /api/supabase-proxy JSON:', jsonErr);
    return makeSafeResponse(new Response(JSON.stringify({
      message: 'Invalid proxy response envelope',
      code: 502
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  // Handle case where proxy endpoint returned an error or non-envelope payload
  if (!proxyRes.ok || !proxyData || proxyData.error) {
    const errorStatus = proxyRes.status >= 400 ? proxyRes.status : 502;
    const errorMessage = proxyData?.error || proxyData?.message || `Proxy request failed with status ${proxyRes.status}`;
    return makeSafeResponse(new Response(JSON.stringify({
      message: errorMessage,
      code: errorStatus,
      error_code: 'proxy_error'
    }), {
      status: errorStatus,
      statusText: proxyRes.statusText || 'Error',
      headers: { 'Content-Type': 'application/json' }
    }));
  }

  const status = typeof proxyData.status === 'number' && proxyData.status >= 200 && proxyData.status <= 599
    ? proxyData.status
    : 200;

  // Auto-clear stale refresh token if validation fails
  if (status === 400 && (url.includes('grant_type=refresh_token') || url.includes('refresh_token'))) {
    console.warn('Detected invalid refresh token response. Purging stale session.');
    clearStaleSupabaseSession();
  }

  // Filter out any forbidden or problematic headers before passing to Response constructor
  const safeHeaders = {};
  if (proxyData.headers && typeof proxyData.headers === 'object') {
    for (const [k, v] of Object.entries(proxyData.headers)) {
      const lower = k.toLowerCase();
      if (!['set-cookie', 'set-cookie2', 'transfer-encoding', 'content-encoding', 'content-length'].includes(lower)) {
        safeHeaders[k] = v;
      }
    }
  }

  const isJsonHeader = String(safeHeaders['content-type'] || '').toLowerCase().includes('application/json');

  // If status is 204 (No Content), 205 (Reset Content), or 304 (Not Modified),
  // WHATWG Response spec requires body to be null, otherwise Response constructor throws TypeError.
  let responseBody;
  if ([204, 205, 304].includes(status)) {
    responseBody = null;
  } else if (proxyData.body === null || proxyData.body === undefined || (typeof proxyData.body === 'string' && proxyData.body.trim() === '')) {
    // If upstream returned empty body on a non-204 response (e.g. 200/201),
    // supply 'null' for JSON so calling .json() doesn't throw "Unexpected end of JSON input"
    responseBody = isJsonHeader ? 'null' : '';
  } else {
    responseBody = proxyData.body;
  }

  try {
    return makeSafeResponse(new Response(responseBody, {
      status,
      statusText: (proxyData.statusText && /^[a-zA-Z0-9\s]+$/.test(proxyData.statusText)) ? proxyData.statusText : undefined,
      headers: safeHeaders
    }));
  } catch (resErr) {
    console.warn('Constructing full Response failed, using clean minimal Response:', resErr);
    try {
      return makeSafeResponse(new Response(responseBody, {
        status,
        headers: { 'Content-Type': safeHeaders['content-type'] || 'application/json' }
      }));
    } catch {
      return makeSafeResponse(new Response(responseBody, { status: 200 }));
    }
  }
}

/**
 * Wraps Response.prototype.json so that unexpected empty responses return null
 * instead of throwing "Unexpected end of JSON input".
 */
function makeSafeResponse(res) {
  if (!res || typeof res.json !== 'function') return res;
  const origJson = res.json.bind(res);
  res.json = async function safeJson() {
    try {
      return await origJson();
    } catch (e) {
      if (e && (e.name === 'SyntaxError' || String(e.message).includes('JSON') || String(e.message).includes('end of'))) {
        return null;
      }
      throw e;
    }
  };
  return res;
}

/**
 * Transparent fetch wrapper: uses proxy when in iframe or when direct fetch is blocked.
 * In restricted environments (iframe sandbox), always proxies without attempting raw direct fetch.
 */
async function smartFetch(input, init = {}) {
  // In production, ALWAYS talk directly to Supabase. Never use the proxy.
  if (isProduction) {
    const directRes = await fetch(input, init);
    return makeSafeResponse(directRes);
  }

  if (isRestrictedEnv) {
    return proxyFetch(input, init);
  }

  try {
    const directRes = await fetch(input, init);
    return makeSafeResponse(directRes);
  } catch (err) {
    console.warn('Direct fetch to Supabase failed in browser. Seamlessly switching to /api/supabase-proxy...', err);
    return proxyFetch(input, init);
  }
}

/**
 * Get or initialize the Supabase client instance.
 * Returns null if running in demo fallback mode.
 */
export async function getSupabase() {
  if (supabase) return supabase;

  await ensurePreviewConfigLoaded();

  if (!isSupabaseConfigured()) {
    return null;
  }

  try {
    supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
      },
      global: {
        fetch: smartFetch,
      },
    });

    supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') {
        clearStaleSupabaseSession();
      }
    });

    return supabase;
  } catch (err) {
    console.error('Failed to initialize Supabase client:', err);
    return null;
  }
}
