/**
 * Trendz Tracker - Supabase Client Initialization
 * Loads @supabase/supabase-js pinned to v2.49.1 from CDN (ES module).
 * Also provides an interactive demo fallback when placeholders are unconfigured.
 */

import { SUPABASE_CONFIG, isSupabaseConfigured } from './config.js';

// Load Supabase ES module from pinned CDN
let supabase = null;

// Initial 24 seeded round categories
export const DEFAULT_ROUND_CATEGORIES = [
  'ADD', 'SUB', 'MIX', 'MULT', 'DIV', 'BRAC',
  'PRIME FACTORS', 'HCF and LCM', 'FRAC +', 'FRAC -', 'FRAC *', 'FRAC ÷',
  'Approximation', 'Remainder', 'Ratio', 'Square Root', 'D.P', 'Next Square',
  'Cube root', 'Next cube', 'Calendar', 'Time Elapsed', 'Sum of Squares', 'Surprise Task'
];

export const DEFAULT_BASICS_CATEGORIES = ['1d4r', '2d2r'];

// In-browser mock state for instant local testing prior to entering live credentials
const DEMO_STORAGE_KEY_STUDENTS = 'trendz_demo_students_v1';
const DEMO_STORAGE_KEY_CATEGORIES = 'trendz_demo_categories_v1';
const DEMO_STORAGE_KEY_AUTH = 'trendz_demo_auth_v1';

function initDemoStorage() {
  if (!localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS)) {
    const initialStudents = [
      { id: 'usr-101', student_code: 'STU101', full_name: 'Aarav Sharma', role: 'student', level: 'Level 3', active: true, created_at: new Date(Date.now() - 86400000 * 5).toISOString() },
      { id: 'usr-102', student_code: 'STU102', full_name: 'Diya Patel', role: 'student', level: 'Level 2', active: true, created_at: new Date(Date.now() - 86400000 * 4).toISOString() },
      { id: 'usr-103', student_code: 'STU103', full_name: 'Kabir Verma', role: 'student', level: 'Level 4', active: true, created_at: new Date(Date.now() - 86400000 * 3).toISOString() },
      { id: 'usr-104', student_code: 'STU104', full_name: 'Ananya Iyer', role: 'student', level: 'Level 1', active: false, created_at: new Date(Date.now() - 86400000 * 2).toISOString() },
      { id: 'usr-105', student_code: 'STU105', full_name: 'Rohan Mehra', role: 'student', level: 'Level 2', active: true, created_at: new Date(Date.now() - 86400000 * 1).toISOString() }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(initialStudents));
  }

  if (!localStorage.getItem(DEMO_STORAGE_KEY_CATEGORIES)) {
    const initialCats = [];
    DEFAULT_ROUND_CATEGORIES.forEach((name, index) => {
      initialCats.push({
        id: `cat-rnd-${index + 1}`,
        name,
        section: 'round',
        sort_order: index + 1,
        active: true,
        created_at: new Date().toISOString()
      });
    });
    DEFAULT_BASICS_CATEGORIES.forEach((name, index) => {
      initialCats.push({
        id: `cat-bas-${index + 1}`,
        name,
        section: 'basics',
        sort_order: index + 1,
        active: true,
        created_at: new Date().toISOString()
      });
    });
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORIES, JSON.stringify(initialCats));
  }
}

