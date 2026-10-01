// music.js
// Soft background music generated live with the Web Audio API: no audio
// files. An original slow waltz in A minor, played on a music-box style
// bell, with a quiet string pad underneath and a gentle echo.
//
// How it works:
//  - Instruments: bell() and pad() build a sound from oscillators (simple
//    tone generators) and shape its volume over time (an "envelope").
//  - Song: a list of chords and two 8-bar melody phrases (A and B).
//  - Scheduler: every 200 ms we check the clock and book the notes for any
//    bar that starts within the next 1.2 seconds. Booking ahead keeps the
//    rhythm steady even if the game is busy for a moment.
//  - Each time the song loops, a few notes change at random (an extra
//    passing note, a grace note, a high sparkle), so it never sounds
//    exactly the same twice.

import { audio } from './sound.js';

const VOLUME = 0.22; // overall music level; kept low so the smash sounds stay clear
const BEAT = 60 / 76; // 76 beats per minute: a slow waltz
const BAR = BEAT * 3; // a waltz has 3 beats per bar
const STORAGE_KEY = 'enchanted-chess-music';

// MIDI note numbers: 69 = A4 (440 Hz). Each +1 is one semitone higher.
const freq = (midi) => 440 * 2 ** ((midi - 69) / 12);

// ---------------------------------------------------------------------------
// The song
// ---------------------------------------------------------------------------

// One chord per bar: a low bass note and three notes for the string pad.
// Am - Dm - G - C - F - Dm - E - Am, a classic minor-key journey home.
const CHORDS = [
  { bass: 45, pad: [57, 60, 64] }, // A minor
  { bass: 50, pad: [53, 57, 62] }, // D minor
  { bass: 43, pad: [55, 59, 62] }, // G major
  { bass: 48, pad: [55, 60, 64] }, // C major
  { bass: 41, pad: [53, 57, 60] }, // F major
  { bass: 50, pad: [53, 57, 62] }, // D minor
  { bass: 40, pad: [56, 59, 64] }, // E major (the G# pulls back to A)
  { bass: 45, pad: [57, 60, 64] }, // A minor
];

// Melody: each bar is a list of [note, beats]. Every bar adds up to 3 beats.
const PHRASE_A = [
  [[76, 2], [69, 1]],
  [[77, 1], [76, 1], [74, 1]],
  [[71, 2], [74, 1]],
  [[72, 3]],
  [[69, 1], [72, 1], [77, 1]],
  [[76, 2], [74, 1]],
  [[71, 1], [74, 1], [68, 1]],
  [[69, 3]],
];
const PHRASE_B = [
  [[72, 1], [76, 1], [81, 1]],
  [[77, 2], [74, 1]],
  [[74, 1], [71, 1], [67, 1]],
  [[76, 2], [72, 1]],
  [[77, 1], [76, 1], [72, 1]],
  [[74, 1], [77, 1], [81, 1]],
  [[80, 1], [76, 1], [71, 1]],
  [[69, 3]],
];
const BARS_PER_LOOP = PHRASE_A.length + PHRASE_B.length;

// ---------------------------------------------------------------------------
// Audio graph: instruments -> bus -> (dry + echo) -> master volume -> speakers
// ---------------------------------------------------------------------------
let ac = null;
let bus = null;
let master = null;

