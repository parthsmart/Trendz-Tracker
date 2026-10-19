/**
 * Trendz Tracker - Supabase Reverse Proxy Handler
 * 
 * Securely proxies browser Supabase requests through the backend server in restricted preview
 * environments (e.g. iframes). Never runs on production.
 * 
 * Strict destination checks:
 * 1. Target URL parsed with new URL()
 * 2. Protocol must be https:
 * 3. Origin must exactly match the origin of the configured Supabase URL
 * 4. Userinfo (username/password) is strictly rejected
 * 5. Path must start with /rest/v1/, /auth/v1/, or /storage/v1/
 * 6. Method must be GET, POST, PATCH, PUT, or DELETE
 * 7. Forward headers strictly limited to: apikey, authorization, content-type, accept, prefer, x-client-info
 * 8. Return real 403 status on rejected destination or method
 * 9. Returns 404 when VERCEL_ENV is 'production'
 */

import { getSupabaseServerConfig } from './_configHelper.js';

export default async function handler(req, res) {
  // Never run proxy in production on Vercel
  if (process.env.VERCEL_ENV === 'production') {
    return res.status(404).json({ error: 'Not Found' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let configuredConfig;
  try {
    configuredConfig = getSupabaseServerConfig();
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  let configuredOrigin;
  try {
    configuredOrigin = new URL(configuredConfig.url).origin;
  } catch {
    return res.status(500).json({ error: 'Invalid configured Supabase URL origin.' });
  }

  let { url, method = 'GET', headers = {}, body } = req.body || {};

  let targetUrlStr = typeof url === 'string' ? url.trim() : '';
  if (targetUrlStr.startsWith('/')) {
    targetUrlStr = configuredConfig.url + targetUrlStr;
  }

  if (!targetUrlStr) {
    return res.status(400).json({ error: 'Missing target URL in proxy request' });
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrlStr);
  } catch {
    return res.status(400).json({ error: 'Invalid target URL format' });
  }

  // 1. Require HTTPS
  if (parsedTarget.protocol !== 'https:') {
    return res.status(403).json({ error: 'Forbidden: Target URL must use https' });
  }

  // 2. Reject username or password
  if (parsedTarget.username || parsedTarget.password) {
    return res.status(403).json({ error: 'Forbidden: Credentials in target URL are prohibited' });
  }

  // 3. Exact origin match
  if (parsedTarget.origin !== configuredOrigin) {
    return res.status(403).json({ error: 'Forbidden: Target origin does not match configured Supabase project' });
  }

  // 4. Allowed paths only
  const pathname = parsedTarget.pathname;
  const isAllowedPath = pathname.startsWith('/rest/v1/') ||
                        pathname.startsWith('/auth/v1/') ||
                        pathname.startsWith('/storage/v1/');

  if (!isAllowedPath) {
    return res.status(403).json({ error: 'Forbidden: Target path is not allowed' });
  }

  // 5. Allowed HTTP methods only
  const upperMethod = (method || 'GET').toUpperCase();
  const allowedMethods = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
  if (!allowedMethods.includes(upperMethod)) {
    return res.status(403).json({ error: `Forbidden: Method ${upperMethod} not allowed` });
  }

  try {
    // 6. Forward only permitted headers
    const allowedHeaderNames = [
      'apikey',
      'authorization',
      'content-type',
      'accept',
      'prefer',
      'x-client-info',
      'x-supabase-api-version',
    ];
    const forwardHeaders = {};

    if (headers && typeof headers === 'object') {
      for (const [k, v] of Object.entries(headers)) {
        const lower = k.toLowerCase();
        if (allowedHeaderNames.includes(lower) && typeof v === 'string') {
          forwardHeaders[lower] = v;
        }
      }
    }

    // Set apikey if missing
    if (!forwardHeaders['apikey']) {
      forwardHeaders['apikey'] = configuredConfig.anonKey;
    }

    const fetchOptions = {
      method: upperMethod,
      headers: forwardHeaders,
    };

    if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(upperMethod)) {
      fetchOptions.body = typeof body === 'object' ? JSON.stringify(body) : String(body);
    }

    const upstreamRes = await fetch(parsedTarget.toString(), fetchOptions);
    const responseText = await upstreamRes.text();

    const responseHeaders = {};
    upstreamRes.headers.forEach((val, key) => {
      const lower = key.toLowerCase();
      if (!['transfer-encoding', 'connection', 'keep-alive', 'content-encoding', 'content-length', 'set-cookie', 'set-cookie2'].includes(lower)) {
        responseHeaders[key] = val;
      }
    });

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: responseHeaders,
      body: responseText
    });
  } catch (err) {
    console.error('Error in /api/supabase-proxy connecting upstream:', err);
    return res.status(502).json({
      error: 'Proxy gateway error connecting to Supabase: ' + (err.message || 'Unknown network error')
    });
  }
}
