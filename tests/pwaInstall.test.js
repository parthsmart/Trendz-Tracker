import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Pure logic imports
import {
  isStandalone,
  isIOS,
  isInstallAvailable,
  getDeferredPrompt,
  setDeferredPrompt,
  triggerPwaInstall,
  ensureIosInstallModal,
  updateAllInstallTriggers,
  mountLoginPwaInstall,
} from '../js/pwaInstall.js';

test('1. Web App Manifest — Valid JSON, metadata, ID, start URL, and icons contract', () => {
  const manifestPath = path.resolve('public/manifest.webmanifest');
  assert.ok(fs.existsSync(manifestPath), 'Expected public/manifest.webmanifest to exist');

  const content = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(content);

  // App Identity & Configuration
  assert.equal(manifest.name, 'Trendz Tracker', 'Manifest name must be "Trendz Tracker"');
  assert.equal(manifest.short_name, 'Trendz Tracker', 'Manifest short_name must be "Trendz Tracker"');
  assert.ok(manifest.id, 'Manifest must have a stable app id');
  assert.equal(manifest.id, '/?source=pwa', 'Manifest id must be stable launch query');
  assert.equal(manifest.start_url, '/?source=pwa', 'start_url must route to root with source=pwa');
  assert.equal(manifest.scope, '/', 'scope must be root "/"');
  assert.equal(manifest.display, 'standalone', 'display mode must be standalone');
  assert.equal(manifest.theme_color, '#2563EB', 'theme_color must match brand primary blue #2563EB');
  assert.equal(manifest.background_color, '#F6F8FB', 'background_color must match body background #F6F8FB');

  // Icons array checks
  assert.ok(Array.isArray(manifest.icons), 'icons must be an array');
  assert.ok(manifest.icons.length >= 4, 'must have at least 4 icon definitions');

  const icon192 = manifest.icons.find((i) => i.sizes === '192x192' && (!i.purpose || i.purpose === 'any'));
  assert.ok(icon192, 'Expected standard 192x192 icon with purpose any');
  assert.equal(icon192.src, '/icons/icon-192.png');

  const icon512 = manifest.icons.find((i) => i.sizes === '512x512' && (!i.purpose || i.purpose === 'any'));
  assert.ok(icon512, 'Expected standard 512x512 icon with purpose any');
  assert.equal(icon512.src, '/icons/icon-512.png');

  const maskable192 = manifest.icons.find((i) => i.sizes === '192x192' && i.purpose === 'maskable');
  assert.ok(maskable192, 'Expected maskable 192x192 icon for Android');
  assert.equal(maskable192.src, '/icons/icon-maskable-192.png');

  const maskable512 = manifest.icons.find((i) => i.sizes === '512x512' && i.purpose === 'maskable');
  assert.ok(maskable512, 'Expected maskable 512x512 icon for Android');
  assert.equal(maskable512.src, '/icons/icon-maskable-512.png');
});

test('2. Physical Assets & Service Worker Isolation — Non-interception of unrelated requests', () => {
  const iconFiles = [
    { file: 'public/icons/icon-192.png', width: 192, height: 192 },
    { file: 'public/icons/icon-512.png', width: 512, height: 512 },
    { file: 'public/icons/icon-maskable-192.png', width: 192, height: 192 },
    { file: 'public/icons/icon-maskable-512.png', width: 512, height: 512 },
    { file: 'public/apple-touch-icon.png', width: 180, height: 180 },
  ];

  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  for (const item of iconFiles) {
    const fullPath = path.resolve(item.file);
    assert.ok(fs.existsSync(fullPath), `Expected ${item.file} to exist on disk`);
    const buf = fs.readFileSync(fullPath);
    assert.ok(buf.length > 500, `${item.file} should have meaningful non-trivial size`);

    // Verify PNG signature
    assert.deepEqual(buf.subarray(0, 8), pngSig, `${item.file} must have valid PNG signature`);

    // Verify IHDR dimensions (width at bytes 16..20, height at bytes 20..24)
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    assert.equal(w, item.width, `${item.file} width should be ${item.width}`);
    assert.equal(h, item.height, `${item.file} height should be ${item.height}`);
  }

  // Service Worker exists & stays strictly out of unrelated requests
  const swPath = path.resolve('public/sw.js');
  assert.ok(fs.existsSync(swPath), 'Expected public/sw.js to exist');
  const swCode = fs.readFileSync(swPath, 'utf8');
  assert.ok(swCode.includes('install'), 'Service worker must handle install');
  assert.ok(swCode.includes('activate'), 'Service worker must handle activate');

  // Verify fetch handler strictly limits interception to same-origin navigate mode
  assert.ok(
    swCode.includes("event.request.mode !== 'navigate'"),
    'Service worker must skip all non-navigate requests without intercepting them'
  );
  assert.ok(
    swCode.includes('/api/'),
    'Service worker must explicitly bypass /api/ endpoints'
  );
  assert.ok(
    swCode.includes('self.location.origin'),
    'Service worker must strictly bypass cross-origin requests (e.g. Supabase)'
  );

  // Favicon svg
  const svgPath = path.resolve('public/favicon.svg');
  assert.ok(fs.existsSync(svgPath), 'Expected public/favicon.svg to exist');
});

