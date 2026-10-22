import test from 'node:test';
import assert from 'node:assert/strict';
import { createGame, footFromPose, mapPoint, solveHomography, stepGame } from '../src/core.js';

test('camera quadrilateral maps onto the numbered floor markers', () => {
  const input = [[.18, .12], [.83, .16], [.92, .86], [.11, .82]];
  const h = solveHomography(input);
  assert.ok(h);
  const expected = [[.045, .058], [.955, .058], [.955, .942], [.045, .942]];
  input.forEach(([x, y], i) => {
    const actual = mapPoint(h, x, y);
    assert.ok(Math.abs(actual.x - expected[i][0]) < 1e-7);
    assert.ok(Math.abs(actual.y - expected[i][1]) < 1e-7);
  });
  assert.equal(solveHomography([[0, 0], [0, 0], [0, 0], [0, 0]]), null);
});

test('visible heel and toe form a foot point', () => {
  const landmarks = [];
  landmarks[29] = { x: .2, y: .5, visibility: .9 };
  landmarks[31] = { x: .3, y: .7, visibility: .9 };
  assert.deepEqual(footFromPose(landmarks, 29, 31), { x: .262, y: .624 });
  landmarks[31].visibility = .1;
  assert.equal(footFromPose(landmarks, 29, 31), null);
});

test('a moving foot kicks the ball once per contact and the goal scores', () => {
  const game = createGame();
  game.running = true;
  const events = stepGame(game, .016, [{ id: 'left', x: .5, y: .71, vx: 0, vy: -.8 }]);
  assert.ok(events.includes('kick'));
  assert.equal(game.shots, 1);
  stepGame(game, .016, [{ id: 'left', x: .5, y: .71, vx: 0, vy: -.8 }]);
  assert.equal(game.shots, 1);
  game.ball = { x: .45, y: .06, vx: 0, vy: -.6 };
  game.goalieClock = 2;
  assert.ok(stepGame(game, .016).includes('goal'));
  assert.equal(game.score, 1);
  assert.equal(game.resetDelay > 0, true);
});

test('one clear kick carries the ball from the starting point into attack', () => {
  const game = createGame();
  game.running = true;
  stepGame(game, .016, [{ id: 'left', x: .5, y: .72, vx: 0, vy: -.75 }]);
  for (let i = 0; i < 60; i++) stepGame(game, 1 / 60);
  assert.ok(game.ball.y < .25 || game.score > 0);
});
