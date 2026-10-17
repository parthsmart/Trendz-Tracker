/**
 * Trendz Tracker - Client Configuration
 * 
 * IMPORTANT FOR SUPABASE SETUP:
 * 1. Project URL and anon / public key are configured below.
 * 2. URL normalizer automatically strips any trailing `/rest/v1` or slashes.
 * 
 * KEEP SERVICE ROLE KEY SECRET:
 * Never put your service_role key here in the browser!
 * The service_role key belongs ONLY in your server environment variables (Vercel / .env).
 */

const RAW_SUPABASE_URL = "https://ctwjujnqxkhononxykdc.supabase.co";
const RAW_SUPABASE_ANON_KEY = "sb_publishable_jKPhD4j4mfiAlKu7ljyLbQ_iqJnvcyw";

/**
 * Normalizes Supabase Project URL to root domain without /rest/v1 or trailing slashes.
 * E.g., "https://xyz.supabase.co/rest/v1/" -> "https://xyz.supabase.co"
 */
function normalizeSupabaseUrl(url) {
  if (!url) return "";
  return url.trim().replace(/\/rest\/v1\/?$/i, "").replace(/\/+$/, "");
}

export const SUPABASE_CONFIG = {
  url: normalizeSupabaseUrl(RAW_SUPABASE_URL),
  anonKey: RAW_SUPABASE_ANON_KEY.trim(),
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
