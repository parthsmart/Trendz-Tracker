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
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm');
    supabase = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
    return supabase;
  } catch (err) {
    console.error('Failed to initialize Supabase client from CDN:', err);
    return null;
  }
}
