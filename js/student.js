/**
 * Trendz Tracker - Student Home Module
 */

import { requireAuth } from './guard.js';

async function initStudentHome() {
  // Guard page: allow only 'student' (and 'admin' testing)
  const profile = await requireAuth(['student', 'admin']);
  if (!profile) return;

  // Render profile info in the welcome hero
  const displayName = document.getElementById('student-display-name');
  const displayCode = document.getElementById('student-display-code');
  const displayLevel = document.getElementById('student-display-level');
  const displayStatus = document.getElementById('student-display-status');
  const pillContainer = document.getElementById('user-pill-container');

  if (displayName) displayName.textContent = profile.full_name;
  if (displayCode) displayCode.textContent = profile.student_code;
  if (displayLevel) displayLevel.textContent = profile.level || 'Not Assigned';
  if (displayStatus) displayStatus.textContent = profile.active ? 'Active' : 'Inactive';
  if (pillContainer) pillContainer.style.display = 'flex';
}

document.addEventListener('DOMContentLoaded', initStudentHome);
