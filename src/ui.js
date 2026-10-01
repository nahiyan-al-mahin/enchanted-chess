// ui.js
// Everything about the HTML panel (HUD): showing whose turn it is, the
// game status, the move list, and the promotion picker.

const SIDE_NAMES = { w: 'Ivory', b: 'Obsidian' };

const el = {
  turn: document.getElementById('turn'),
  status: document.getElementById('status'),
  moves: document.getElementById('moves'),
  promotion: document.getElementById('promotion'),
};

// Reads the chess.js game and refreshes the panel.
export function updateHud(chess) {
  const side = SIDE_NAMES[chess.turn()];
  el.turn.textContent = chess.isGameOver() ? 'Game over' : `${side} to move`;

  let status = '';
  if (chess.isCheckmate()) {
    const winner = SIDE_NAMES[chess.turn() === 'w' ? 'b' : 'w'];
    status = `Checkmate! ${winner} wins.`;
  } else if (chess.isStalemate()) {
    status = 'Stalemate. It is a draw.';
  } else if (chess.isThreefoldRepetition()) {
    status = 'Draw by threefold repetition.';
  } else if (chess.isInsufficientMaterial()) {
    status = 'Draw: not enough pieces to checkmate.';
  } else if (chess.isDraw()) {
    status = 'Draw by the fifty-move rule.';
  } else if (chess.inCheck()) {
    status = `${side} is in check!`;
  }
  el.status.textContent = status;

  // Move list, two moves (White + Black) per line.
  const history = chess.history();
  el.moves.innerHTML = '';
  for (let i = 0; i < history.length; i += 2) {
    const li = document.createElement('li');
    li.textContent = `${history[i]}  ${history[i + 1] ?? ''}`;
    el.moves.appendChild(li);
  }
  el.moves.scrollTop = el.moves.scrollHeight;
}

// Fills in the online panel.
//   players: [{ color: 'w'|'b', name, you, state, countdown, clock, clockState }]
//     clock: e.g. '4:59' (or null with no time control); clockState: 'running' | 'low' | ''
//     state: 'online' | 'offline' | 'exited' | 'empty'; countdown: e.g. '0:42' while offline
//   status, notice: lines of text
const online = {
  box: document.getElementById('online'),
  players: document.getElementById('online-players'),
  status: document.getElementById('online-status'),
  notice: document.getElementById('online-notice'),
};
export function showOnlinePanel({ players, status, notice }) {
  online.box.classList.remove('hidden');
  online.players.replaceChildren(
    ...players.map(({ color, name, you, state, countdown, clock, clockState }) => {
      // Built with textContent (never innerHTML), so a name can't inject HTML.
      const li = document.createElement('li');
      const dot = document.createElement('span');
      dot.className = `dot ${color}`;
      const label = document.createElement('span');
      label.className = 'player-name' + (you ? ' you' : '');
      label.textContent = name ?? (color === 'w' ? 'Ivory' : 'Obsidian') + ': waiting...';
      li.append(dot, label);
      if (you) li.append(Object.assign(document.createElement('span'), { className: 'you', textContent: '(you)' }));
      if (state === 'offline') li.append(Object.assign(document.createElement('span'), { className: 'away', textContent: 'disconnected' }));
      if (state === 'exited') li.append(Object.assign(document.createElement('span'), { className: 'away', textContent: 'left' }));
      if (countdown) li.append(Object.assign(document.createElement('span'), { className: 'countdown', textContent: countdown }));
      if (clock) li.append(Object.assign(document.createElement('span'), { className: `clock ${clockState}`, textContent: clock }));
      return li;
    })
  );
  online.status.textContent = status;
  online.notice.textContent = notice;
}

// Asks a yes/no question in a stone panel. Resolves true for yes.
export function askConfirm(question, yesLabel, noLabel) {
  const box = document.getElementById('confirm');
  box.querySelector('.confirm-text').textContent = question;
  const yes = box.querySelector('.confirm-yes');
  const no = box.querySelector('.confirm-no');
  yes.textContent = yesLabel;
  no.textContent = noLabel;
  box.classList.remove('hidden');
  return new Promise((resolve) => {
    const answer = (value) => () => {
      box.classList.add('hidden');
      yes.onclick = no.onclick = null;
      resolve(value);
    };
    yes.onclick = answer(true);
    no.onclick = answer(false);
  });
}

// The game over panel. actions: { menu(), newGame(), rematch() }
const gameover = document.getElementById('gameover');
export function showGameOver(title, text, actions) {
  gameover.querySelector('.gameover-title').textContent = title;
  gameover.querySelector('.gameover-text').textContent = text;
  gameover.classList.remove('hidden', 'peek');
  gameover.onclick = (e) => {
    const which = e.target.closest('[data-gameover]')?.dataset.gameover;
    if (which === 'view') gameover.classList.add('peek'); // shrink so the board can be seen
    if (which === 'menu') actions.menu();
    if (which === 'new') actions.newGame();
    if (which === 'rematch') actions.rematch();
  };
}

// The Rematch button and the line above the buttons.
//   rematch: { show, label, disabled, calling, note }
export function updateRematch({ show, label, disabled, calling, note }) {
  const button = gameover.querySelector('[data-gameover="rematch"]');
  button.hidden = !show;
  button.textContent = label;
  button.disabled = disabled;
  button.classList.toggle('calling', !!calling);
  gameover.querySelector('.gameover-rematch').textContent = note;
}

export function hideGameOver() {
  gameover.classList.add('hidden');
}

// Shows the promotion picker and resolves with 'q', 'r', 'b' or 'n'.
export function askPromotion() {
  return new Promise((resolve) => {
    el.promotion.classList.remove('hidden');
    const buttons = el.promotion.querySelectorAll('button');
    const pick = (e) => {
      buttons.forEach((b) => b.removeEventListener('click', pick));
      el.promotion.classList.add('hidden');
      resolve(e.currentTarget.dataset.piece);
    };
    buttons.forEach((b) => b.addEventListener('click', pick));
  });
}