function buildGraph() {
  ac = audio();
  master = ac.createGain();
  master.gain.value = 0;
  master.connect(ac.destination);

  bus = ac.createGain();
  bus.connect(master); // the "dry" sound

  // Echo: a delay whose output is fed back into itself, a little quieter
  // and duller each time, like a sound bouncing around a stone hall.
  const delay = ac.createDelay(1);
  delay.delayTime.value = BEAT * 0.5;
  const feedback = ac.createGain();
  feedback.gain.value = 0.32;
  const dull = ac.createBiquadFilter();
  dull.type = 'lowpass';
  dull.frequency.value = 2400;
  const wet = ac.createGain();
  wet.gain.value = 0.35;

  bus.connect(delay);
  delay.connect(dull).connect(feedback).connect(delay);
  dull.connect(wet).connect(master);
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

// A music-box / celesta bell: a pure tone plus a few higher "overtones"
// that ring briefly at the start, giving it that glassy, metallic ping.
function bell(time, midi, volume, decay = 2.4) {
  const f = freq(midi);
  const partials = [
    [1, 1, decay], // [frequency multiple, loudness, how long it rings]
    [2, 0.25, decay * 0.5],
    [3, 0.1, decay * 0.3],
    [4.07, 0.12, decay * 0.12], // slightly "off" overtone = metallic shimmer
  ];
  for (const [mult, level, length] of partials) {
    if (f * mult > 12000) continue;
    const osc = ac.createOscillator();
    osc.frequency.value = f * mult;
    const env = ac.createGain();
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(volume * level, time + 0.004); // instant strike
    env.gain.exponentialRampToValueAtTime(0.0001, time + length); // slow fade
    osc.connect(env).connect(bus);
    osc.start(time);
    osc.stop(time + length + 0.05);
  }
}

// A soft string pad: two slightly out-of-tune "sawtooth" waves per note
// (that's what makes strings sound rich), softened by a filter, fading in
// slowly and fading out slowly so the chords blend into each other.
function pad(time, duration, notes) {
  const filter = ac.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 750;
  const env = ac.createGain();
  env.gain.setValueAtTime(0, time);
  env.gain.linearRampToValueAtTime(0.022, time + 0.9);
  env.gain.setValueAtTime(0.022, time + duration);
  env.gain.linearRampToValueAtTime(0, time + duration + 1.5);
  filter.connect(env).connect(bus);

  for (const midi of notes) {
    for (const detune of [-7, 7]) {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq(midi);
      osc.detune.value = detune; // in cents (hundredths of a semitone)
      osc.connect(filter);
      osc.start(time);
      osc.stop(time + duration + 1.6);
    }
  }
}

// ---------------------------------------------------------------------------
// Variations
// ---------------------------------------------------------------------------
const A_MINOR_SCALE = [9, 11, 0, 2, 4, 5, 7]; // A B C D E F G (as note-in-octave numbers)

// The next note up the scale, used for grace notes.
function scaleStepAbove(midi) {
  for (let m = midi + 1; m < midi + 3; m++) if (A_MINOR_SCALE.includes(m % 12)) return m;
  return midi + 2;
}

// A nearby note that belongs to the current chord, used for passing notes.
function nearbyChordTone(midi, chord) {
  const tones = chord.pad.map((n) => n % 12);
  const options = [];
  for (let d = 1; d <= 5; d++) {
    if (tones.includes((midi + d) % 12)) options.push(midi + d);
    if (tones.includes((midi - d) % 12)) options.push(midi - d);
  }
  return options[Math.floor(Math.random() * options.length)] ?? midi;
}

// Turns one bar of the written melody into the notes we'll actually play,
// with small random changes. `lift` raises the melody an octave.
function varyBar(written, chord, lift) {
  const notes = [];
  let beat = 0;
  for (const [midi, beats] of written) {
    const m = midi + lift;
    if (beats >= 2 && Math.random() < 0.3) {
      // Split a long note: hold it for one beat, then step to a chord tone.
      notes.push({ midi: m, beat, beats: 1, volume: 1 });
      notes.push({ midi: nearbyChordTone(m, chord), beat: beat + 1, beats: beats - 1, volume: 0.8 });
    } else {
      notes.push({ midi: m, beat, beats, volume: 1 });
    }
    if (beat === 0 && Math.random() < 0.2) {
      // A quick, quiet grace note just before the downbeat.
      notes.push({ midi: scaleStepAbove(m), beat: -0.12, beats: 0.2, volume: 0.45 });
    }
    beat += beats;
  }
  if (Math.random() < 0.25) {
    // A tiny high "sparkle" echoing the bar's first note on the last half-beat.
    notes.push({ midi: written[0][0] + lift + 12, beat: 2.5, beats: 0.5, volume: 0.3 });
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
let barIndex = 0; // position in the song (0..15)
let loopCount = 0;
let nextBarTime = 0; // when (on the audio clock) the next bar starts
let timer = null;

function scheduleBar(time) {
  const inPhraseA = barIndex < PHRASE_A.length;
  const chord = CHORDS[barIndex % CHORDS.length];
  const written = inPhraseA ? PHRASE_A[barIndex] : PHRASE_B[barIndex - PHRASE_A.length];
  // Every other time round, phrase A is played an octave higher.
  const lift = inPhraseA && loopCount % 2 === 1 ? 12 : 0;

  // Melody on the bell.
  for (const note of varyBar(written, chord, lift)) {
    bell(time + note.beat * BEAT, note.midi, 0.2 * note.volume, 1.2 + note.beats * BEAT);
  }

  // Waltz accompaniment, music-box style: a low note on beat 1 ("oom"),
  // then two soft chord notes on beats 2 and 3 ("pah, pah").
  bell(time, chord.bass + 12, 0.13, 2.2);
  for (const b of [1, 2]) {
    for (const n of chord.pad.slice(1)) bell(time + b * BEAT, n + 12, 0.045, 1.2);
  }

  // String pad holding the chord for the whole bar.
  pad(time, BAR, chord.pad);

  barIndex = (barIndex + 1) % BARS_PER_LOOP;
  if (barIndex === 0) loopCount++;
}

function tick() {
  const now = ac.currentTime;
  // If the browser paused our timer (e.g. the tab was hidden), don't try to
  // catch up on missed bars; just carry on from now.
  if (nextBarTime < now) nextBarTime = now + 0.1;
  while (nextBarTime < now + 1.2) {
    scheduleBar(nextBarTime);
    nextBarTime += BAR;
  }
}

function start() {
  try {
    if (!ac) buildGraph();
    master.gain.cancelScheduledValues(ac.currentTime);
    master.gain.setTargetAtTime(VOLUME, ac.currentTime, 0.8); // gentle fade in
    if (!timer) {
      tick();
      timer = setInterval(tick, 200);
    }
  } catch {
    /* audio not available; the game works fine without music */
  }
}

function stop() {
  if (!ac) return;
  clearInterval(timer);
  timer = null;
  master.gain.cancelScheduledValues(ac.currentTime);
  master.gain.setTargetAtTime(0, ac.currentTime, 0.3); // quick fade out
}

// ---------------------------------------------------------------------------
// On/off button, remembered between visits
// ---------------------------------------------------------------------------

// localStorage can be blocked (e.g. private browsing), so guard every use.
function loadEnabled() {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}
function saveEnabled(on) {
  try {
    localStorage.setItem(STORAGE_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
}

export function initMusic(button) {
  let enabled = loadEnabled();
  let unlocked = false; // browsers only allow sound after the first click
  const showLabel = () => (button.textContent = `Music: ${enabled ? 'on' : 'off'}`);
  showLabel();

  // The first click or tap anywhere on the page starts the music.
  window.addEventListener(
    'pointerdown',
    () => {
      unlocked = true;
      if (enabled) start();
    },
    { once: true }
  );

  button.addEventListener('click', () => {
    enabled = !enabled;
    saveEnabled(enabled);
    showLabel();
    if (unlocked) enabled ? start() : stop();
  });
}
