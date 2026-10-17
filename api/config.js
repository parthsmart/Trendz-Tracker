/**
 * Vercel Serverless Function: /api/config
 * Returns public Supabase URL and anon key safely.
 */

import { getSupabaseServerConfig } from './_configHelper.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  try {
    const { url, anonKey } = getSupabaseServerConfig();
    return res.status(200).json({
      supabaseUrl: url,
      supabaseAnonKey: anonKey,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Supabase configuration error: SUPABASE_URL and SUPABASE_ANON_KEY must be properly configured in environment variables.'
    });
  }
}
