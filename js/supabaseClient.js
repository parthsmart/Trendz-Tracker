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
 * to prevent repetitive AuthApiError / AuthRetryableFetchError loops.
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
    keysToRemove.forEach((k) => localStorage.removeItem(k));
  } catch (e) {
    console.warn('Could not clear Supabase auth tokens:', e);
  }
}

/**
 * Checks whether an error object or message comes from a transient or stale
 * @supabase/auth-js background token refresh.
 */
function classifySupabaseAuthError(errOrArg) {
  if (!errOrArg) return { isRetryableAuthError: false, isInvalidRefreshToken: false };
  const name = typeof errOrArg === 'object' ? (errOrArg.name || '') : '';
  const code = typeof errOrArg === 'object' ? (errOrArg.code || errOrArg.error_code || '') : '';
  const msg =
    typeof errOrArg === 'string'
      ? errOrArg
      : (errOrArg.message || errOrArg.msg || errOrArg.error_description || '');

  const isInvalidRefreshToken =
    code === 'refresh_token_not_found' ||
    code === 'session_not_found' ||
    code === 'validation_failed' ||
    name === 'AuthSessionMissingError' ||
    msg.includes('Invalid Refresh Token') ||
    msg.includes('Refresh Token Not Found') ||
    msg.includes('Refresh token is not valid') ||
    msg.includes('refresh_token_not_found') ||
    msg.includes('session_not_found');

  const isRetryableAuthError =
    name === 'AuthRetryableFetchError' ||
    msg.includes('AuthRetryableFetchError') ||
    msg.includes('Auto refresh tick failed');

  return { isRetryableAuthError, isInvalidRefreshToken };
}

// Global protection against stale or invalid refresh token and retryable auth fetch errors.
// Note: @supabase/auth-js catches refresh errors inside _recoverAndRefresh() and calls
// console.error(error) directly, which triggers preview error overlays unless intercepted.
if (typeof window !== 'undefined') {
  window.addEventListener('unhandledrejection', (event) => {
    const { isRetryableAuthError, isInvalidRefreshToken } = classifySupabaseAuthError(event?.reason);
    if (isInvalidRefreshToken || isRetryableAuthError) {
      event.preventDefault();
      if (isInvalidRefreshToken) {
        clearStaleSupabaseSession();
      }
    }
  });

  if (typeof console !== 'undefined' && typeof console.error === 'function' && !console.error.__trendzWrapped) {
    const origConsoleError = console.error.bind(console);
    const wrappedConsoleError = (...args) => {
      for (const arg of args) {
        const { isRetryableAuthError, isInvalidRefreshToken } = classifySupabaseAuthError(arg);
        if (isRetryableAuthError || isInvalidRefreshToken) {
          if (isInvalidRefreshToken) {
            clearStaleSupabaseSession();
          }
          console.warn('[Supabase Auth] Handled background session recovery warning:', arg?.message || arg?.name || arg);
          return;
        }
      }
      origConsoleError(...args);
    };
    wrappedConsoleError.__trendzWrapped = true;
    console.error = wrappedConsoleError;
  }
}

/**
 * Validates any persisted sb-*-auth-token entry in localStorage prior to client creation.
 * Purges malformed entries so GoTrueClient._recoverAndRefresh() does not fail on startup.
 */
function sanitizeStoredSupabaseSessions() {
  if (typeof localStorage === 'undefined') return;
  try {
    const keysToInspect = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) {
        keysToInspect.push(k);
      }
    }
    for (const k of keysToInspect) {
      const raw = localStorage.getItem(k);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (
          !parsed ||
          typeof parsed !== 'object' ||
          typeof parsed.access_token !== 'string' ||
          typeof parsed.refresh_token !== 'string' ||
          parsed.refresh_token.trim().length < 8
        ) {
          localStorage.removeItem(k);
        }
      } catch {
        localStorage.removeItem(k);
      }
    }
  } catch {
    // ignore storage access issues
  }
}

/**
 * Attempts a direct browser fetch to Supabase (used as a fallback if the local proxy is restarting).
 * Never returns a 502/503/504 response, as @supabase/auth-js throws AuthRetryableFetchError on those codes.
 */
