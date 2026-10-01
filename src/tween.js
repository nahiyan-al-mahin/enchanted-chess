// tween.js
// A tiny animation helper. tween(duration, onUpdate) calls onUpdate(t) every
// frame with t going from 0 to 1, and returns a Promise that resolves when
// the animation finishes. That lets us write animations step by step:
//
//   await tween(0.5, (t) => { piece.position.x = t * 2; });
//   console.log('done!');

const running = [];

export function tween(duration, onUpdate) {
  return new Promise((resolve) => {
    running.push({ elapsed: 0, duration, onUpdate, resolve });
  });
}

// Must be called once per frame from the main loop.
export function updateTweens(dt) {
  for (let i = running.length - 1; i >= 0; i--) {
    const tw = running[i];
    tw.elapsed += dt;
    const t = Math.min(1, tw.elapsed / tw.duration);
    tw.onUpdate(t);
    if (t >= 1) {
      running.splice(i, 1);
      tw.resolve();
    }
  }
}

// Starts slow, speeds up, ends slow.
export const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
