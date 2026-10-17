/**
 * Trendz Tracker - Demo Database Module (js/demoDb.js)
 * 
 * NOTE FOR PRODUCTION LAUNCH:
 * This file contains isolated, fixed static sample data used ONLY when live Supabase
 * credentials are unconfigured/placeholders. When real credentials are configured in
 * js/config.js and .env, this mock mode is strictly disabled and unreachable.
 * This entire file can be safely deleted prior to production launch.
 */

import { isSupabaseConfigured, isDemoAllowedHost } from './config.js';

// Static keys for demo state persistence
const DEMO_STORAGE_KEY_STUDENTS = 'trendz_demo_students_v2';
const DEMO_STORAGE_KEY_CATEGORIES = 'trendz_demo_categories_v2';
const DEMO_STORAGE_KEY_AUTH = 'trendz_demo_auth_v2';
const DEMO_STORAGE_KEY_TODOS = 'trendz_demo_todos_v2';
const DEMO_STORAGE_KEY_RESOURCES = 'trendz_demo_resources_v2';
const DEMO_STORAGE_KEY_RESULTS = 'trendz_demo_results_v2';

export const DEFAULT_ROUND_CATEGORIES = [
  'ADD', 'SUB', 'MIX', 'MULT', 'DIV', 'BRAC',
  'PRIME FACTORS', 'HCF and LCM', 'FRAC +', 'FRAC -', 'FRAC *', 'FRAC ÷',
  'Approximation', 'Remainder', 'Ratio', 'Square Root', 'D.P', 'Next Square',
  'Cube root', 'Next cube', 'Calendar', 'Time Elapsed', 'Sum of Squares', 'Surprise Task'
];

export const DEFAULT_BASICS_CATEGORIES = ['1d4r', '2d2r'];

/**
 * Returns whether Demo Mode is currently active.
 * STRICT SECURITY RULE: Demo mode turns on ONLY when Supabase keys are placeholders
 * AND only on localhost or run.app hosts. On production hostnames, it always returns false.
 */
export function isDemoMode() {
  return !isSupabaseConfigured() && isDemoAllowedHost();
}

/**
 * Initializes static fake data for demo testing.
 */
