# Sounds, music and vibration

Every sound in Trendz Tracker is **synthesised in the browser** with the Web Audio API by
`js/feedback.js`. The app ships no audio files: nothing is downloaded, and nothing extra is
cached for offline use. Each sound is a few oscillator notes defined in `SOUND_SPECS`.

**Source:** original to this project, written for Trendz Tracker in November 2026.
**Licence:** CC0 1.0 (public domain dedication). No third-party samples, loops or presets are used.

| Cue | When it plays | Sound | Length | Vibration (ms) |
|---|---|---|---|---|
| `correct` | Right answer (Flash Anzan try, live duel answer), and the settings preview | E5 → A5 rising chime | 0.23 s | 12 |
| `wrong` | Wrong answer (Flash Anzan try, live duel answer) | Soft low "bonk" sliding down | 0.23 s | 30-40-30 |
| `tick` | Each number of a get-ready countdown | Short A5 blip | 0.05 s | 8 |
| `start` | A practice round or test section begins | C5-E5-G5 rising | 0.38 s | 20 |
| `finish` | Round finished, results showing | G5 → C6 bell | 0.42 s | 25 |
| `pb` | Personal best (XP card after a round) | C-E-G-C arpeggio with sparkle | 0.6 s | 20-40-20-40-60 |
| `levelup` | New badge or league promotion | Rising arpeggio into a chord | 0.9 s | 30-50-30-50-90 |
| `win` | Duel won (live or classic) | Short fanfare into a chord | 1.05 s | 40-60-40-60-120 |
| `chest` | Chest opens in the store | Whoosh, then twinkles and a chord | 0.76 s | 15-30-15-30-15-30-60 |

Pages fire a cue by importing `cue()` from `js/feedback.js`, or without importing anything:

```js
document.dispatchEvent(new CustomEvent('tt:cue', { detail: 'chest' }));
```

## Background music

`practiceStarted(context)` and `practiceEnded()` (in `js/feedback.js`) start and stop a calm,
original loop: a soft pad playing I-vi-IV-V in C at 72 bpm, with a slow pentatonic line on top,
through a low-pass filter. It is also generated in code, under CC0.

- It is **off by default**. Students turn it on under Account → Settings → Background music.
- Weekly tests, Memoriad rounds and live duels count as `'test'`. Music plays there only if
  **Music in tests too** is also on.
- It pauses when the tab is hidden and stops when the round ends or the page closes.

## Vibration

`navigator.vibrate` is used only where the browser supports it (most Android phones; not iOS
Safari). Patterns are short (at most 0.4 s in total). Students can turn vibration off.

## Settings

All of this sits in one panel on the Account page. The panel is saved on the device
(`localStorage` key `tt_prefs`) and, once the person is signed in, in
`public.student_preferences` through the `my_preferences()` and `save_my_preferences(jsonb)` RPCs.
