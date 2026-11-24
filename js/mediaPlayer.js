/**
 * Trendz Tracker — Shared Media Player Component (js/mediaPlayer.js)
 *
 * Used by:
 * 1. Resources -> Lectures (Student & Teacher catalogue viewer)
 * 2. Admin Live Classes -> Recordings Library (Admin private playback)
 *
 * Implements:
 * - Surface: Deep navy (#0f172a, #1e293b), orange accents (#f97316), contrast text (#f8fafc)
 * - Native HTML5 video controls with sleek custom overlay
 * - Play/Pause, 10s skip back/forward, scrub bar, time display, volume, speed (0.75x..2x), fullscreen
 * - Keyboard shortcuts: Space, Left/Right Arrows, M, F
 * - Scoped resume from last watched point (localStorage per userId + mediaId)
 * - Embed fallback for Google Drive / external embeds with responsive 16:9 framing and queue navigation
 */

export function formatDuration(seconds) {
  if (isNaN(seconds) || seconds < 0) return '00:00';
  const s = Math.floor(seconds);
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hrs > 0) {
    const hh = String(hrs).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

export class TrendzMediaPlayer {
  constructor(container, options = {}) {
    if (!container) {
      throw new Error('[TrendzMediaPlayer] A valid container element is required.');
    }
    this.container = container;
    this.options = { ...options };
    this.userId = options.userId || 'guest';
    this.mediaId = options.mediaId || null;
    this.mediaType = options.mediaType || 'video_mp4'; // 'video_mp4' | 'drive_embed' | 'youtube_embed' | 'hls'
    this.mediaUrl = options.mediaUrl || '';
    this.title = options.title || 'Lecture Video';
    this.category = options.category || '';
    this.lessonOrder = options.lessonOrder || 1;
    this.totalLessons = options.totalLessons || 1;
    this.hasNext = Boolean(options.hasNext);
    this.hasPrevious = Boolean(options.hasPrevious);
    this.onNext = options.onNext || null;
    this.onPrevious = options.onPrevious || null;

    this.video = null;
    this.iframe = null;
    this.hideControlsTimer = null;
    this.isScrubbing = false;
    this.boundKeyHandler = this.handleKeyDown.bind(this);

    this.render();
  }

  getStorageKey() {
    return `trendz_playback_${this.userId}_${this.mediaId || 'default'}`;
  }

  getSavedPosition() {
    try {
      const val = localStorage.getItem(this.getStorageKey());
      return val ? Number(val) : 0;
    } catch (_) {
      return 0;
    }
  }

  savePosition(time) {
    if (!this.mediaId) return;
    try {
      localStorage.setItem(this.getStorageKey(), String(Math.floor(time)));
    } catch (_) {}
  }

  clearSavedPosition() {
    if (!this.mediaId) return;
    try {
      localStorage.removeItem(this.getStorageKey());
    } catch (_) {}
  }

  render() {
    this.container.innerHTML = '';
    if (this.container.classList?.add) {
      this.container.classList.add('trendz-player-container');
    }
    this.container.tabIndex = 0; // Focusable for keyboard shortcuts

    if (this.mediaType === 'drive_embed' || this.mediaType === 'youtube_embed' || this.isEmbedUrl(this.mediaUrl)) {
      this.renderEmbed();
    } else {
      this.renderNative();
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', this.boundKeyHandler);
    }
  }

  isEmbedUrl(url) {
    if (!url) return false;
    return (
      url.includes('drive.google.com') ||
      url.includes('youtube.com') ||
      url.includes('youtu.be') ||
      url.includes('/preview') ||
      url.includes('/embed')
    );
  }

  normalizeDriveEmbedUrl(url) {
    if (!url) return '';
    // If it's a drive file link like https://drive.google.com/file/d/ID/view, convert to /preview
    if (url.includes('drive.google.com/file/d/')) {
      const match = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (match && match[1]) {
        return `https://drive.google.com/file/d/${match[1]}/preview`;
      }
    }
    return url;
  }

  renderEmbed() {
    const embedUrl = this.normalizeDriveEmbedUrl(this.mediaUrl);
    const hasCategory = Boolean(this.category);

    this.container.innerHTML = `
      <div class="trendz-player-stage">
        <iframe
          class="trendz-player-embed-frame"
          src="${embedUrl}"
          allow="autoplay; encrypted-media; fullscreen"
          allowfullscreen
          title="${this.title}"
        ></iframe>
      </div>
      <div class="trendz-player-nav-bar">
        <div class="trendz-player-nav-title">
          ${hasCategory ? `<span class="trendz-player-nav-badge">${this.category}</span>` : ''}
          <span>${this.title}</span>
          ${this.totalLessons > 1 ? `<span style="font-size: 11px; color: #94a3b8;">(${this.lessonOrder} of ${this.totalLessons})</span>` : ''}
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="trendz-player-btn btn-player-prev" ${!this.hasPrevious ? 'disabled' : ''} title="Previous Lesson">
            <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
          </button>
          <button type="button" class="trendz-player-btn btn-player-next" ${!this.hasNext ? 'disabled' : ''} title="Next Lesson">
            <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
          </button>
          <button type="button" class="trendz-player-btn btn-player-fs" title="Fullscreen">
            <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
          </button>
        </div>
      </div>
    `;

    this.container.querySelector('.btn-player-prev')?.addEventListener('click', () => {
      if (this.onPrevious) this.onPrevious();
    });

    this.container.querySelector('.btn-player-next')?.addEventListener('click', () => {
      if (this.onNext) this.onNext();
    });

    this.container.querySelector('.btn-player-fs')?.addEventListener('click', () => {
      this.toggleFullscreen();
    });
  }

  renderNative() {
    this.container.innerHTML = `
      <div class="trendz-player-stage">
        <video class="trendz-player-video" playsinline preload="metadata" src="${this.mediaUrl}"></video>

        <!-- Loading spinner -->
        <div class="trendz-player-spinner-overlay" style="display: none;">
          <div class="trendz-player-spinner"></div>
          <div class="trendz-player-spinner-text">Buffering lecture...</div>
        </div>

        <!-- Big Play Button -->
        <button type="button" class="trendz-player-big-play" aria-label="Play video">
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        </button>

        <!-- Error State -->
        <div class="trendz-player-error-overlay" style="display: none;">
          <div class="trendz-player-error-icon">⚠️</div>
          <div class="trendz-player-error-title">Unable to play video</div>
          <div class="trendz-player-error-msg">The media stream could not be loaded or network connection timed out.</div>
          <button type="button" class="trendz-player-retry-btn">Try again</button>
        </div>

        <!-- Toast message -->
        <div class="trendz-player-toast"></div>

        <!-- Top Header -->
        <div class="trendz-player-header">
          <div class="trendz-player-title-wrap">
            ${this.category ? `<span class="trendz-player-category-tag">${this.category}</span>` : ''}
            <span class="trendz-player-title">${this.title}</span>
          </div>
          <div style="display: flex; gap: 6px;">
            <button type="button" class="trendz-player-btn btn-player-prev" ${!this.hasPrevious ? 'disabled' : ''} title="Previous (P)">
              <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6l8.5 6V6z"/></svg>
            </button>
            <button type="button" class="trendz-player-btn btn-player-next" ${!this.hasNext ? 'disabled' : ''} title="Next (N)">
              <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
            </button>
          </div>
        </div>

        <!-- Controls overlay -->
        <div class="trendz-player-controls">
          <!-- Scrub bar -->
          <div class="trendz-player-scrub-bar" role="slider" aria-label="Seek slider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
            <div class="trendz-player-buffered"></div>
            <div class="trendz-player-progress">
              <div class="trendz-player-scrub-handle"></div>
            </div>
          </div>

          <!-- Bottom controls row -->
          <div class="trendz-player-bottom-row">
            <div class="trendz-player-left-group">
              <button type="button" class="trendz-player-btn btn-play-pause" aria-label="Play">
                <svg class="icon-play" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                <svg class="icon-pause" viewBox="0 0 24 24" style="display: none;"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
              </button>

              <button type="button" class="trendz-player-btn btn-skip-back" title="Rewind 10s (Left Arrow)" aria-label="Rewind 10 seconds">
                <svg viewBox="0 0 24 24"><path d="M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.2 3.16-1.98 5.12-1.98 3.73 0 6.84 2.55 7.73 6h2.08c-.97-4.57-5.01-8-9.81-8z"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" fill="currentColor">10</text></svg>
              </button>

              <button type="button" class="trendz-player-btn btn-skip-fwd" title="Fast Forward 10s (Right Arrow)" aria-label="Fast forward 10 seconds">
                <svg viewBox="0 0 24 24"><path d="M11.5 8c2.65 0 5.05.99 6.9 2.6L22 7v9h-9l3.62-3.62c-1.39-1.2-3.16-1.98-5.12-1.98-3.73 0-6.84 2.55-7.73 6H1.69c.97-4.57 5.01-8 9.81-8z"/><text x="12" y="16" font-size="6" font-weight="bold" text-anchor="middle" fill="currentColor">10</text></svg>
              </button>

              <div class="trendz-player-volume-wrap">
                <button type="button" class="trendz-player-btn btn-volume" aria-label="Mute (M)">
                  <svg class="icon-vol-on" viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>
                  <svg class="icon-vol-off" viewBox="0 0 24 24" style="display: none;"><path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/></svg>
                </button>
                <input type="range" class="trendz-player-volume-slider" min="0" max="1" step="0.05" value="1" aria-label="Volume">
              </div>

              <div class="trendz-player-time">
                <span class="trendz-player-time-current">00:00</span>
                <span> / </span>
                <span class="trendz-player-time-total">00:00</span>
              </div>
            </div>

            <div class="trendz-player-right-group">
              <select class="trendz-player-speed-select" aria-label="Playback Speed">
                <option value="0.75">0.75x</option>
                <option value="1" selected>1.0x</option>
                <option value="1.25">1.25x</option>
                <option value="1.5">1.5x</option>
                <option value="2">2.0x</option>
              </select>

              <button type="button" class="trendz-player-btn btn-fullscreen" aria-label="Fullscreen (F)">
                <svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
              </button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.video = this.container.querySelector('video');
    this.attachNativeEvents();
  }

  attachNativeEvents() {
    const stage = this.container.querySelector('.trendz-player-stage');
    const video = this.video;
    if (!stage || !video || typeof stage.addEventListener !== 'function') return;
    const playBtn = this.container.querySelector('.btn-play-pause');
    const bigPlayBtn = this.container.querySelector('.trendz-player-big-play');
    const iconPlay = this.container.querySelector('.icon-play');
    const iconPause = this.container.querySelector('.icon-pause');
    const scrubBar = this.container.querySelector('.trendz-player-scrub-bar');
    const progressBar = this.container.querySelector('.trendz-player-progress');
    const bufferedBar = this.container.querySelector('.trendz-player-buffered');
    const timeCurrent = this.container.querySelector('.trendz-player-time-current');
    const timeTotal = this.container.querySelector('.trendz-player-time-total');
    const skipBackBtn = this.container.querySelector('.btn-skip-back');
    const skipFwdBtn = this.container.querySelector('.btn-skip-fwd');
    const volBtn = this.container.querySelector('.btn-volume');
    const volSlider = this.container.querySelector('.trendz-player-volume-slider');
    const iconVolOn = this.container.querySelector('.icon-vol-on');
    const iconVolOff = this.container.querySelector('.icon-vol-off');
    const speedSelect = this.container.querySelector('.trendz-player-speed-select');
    const fsBtn = this.container.querySelector('.btn-fullscreen');
    const spinner = this.container.querySelector('.trendz-player-spinner-overlay');
    const errorOverlay = this.container.querySelector('.trendz-player-error-overlay');
    const retryBtn = this.container.querySelector('.trendz-player-retry-btn');
    const header = this.container.querySelector('.trendz-player-header');
    const controls = this.container.querySelector('.trendz-player-controls');

    // Controls autohide logic
    const showControls = () => {
      header.classList.remove('is-hidden');
      controls.classList.remove('is-hidden');
      if (this.hideControlsTimer) clearTimeout(this.hideControlsTimer);
      if (!video.paused) {
        this.hideControlsTimer = setTimeout(() => {
          header.classList.add('is-hidden');
          controls.classList.add('is-hidden');
        }, 3000);
      }
    };

    stage.addEventListener('mousemove', showControls);
    stage.addEventListener('touchstart', showControls, { passive: true });

    // Video Playback State Updates
    const updatePlayState = () => {
      if (video.paused) {
        iconPlay.style.display = 'block';
        iconPause.style.display = 'none';
        bigPlayBtn.style.display = 'flex';
        showControls();
      } else {
        iconPlay.style.display = 'none';
        iconPause.style.display = 'block';
        bigPlayBtn.style.display = 'none';
        showControls();
      }
    };

    video.addEventListener('play', updatePlayState);
    video.addEventListener('pause', updatePlayState);
    video.addEventListener('waiting', () => {
      spinner.style.display = 'flex';
    });
    video.addEventListener('playing', () => {
      spinner.style.display = 'none';
      errorOverlay.style.display = 'none';
    });
    video.addEventListener('canplay', () => {
      spinner.style.display = 'none';
    });

    video.addEventListener('error', () => {
      spinner.style.display = 'none';
      errorOverlay.style.display = 'flex';
    });

    retryBtn.addEventListener('click', () => {
      errorOverlay.style.display = 'none';
      spinner.style.display = 'flex';
      video.load();
      video.play().catch(() => {});
    });

    // Time & Progress Updates
    video.addEventListener('loadedmetadata', () => {
      timeTotal.textContent = formatDuration(video.duration);
      // Check saved progress
      const savedPos = this.getSavedPosition();
      if (savedPos > 3 && savedPos < (video.duration - 3)) {
        video.currentTime = savedPos;
        this.showToast(`Resumed from ${formatDuration(savedPos)}`);
      }
    });

    video.addEventListener('timeupdate', () => {
      if (!this.isScrubbing && video.duration) {
        const pct = (video.currentTime / video.duration) * 100;
        progressBar.style.width = `${pct}%`;
        timeCurrent.textContent = formatDuration(video.currentTime);
        scrubBar.setAttribute('aria-valuenow', String(Math.round(pct)));
        // Save position every 3 seconds
        this.savePosition(video.currentTime);
      }
    });

    video.addEventListener('progress', () => {
      if (video.buffered.length > 0 && video.duration) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const pct = (bufferedEnd / video.duration) * 100;
        bufferedBar.style.width = `${pct}%`;
      }
    });

    video.addEventListener('ended', () => {
      this.clearSavedPosition();
      if (this.hasNext && this.onNext) {
        this.showToast('Playing next lesson...');
        setTimeout(() => this.onNext(), 1000);
      }
    });

    // Scrub / Seek interactions
    const seekToPosition = (e) => {
      const rect = scrubBar.getBoundingClientRect();
      const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      if (video.duration) {
        video.currentTime = pos * video.duration;
        progressBar.style.width = `${pos * 100}%`;
      }
    };

    scrubBar.addEventListener('click', seekToPosition);

    // Play / Pause triggers
    playBtn.addEventListener('click', () => this.togglePlay());
    bigPlayBtn.addEventListener('click', () => this.togglePlay());
    video.addEventListener('click', () => this.togglePlay());

    // Skip triggers
    skipBackBtn.addEventListener('click', () => this.skip(-10));
    skipFwdBtn.addEventListener('click', () => this.skip(10));

    // Volume triggers
    volBtn.addEventListener('click', () => this.toggleMute());
    volSlider.addEventListener('input', (e) => {
      const vol = Number(e.target.value);
      video.volume = vol;
      video.muted = vol === 0;
      iconVolOn.style.display = vol === 0 ? 'none' : 'block';
      iconVolOff.style.display = vol === 0 ? 'block' : 'none';
    });

    // Speed selector
    speedSelect.addEventListener('change', (e) => {
      video.playbackRate = Number(e.target.value);
    });

    // Fullscreen trigger
    fsBtn.addEventListener('click', () => this.toggleFullscreen());

    // Navigation triggers (Prev/Next)
    this.container.querySelector('.btn-player-prev')?.addEventListener('click', () => {
      if (this.onPrevious) this.onPrevious();
    });

    this.container.querySelector('.btn-player-next')?.addEventListener('click', () => {
      if (this.onNext) this.onNext();
    });
  }

  showToast(msg) {
    const toast = this.container.querySelector('.trendz-player-toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add('is-visible');
    setTimeout(() => toast.classList.remove('is-visible'), 2500);
  }

  togglePlay() {
    if (!this.video) return;
    if (this.video.paused) {
      this.video.play().catch(() => {});
    } else {
      this.video.pause();
    }
  }

  play() {
    if (this.video) this.video.play().catch(() => {});
  }

  pause() {
    if (this.video) this.video.pause();
  }

  skip(delta) {
    if (!this.video || !this.video.duration) return;
    this.video.currentTime = Math.max(0, Math.min(this.video.duration, this.video.currentTime + delta));
    this.showToast(delta > 0 ? `+${delta}s` : `${delta}s`);
  }

  toggleMute() {
    if (!this.video) return;
    this.video.muted = !this.video.muted;
    const volSlider = this.container.querySelector('.trendz-player-volume-slider');
    const iconVolOn = this.container.querySelector('.icon-vol-on');
    const iconVolOff = this.container.querySelector('.icon-vol-off');

    if (this.video.muted) {
      if (iconVolOn) iconVolOn.style.display = 'none';
      if (iconVolOff) iconVolOff.style.display = 'block';
      if (volSlider) volSlider.value = 0;
    } else {
      if (iconVolOn) iconVolOn.style.display = 'block';
      if (iconVolOff) iconVolOff.style.display = 'none';
      if (volSlider) volSlider.value = this.video.volume || 1;
    }
  }

  toggleFullscreen() {
    if (!document.fullscreenElement) {
      this.container.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  handleKeyDown(e) {
    // Ignore keystrokes when typing inside text inputs, textareas, or selects
    const tag = (document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    if (e.code === 'Space') {
      e.preventDefault();
      this.togglePlay();
    } else if (e.code === 'ArrowLeft') {
      e.preventDefault();
      this.skip(-10);
    } else if (e.code === 'ArrowRight') {
      e.preventDefault();
      this.skip(10);
    } else if (e.key === 'm' || e.key === 'M') {
      e.preventDefault();
      this.toggleMute();
    } else if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      this.toggleFullscreen();
    } else if (e.key === 'p' || e.key === 'P') {
      if (this.hasPrevious && this.onPrevious) {
        e.preventDefault();
        this.onPrevious();
      }
    } else if (e.key === 'n' || e.key === 'N') {
      if (this.hasNext && this.onNext) {
        e.preventDefault();
        this.onNext();
      }
    }
  }

  destroy() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('keydown', this.boundKeyHandler);
    }
    if (this.hideControlsTimer) clearTimeout(this.hideControlsTimer);
    if (this.video) {
      this.video.pause?.();
      this.video.src = '';
      this.video.load?.();
    }
    this.container.innerHTML = '';
  }
}