async function tryDirectSupabaseFetch(url, method, headers, body) {
  if (!url || typeof url !== 'string' || !url.startsWith('https://')) {
    return null;
  }
  try {
    const directInit = {
      method: method || 'GET',
      headers: headers || {},
    };
    if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(directInit.method.toUpperCase())) {
      directInit.body = body;
    }
    const directRes = await fetch(url, directInit);
    if ([502, 503, 504].includes(directRes.status)) {
      return null;
    }
    return makeSafeResponse(directRes, '', url);
  } catch {
    return null;
  }
}

/**
 * Builds a clean synthetic error response that never triggers AuthRetryableFetchError: {}
 * in @supabase/auth-js (which throws AuthRetryableFetchError on status 502, 503, 504).
 */
function buildSyntheticErrorResponse(url, message, originalStatus = 500) {
  const cleanMessage = message || 'Service temporarily unavailable';
  const isAuthEndpoint = typeof url === 'string' && url.includes('/auth/v1/');
  if (isAuthEndpoint) {
    clearStaleSupabaseSession();
    return makeSafeResponse(
      new Response(
        JSON.stringify({
          message: cleanMessage,
          msg: cleanMessage,
          error: 'invalid_grant',
          error_description: cleanMessage,
          error_code: 'session_not_found',
          code: 'session_not_found',
        }),
        {
          status: 401,
          statusText: 'Unauthorized',
          headers: {
            'Content-Type': 'application/json',
            'X-Supabase-Api-Version': '2024-01-01',
          },
        }
      ),
      cleanMessage,
      url
    );
  }

  // Avoid 502, 503, 504 which cause @supabase/auth-js to throw AuthRetryableFetchError({})
  const safeStatus = [502, 503, 504].includes(originalStatus) ? 500 : (originalStatus >= 400 ? originalStatus : 500);
  return makeSafeResponse(
    new Response(
      JSON.stringify({
        message: cleanMessage,
        msg: cleanMessage,
        error: cleanMessage,
        error_description: cleanMessage,
        code: String(safeStatus),
      }),
      {
        status: safeStatus,
        statusText: 'Internal Server Error',
        headers: { 'Content-Type': 'application/json' },
      }
    ),
    cleanMessage,
    url
  );
}

/**
 * Proxies request through /api/supabase-proxy to bypass browser cross-origin,
 * adblocker, or network/firewall blocking. Retries transient server restarts and
 * falls back to direct fetch if needed.
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

  let proxyRes = null;
  let lastNetErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      proxyRes = await fetch('/api/supabase-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method, headers, body }),
      });
      if (![502, 503, 504].includes(proxyRes.status) || attempt === 1) {
        break;
      }
    } catch (netErr) {
      lastNetErr = netErr;
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }

  if (!proxyRes) {
    const directFallback = await tryDirectSupabaseFetch(url, method, headers, body);
    if (directFallback) return directFallback;
    return buildSyntheticErrorResponse(url, 'Proxy connection failed: ' + (lastNetErr?.message || 'offline'), 500);
  }

  let proxyData = null;
  try {
    const rawEnvelope = await proxyRes.text();
    if (rawEnvelope && rawEnvelope.trim()) {
      proxyData = JSON.parse(rawEnvelope);
    }
  } catch {
    const directFallback = await tryDirectSupabaseFetch(url, method, headers, body);
    if (directFallback) return directFallback;
    const fallbackStatus = proxyRes.status >= 400 ? proxyRes.status : 500;
    const fallbackMsg =
      proxyRes.status === 413
        ? 'Proxy request payload too large (HTTP 413).'
        : `Invalid proxy response envelope (HTTP ${proxyRes.status || 500} ${proxyRes.statusText || ''})`.trim();
    return buildSyntheticErrorResponse(url, fallbackMsg, fallbackStatus);
  }

  // Handle case where proxy endpoint returned an error or non-envelope payload
  if (!proxyRes.ok || !proxyData || proxyData.error) {
    const directFallback = await tryDirectSupabaseFetch(url, method, headers, body);
    if (directFallback) return directFallback;
    const errorStatus = proxyRes.status >= 400 ? proxyRes.status : 500;
    const errorMessage = proxyData?.error || proxyData?.message || `Proxy request failed with status ${proxyRes.status}`;
    return buildSyntheticErrorResponse(url, errorMessage, errorStatus);
  }

  let status = typeof proxyData.status === 'number' && proxyData.status >= 200 && proxyData.status <= 599
    ? proxyData.status
    : 200;

  // If upstream returned 502/503/504, try direct fetch once before returning a safe status
  if ([502, 503, 504].includes(status)) {
    const directFallback = await tryDirectSupabaseFetch(url, method, headers, body);
    if (directFallback && ![502, 503, 504].includes(directFallback.status)) {
      return directFallback;
    }
    return buildSyntheticErrorResponse(url, 'Upstream Supabase gateway timeout or unavailable', 500);
  }

  // Auto-clear stale refresh token if validation fails
  if ((status === 400 || status === 401) && (url.includes('grant_type=refresh_token') || url.includes('refresh_token'))) {
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
    responseBody = isJsonHeader ? 'null' : '';
  } else {
    responseBody = proxyData.body;
  }

  try {
    return makeSafeResponse(
      new Response(responseBody, {
        status,
        statusText: (proxyData.statusText && /^[a-zA-Z0-9\s]+$/.test(proxyData.statusText)) ? proxyData.statusText : undefined,
        headers: safeHeaders,
      }),
      '',
      url
    );
  } catch (resErr) {
    try {
      return makeSafeResponse(
        new Response(responseBody, {
          status,
          headers: { 'Content-Type': safeHeaders['content-type'] || 'application/json' },
        }),
        '',
        url
      );
    } catch {
      return makeSafeResponse(new Response(responseBody, { status: 200 }), '', url);
    }
  }
}

/**
 * Guarantees that a Response never has status 502/503/504 (which causes @supabase/auth-js
 * to throw `AuthRetryableFetchError: {}`), wraps `.json()` against empty bodies, and
 * attaches a readable `.message` property on non-2xx responses.
 */