test('3. Vercel Configuration — MIME types and Cache-Control headers', () => {
  const vercelPath = path.resolve('vercel.json');
  assert.ok(fs.existsSync(vercelPath), 'vercel.json must exist');
  const vercel = JSON.parse(fs.readFileSync(vercelPath, 'utf8'));

  assert.ok(Array.isArray(vercel.headers), 'vercel.json headers must be an array');

  // Check manifest rule
  const manifestHeader = vercel.headers.find((h) => h.source && h.source.includes('manifest'));
  assert.ok(manifestHeader, 'vercel.json must configure manifest headers');
  const manifestType = manifestHeader.headers.find((h) => h.key.toLowerCase() === 'content-type');
  assert.ok(manifestType, 'manifest rule must set Content-Type');
  assert.ok(manifestType.value.includes('application/manifest+json'), 'Content-Type must be application/manifest+json');

  // Check sw.js rule
  const swHeader = vercel.headers.find((h) => h.source && h.source.includes('sw.js'));
  assert.ok(swHeader, 'vercel.json must configure sw.js headers');
  const swCache = swHeader.headers.find((h) => h.key.toLowerCase() === 'cache-control');
  assert.ok(swCache.value.includes('must-revalidate'), 'sw.js must revalidate immediately');
});

test('4. HTML Entry Pages — Manifest link, apple-touch-icon, and theme-color meta tags', () => {
  const checkPages = [
    'index.html',
    'pages/student.html',
    'pages/admin.html',
    'pages/teacher.html',
    'pages/round-scores.html',
  ];

  for (const pageRel of checkPages) {
    const fullPath = path.resolve(pageRel);
    assert.ok(fs.existsSync(fullPath), `Page ${pageRel} must exist`);
    const html = fs.readFileSync(fullPath, 'utf8');

    assert.ok(
      html.includes('rel="manifest"') && html.includes('/manifest.webmanifest'),
      `${pageRel} must link to /manifest.webmanifest`
    );
    assert.ok(
      html.includes('name="theme-color"') && html.includes('#2563EB'),
      `${pageRel} must specify theme-color #2563EB`
    );
    assert.ok(
      html.includes('rel="apple-touch-icon"') && html.includes('/apple-touch-icon.png'),
      `${pageRel} must specify apple-touch-icon /apple-touch-icon.png`
    );
    assert.ok(
      html.includes('name="apple-mobile-web-app-capable"'),
      `${pageRel} must include apple-mobile-web-app-capable`
    );
  }
});

test('5. PWA Controller — Standalone mode detection', () => {
  const originalWindow = global.window;
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    // 5a. Not standalone by default
    global.window = {
      matchMedia: (query) => ({ matches: false, media: query }),
      navigator: { standalone: false },
      location: { search: '' },
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: { standalone: false },
      configurable: true,
      writable: true,
    });
    assert.equal(isStandalone(), false, 'Default browser tab should not be standalone');

    // 5b. MatchMedia standalone
    global.window.matchMedia = (query) => ({
      matches: query === '(display-mode: standalone)',
      media: query,
    });
    assert.equal(isStandalone(), true, 'display-mode: standalone should report standalone');

    // 5c. iOS navigator.standalone = true
    global.window.matchMedia = () => ({ matches: false });
    global.window.navigator = { standalone: true };
    Object.defineProperty(globalThis, 'navigator', {
      value: { standalone: true },
      configurable: true,
      writable: true,
    });
    assert.equal(isStandalone(), true, 'navigator.standalone === true should report standalone');

    // 5d. Visiting /?source=pwa in a regular browser tab must NOT count as standalone
    global.window.matchMedia = () => ({ matches: false });
    global.window.navigator = { standalone: false };
    Object.defineProperty(globalThis, 'navigator', {
      value: { standalone: false },
      configurable: true,
      writable: true,
    });
    global.window.location = { search: '?source=pwa' };
    assert.equal(
      isStandalone(),
      false,
      'Visiting /?source=pwa in a regular browser tab must NOT count as standalone'
    );
  } finally {
    global.window = originalWindow;
    if (originalNavDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavDesc);
    }
  }
});

