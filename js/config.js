/**
 * Trendz Tracker - Client Configuration
 * 
 * IMPORTANT FOR SUPABASE SETUP:
 * 1. Create a free project at https://supabase.com
 * 2. In Project Settings -> API, copy:
 *    - Project URL into 'url' below
 *    - anon / public key into 'anonKey' below
 * 
 * KEEP SERVICE ROLE KEY SECRET:
 * Never put your service_role key here in the browser!
 * The service_role key belongs ONLY in your server environment variables (Vercel / .env).
 */

export const SUPABASE_CONFIG = {
  // Replace these placeholders with your actual Supabase project credentials:
  url: "YOUR_SUPABASE_URL",         // e.g. "https://abcdefghijklmnopqrst.supabase.co"
  anonKey: "YOUR_SUPABASE_ANON_KEY", // e.g. "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
};

/**
 * Checks if real Supabase credentials have been configured.
 */
export function isSupabaseConfigured() {
  const url = SUPABASE_CONFIG.url;
  const key = SUPABASE_CONFIG.anonKey;
  return Boolean(
    url && 
    key && 
    url !== "YOUR_SUPABASE_URL" && 
    key !== "YOUR_SUPABASE_ANON_KEY" &&
    url.startsWith("https://")
  );
}

/**
 * Email domain used for student accounts.
 * Student ID "STU-101" is mapped to "stu-101@trendz.local"
 */
export const AUTH_EMAIL_DOMAIN = "trendz.local";