function makeSafeResponse(res, fallbackMessage = '', requestUrl = '') {
  if (!res || typeof res.json !== 'function') return res;

  // Never allow status 502, 503, or 504 to reach @supabase/auth-js handleError()
  if ([502, 503, 504].includes(res.status)) {
    return buildSyntheticErrorResponse(
      requestUrl || res.url || '',
      fallbackMessage || `Service temporarily unavailable (HTTP ${res.status})`,
      500
    );
  }

  if (!res.ok || fallbackMessage) {
    const msgValue = fallbackMessage || res.statusText || `HTTP ${res.status || 500} error`;
    if (!res.message) {
      try {
        Object.defineProperty(res, 'message', {
          value: msgValue,
          configurable: true,
          enumerable: false,
        });
      } catch {
        // ignore if Response object is frozen
      }
    }
  }

  const origJson = res.json.bind(res);
  res.json = async function safeJson() {
    try {
      return await origJson();
    } catch (e) {
      if (e && (e.name === 'SyntaxError' || String(e.message).includes('JSON') || String(e.message).includes('end of'))) {
        return res.ok ? null : { message: fallbackMessage || `HTTP ${res.status || 500} error` };
      }
      throw e;
    }
  };
  return res;
}

/**
 * Transparent fetch wrapper: uses proxy when in iframe or when direct fetch is blocked.
 * In restricted environments (iframe sandbox), proxies with automatic direct fallback.
 */
async function smartFetch(input, init = {}) {
  const reqUrl = typeof input === 'string' ? input : (input?.url || '');

  // In production, ALWAYS talk directly to Supabase. Never use the proxy.
  if (isProduction) {
    try {
      const directRes = await fetch(input, init);
      return makeSafeResponse(directRes, '', reqUrl);
    } catch (err) {
      return buildSyntheticErrorResponse(reqUrl, err?.message || 'Network request failed', 500);
    }
  }

  if (isRestrictedEnv) {
    return proxyFetch(input, init);
  }

  try {
    const directRes = await fetch(input, init);
    if ([502, 503, 504].includes(directRes.status)) {
      return proxyFetch(input, init);
    }
    return makeSafeResponse(directRes, '', reqUrl);
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
    sanitizeStoredSupabaseSessions();

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

