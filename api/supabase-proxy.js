/**
 * Trendz Tracker - Supabase Reverse Proxy Handler
 * 
 * Securely proxies browser Supabase requests through the backend server.
 * This guarantees reliable operation even if the client browser or network
 * blocks third-party cross-origin requests (e.g., adblockers, strict iframe policies,
 * privacy extensions, or school/regional firewall blocks).
 * 
 * Security constraint: Only forwards requests to the institute's official Supabase project.
 */

function getCleanUrl() {
  const rawUrl = process.env.SUPABASE_URL || 'https://ctwjujnqxkhononxykdc.supabase.co';
  return rawUrl.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  let { url, method = 'GET', headers = {}, body } = req.body || {};
  const supabaseBaseUrl = getCleanUrl();

  let targetUrl = typeof url === 'string' ? url.trim() : '';
  if (targetUrl.startsWith('/')) {
    targetUrl = supabaseBaseUrl + targetUrl;
  }

  if (!targetUrl) {
    return res.status(200).json({
      status: 400,
      statusText: 'Bad Request',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Missing target URL in proxy request', code: 400 })
    });
  }

  // Security: only allow proxying to our configured Supabase project
  const isAllowed = targetUrl.startsWith(supabaseBaseUrl) || 
    targetUrl.startsWith('https://ctwjujnqxkhononxykdc.supabase.co');

  if (!isAllowed) {
    return res.status(200).json({
      status: 403,
      statusText: 'Forbidden',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Forbidden: Target URL must belong to the configured Supabase project.', code: 403 })
    });
  }

  try {
    const forwardHeaders = { ...headers };
    
    // Remove host or origin header that might confuse Cloudflare on Supabase
    delete forwardHeaders['host'];
    delete forwardHeaders['Host'];
    delete forwardHeaders['content-length'];
    delete forwardHeaders['Content-Length'];

    // Ensure apikey is present if missing
    if (!forwardHeaders['apikey'] && !forwardHeaders['Apikey']) {
      const anonKey = process.env.SUPABASE_ANON_KEY || 'sb_publishable_jKPhD4j4mfiAlKu7ljyLbQ_iqJnvcyw';
      forwardHeaders['apikey'] = anonKey;
    }

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: forwardHeaders,
    };

    if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(fetchOptions.method)) {
      fetchOptions.body = typeof body === 'object' ? JSON.stringify(body) : String(body);
    }

    const upstreamRes = await fetch(targetUrl, fetchOptions);
    const responseText = await upstreamRes.text();

    const responseHeaders = {};
    upstreamRes.headers.forEach((val, key) => {
      // Exclude hop-by-hop headers, cookies, and encoding/length headers because text() has already decompressed the body
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
    return res.status(200).json({
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: 'Proxy gateway error connecting to Supabase: ' + (err.message || 'Unknown network error'),
        code: 502,
        error_code: 'proxy_bad_gateway'
      })
    });
  }
}
