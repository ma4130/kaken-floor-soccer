import test from 'node:test';
import assert from 'node:assert/strict';
import { assignPoseTeams, createGame, footFromPose, mapPoint, solveHomography, stepGame } from '../src/core.js';

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

test('pose teams stay assigned when the detector changes its output order', () => {
  const first = assignPoseTeams([{ x: .25, y: .5 }, { x: .75, y: .5 }]);
  assert.deepEqual(first.map(p => p.team), ['blue', 'pink']);
  const reversed = assignPoseTeams([{ x: .76, y: .5 }, { x: .24, y: .5 }], {
    blue: { x: .25, y: .5 }, pink: { x: .75, y: .5 }
  });
  assert.deepEqual(reversed.map(p => p.team), ['pink', 'blue']);
  assert.equal(assignPoseTeams([{ x: .8, y: .5 }], { pink: { x: .76, y: .5 } })[0].team, 'pink');
});

test('each team gets its own kick count and scores in the opposite goal', () => {
  const game = createGame();
  game.running = true;
  const events = stepGame(game, .016, [{ id: 'blue-left', team: 'blue', x: .47, y: .5, vx: .8, vy: 0 }]);
  assert.ok(events.includes('kick'));
  assert.deepEqual(game.shots, { blue: 1, pink: 0 });
  stepGame(game, .016, [{ id: 'blue-left', team: 'blue', x: .47, y: .5, vx: .8, vy: 0 }]);
  assert.equal(game.shots.blue, 1);
  game.ball = { x: .94, y: .5, vx: .7, vy: 0 };
  assert.ok(stepGame(game, .016).includes('goal'));
  assert.deepEqual(game.scores, { blue: 1, pink: 0 });
  assert.ok(game.resetDelay > 0);
  for (let i = 0; i < 70; i++) stepGame(game, .016);
  game.ball = { x: .06, y: .5, vx: -.7, vy: 0 };
  assert.ok(stepGame(game, .016).includes('goal'));
  assert.deepEqual(game.scores, { blue: 1, pink: 1 });
});

test('the ball rebounds outside the goal opening and match ends with a winner', () => {
  const game = createGame();
  game.running = true;
  game.ball = { x: .94, y: .25, vx: .7, vy: 0 };
  assert.ok(!stepGame(game, .016).includes('goal'));
  assert.ok(game.ball.vx < 0);
  game.scores.pink = 2;
  game.time = .01;
  assert.ok(stepGame(game, .016).includes('finish'));
  assert.equal(game.message, 'PINK WINS!');
  assert.equal(game.running, false);
});