// Interactive Mock Database implementation for Demo Mode
export const DemoDB = {
  getStudents() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS) || '[]');
  },
  saveStudents(students) {
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(students));
  },
  addStudent({ student_code, full_name, level }) {
    const students = this.getStudents();
    const cleanCode = student_code.trim().toUpperCase();
    if (students.some(s => s.student_code === cleanCode)) {
      throw new Error(`Student code "${cleanCode}" is already in use.`);
    }
    const newStudent = {
      id: `usr-${Date.now()}`,
      student_code: cleanCode,
      full_name: full_name.trim(),
      role: 'student',
      level: level ? level.trim() : null,
      active: true,
      created_at: new Date().toISOString()
    };
    students.unshift(newStudent);
    this.saveStudents(students);
    return newStudent;
  },
  toggleStudentActive(studentId) {
    const students = this.getStudents();
    const index = students.findIndex(s => s.id === studentId || s.student_code === studentId);
    if (index === -1) throw new Error('Student not found');
    students[index].active = !students[index].active;
    this.saveStudents(students);
    return students[index];
  },
  resetStudentPassword(studentId) {
    const students = this.getStudents();
    const student = students.find(s => s.id === studentId || s.student_code === studentId);
    if (!student) throw new Error('Student not found');
    return true;
  },
  getCategories() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_CATEGORIES) || '[]');
  },
  saveCategories(cats) {
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORIES, JSON.stringify(cats));
  },
  addCategory({ name, section }) {
    const cats = this.getCategories();
    const maxSort = cats
      .filter(c => c.section === section)
      .reduce((max, c) => Math.max(max, c.sort_order || 0), 0);
    const newCat = {
      id: `cat-${Date.now()}`,
      name: name.trim(),
      section,
      sort_order: maxSort + 1,
      active: true,
      created_at: new Date().toISOString()
    };
    cats.push(newCat);
    this.saveCategories(cats);
    return newCat;
  },
  renameCategory(catId, newName) {
    const cats = this.getCategories();
    const target = cats.find(c => c.id === catId);
    if (!target) throw new Error('Category not found');
    target.name = newName.trim();
    this.saveCategories(cats);
    return target;
  },
  toggleCategoryActive(catId) {
    const cats = this.getCategories();
    const target = cats.find(c => c.id === catId);
    if (!target) throw new Error('Category not found');
    target.active = !target.active;
    this.saveCategories(cats);
    return target;
  },
  reorderCategory(catId, direction) {
    const cats = this.getCategories();
    const current = cats.find(c => c.id === catId);
    if (!current) return;
    const sameSection = cats.filter(c => c.section === current.section).sort((a, b) => a.sort_order - b.sort_order);
    const index = sameSection.findIndex(c => c.id === catId);
    if (direction === 'up' && index > 0) {
      const prev = sameSection[index - 1];
      const tempOrder = current.sort_order;
      current.sort_order = prev.sort_order;
      prev.sort_order = tempOrder;
    } else if (direction === 'down' && index < sameSection.length - 1) {
      const next = sameSection[index + 1];
      const tempOrder = current.sort_order;
      current.sort_order = next.sort_order;
      next.sort_order = tempOrder;
    }
    this.saveCategories(cats);
  },
  getDemoAuth() {
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUTH) || 'null');
  },
  setDemoAuth(userProfile) {
    if (!userProfile) {
      localStorage.removeItem(DEMO_STORAGE_KEY_AUTH);
    } else {
      localStorage.setItem(DEMO_STORAGE_KEY_AUTH, JSON.stringify(userProfile));
    }
  }
};

// Auto-detect environments where cross-origin requests to third-party domains are restricted
// (e.g. AI Studio preview iframes, Cloud Run, sandboxes)
const isRestrictedEnv = typeof window !== 'undefined' && (
  window.self !== window.top ||
  window.location.hostname.includes('run.app') ||
  window.location.hostname === 'localhost' ||
  window.location.hostname === '127.0.0.1'
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
    const name = event?.reason?.name || '';
    if (
      msg.includes('Invalid Refresh Token') ||
      msg.includes('Refresh Token Not Found') ||
      msg.includes('refresh_token_not_found') ||
      msg.includes('Failed to fetch') ||
      name === 'AuthApiError'
    ) {
      console.warn('Caught unhandled auth/network rejection. Clearing invalid token from storage if needed.', msg);
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

  let proxyData;
  try {
    proxyData = await proxyRes.json();
  } catch (jsonErr) {
    console.warn('Failed to parse /api/supabase-proxy JSON:', jsonErr);
    return new Response(JSON.stringify({
      message: 'Invalid proxy response envelope',
      code: 502
    }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
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

  // If status is 204 (No Content), 205 (Reset Content), or 304 (Not Modified),
  // WHATWG Response spec requires body to be null, otherwise Response constructor throws TypeError.
  const responseBody = [204, 205, 304].includes(status) ? null : (proxyData.body ?? '');

  try {
    return new Response(responseBody, {
      status,
      statusText: (proxyData.statusText && /^[a-zA-Z0-9\s]+$/.test(proxyData.statusText)) ? proxyData.statusText : undefined,
      headers: safeHeaders
    });
  } catch (resErr) {
    console.warn('Constructing full Response failed, using clean minimal Response:', resErr);
    try {
      return new Response(responseBody, {
        status,
        headers: { 'Content-Type': safeHeaders['content-type'] || 'application/json' }
      });
    } catch {
      return new Response(responseBody, { status: 200 });
    }
  }
}

/**
 * Transparent fetch wrapper: uses proxy when in iframe or when direct fetch is blocked.
 * In restricted environments (iframe sandbox), always proxies without attempting raw direct fetch.
 */
async function smartFetch(input, init = {}) {
  if (isRestrictedEnv) {
    return proxyFetch(input, init);
  }

  try {
    return await fetch(input, init);
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

  if (!isSupabaseConfigured()) {
    return null;
  }

  try {
    let createClient;
    try {
      const mod = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm');
      createClient = mod.createClient;
    } catch (cdnErr) {
      console.warn('CDN import failed, attempting local module import...', cdnErr);
      const mod = await import('@supabase/supabase-js');
      createClient = mod.createClient;
    }

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
