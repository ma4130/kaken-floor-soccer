export const FIELD = { width: 1600, height: 900, ballRadius: 0.019 };

export function solveHomography(points) {
  if (!Array.isArray(points) || points.length !== 4) return null;
  // These are the numbered markers drawn on the projected field border.
  const destination = [[0.045, 0.058], [0.955, 0.058], [0.955, 0.942], [0.045, 0.942]];
  const matrix = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = points[i];
    const [u, v] = destination[i];
    if (![x, y, u, v].every(Number.isFinite)) return null;
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let row = col + 1; row < 8; row++) {
      if (Math.abs(matrix[row][col]) > Math.abs(matrix[pivot][col])) pivot = row;
    }
    if (Math.abs(matrix[pivot][col]) < 1e-10) return null;
    [matrix[col], matrix[pivot]] = [matrix[pivot], matrix[col]];
    const divisor = matrix[col][col];
    for (let j = col; j <= 8; j++) matrix[col][j] /= divisor;
    for (let row = 0; row < 8; row++) {
      if (row === col) continue;
      const factor = matrix[row][col];
      for (let j = col; j <= 8; j++) matrix[row][j] -= factor * matrix[col][j];
    }
  }
  return matrix.map(row => row[8]);
}

export function mapPoint(h, x, y) {
  if (!h) return null;
  const d = h[6] * x + h[7] * y + 1;
  if (Math.abs(d) < 1e-8) return null;
  return { x: (h[0] * x + h[1] * y + h[2]) / d, y: (h[3] * x + h[4] * y + h[5]) / d };
}

export function createGame() {
  return {
    ball: { x: 0.5, y: 0.69, vx: 0, vy: 0 },
    score: 0,
    shots: 0,
    time: 60,
    running: false,
    flash: 0,
    message: 'READY?',
    messageTime: 0,
    resetDelay: 0,
    goalieX: 0.5,
    goalieClock: 0,
    lastKicks: {},
    elapsed: 0
  };
}

export function resetBall(game) {
  game.ball = { x: 0.5, y: 0.69, vx: 0, vy: 0 };
}

export function stepGame(game, dt, feet = []) {
  const events = [];
  dt = Math.min(Math.max(dt, 0), 0.05);
  if (!game.running || dt === 0) return events;
  game.elapsed += dt;
  game.time = Math.max(0, game.time - dt);
  game.goalieClock += dt;
  game.goalieX = 0.5 + Math.sin(game.goalieClock * 1.65) * 0.105;
  game.flash = Math.max(0, game.flash - dt);
  game.messageTime = Math.max(0, game.messageTime - dt);
  if (game.resetDelay > 0) {
    game.resetDelay -= dt;
    if (game.resetDelay <= 0) resetBall(game);
    if (game.time === 0) { game.running = false; game.message = 'TIME UP'; game.messageTime = 999; events.push('finish'); }
    return events;
  }

  const ball = game.ball;
  for (const foot of feet) {
    if (!Number.isFinite(foot.x) || !Number.isFinite(foot.y)) continue;
    const dx = ball.x - foot.x;
    const dy = ball.y - foot.y;
    const distance = Math.hypot(dx, dy);
    const speed = Math.hypot(foot.vx || 0, foot.vy || 0);
    const last = game.lastKicks[foot.id] ?? -10;
    if (distance < 0.052 && speed > 0.11 && game.elapsed - last > 0.22) {
      const directionX = distance > 0.001 ? dx / distance : 0;
      const directionY = distance > 0.001 ? dy / distance : -1;
      const strength = Math.min(0.86, Math.max(0.25, speed * 0.47));
      ball.vx = Math.max(-1.2, Math.min(1.2, ball.vx * 0.25 + (foot.vx || 0) * 0.8 + directionX * strength * 0.5));
      ball.vy = Math.max(-1.2, Math.min(1.2, ball.vy * 0.25 + (foot.vy || 0) * 0.8 + directionY * strength * 0.5));
      game.lastKicks[foot.id] = game.elapsed;
      game.shots++;
      events.push('kick');
    }
  }

  const friction = Math.exp(-0.8 * dt);
  ball.vx *= friction;
  ball.vy *= friction;
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  const r = FIELD.ballRadius;
  if (ball.x < 0.045 + r) { ball.x = 0.045 + r; ball.vx = Math.abs(ball.vx) * 0.72; }
  if (ball.x > 0.955 - r) { ball.x = 0.955 - r; ball.vx = -Math.abs(ball.vx) * 0.72; }
  if (ball.y > 0.92 - r) { ball.y = 0.92 - r; ball.vy = -Math.abs(ball.vy) * 0.72; }

  // The goalie guards the goal mouth; a clean shot must pass either side of it.
  if (ball.vy < 0 && ball.y - r < 0.145 && ball.y + r > 0.105 && Math.abs(ball.x - game.goalieX) < 0.058) {
    ball.y = 0.145 + r;
    ball.vy = Math.abs(ball.vy) * 0.76;
    ball.vx += (ball.x < game.goalieX ? -1 : 1) * 0.07;
    events.push('save');
  }
  if (ball.y < 0.054) {
    if (ball.x > 0.392 && ball.x < 0.608) {
      game.score++;
      game.flash = 0.65;
      game.message = 'GOAL!';
      game.messageTime = 1.5;
      game.resetDelay = 1.25;
      ball.vx = 0;
      ball.vy = 0;
      events.push('goal');
    } else {
      ball.y = 0.054;
      ball.vy = Math.abs(ball.vy) * 0.72;
    }
  }
  if (game.time === 0) { game.running = false; game.message = 'TIME UP'; game.messageTime = 999; events.push('finish'); }
  return events;
}

export function footFromPose(landmarks, heelIndex, toeIndex) {
  const heel = landmarks?.[heelIndex];
  const toe = landmarks?.[toeIndex];
  if (!heel || !toe || (heel.visibility ?? 1) < 0.45 || (toe.visibility ?? 1) < 0.45) return null;
  return { x: heel.x * 0.38 + toe.x * 0.62, y: heel.y * 0.38 + toe.y * 0.62 };
}
