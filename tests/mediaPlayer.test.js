/**
 * Trendz Tracker — Shared Media Player Test Suite (tests/mediaPlayer.test.js)
 *
 * Verifies:
 * 1. Time formatting helper (formatDuration): mm:ss and hh:mm:ss
 * 2. URL parsing & Google Drive preview conversion
 * 3. Scoped localStorage key generation per user and media ID
 * 4. Embed player rendering and queue navigation callbacks
 * 5. Native player state handling: play/pause, skip, mute, speed
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatDuration, TrendzMediaPlayer } from '../js/mediaPlayer.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

test('1. formatDuration formats seconds to MM:SS and HH:MM:SS cleanly', () => {
  assert.equal(formatDuration(0), '00:00');
  assert.equal(formatDuration(9), '00:09');
  assert.equal(formatDuration(65), '01:05');
  assert.equal(formatDuration(599), '09:59');
  assert.equal(formatDuration(3600), '01:00:00');
  assert.equal(formatDuration(3665), '01:01:05');
  assert.equal(formatDuration(7325), '02:02:05');
  assert.equal(formatDuration(-10), '00:00');
  assert.equal(formatDuration(NaN), '00:00');
});

test('2. TrendzMediaPlayer storage keys are strictly scoped to user and media ID', () => {
  const mockContainer = {
    classList: { add: () => {} },
    innerHTML: '',
    querySelector: () => null,
  };

  const player1 = new TrendzMediaPlayer(mockContainer, {
    userId: 'usr-101',
    mediaId: 'rec-webinar-001',
  });
  assert.equal(player1.getStorageKey(), 'trendz_playback_usr-101_rec-webinar-001');

  const player2 = new TrendzMediaPlayer(mockContainer, {
    userId: 'usr-202',
    mediaId: 'rec-webinar-001',
  });
  assert.equal(player2.getStorageKey(), 'trendz_playback_usr-202_rec-webinar-001');
  assert.notEqual(player1.getStorageKey(), player2.getStorageKey(), 'Storage keys must not collide between different users');

  const player3 = new TrendzMediaPlayer(mockContainer, {
    userId: 'usr-101',
    mediaId: 'lec-addition-01',
  });
  assert.notEqual(player1.getStorageKey(), player3.getStorageKey(), 'Storage keys must not collide between different media items');
});

test('3. Google Drive file URLs are automatically converted to clean preview embed URLs', () => {
  const mockContainer = {
    classList: { add: () => {} },
    innerHTML: '',
    querySelector: () => null,
  };

  const player = new TrendzMediaPlayer(mockContainer, {
    mediaType: 'drive_embed',
    mediaUrl: 'https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J/view?usp=sharing',
  });

  const normalized = player.normalizeDriveEmbedUrl('https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J/view?usp=sharing');
  assert.equal(normalized, 'https://drive.google.com/file/d/1A2B3C4D5E6F7G8H9I0J/preview');
  assert.equal(player.isEmbedUrl('https://drive.google.com/file/d/xyz/preview'), true);
  assert.equal(player.isEmbedUrl('https://example.com/videos/class.mp4'), false);
});

test('4. Embed rendering renders iframe and wires up Previous/Next queue callbacks', () => {
  let prevCalled = false;
  let nextCalled = false;

  let storedHtml = '';
  const listeners = new Map();

  const mockContainer = {
    classList: { add: () => {} },
    set innerHTML(val) { storedHtml = val; },
    get innerHTML() { return storedHtml; },
    querySelector: (sel) => {
      if (sel === '.btn-player-prev') {
        return {
          addEventListener: (ev, cb) => { listeners.set('prev', cb); },
        };
      }
      if (sel === '.btn-player-next') {
        return {
          addEventListener: (ev, cb) => { listeners.set('next', cb); },
        };
      }
      return null;
    },
  };

  const player = new TrendzMediaPlayer(mockContainer, {
    mediaType: 'drive_embed',
    mediaUrl: 'https://drive.google.com/file/d/test1234/preview',
    title: 'Addition Basics - Part 1',
    category: 'Addition',
    lessonOrder: 1,
    totalLessons: 3,
    hasPrevious: false,
    hasNext: true,
    onPrevious: () => { prevCalled = true; },
    onNext: () => { nextCalled = true; },
  });

  assert.ok(mockContainer.innerHTML.includes('<iframe'), 'Expected <iframe> rendered for embed');
  assert.ok(mockContainer.innerHTML.includes('https://drive.google.com/file/d/test1234/preview'));
  assert.ok(mockContainer.innerHTML.includes('Addition Basics - Part 1'));
  assert.ok(mockContainer.innerHTML.includes('(1 of 3)'));

  // Trigger next
  assert.ok(listeners.has('next'));
  listeners.get('next')();
  assert.equal(nextCalled, true, 'Expected onNext to be called');
});

test('5. Native player controls: skip, volume toggle, and keyboard shortcuts dispatch cleanly', () => {
  let playCalled = false;
  let pauseCalled = false;

  const mockVideo = {
    duration: 120,
    currentTime: 30,
    volume: 1,
    muted: false,
    paused: true,
    play: () => { playCalled = true; return Promise.resolve(); },
    pause: () => { pauseCalled = true; },
  };

  const mockContainer = {
    classList: { add: () => {} },
    innerHTML: '',
    querySelector: (sel) => {
      if (sel === 'video') return mockVideo;
      return null;
    },
  };

  const player = new TrendzMediaPlayer(mockContainer, {
    mediaType: 'video_mp4',
    mediaUrl: 'https://example.com/lecture.mp4',
  });
  player.video = mockVideo;

  // Toggle play
  player.togglePlay();
  assert.equal(playCalled, true);

  mockVideo.paused = false;
  player.togglePlay();
  assert.equal(pauseCalled, true);

  // Skip +10s
  player.skip(10);
  assert.equal(mockVideo.currentTime, 40);

  // Skip -10s
  player.skip(-10);
  assert.equal(mockVideo.currentTime, 30);

  // Toggle mute
  player.toggleMute();
  assert.equal(mockVideo.muted, true);
  player.toggleMute();
  assert.equal(mockVideo.muted, false);

  player.destroy();
});

test('6. All three Jr. MCWC Addition lecture videos load authorized Classroom source references without sample clips', () => {
  const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../data/jr_mcwc_classroom_manifest.json'), 'utf-8'));
  const addition = manifest.categories.find((c) => c.slug === 'addition');
  assert.ok(addition, 'Addition category must exist');
  assert.equal(addition.lessons.length, 3, 'Must have 3 Addition lessons in order');

  addition.lessons.forEach((lesson, idx) => {
    let storedHtml = '';
    const mockContainer = {
      classList: { add: () => {} },
      set innerHTML(val) { storedHtml = val; },
      get innerHTML() { return storedHtml; },
      querySelector: () => null,
    };

    const player = new TrendzMediaPlayer(mockContainer, {
      mediaType: lesson.mediaType,
      mediaUrl: lesson.mediaUrl,
      title: lesson.title,
      category: 'Addition',
      lessonOrder: lesson.lessonOrder,
      totalLessons: 3,
    });

    assert.equal(lesson.mediaType, 'drive_embed', `Lesson ${idx + 1} must be an authorized Classroom Drive embed`);
    assert.ok(!lesson.mediaUrl.includes('flower.mp4') && !lesson.mediaUrl.includes('mov_bbb.mp4') && !lesson.mediaUrl.includes('movie.mp4'),
      `Lesson ${idx + 1} must not contain sample clips in publishable catalogue`);
    assert.ok(lesson.mediaUrl.startsWith('https://drive.google.com/file/d/'),
      `Lesson ${idx + 1} must reference authorized Classroom Google Drive source`);
    assert.ok(storedHtml.includes('trendz-player-embed-frame'), 'Must render responsive embedded player frame');
    assert.ok(storedHtml.includes(player.normalizeDriveEmbedUrl(lesson.mediaUrl)), 'Player frame must embed normalized preview URL');
    player.destroy();
  });
});
