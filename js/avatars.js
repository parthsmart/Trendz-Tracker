/**
 * Trendz Tracker - student profile photos (js/avatars.js)
 *
 * Photos live in the private Supabase Storage bucket `avatars` under `<student uid>/<file>.jpg`.
 * The browser shrinks every photo to a 256px square JPEG before upload, then the
 * `set_my_avatar` RPC records it on the profile (the database checks the folder is the
 * caller's own). Pages show photos through short-lived signed URLs; the database decides
 * who may see a photo (`avatar_path` comes back null when names are hidden).
 *
 * A student who picked a cartoon avatar gets a `look:1|...` token in `avatar_path`
 * instead (from avatar_visible() in SQL). signAvatarUrls turns those tokens into inline
 * SVG data URIs, so every page shows avatars without any change of its own.
 */

import { getSupabase } from './supabaseClient.js';
import { isLookToken, lookTokenDataUri } from '../shared/avatarArt.js';

export const AVATAR_BUCKET = 'avatars';
export const AVATAR_SIZE = 256;
export const AVATAR_MAX_INPUT_BYTES = 10 * 1024 * 1024;
const AVATAR_PATH_RE = /^[0-9a-f-]{36}\/[A-Za-z0-9_-]{1,64}\.(jpg|png|webp)$/;
const URL_TTL_SECONDS = 3600;
const urlCache = new Map(); // path -> { url, expires }

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function isAvatarPath(path) {
  return typeof path === 'string' && AVATAR_PATH_RE.test(path);
}

/** True for a photo path or a cartoon avatar token. */
export function isAvatarRef(value) {
  return isAvatarPath(value) || isLookToken(value);
}

/** First letter for the fallback circle. */
export function avatarInitial(name) {
  const ch = String(name ?? '').trim().charAt(0).toUpperCase();
  return ch || '?';
}

/**
 * Round avatar: the photo when `url` is set, otherwise the initial letter.
 * `size` is in px. `extraClass` is added to the wrapper.
 */
export function avatarHtml(url, name, size = 32, extraClass = '') {
  const s = Math.max(16, Math.round(Number(size) || 32));
  const cls = `tt-av${extraClass ? ` ${extraClass}` : ''}`;
  const style = `width:${s}px;height:${s}px;font-size:${Math.round(s * 0.42)}px`;
  if (url) {
    return `<span class="${cls}" style="${style}"><img src="${escapeHtml(url)}" alt="" loading="lazy" decoding="async" /></span>`;
  }
  return `<span class="${cls}" style="${style}" aria-hidden="true">${escapeHtml(avatarInitial(name))}</span>`;
}

/** Shared avatar styles (injected once). */
export function ensureAvatarStyles(doc = globalThis.document) {
  if (!doc || doc.getElementById('tt-avatar-style')) return;
  const style = doc.createElement('style');
  style.id = 'tt-avatar-style';
  style.textContent = `
    .tt-av { display: inline-grid; place-items: center; flex: none; border-radius: 50%; overflow: hidden; background: var(--color-primary, #2563eb); color: #fff; font-weight: 800; line-height: 1; vertical-align: middle; }
    .tt-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
  `;
  doc.head.appendChild(style);
}

/**
 * Signed URLs for avatar paths. Returns a Map(path -> url); missing paths are left out.
 * Never throws.
 */
