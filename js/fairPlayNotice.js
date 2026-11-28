/**
 * Student-side fair-play notice. When the server saved a result but sent it to a teacher for a
 * quick check, it answers with { under_review: true, review_message }. The wording is always
 * friendly; students never see the reasons.
 */
import { showToast } from './toast.js';
import { UNDER_REVIEW_MESSAGE } from '../shared/fairPlay.js';

export function fairPlayNoticeText(data) {
  if (!data || data.under_review !== true) return '';
  return typeof data.review_message === 'string' && data.review_message.trim()
    ? data.review_message.trim()
    : UNDER_REVIEW_MESSAGE;
}

export function showFairPlayNotice(data) {
  const text = fairPlayNoticeText(data);
  if (text) showToast('info', text, 8000);
  return Boolean(text);
}
