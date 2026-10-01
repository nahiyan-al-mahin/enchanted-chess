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