export async function signAvatarUrls(paths) {
  const out = new Map();
  const now = Date.now();
  for (const t of new Set((paths || []).filter(isLookToken))) {
    const uri = lookTokenDataUri(t);
    if (uri) out.set(t, uri);
  }
  const wanted = [...new Set((paths || []).filter(isAvatarPath))];
  const toSign = [];
  for (const p of wanted) {
    const hit = urlCache.get(p);
    if (hit && hit.expires > now) out.set(p, hit.url);
    else toSign.push(p);
  }
  if (!toSign.length) return out;
  let supabase = null;
  try {
    supabase = await getSupabase();
  } catch {
    supabase = null;
  }
  if (!supabase?.storage) return out;
  try {
    const { data, error } = await supabase.storage.from(AVATAR_BUCKET).createSignedUrls(toSign, URL_TTL_SECONDS);
    if (error || !Array.isArray(data)) return out;
    for (const row of data) {
      if (row?.path && row?.signedUrl) {
        out.set(row.path, row.signedUrl);
        urlCache.set(row.path, { url: row.signedUrl, expires: now + (URL_TTL_SECONDS - 120) * 1000 });
      }
    }
  } catch {
    // Photos are decoration: fall back to initials.
  }
  return out;
}

export async function signAvatarUrl(path) {
  if (isLookToken(path)) return lookTokenDataUri(path);
  if (!isAvatarPath(path)) return null;
  const map = await signAvatarUrls([path]);
  return map.get(path) || null;
}

/** Centre square of an image of size (w, h): { sx, sy, side }. */
export function centreSquare(w, h) {
  const side = Math.max(1, Math.min(Number(w) || 1, Number(h) || 1));
  return { sx: Math.round(((Number(w) || side) - side) / 2), sy: Math.round(((Number(h) || side) - side) / 2), side };
}

/** Checks a picked file before reading it. Returns an error message or ''. */
export function validateAvatarFile(file) {
  if (!file) return 'Choose a photo first.';
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '') && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || '')) {
    return 'Please choose a JPG, PNG or WebP photo.';
  }
  if (file.size > AVATAR_MAX_INPUT_BYTES) return 'That photo is too large. Please choose one under 10 MB.';
  return '';
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('We could not read that photo. Please try another one.'));
    };
    img.src = url;
  });
}

/** Shrinks a photo to a centred AVATAR_SIZE square JPEG Blob. */
export async function shrinkAvatar(file) {
  const img = await loadImage(file);
  const { sx, sy, side } = centreSquare(img.naturalWidth || img.width, img.naturalHeight || img.height);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_SIZE, AVATAR_SIZE);
  ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('We could not prepare that photo. Please try another one.');
  return blob;
}

function randomName() {
  const bytes = new Uint8Array(9);
  (globalThis.crypto || window.crypto).getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Uploads a new photo for the signed-in student. Returns { path, url }. Throws a friendly Error. */
export async function uploadAvatar(file, userId) {
  const problem = validateAvatarFile(file);
  if (problem) throw new Error(problem);
  const supabase = await getSupabase();
  if (!supabase?.storage) throw new Error('Photos need an internet connection to the school server.');
  const blob = await shrinkAvatar(file);
  const path = `${userId}/${randomName()}.jpg`;
  const { error: upErr } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false, cacheControl: '3600' });
  if (upErr) throw new Error('The photo could not be uploaded. Please try again.');
  const { data, error } = await supabase.rpc('set_my_avatar', { p_path: path });
  if (error) {
    await supabase.storage.from(AVATAR_BUCKET).remove([path]).catch(() => {});
    throw new Error('The photo could not be saved. Please try again.');
  }
  const oldPath = data?.old_path;
  if (isAvatarPath(oldPath) && oldPath !== path) {
    urlCache.delete(oldPath);
    await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]).catch(() => {});
  }
  return { path, url: await signAvatarUrl(path) };
}

/** Removes a photo (own, or a student's when the caller may moderate). */
export async function removeAvatar(studentId = null) {
  const supabase = await getSupabase();
  if (!supabase) throw new Error('Photos need an internet connection to the school server.');
  const { data, error } = await supabase.rpc('clear_avatar', { p_student: studentId });
  if (error) throw new Error('The photo could not be removed. Please try again.');
  const oldPath = data?.old_path;
  if (isAvatarPath(oldPath)) {
    urlCache.delete(oldPath);
    await supabase.storage.from(AVATAR_BUCKET).remove([oldPath]).catch(() => {});
  }
}
