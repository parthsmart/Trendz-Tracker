/**
 * Trendz Tracker - Private Student Messages Client Helper (js/studentMessages.js)
 *
 * Provides client-side helpers to send private notes and flags to students,
 * validate inputs, and ensure idempotency.
 */

import { isSupabaseConfigured } from './config.js';
import { isDemoMode, DemoDB } from './demoDb.js';
import { getSupabase } from './supabaseClient.js';

/**
 * Sends a private message/flag from an admin to a student.
 *
 * @param {{
 *   studentId: string,
 *   title: string,
 *   body: string,
 *   needsAttention?: boolean,
 *   attentionReason?: string|null,
 *   linkedType?: 'score'|'weekly_test'|'attempt'|null,
 *   linkedId?: string|null,
 *   clientNonce?: string|null
 * }} params
 * @returns {Promise<Record<string, any>>}
 */
export async function sendStudentMessage({
  studentId,
  title,
  body,
  needsAttention = false,
  attentionReason = null,
  linkedType = null,
  linkedId = null,
  clientNonce = null,
}) {
  if (!studentId) {
    throw new Error('Please select a student.');
  }

  const cleanTitle = String(title || '').trim();
  const cleanBody = String(body || '').trim();
  const cleanReason = attentionReason ? String(attentionReason).trim() : null;

  if (!cleanTitle || cleanTitle.length > 120) {
    throw new Error('Title is required and must not exceed 120 characters.');
  }

  if (!cleanBody || cleanBody.length > 2000) {
    throw new Error('Message body is required and must not exceed 2000 characters.');
  }

  // Generate an idempotency nonce if not provided
  const nonce = clientNonce || `msg-nonce-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  if (isSupabaseConfigured()) {
    const supabase = await getSupabase();
    if (!supabase) throw new Error('Supabase client unavailable');

    const { data, error } = await supabase.rpc('admin_send_student_message', {
      p_student_id: studentId,
      p_title: cleanTitle,
      p_body: cleanBody,
      p_needs_attention: Boolean(needsAttention),
      p_attention_reason: cleanReason,
      p_linked_type: linkedType || null,
      p_linked_id: linkedId || null,
      p_client_nonce: nonce,
    });

    if (error) {
      throw new Error(error.message || 'Failed to send student message');
    }

    return data;
  }

  if (isDemoMode() && DemoDB && typeof DemoDB.sendStudentMessage === 'function') {
    return DemoDB.sendStudentMessage({
      studentId,
      title: cleanTitle,
      body: cleanBody,
      needsAttention: Boolean(needsAttention),
      attentionReason: cleanReason,
      linkedType: linkedType || null,
      linkedId: linkedId || null,
      clientNonce: nonce,
    });
  }

  throw new Error('Backend unavailable to send message');
}

/**
 * Marks a student private message as read.
 *
 * @param {string} messageId
 * @returns {Promise<boolean>}
 */
export async function markStudentMessageRead(messageId) {
  if (!messageId) return false;

  if (isSupabaseConfigured()) {
    try {
      const supabase = await getSupabase();
      if (!supabase) return false;
      const { data, error } = await supabase.rpc('mark_student_message_read', {
        p_msg_id: messageId,
      });
      if (error) return false;
      return Boolean(data);
    } catch {
      return false;
    }
  }

  if (isDemoMode() && DemoDB && typeof DemoDB.markStudentMessageRead === 'function') {
    return DemoDB.markStudentMessageRead(null, messageId);
  }

  return false;
}
