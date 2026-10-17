/**
 * Trendz Tracker - Toast Notification Utility
 */

let toastContainer = null;

function ensureToastContainer() {
  if (!toastContainer) {
    toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
      toastContainer = document.createElement('div');
      toastContainer.id = 'toast-container';
      toastContainer.className = 'toast-container';
      document.body.appendChild(toastContainer);
    }
  }
  return toastContainer;
}

/**
 * Shows a toast message.
 * @param {'success' | 'error' | 'info'} type
 * @param {string} message
 * @param {number} durationMs
 */
export function showToast(type, message, durationMs = 4000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');

  const textSpan = document.createElement('span');
  textSpan.textContent = message;

  const closeBtn = document.createElement('button');
  closeBtn.innerHTML = '&times;';
  closeBtn.className = 'modal-close';
  closeBtn.style.padding = '0';
  closeBtn.style.marginLeft = '8px';
  closeBtn.setAttribute('aria-label', 'Close toast');
  closeBtn.onclick = () => {
    toast.remove();
  };

  toast.appendChild(textSpan);
  toast.appendChild(closeBtn);
  container.appendChild(toast);

  if (durationMs > 0) {
    setTimeout(() => {
      if (toast.parentElement) {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        toast.style.transition = 'all 150ms ease';
        setTimeout(() => toast.remove(), 150);
      }
    }, durationMs);
  }
}
