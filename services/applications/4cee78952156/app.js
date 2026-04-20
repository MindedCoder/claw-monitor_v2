const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const durationEl = document.getElementById('duration');
const bestScoreEl = document.getElementById('bestScore');
const overlay = document.getElementById('overlay');
const overlayTitle = document.getElementById('overlayTitle');
const overlayText = document.getElementById('overlayText');
const startBtn = document.getElementById('startBtn');
const restartBtn = document.getElementById('restartBtn');

const GRID_COUNT = 22;
const TILE_SIZE = canvas.width / GRID_COUNT;
const TICK_MS = 145;
const BEST_SCORE_KEY = 'snake-mobile-swipe-best';
const MIN_SWIPE = 18;

let snake = [];
let direction = { x: 1, y: 0 };
let nextDirection = { x: 1, y: 0 };
let food = { x: 0, y: 0 };
let gameLoop = null;
let timerLoop = null;
let score = 0;
let startedAt = 0;
let elapsedMs = 0;
let running = false;
let touchStartX = 0;
let touchStartY = 0;

function initGame() {
  snake = [
    { x: 5, y: 9 },
    { x: 4, y: 9 },
    { x: 3, y: 9 }
  ];
  direction = { x: 1, y: 0 };
  nextDirection = { x: 1, y: 0 };
  food = spawnFood();
  score = 0;
  startedAt = 0;
  elapsedMs = 0;
  running = false;
  stopLoops();
  scoreEl.textContent = '0';
  durationEl.textContent = '00:00';
  bestScoreEl.textContent = localStorage.getItem(BEST_SCORE_KEY) || '0';
  showOverlay('轻点开始', '开始后在棋盘上滑动控制方向，吃到果子就加分。');
  draw();
}

function stopLoops() {
  if (gameLoop) {
    clearInterval(gameLoop);
    gameLoop = null;
  }
  if (timerLoop) {
    clearInterval(timerLoop);
    timerLoop = null;
  }
}

function startGame() {
  if (running) return;
  running = true;
  startedAt = Date.now() - elapsedMs;
  overlay.classList.remove('show');
  gameLoop = setInterval(tick, TICK_MS);
  timerLoop = setInterval(() => {
    elapsedMs = Date.now() - startedAt;
    durationEl.textContent = formatTime(elapsedMs);
  }, 250);
}

function restartGame() {
  initGame();
  startGame();
}

function spawnFood() {
  while (true) {
    const item = {
      x: Math.floor(Math.random() * GRID_COUNT),
      y: Math.floor(Math.random() * GRID_COUNT)
    };
    const occupied = snake.some((part) => part.x === item.x && part.y === item.y);
    if (!occupied) return item;
  }
}

function tick() {
  direction = nextDirection;
  const head = {
    x: snake[0].x + direction.x,
    y: snake[0].y + direction.y
  };

  const hitWall = head.x < 0 || head.y < 0 || head.x >= GRID_COUNT || head.y >= GRID_COUNT;
  const hitSelf = snake.some((part) => part.x === head.x && part.y === head.y);
  if (hitWall || hitSelf) {
    endGame();
    return;
  }

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score += 10;
    scoreEl.textContent = String(score);
    food = spawnFood();
  } else {
    snake.pop();
  }

  draw();
}

function endGame() {
  running = false;
  stopLoops();
  elapsedMs = Date.now() - startedAt;
  durationEl.textContent = formatTime(elapsedMs);
  const best = Math.max(Number(localStorage.getItem(BEST_SCORE_KEY) || 0), score);
  localStorage.setItem(BEST_SCORE_KEY, String(best));
  bestScoreEl.textContent = String(best);
  showOverlay('游戏结束', `分数 ${score}，时长 ${formatTime(elapsedMs)}。点重新开始再来一局。`);
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
  bg.addColorStop(0, '#ffffff');
  bg.addColorStop(1, '#f8fafc');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= GRID_COUNT; i += 1) {
    const offset = i * TILE_SIZE;
    ctx.beginPath();
    ctx.moveTo(offset, 0);
    ctx.lineTo(offset, canvas.height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, offset);
    ctx.lineTo(canvas.width, offset);
    ctx.stroke();
  }

  snake.forEach((part, index) => {
    const x = part.x * TILE_SIZE + 2;
    const y = part.y * TILE_SIZE + 2;
    const size = TILE_SIZE - 4;
    ctx.fillStyle = index === 0 ? '#22c55e' : '#34d399';
    roundRect(x, y, size, size, 7);
    ctx.fill();

    if (index === 0) {
      ctx.fillStyle = '#ecfeff';
      ctx.beginPath();
      ctx.arc(x + size * 0.35, y + size * 0.34, 2.2, 0, Math.PI * 2);
      ctx.arc(x + size * 0.65, y + size * 0.34, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
  });

  const fx = food.x * TILE_SIZE + TILE_SIZE / 2;
  const fy = food.y * TILE_SIZE + TILE_SIZE / 2;
  ctx.fillStyle = '#fb7185';
  ctx.beginPath();
  ctx.arc(fx, fy, TILE_SIZE * 0.28, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fecdd3';
  ctx.beginPath();
  ctx.arc(fx - 2, fy - 2, TILE_SIZE * 0.08, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function formatTime(ms) {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const seconds = String(totalSec % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function showOverlay(title, text) {
  overlayTitle.textContent = title;
  overlayText.textContent = text;
  overlay.classList.add('show');
}

function setDirectionBySwipe(dx, dy) {
  if (Math.abs(dx) < MIN_SWIPE && Math.abs(dy) < MIN_SWIPE) return;

  let candidate;
  if (Math.abs(dx) > Math.abs(dy)) {
    candidate = dx > 0 ? { x: 1, y: 0 } : { x: -1, y: 0 };
  } else {
    candidate = dy > 0 ? { x: 0, y: 1 } : { x: 0, y: -1 };
  }

  if (candidate.x === -direction.x && candidate.y === -direction.y) return;
  nextDirection = candidate;
  if (!running) startGame();
}

canvas.addEventListener('touchstart', (event) => {
  const touch = event.changedTouches[0];
  touchStartX = touch.clientX;
  touchStartY = touch.clientY;
}, { passive: true });

canvas.addEventListener('touchend', (event) => {
  const touch = event.changedTouches[0];
  const dx = touch.clientX - touchStartX;
  const dy = touch.clientY - touchStartY;
  setDirectionBySwipe(dx, dy);
}, { passive: true });

canvas.addEventListener('pointerdown', (event) => {
  touchStartX = event.clientX;
  touchStartY = event.clientY;
});

canvas.addEventListener('pointerup', (event) => {
  const dx = event.clientX - touchStartX;
  const dy = event.clientY - touchStartY;
  setDirectionBySwipe(dx, dy);
});

startBtn.addEventListener('click', startGame);
restartBtn.addEventListener('click', restartGame);

overlay.addEventListener('click', (event) => {
  if (!event.target.closest('button') && !running) {
    startGame();
  }
});

initGame();
