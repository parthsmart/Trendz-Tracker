/**
 * Vercel Serverless Function: /api/config
 * Returns public Supabase URL and anon key safely.
 */

function getCleanUrl() {
  const rawUrl = process.env.SUPABASE_URL || 'https://ctwjujnqxkhononxykdc.supabase.co';
  return rawUrl.trim().replace(/\/rest\/v1\/?$/i, '').replace(/\/+$/, '');
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const cleanUrl = getCleanUrl();
  const anonKey = (process.env.SUPABASE_ANON_KEY || 'sb_publishable_jKPhD4j4mfiAlKu7ljyLbQ_iqJnvcyw').trim();

  return res.status(200).json({
    supabaseUrl: cleanUrl,
    supabaseAnonKey: anonKey,
  });
}
