// intro.js
// The title screen shown before the board: name entry, "Create game room",
// "Join with code", the invite prompt, and the waiting room (lobby).
//
// This file only looks after the screens and what's typed into them. It
// never talks to the server itself: when a button needs the server, it
// calls one of the "actions" main.js gave it (create, join, acceptInvite,
// cancel), and main.js decides which screen comes next.

const root = document.getElementById('intro');
const nameInput = document.getElementById('intro-name');
const codeInput = document.getElementById('intro-code');
const nameField = root.querySelector('.intro-name');
const errorBox = root.querySelector('.intro-error');
const NAME_KEY = 'enchanted-chess-name';

let screen = null;
const chosen = { side: 'w', time: 0 }; // the "Create room" choices

// Names are remembered in this browser for next time.
try {
  nameInput.value = localStorage.getItem(NAME_KEY) ?? '';
} catch {
  /* storage blocked: start empty */
}

// Returns the typed name, or shows an error and returns null.
function readName() {
  const name = nameInput.value.replace(/\s+/g, ' ').trim();
  if (!name) {
    introError('Please enter your name first.');
    nameInput.focus();
    return null;
  }
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* ignore */
  }
  return name;
}

// Copies text and briefly says so on the button. If the browser won't
// allow copying, the text is shown in a box to copy by hand.
export async function copyToClipboard(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = 'Copied!';
    setTimeout(() => (button.textContent = label), 1500);
  } catch {
    prompt('Copy this and send it to your friend:', text);
  }
}

// Shows the intro with one screen visible. `fill` sets the text of any
// element marked data-fill="..." (e.g. the room code and link).
export function showIntro(name, fill = {}) {
  screen = name;
  document.body.classList.add('intro-open');
  root.classList.remove('hidden');
  for (const section of root.querySelectorAll('section')) section.hidden = section.dataset.screen !== name;
  nameField.hidden = name === 'lobby' || name === 'connecting';
  for (const [key, value] of Object.entries(fill)) {
    for (const el of root.querySelectorAll(`[data-fill="${key}"]`)) {
      if (el.tagName === 'INPUT') el.value = value;
      else el.textContent = value;
    }
  }
  introError('');
  setIntroBusy(false);
  if (name === 'join') codeInput.focus();
  else if (!nameField.hidden && !nameInput.value) nameInput.focus();
}

export function hideIntro() {
  screen = null;
  root.classList.add('hidden');
  document.body.classList.remove('intro-open');
}

export const introScreen = () => screen;

export function introError(text) {
  errorBox.textContent = text;
}

// While waiting for the server, grey out the buttons so nobody double-clicks.
export function setIntroBusy(busy) {
  for (const b of root.querySelectorAll('section button')) b.disabled = busy;
}

// actions: { create({ name, side, time }), join({ name, code }), acceptInvite({ name }), cancel() }
export function initIntro(actions) {
  // The Ivory/Obsidian/Random and time buttons work like radio buttons.
  for (const group of root.querySelectorAll('[data-choice]')) {
    group.addEventListener('click', (e) => {
      const button = e.target.closest('button');
      if (!button) return;
      group.querySelectorAll('button').forEach((b) => b.classList.toggle('selected', b === button));
      const key = group.dataset.choice;
      chosen[key] = key === 'time' ? Number(button.dataset.value) : button.dataset.value;
    });
  }

  const run = {
    'show-create': () => readName() && showIntro('create'),
    'show-join': () => readName() && showIntro('join'),
    back: () => showIntro('menu'),
    create() {
      const name = readName();
      if (name) actions.create({ name, ...chosen });
    },
    join() {
      const name = readName();
      const code = codeInput.value.trim().toUpperCase();
      if (!name) return;
      if (!/^[A-Z0-9]{4,8}$/.test(code)) return introError('Room codes are 4 letters or numbers, like K7QX.');
      actions.join({ name, code });
    },
    'accept-invite'() {
      const name = readName();
      if (name) actions.acceptInvite({ name });
    },
    'copy-code': (button) => copyToClipboard(root.querySelector('.intro-room-code.big').textContent, button),
    'copy-link': (button) => copyToClipboard(root.querySelector('.intro-link').value, button),
    cancel: () => actions.cancel(),
  };
  root.addEventListener('click', (e) => {
    const button = e.target.closest('[data-action]');
    if (button && !button.disabled) run[button.dataset.action](button);
  });

  // Pressing Enter does the main thing on each screen.
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const primary = { join: 'join', create: 'create', invite: 'accept-invite' }[screen];
    if (primary) run[primary]();
  });
}