test('6. PWA Controller — iOS / iPadOS Safari detection', () => {
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  try {
    // iPhone UA
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        platform: 'iPhone',
        maxTouchPoints: 5,
      },
      configurable: true,
      writable: true,
    });
    assert.equal(isIOS(), true, 'iPhone should be detected as iOS');

    // iPad UA
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15',
        platform: 'iPad',
        maxTouchPoints: 5,
      },
      configurable: true,
      writable: true,
    });
    assert.equal(isIOS(), true, 'iPad should be detected as iOS');

    // iPadOS Desktop Mode (reports MacIntel platform with touch points)
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
        platform: 'MacIntel',
        maxTouchPoints: 5,
      },
      configurable: true,
      writable: true,
    });
    assert.equal(isIOS(), true, 'iPad in desktop UA mode should be detected as iOS');

    // Desktop Chrome on Windows
    Object.defineProperty(globalThis, 'navigator', {
      value: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
        platform: 'Win32',
        maxTouchPoints: 0,
      },
      configurable: true,
      writable: true,
    });
    assert.equal(isIOS(), false, 'Windows Chrome should not be detected as iOS');
  } finally {
    if (originalNavDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavDesc);
    }
  }
});

test('7. PWA Controller — Install dismissal flow: clears saved prompt and prevents retrying expired prompt', async () => {
  const originalWindow = global.window;
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = global.document;

  try {
    const mockNav = { standalone: false, userAgent: 'Chrome/120.0 Win32' };
    global.window = {
      matchMedia: () => ({ matches: false }),
      navigator: mockNav,
      location: { search: '' },
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: mockNav,
      configurable: true,
      writable: true,
    });

    let buttonDisplay = 'none';
    const mockInstallBtn = {
      style: {
        get display() {
          return buttonDisplay;
        },
        set display(v) {
          buttonDisplay = v;
        },
      },
      setAttribute: () => {},
      removeAttribute: () => {},
    };

    global.document = {
      getElementById: (id) => (id === 'btn-login-pwa-install' ? mockInstallBtn : null),
      querySelectorAll: () => [],
      createElement: () => ({
        setAttribute: () => {},
        querySelectorAll: () => [],
        addEventListener: () => {},
        style: {},
      }),
      body: { appendChild: () => {} },
    };

    setDeferredPrompt(null);
    assert.equal(isInstallAvailable(), false, 'Unavailable when no prompt');

    // Scenario A: User dismisses native prompt
    let promptCallCount = 0;
    const mockDismissPromptEvent = {
      prompt: async () => {
        promptCallCount++;
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    };

    setDeferredPrompt(mockDismissPromptEvent);
    assert.equal(isInstallAvailable(), true, 'Available after beforeinstallprompt');
    assert.equal(buttonDisplay, 'inline-flex', 'Install button is shown');

    // First click: triggers prompt, user dismisses
    const firstOutcome = await triggerPwaInstall();
    assert.equal(firstOutcome, 'dismissed', 'First click outcome is dismissed');
    assert.equal(promptCallCount, 1, 'prompt() was called exactly once');

    // Crucial check: event is cleared immediately and UI refreshed
    assert.equal(getDeferredPrompt(), null, 'deferredPrompt must be cleared after dismissal');
    assert.equal(isInstallAvailable(), false, 'Install availability becomes false');
    assert.equal(buttonDisplay, 'none', 'Install button is hidden after dismissal');

    // Second click: user clicks again on expired prompt
    const secondOutcome = await triggerPwaInstall();
    assert.equal(secondOutcome, 'unavailable', 'Subsequent click returns unavailable without throwing');
    assert.equal(promptCallCount, 1, 'prompt() must NEVER be called again on expired event');

    // Scenario B: Prompt invocation error (e.g. already used or user gesture error)
    let errorPromptCallCount = 0;
    const mockErrorPromptEvent = {
      prompt: async () => {
        errorPromptCallCount++;
        throw new DOMException('The prompt has already been shown/used.', 'InvalidStateError');
      },
      userChoice: Promise.resolve({ outcome: 'dismissed' }),
    };

    setDeferredPrompt(mockErrorPromptEvent);
    assert.equal(isInstallAvailable(), true);
    assert.equal(buttonDisplay, 'inline-flex');

    const errorOutcome = await triggerPwaInstall();
    assert.equal(errorOutcome, 'dismissed', 'Error returns dismissed gracefully');
    assert.equal(getDeferredPrompt(), null, 'deferredPrompt must be cleared on error');
    assert.equal(isInstallAvailable(), false, 'Install becomes unavailable after error');
    assert.equal(buttonDisplay, 'none', 'Install button is hidden after error');

    // Clicking again after error
    const thirdOutcome = await triggerPwaInstall();
    assert.equal(thirdOutcome, 'unavailable');
    assert.equal(errorPromptCallCount, 1, 'Expired prompt is never retried');
  } finally {
    global.window = originalWindow;
    if (originalNavDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavDesc);
    }
    global.document = originalDocument;
    setDeferredPrompt(null);
  }
});

