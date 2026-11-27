/**
 * Trendz Tracker - printable certificate (js/certificate.js)
 *
 * /pages/certificate.html?badge=<key>[&student=<id>]
 * Shows a certificate for an earned tier, award or league badge, built from the
 * `my_profile` RPC (the database decides what was earned and when). Print or save as PDF.
 */

import { requireAuth } from './guard.js';
import { callXpRpc } from './xpRewards.js';
import { buildCertificateModel } from './arenaView.js';

const $ = (id) => document.getElementById(id);

async function initCertificatePage() {
  const viewer = await requireAuth(['student', 'teacher', 'admin']);
  if (!viewer) return;
  const params = new URLSearchParams(window.location.search);
  const badge = params.get('badge') || '';
  const student = params.get('student');
  const status = $('ce-status');
  if (viewer.role !== 'student' && !(student && /^[0-9a-f-]{36}$/i.test(student))) {
    status.textContent = 'Open certificates from a student’s profile.';
    return;
  }
  if (viewer.role !== 'student') {
    $('ce-back').href = `/pages/profile.html?student=${encodeURIComponent(student)}`;
  }
  const data = await callXpRpc('my_profile', viewer.role === 'student' ? {} : { p_student: student });
  const model = data ? buildCertificateModel(data, badge) : null;
  if (!model) {
    status.textContent = 'This certificate is not available yet — the badge has not been earned.';
    return;
  }
  $('ce-name').textContent = model.name;
  $('ce-icon').textContent = model.icon || '🏅';
  $('ce-title').textContent = model.title;
  $('ce-detail').textContent = model.detail;
  $('ce-date').textContent = model.date;
  $('ce-level').textContent = model.level || '—';
  document.title = `${model.title} certificate - Trendz Tracker`;
  status.hidden = true;
  $('ce-sheet').hidden = false;
  const print = $('ce-print');
  print.disabled = false;
  print.addEventListener('click', () => window.print());
}

if (typeof document !== 'undefined') {
  document.addEventListener('DOMContentLoaded', initCertificatePage);
}
