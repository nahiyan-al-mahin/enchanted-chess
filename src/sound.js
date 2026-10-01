// sound.js
// Sound effects made from scratch with the Web Audio API, so we don't need
// any audio files (and don't risk using someone else's sounds).
//
// Browsers only allow audio after the player interacts with the page,
// so the AudioContext is created on the first click.

let ctx = null;

// Exported so music.js can share the same AudioContext.
export function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Short burst of filtered noise: sounds like stone scraping or cracking.
function noiseBurst(duration, freq, volume) {
  const ac = audio();
  const buffer = ac.createBuffer(1, ac.sampleRate * duration, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(volume, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + duration);

  src.connect(filter).connect(gain).connect(ac.destination);
  src.start();
}

// Low "thud" that drops in pitch.
function thump(volume) {
  const ac = audio();
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.frequency.setValueAtTime(110, ac.currentTime);
  osc.frequency.exponentialRampToValueAtTime(35, ac.currentTime + 0.3);
  gain.gain.setValueAtTime(volume, ac.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.35);
  osc.connect(gain).connect(ac.destination);
  osc.start();
  osc.stop(ac.currentTime + 0.4);
}

export function playMoveSound() {
  try {
    noiseBurst(0.12, 400, 0.15);
    thump(0.2);
  } catch {
    /* audio not available; the game works fine without it */
  }
}

export function playSmashSound() {
  try {
    noiseBurst(0.5, 900, 0.6);
    noiseBurst(0.25, 2500, 0.25);
    thump(0.8);
  } catch {
    /* ignore */
  }
}

// Call this from any click handler to unlock audio early.
export function unlockAudio() {
  try {
    audio();
  } catch {
    /* ignore */
  }
}