function initDemoStorage() {
  if (typeof localStorage === 'undefined') return;

  // 1. Initial Students
  if (!localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS)) {
    const initialStudents = [
      { id: 'usr-101', student_code: 'STU101', full_name: 'Aarav Sharma', role: 'student', level: 'Level 3', active: true, created_at: '2026-10-01T10:00:00.000Z' },
      { id: 'usr-102', student_code: 'STU102', full_name: 'Diya Patel', role: 'student', level: 'Level 2', active: true, created_at: '2026-10-02T10:00:00.000Z' },
      { id: 'usr-103', student_code: 'STU103', full_name: 'Kabir Verma', role: 'student', level: 'Level 4', active: true, created_at: '2026-10-03T10:00:00.000Z' },
      { id: 'usr-104', student_code: 'STU104', full_name: 'Ananya Iyer', role: 'student', level: 'Level 1', active: false, created_at: '2026-10-04T10:00:00.000Z' },
      { id: 'usr-105', student_code: 'STU105', full_name: 'Rohan Mehra', role: 'student', level: 'Level 2', active: true, created_at: '2026-10-05T10:00:00.000Z' }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(initialStudents));
  }

  // 2. Initial Categories
  if (!localStorage.getItem(DEMO_STORAGE_KEY_CATEGORIES)) {
    const initialCats = [];
    DEFAULT_ROUND_CATEGORIES.forEach((name, index) => {
      initialCats.push({
        id: `cat-rnd-${index + 1}`,
        name,
        section: 'round',
        sort_order: index + 1,
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      });
    });
    DEFAULT_BASICS_CATEGORIES.forEach((name, index) => {
      initialCats.push({
        id: `cat-bas-${index + 1}`,
        name,
        section: 'basics',
        sort_order: index + 1,
        active: true,
        created_at: '2026-10-01T00:00:00.000Z'
      });
    });
    localStorage.setItem(DEMO_STORAGE_KEY_CATEGORIES, JSON.stringify(initialCats));
  }

  // 3. Initial Resources
  if (!localStorage.getItem(DEMO_STORAGE_KEY_RESOURCES)) {
    const initialResources = [
      {
        id: 'res-1',
        title: 'Junior World Championship Official Rules 2026',
        url: 'https://trendzabacus.com/rules-2026.pdf',
        description: 'Official timing, round structure, and calculation rules for Junior category.',
        topic: 'Championship Guidelines',
        sort_order: 1,
        active: true,
        created_at: '2026-10-10T10:00:00.000Z'
      },
      {
        id: 'res-2',
        title: 'Mental Addition & Subtraction Speed Handbook',
        url: 'https://trendzabacus.com/guides/add-sub-speed.pdf',
        description: 'Tips for rapid 1-digit and 2-digit row visualization without hesitation.',
        topic: 'Calculation Techniques',
        sort_order: 2,
        active: true,
        created_at: '2026-10-11T10:00:00.000Z'
      },
      {
        id: 'res-3',
        title: 'Calendar & Day Calculation Shortcuts',
        url: 'https://trendzabacus.com/guides/calendar-tricks.pdf',
        description: 'Doomsday rule and modular arithmetic shortcuts for calendar tasks.',
        topic: 'Calculation Techniques',
        sort_order: 3,
        active: true,
        created_at: '2026-10-12T10:00:00.000Z'
      },
      {
        id: 'res-4',
        title: 'Daily Practice Routine & Warm-Up Drills',
        url: 'https://trendzabacus.com/practice/warmup.pdf',
        description: 'Structured 20-minute daily regimen prior to competition round simulation.',
        topic: 'Practice Materials',
        sort_order: 4,
        active: true,
        created_at: '2026-10-13T10:00:00.000Z'
      }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_RESOURCES, JSON.stringify(initialResources));
  }

  // 4. Initial To-Dos
  if (!localStorage.getItem(DEMO_STORAGE_KEY_TODOS)) {
    const initialTodos = [
      { id: 'todo-1', title: 'Round Drill: Addition (ADD)', section: 'round', category_id: 'cat-rnd-1', level: null, sort_order: 1, active: true },
      { id: 'todo-2', title: 'Round Drill: Subtraction (SUB)', section: 'round', category_id: 'cat-rnd-2', level: null, sort_order: 2, active: true },
      { id: 'todo-3', title: 'Round Drill: Multiplication (MULT)', section: 'round', category_id: 'cat-rnd-4', level: null, sort_order: 3, active: true },
      { id: 'todo-4', title: 'Round Drill: Division (DIV)', section: 'round', category_id: 'cat-rnd-5', level: null, sort_order: 4, active: true },
      { id: 'todo-5', title: 'Mental Basics: 1-digit 4-rows (1d4r)', section: 'basics', category_id: 'cat-bas-1', level: null, sort_order: 5, active: true },
      { id: 'todo-6', title: 'Mental Basics: 2-digit 2-rows (2d2r)', section: 'basics', category_id: 'cat-bas-2', level: null, sort_order: 6, active: true },
      { id: 'todo-7', title: 'Any Round Competition Task', section: 'round', category_id: null, level: null, sort_order: 7, active: true }
    ];
    localStorage.setItem(DEMO_STORAGE_KEY_TODOS, JSON.stringify(initialTodos));
  }

  // 5. Initial Results (90-day sample data for STU101 across 5 rounds and daily basics)
  if (!localStorage.getItem(DEMO_STORAGE_KEY_RESULTS)) {
    const sampleResults = [];
    const now = new Date();
    
    // Sample rounds: 240, 241, 242, 243, 244
    const rounds = [240, 241, 242, 243, 244];
    rounds.forEach((roundNum, rIdx) => {
      const daysAgo = (4 - rIdx) * 2;
      const roundDate = new Date(now.getTime() - daysAgo * 86400000).toISOString().split('T')[0];
      
      DEFAULT_ROUND_CATEGORIES.forEach((catName, cIdx) => {
        // Some categories in older rounds left unattempted to demonstrate partial rounds
        if (roundNum === 240 && cIdx > 18) return;
        if (roundNum === 241 && cIdx > 20) return;

        const total = 20;
        // High accuracy with occasional realistic mistakes
        let correct = total;
        if (cIdx % 7 === 1) correct = 19;
        else if (cIdx % 7 === 3) correct = 18;
        else if (cIdx % 7 === 5) correct = 17;

        sampleResults.push({
          id: `res-rnd-${roundNum}-${cIdx + 1}`,
          student_id: 'usr-101',
          round_number: roundNum,
          category_id: `cat-rnd-${cIdx + 1}`,
          correct,
          total,
          time_seconds: 45 + (cIdx % 5) * 8,
          note: null,
          entry_date: roundDate,
          created_at: new Date(now.getTime() - daysAgo * 86400000 + cIdx * 60000).toISOString()
        });
      });
    });

    // Sample basics over the last 14 days
    for (let day = 0; day < 14; day++) {
      const dateStr = new Date(now.getTime() - day * 86400000).toISOString().split('T')[0];
      // 1d4r entry
      sampleResults.push({
        id: `res-bas-1d-${day}`,
        student_id: 'usr-101',
        round_number: null,
        category_id: 'cat-bas-1',
        correct: 19 + (day % 2),
        total: 20,
        time_seconds: 32 + (day % 4),
        note: 'Daily speed sprint',
        entry_date: dateStr,
        created_at: new Date(now.getTime() - day * 86400000 + 3600000).toISOString()
      });
      // 2d2r entry
      if (day % 2 === 0) {
        sampleResults.push({
          id: `res-bas-2d-${day}`,
          student_id: 'usr-101',
          round_number: null,
          category_id: 'cat-bas-2',
          correct: 18 + (day % 3 === 0 ? 2 : 1),
          total: 20,
          time_seconds: 40 + (day % 5),
          note: '2-digit concentration',
          entry_date: dateStr,
          created_at: new Date(now.getTime() - day * 86400000 + 7200000).toISOString()
        });
      }
    }

    localStorage.setItem(DEMO_STORAGE_KEY_RESULTS, JSON.stringify(sampleResults));
  }
}

