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
  return showActionToast(type, message, null, null, durationMs);
}

/**
 * Shows a toast message with an optional action button (e.g. "Undo").
 * @param {'success' | 'error' | 'info'} type
 * @param {string} message
 * @param {string|null} actionLabel
 * @param {(() => void)|null} onAction
 * @param {number} [durationMs=5000]
 */
export function showActionToast(type, message, actionLabel = null, onAction = null, durationMs = 5000) {
  const container = ensureToastContainer();
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', 'alert');

  const textSpan = document.createElement('span');
  textSpan.textContent = message;
  toast.appendChild(textSpan);

  if (actionLabel && typeof onAction === 'function') {
    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.className = 'btn btn-outline btn-sm';
    actionBtn.style.marginLeft = '10px';
    actionBtn.style.padding = '2px 8px';
    actionBtn.style.fontSize = '12px';
    actionBtn.style.fontWeight = '700';
    actionBtn.textContent = actionLabel;
    actionBtn.onclick = () => {
      toast.remove();
      onAction();
    };
    toast.appendChild(actionBtn);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.innerHTML = '&times;';
  closeBtn.className = 'modal-close';
  closeBtn.style.padding = '0';
  closeBtn.style.marginLeft = '8px';
  closeBtn.setAttribute('aria-label', 'Close toast');
  closeBtn.onclick = () => {
    toast.remove();
  };

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

  return toast;
}