test('8. PWA Controller — iOS Safari instruction modal verified via actual Install option (No test hooks in shipped code)', async () => {
  const originalWindow = global.window;
  const originalNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalDocument = global.document;

  try {
    const mockNav = {
      standalone: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    };
    global.window = {
      matchMedia: () => ({ matches: false }),
      navigator: mockNav,
      location: { search: '' },
      addEventListener: () => {},
    };
    Object.defineProperty(globalThis, 'navigator', {
      value: mockNav,
      configurable: true,
      writable: true,
    });

    let attachedModal = null;
    global.document = {
      getElementById: (id) => (attachedModal && attachedModal.id === id ? attachedModal : null),
      querySelectorAll: () => [],
      addEventListener: () => {},
      removeEventListener: () => {},
      createElement: (tag) => {
        const el = {
          tagName: tag,
          id: '',
          className: '',
          attributes: {},
          setAttribute(k, v) {
            this.attributes[k] = v;
          },
          removeAttribute(k) {
            delete this.attributes[k];
          },
          hasAttribute(k) {
            return k in this.attributes;
          },
          classList: {
            add: (cls) => {
              el.className = `${el.className} ${cls}`.trim();
            },
            remove: (cls) => {
              el.className = el.className.replace(cls, '').trim();
            },
            contains: (cls) => el.className.includes(cls),
          },
          querySelectorAll: () => [],
          querySelector: () => null,
          addEventListener: () => {},
          style: {},
        };
        return el;
      },
      body: {
        appendChild: (el) => {
          attachedModal = el;
        },
      },
    };

    setDeferredPrompt(null);
    assert.equal(isIOS(), true, 'Must identify as iOS');
    assert.equal(isInstallAvailable(), true, 'Must be available on iOS non-standalone');

    // Confirm that shipped code does NOT contain test-ios-pwa event hook
    const pwaSource = fs.readFileSync(path.resolve('js/pwaInstall.js'), 'utf8');
    assert.equal(
      pwaSource.includes('test-ios-pwa'),
      false,
      'Shipped code must not contain test-ios-pwa event listener'
    );

    // Verify modal opens by clicking the actual install option (triggerPwaInstall)
    const result = await triggerPwaInstall();
    assert.equal(result, 'instructions', 'triggerPwaInstall must open instructions modal on iOS');

    assert.ok(attachedModal, 'Modal element must be created and appended');
    assert.equal(attachedModal.id, 'ios-pwa-install-modal');
    assert.ok(attachedModal.innerHTML.includes('Share'), 'Modal must instruct user to tap Share');
    assert.ok(attachedModal.innerHTML.includes('Add to Home Screen'), 'Modal must instruct user to tap Add to Home Screen');
    assert.ok(attachedModal.innerHTML.includes('Open as Web App'), 'Modal must instruct user to Open as Web App');
    assert.ok(attachedModal.innerHTML.includes('aria-modal="true"'), 'Modal must be accessible with aria-modal="true"');
    assert.ok(attachedModal.innerHTML.includes('role="dialog"'), 'Modal must have role="dialog"');
  } finally {
    global.window = originalWindow;
    if (originalNavDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavDesc);
    }
    global.document = originalDocument;
  }
});

test('9. Login page & Header navigation DOM contract', () => {
  const indexHtml = fs.readFileSync(path.resolve('index.html'), 'utf8');
  assert.ok(indexHtml.includes('id="login-pwa-install-container"'), 'Login page must contain install container');
  assert.ok(indexHtml.includes('id="btn-login-pwa-install"'), 'Login page must contain btn-login-pwa-install');
  assert.ok(indexHtml.includes('mountLoginPwaInstall'), 'Login script must call mountLoginPwaInstall');

  const headerNavJs = fs.readFileSync(path.resolve('js/headerNav.js'), 'utf8');
  assert.ok(headerNavJs.includes('btn-header-pwa-install'), 'headerNav must provide desktop btn-header-pwa-install');
  assert.ok(headerNavJs.includes('data-nav-action="install-pwa"'), 'headerNav must provide drawer install-pwa action');
  assert.ok(headerNavJs.includes('triggerPwaInstall'), 'headerNav must route install-pwa action to triggerPwaInstall');
});