/**
 * Interactive Mock Database implementation for Demo Mode
 */
export const DemoDB = {
  getStudents() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_STUDENTS) || '[]');
  },
  saveStudents(students) {
    localStorage.setItem(DEMO_STORAGE_KEY_STUDENTS, JSON.stringify(students));
  },
  addStudent({ student_code, full_name, level }) {
    if (!isDemoMode()) {
      throw new Error('Action blocked: Demo mode cannot mutate live database.');
    }
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
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_AUTH) || 'null');
  },
  setDemoAuth(userProfile) {
    if (!userProfile) {
      localStorage.removeItem(DEMO_STORAGE_KEY_AUTH);
    } else {
      localStorage.setItem(DEMO_STORAGE_KEY_AUTH, JSON.stringify(userProfile));
    }
  },

  // --------------------------------------------------------------------------
  // Phase 3 Static Sample RPC Mock Implementations (Used ONLY in Demo Mode)
  // --------------------------------------------------------------------------

  /**
   * Mock RPC today_ist() returning current date in Asia/Kolkata
   */
  async mockTodayIST() {
    try {
      const istFormatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      return istFormatter.format(new Date());
    } catch {
      return new Date().toISOString().split('T')[0];
    }
  },

  /**
   * Mock RPC streak_for(p_student) returning fixed static sample data:
   * Streak of 8 days, best 15, 1 shield used/ready, today active.
   */
  async mockStreakFor(_studentId) {
    return {
      current_streak: 8,
      best_streak: 15,
      shields: 1,
      active_today: true
    };
  },

  /**
   * Mock RPC todo_for(p_student) returning fixed static sample tasks:
   * 4 of 7 completed today.
   */
  async mockTodoFor(_studentId) {
    initDemoStorage();
    const todos = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TODOS) || '[]');
    // Return sample status: first 4 done, rest pending
    return todos.filter(t => t.active).map((t, idx) => ({
      task_id: t.id,
      task_title: t.title,
      task_section: t.section,
      task_category_id: t.category_id,
      done: idx < 4 // 4 of 7 done
    }));
  },

  /**
   * Resources table CRUD in Demo Mode
   */
  getResources() {
    initDemoStorage();
    const resources = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESOURCES) || '[]');
    return resources.sort((a, b) => a.sort_order - b.sort_order);
  },
  saveResources(resList) {
    localStorage.setItem(DEMO_STORAGE_KEY_RESOURCES, JSON.stringify(resList));
  },
  addResource({ title, url, description, topic }) {
    if (!isDemoMode()) throw new Error('Blocked in production mode');
    const list = this.getResources();
    const newRes = {
      id: `res-${Date.now()}`,
      title: title.trim(),
      url: url.trim(),
      description: description ? description.trim() : '',
      topic: topic ? topic.trim() : 'General',
      sort_order: list.length + 1,
      active: true,
      created_at: new Date().toISOString()
    };
    list.push(newRes);
    this.saveResources(list);
    return newRes;
  },
  updateResource(id, updates) {
    const list = this.getResources();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) throw new Error('Resource not found');
    list[idx] = { ...list[idx], ...updates };
    this.saveResources(list);
    return list[idx];
  },
  reorderResource(id, direction) {
    const list = this.getResources();
    const idx = list.findIndex(r => r.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx > 0) {
      const prev = list[idx - 1];
      const temp = list[idx].sort_order;
      list[idx].sort_order = prev.sort_order;
      prev.sort_order = temp;
    } else if (direction === 'down' && idx < list.length - 1) {
      const next = list[idx + 1];
      const temp = list[idx].sort_order;
      list[idx].sort_order = next.sort_order;
      next.sort_order = temp;
    }
    this.saveResources(list);
  },
  toggleResourceActive(id) {
    const list = this.getResources();
    const target = list.find(r => r.id === id);
    if (!target) throw new Error('Resource not found');
    target.active = !target.active;
    this.saveResources(list);
    return target;
  },

  /**
   * Daily To-Dos CRUD in Demo Mode
   */
  getTodos() {
    initDemoStorage();
    const todos = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_TODOS) || '[]');
    return todos.sort((a, b) => a.sort_order - b.sort_order);
  },
  saveTodos(todos) {
    localStorage.setItem(DEMO_STORAGE_KEY_TODOS, JSON.stringify(todos));
  },
  addTodo({ title, section, category_id, level }) {
    if (!isDemoMode()) throw new Error('Blocked in production mode');
    const todos = this.getTodos();
    const newTodo = {
      id: `todo-${Date.now()}`,
      title: title.trim(),
      section,
      category_id: category_id || null,
      level: level ? level.trim() : null,
      sort_order: todos.length + 1,
      active: true,
      created_at: new Date().toISOString()
    };
    todos.push(newTodo);
    this.saveTodos(todos);
    return newTodo;
  },
  updateTodo(id, updates) {
    const todos = this.getTodos();
    const idx = todos.findIndex(t => t.id === id);
    if (idx === -1) throw new Error('Task not found');
    todos[idx] = { ...todos[idx], ...updates };
    this.saveTodos(todos);
    return todos[idx];
  },
  reorderTodo(id, direction) {
    const todos = this.getTodos();
    const idx = todos.findIndex(t => t.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx > 0) {
      const prev = todos[idx - 1];
      const temp = todos[idx].sort_order;
      todos[idx].sort_order = prev.sort_order;
      prev.sort_order = temp;
    } else if (direction === 'down' && idx < todos.length - 1) {
      const next = todos[idx + 1];
      const temp = todos[idx].sort_order;
      todos[idx].sort_order = next.sort_order;
      next.sort_order = temp;
    }
    this.saveTodos(todos);
  },
  toggleTodoActive(id) {
    const todos = this.getTodos();
    const target = todos.find(t => t.id === id);
    if (!target) throw new Error('Task not found');
    target.active = !target.active;
    this.saveTodos(todos);
    return target;
  },

  /**
   * Historical results for STU101 in Demo Mode
   */
  getResults() {
    initDemoStorage();
    return JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY_RESULTS) || '[]');
  },

  /**
   * Static sample data for the Admin Overview in Demo Mode.
   * Matches the public.admin_overview() RPC return contract.
   * Zero JavaScript streak calculation; strictly static pre-computed numbers.
   */
  getAdminOverview() {
    return [
      {
        student_id: 'usr-101',
        student_code: 'STU101',
        full_name: 'Aarav Sharma',
        level: 'Level 3',
        active: true,
        current_streak: 8,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 14,
        accuracy_7d: 91.5
      },
      {
        student_id: 'usr-102',
        student_code: 'STU102',
        full_name: 'Diya Patel',
        level: 'Level 2',
        active: true,
        current_streak: 5,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 10,
        accuracy_7d: 87.0
      },
      {
        student_id: 'usr-103',
        student_code: 'STU103',
        full_name: 'Kabir Verma',
        level: 'Level 4',
        active: true,
        current_streak: 12,
        entered_today: false,
        last_entry_date: '2026-10-16',
        entries_7d: 8,
        accuracy_7d: 94.2
      },
      {
        student_id: 'usr-104',
        student_code: 'STU104',
        full_name: 'Ananya Iyer',
        level: 'Level 1',
        active: false,
        current_streak: 0,
        entered_today: false,
        last_entry_date: '2026-09-28',
        entries_7d: 0,
        accuracy_7d: null
      },
      {
        student_id: 'usr-105',
        student_code: 'STU105',
        full_name: 'Rohan Mehra',
        level: 'Level 2',
        active: true,
        current_streak: 0,
        entered_today: false,
        last_entry_date: '2026-10-12', // 5 days ago -> Needs attention
        entries_7d: 2,
        accuracy_7d: 78.4
      },
      {
        student_id: 'usr-106',
        student_code: 'STU106',
        full_name: 'Mira Joshi',
        level: 'Level 3',
        active: true,
        current_streak: 0,
        entered_today: false,
        last_entry_date: '2026-10-13', // 4 days ago -> Needs attention
        entries_7d: 3,
        accuracy_7d: 82.1
      },
      {
        student_id: 'usr-107',
        student_code: 'STU107',
        full_name: 'Arjun Nair',
        level: 'Master',
        active: true,
        current_streak: 22,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 18,
        accuracy_7d: 96.8
      },
      {
        student_id: 'usr-108',
        student_code: 'STU108',
        full_name: 'Riya Sen',
        level: 'Level 2',
        active: true,
        current_streak: 3,
        entered_today: false,
        last_entry_date: '2026-10-16',
        entries_7d: 6,
        accuracy_7d: 89.2
      },
      {
        student_id: 'usr-109',
        student_code: 'STU109',
        full_name: 'Vivaan Gupta',
        level: 'Level 1',
        active: true,
        current_streak: 1,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 5,
        accuracy_7d: 85.0
      },
      {
        student_id: 'usr-110',
        student_code: 'STU110',
        full_name: 'Meera Rao',
        level: 'Level 4',
        active: true,
        current_streak: 15,
        entered_today: true,
        last_entry_date: '2026-10-17',
        entries_7d: 12,
        accuracy_7d: 93.4
      }
    ];
  }
};
