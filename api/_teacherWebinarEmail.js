export function normalizeCohostEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && !email.endsWith('.local') ? email : '';
}

export function getTeacherWebinarEmail(user) {
  return normalizeCohostEmail(user.app_metadata?.webinar_cohost_email) ||
    (user.email_confirmed_at ? normalizeCohostEmail(user.email) : '');
}
