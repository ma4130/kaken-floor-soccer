import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { createGame, footFromPose, mapPoint, solveHomography, stepGame } from './core.js';
import './style.css';

const CHANNEL = 'floor-soccer-v1';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task';
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const cornerNames = ['左上', '右上', '右下', '左下'];
const channel = new BroadcastChannel(CHANNEL);
const isProjector = new URLSearchParams(location.search).has('projector');
const app = document.querySelector('#app');

let game = createGame();
let feet = [];
let calibration = loadCalibration();
let calibrationPoints = [];
let calibrating = false;
let demoMode = false;
let sensitivity = Number(localStorage.getItem('floor-soccer-sensitivity') || 1);
let soundEnabled = localStorage.getItem('floor-soccer-sound') !== 'off';
let lastTime = performance.now();
let lastBroadcast = 0;
let audioContext;

function loadCalibration() {
  try {
    const points = JSON.parse(localStorage.getItem('floor-soccer-calibration'));
    return solveHomography(points) ? points : null;
  } catch { return null; }
}

function setupCanvas(canvas) {
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * ratio));
  const h = Math.max(1, Math.round(rect.height * ratio));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(w / 1600, 0, 0, h / 900, 0, 0);
  return ctx;
}

function roundedRect(ctx, x, y, w, h, r, fill, stroke) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.stroke(); }
}

function drawCourt(canvas, state = game, players = feet, showCalibration = calibrating) {
  const ctx = setupCanvas(canvas);
  const w = 1600, h = 900;
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, '#0a2822'); gradient.addColorStop(0.52, '#0b342a'); gradient.addColorStop(1, '#0a211e');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, w, h);
  ctx.save(); ctx.globalAlpha = 0.09;
  for (let i = 0; i < 10; i++) { ctx.fillStyle = i % 2 ? '#40e7a4' : '#082019'; ctx.fillRect(72 + i * 146, 50, 146, 800); }
  ctx.restore();
  ctx.strokeStyle = 'rgba(186,255,218,.56)'; ctx.lineWidth = 5;
  ctx.strokeRect(72, 52, 1456, 796);
  ctx.beginPath(); ctx.moveTo(72, 450); ctx.lineTo(1528, 450); ctx.stroke();
  ctx.beginPath(); ctx.arc(800, 450, 106, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(800, 450, 7, 0, Math.PI * 2); ctx.fillStyle = '#baffdc'; ctx.fill();
  ctx.strokeRect(550, 52, 500, 168);
  ctx.strokeRect(665, 52, 270, 76);
  ctx.beginPath(); ctx.arc(800, 220, 8, 0, Math.PI * 2); ctx.fill();
  // Goal is wide and bright enough to remain legible on a projected floor.
  ctx.shadowColor = '#55ffae'; ctx.shadowBlur = 38;
  roundedRect(ctx, 628, 12, 344, 64, 20, '#44e89a', '#d5ffe8');
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#073d2b'; ctx.font = '900 38px "Barlow Condensed", sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('GOAL', 800, 58);
  ctx.fillStyle = '#c7ffe2'; ctx.font = '700 24px "Barlow Condensed", sans-serif';
  ctx.fillText('KICK THE LIGHT', 800, 824);

  // Goalie.
  const goalieX = state.goalieX * w;
  ctx.shadowColor = '#ffb46d'; ctx.shadowBlur = 24;
  roundedRect(ctx, goalieX - 66, 110, 132, 25, 13, '#ffae64');
  ctx.shadowBlur = 0;

  // The ball trail is inferred from velocity so it works across the second window.
  const ball = state.ball;
  const bx = ball.x * w, by = ball.y * h;
  const velocity = Math.hypot(ball.vx, ball.vy);
  if (velocity > 0.04) {
    ctx.strokeStyle = 'rgba(204,255,126,.35)'; ctx.lineWidth = 23; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - ball.vx * 175, by - ball.vy * 110); ctx.stroke();
  }
  ctx.shadowColor = '#d9ff70'; ctx.shadowBlur = 45;
  ctx.fillStyle = '#d9ff70'; ctx.beginPath(); ctx.arc(bx, by, 31, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0; ctx.fillStyle = '#193f24';
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(bx + Math.cos(angle) * 15, by + Math.sin(angle) * 15, 4.5, 0, Math.PI * 2); ctx.fill();
  }

  for (const foot of players) {
    const x = foot.x * w, y = foot.y * h;
    if (x < 0 || x > w || y < 0 || y > h) continue;
    const color = foot.id === 'left' ? '#56d9ff' : '#ff8b7b';
    ctx.strokeStyle = color; ctx.lineWidth = 5; ctx.shadowColor = color; ctx.shadowBlur = 22;
    ctx.beginPath(); ctx.arc(x, y, 38, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.shadowBlur = 0;
  }

  roundedRect(ctx, 100, 76, 190, 97, 20, 'rgba(2,20,17,.8)', 'rgba(136,250,192,.26)');
  roundedRect(ctx, 1310, 76, 190, 97, 20, 'rgba(2,20,17,.8)', 'rgba(136,250,192,.26)');
  ctx.textAlign = 'left'; ctx.fillStyle = '#9cd5bc'; ctx.font = '700 22px "Barlow Condensed", sans-serif'; ctx.fillText('SCORE', 124, 111);
  ctx.fillStyle = '#f0ffe8'; ctx.font = '900 62px "Barlow Condensed", sans-serif'; ctx.fillText(String(state.score).padStart(2, '0'), 122, 160);
  ctx.fillStyle = '#9cd5bc'; ctx.font = '700 22px "Barlow Condensed", sans-serif'; ctx.fillText('TIME', 1334, 111);
  ctx.fillStyle = '#f0ffe8'; ctx.font = '900 62px "Barlow Condensed", sans-serif'; ctx.fillText(String(Math.ceil(state.time)).padStart(2, '0'), 1332, 160);

  if (state.flash > 0) { ctx.fillStyle = `rgba(170,255,154,${state.flash * .27})`; ctx.fillRect(0, 0, w, h); }
  if ((state.messageTime > 0 || !state.running) && !showCalibration) {
    const label = state.messageTime > 0 ? state.message : (state.time <= 0 ? 'TIME UP' : 'READY?');
    ctx.textAlign = 'center'; ctx.font = '900 124px "Barlow Condensed", sans-serif';
    ctx.shadowColor = '#071b18'; ctx.shadowBlur = 35; ctx.fillStyle = '#f3ffe8'; ctx.fillText(label, 800, 411); ctx.shadowBlur = 0;
    if (!state.running && state.time > 0) { ctx.font = '600 28px "Noto Sans JP", sans-serif'; ctx.fillText('操作画面でゲームをスタート', 800, 471); }
    if (!state.running && state.time === 0) { ctx.font = '600 28px "Noto Sans JP", sans-serif'; ctx.fillText(`${state.score} GOALS · ${state.shots} SHOTS`, 800, 475); }
  }
  if (showCalibration) {
    ctx.fillStyle = 'rgba(1,18,15,.46)'; ctx.fillRect(0, 0, w, h);
    const marks = [[72, 52], [1528, 52], [1528, 848], [72, 848]];
    marks.forEach(([x, y], i) => {
      ctx.strokeStyle = '#dfff74'; ctx.lineWidth = 6; ctx.shadowColor = '#dfff74'; ctx.shadowBlur = 25;
      ctx.beginPath(); ctx.arc(x, y, 30, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = '#eaffac'; ctx.textAlign = 'center'; ctx.font = '900 26px "Barlow Condensed", sans-serif'; ctx.fillText(String(i + 1), x, y + 9);
    });
    ctx.fillStyle = '#f3ffe8'; ctx.textAlign = 'center'; ctx.font = '700 36px "Noto Sans JP", sans-serif'; ctx.fillText('カメラ画面で 1 → 2 → 3 → 4 をクリック', 800, 450);
  }
}

function playSound(event) {
  if (!soundEnabled || isProjector) return;
  try {
    audioContext ||= new AudioContext();
    const now = audioContext.currentTime;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = event === 'goal' ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(event === 'goal' ? 490 : event === 'save' ? 190 : 135, now);
    oscillator.frequency.exponentialRampToValueAtTime(event === 'goal' ? 980 : event === 'save' ? 110 : 55, now + (event === 'goal' ? .4 : .16));
    gain.gain.setValueAtTime(.11, now); gain.gain.exponentialRampToValueAtTime(.001, now + (event === 'goal' ? .45 : .18));
    oscillator.connect(gain).connect(audioContext.destination);
    oscillator.start(now); oscillator.stop(now + (event === 'goal' ? .46 : .2));
  } catch { /* Audio is optional. */ }
}

function broadcast(force = false) {
  const now = performance.now();
  if (!force && now - lastBroadcast < 40) return;
  lastBroadcast = now;
  channel.postMessage({ type: 'state', game, feet, calibrating });
}

if (isProjector) {
  app.innerHTML = `<main class="projection"><canvas id="projector-canvas" aria-label="床サッカーの投影画面"></canvas><button class="fullscreen-button" id="fullscreen-button">⛶ 全画面表示</button><div class="projector-hint" id="projector-hint">操作画面との接続を待っています</div></main>`;
  const canvas = document.querySelector('#projector-canvas');
  const hint = document.querySelector('#projector-hint');
  let connected = false;
  channel.onmessage = e => {
    if (e.data?.type !== 'state') return;
    game = e.data.game; feet = e.data.feet; calibrating = e.data.calibrating;
    connected = true; hint.hidden = true;
  };
  document.querySelector('#fullscreen-button').addEventListener('click', async () => {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    else await document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', () => document.body.classList.toggle('is-fullscreen', !!document.fullscreenElement));
  function projectionLoop() { drawCourt(canvas, game, feet, calibrating); requestAnimationFrame(projectionLoop); }
  projectionLoop();
  channel.postMessage({ type: 'hello' });
  window.setInterval(() => { if (!connected) channel.postMessage({ type: 'hello' }); }, 1000);
} else {
  app.innerHTML = `
    <div class="shell">
      <header class="topbar"><a class="brand" href="./"><span class="brand-ball">✦</span><span>FLOOR<br><b>SOCCER</b></span></a><span class="top-label">KAKEN / INTERACTIVE FLOOR GAME</span><span class="live-pill"><i></i> LIVE EXPERIENCE</span></header>
      <main>
        <section class="hero"><div><div class="eyebrow"><span>01 / INTERACTIVE GAME</span><span class="eyebrow-line"></span><span>CAMERA × PROJECTION</span></div><h1>足で、<em>決めろ。</em></h1><p>床に映ったボールをキックして、ゴールを狙おう。<br>カメラが足の動きをとらえ、光のフィールドに反映します。</p><div class="hero-actions"><button id="open-projector" class="button button-primary">↗ 投影画面を開く</button><a href="#setup" class="text-link">セットアップを見る <span>↓</span></a></div></div><div class="hero-decoration"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="hero-foot">⚽</span><span class="hero-deco-label">MOVE YOUR FEET<br>MAKE IT COUNT.</span></div></section>
        <section class="workspace" id="setup">
          <div class="section-heading"><div><span class="section-kicker">PLAY STATION</span><h2>ゲームを準備する</h2></div><span class="section-note">上から順に設定してください <b>↓</b></span></div>
          <div class="workspace-grid">
            <div class="left-column">
              <article class="panel camera-panel"><div class="panel-heading"><div><span class="step">01</span><h3>カメラで足元を映す</h3></div><span class="tag" id="camera-tag">未接続</span></div><div class="camera-stage" id="camera-stage"><video id="camera-video" playsinline muted></video><canvas id="camera-overlay"></canvas><div class="camera-empty" id="camera-empty"><span class="camera-symbol">◉</span><strong>CAMERA OFFLINE</strong><small>足元が映る位置にカメラを設置してください</small></div></div><div class="camera-actions"><select id="camera-select" aria-label="カメラを選択"><option value="">標準のカメラ</option></select><button id="start-camera" class="button button-light">カメラを起動</button><button id="stop-camera" class="button button-quiet" disabled>停止</button></div><p class="hint">全身と両足が映るよう、カメラを床に向けて少し斜め上から設置してください。</p></article>
              <article class="panel calibration-panel"><div class="panel-heading"><div><span class="step">02</span><h3>床の四隅を合わせる</h3></div><span class="tag" id="calibration-tag">未設定</span></div><p>投影画面に出る <b>1 → 2 → 3 → 4</b> の四隅を、上のカメラ映像で順にクリックします。</p><div class="calibration-progress" id="calibration-progress"><span>1</span><span>2</span><span>3</span><span>4</span></div><div class="calibration-actions"><button id="calibrate" class="button button-outline">四隅の設定を始める</button><button id="clear-calibration" class="button button-quiet">設定を消す</button></div><p class="inline-status" id="calibration-status">カメラと投影画面を開くと設定できます。</p></article>
            </div>
            <div class="right-column">
              <article class="panel game-panel"><div class="panel-heading"><div><span class="step">03</span><h3>ゲームをプレイ</h3></div><span class="tag tag-accent">60 SEC CHALLENGE</span></div><div class="game-screen"><canvas id="game-canvas" aria-label="床サッカーのプレビュー"></canvas></div><div class="mode-tabs" role="group" aria-label="操作方法"><button id="camera-mode" class="mode active">◉ 足で操作</button><button id="demo-mode" class="mode">↗ マウスで試す</button></div><p class="mode-hint" id="mode-hint">足の動きがボールに当たるとシュートできます。</p><div class="game-actions"><button id="start-game" class="button button-primary">▶ ゲームスタート</button><button id="reset-game" class="button button-quiet">↻ リセット</button></div><div class="game-stats"><div><span>GOALS</span><strong id="score-value">00</strong></div><div><span>SHOTS</span><strong id="shots-value">00</strong></div><div><span>TIME LEFT</span><strong id="time-value">60</strong></div></div></article>
              <article class="panel settings-panel"><div class="panel-heading"><div><span class="step small-step">✦</span><h3>プレイ設定</h3></div></div><label class="setting-row" for="sensitivity"><span>キック感度<small>足の動きをボールに伝える強さ</small></span><span class="setting-control"><input id="sensitivity" type="range" min="0.5" max="1.8" step="0.1" value="1"><b id="sensitivity-value">1.0×</b></span></label><label class="setting-row" for="sound"><span>効果音<small>キック・ゴール音を再生</small></span><input id="sound" type="checkbox" checked></label></article>
            </div>
          </div>
        </section>
        <section class="howto"><span class="section-kicker">HOW TO PLAY</span><h2>光のボールを、足で蹴る。</h2><div class="howto-grid"><div><span>01</span><strong>映す</strong><p>投影画面をプロジェクターへ移動して全画面に。</p></div><div><span>02</span><strong>合わせる</strong><p>カメラ映像の中で床の四隅を指定。</p></div><div><span>03</span><strong>決める</strong><p>足を動かしてボールを蹴り、60秒でゴールを狙う。</p></div></div></section>
      </main><footer>FLOOR SOCCER <span>MADE FOR KAKEN</span></footer>
    </div>`;

  const $ = selector => document.querySelector(selector);
  const video = $('#camera-video');
  const overlay = $('#camera-overlay');
  const stage = $('#camera-stage');
  const court = $('#game-canvas');
  let stream = null;
  let landmarker = null;
  let poseLoading = false;
  let previousFoot = new Map();
  let lastDetection = 0;
  let pointerFoot = null;
  let lastPointer = null;
  const calibrated = () => solveHomography(calibration);

  function status(text, good = false) { $('#calibration-status').textContent = text; $('#calibration-status').classList.toggle('good', good); }
  function updateCalibrationUI() {
    $('#calibration-tag').textContent = calibration ? '設定済み' : '未設定';
    $('#calibration-tag').classList.toggle('tag-success', !!calibration);
    [...$('#calibration-progress').children].forEach((item, i) => item.classList.toggle('done', i < calibrationPoints.length || (!!calibration && !calibrating)));
    stage.classList.toggle('calibrating', calibrating);
    $('#calibrate').textContent = calibrating ? '設定を中止' : '四隅の設定を始める';
  }
  updateCalibrationUI();

  async function populateCameras() {
    try {
      const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
      const selected = $('#camera-select').value;
      $('#camera-select').innerHTML = '<option value="">標準のカメラ</option>' + devices.map((d, i) => `<option value="${d.deviceId}">${escapeHTML(d.label || `カメラ ${i + 1}`)}</option>`).join('');
      $('#camera-select').value = selected;
    } catch { /* Device labels can be unavailable before permission. */ }
  }
  function escapeHTML(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }

  async function loadPose() {
    if (landmarker || poseLoading) return;
    poseLoading = true;
    $('#camera-tag').textContent = '認識モデルを準備中';
    try {
      const vision = await FilesetResolver.forVisionTasks(WASM);
      try {
        landmarker = await PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' }, runningMode: 'VIDEO', numPoses: 2, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      } catch {
        landmarker = await PoseLandmarker.createFromOptions(vision, { baseOptions: { modelAssetPath: MODEL, delegate: 'CPU' }, runningMode: 'VIDEO', numPoses: 2, minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5 });
      }
      $('#camera-tag').textContent = '認識中'; $('#camera-tag').classList.add('tag-success');
    } catch (error) {
      console.error(error);
      $('#camera-tag').textContent = '認識に失敗';
      status('姿勢認識モデルを読み込めませんでした。ネット接続を確認してください。');
    } finally { poseLoading = false; }
  }

  async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { status('カメラは localhost または HTTPS で開いてください。'); return; }
    $('#camera-tag').textContent = '接続中';
    try {
      if (stream) stream.getTracks().forEach(t => t.stop());
      const deviceId = $('#camera-select').value;
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } });
      video.srcObject = stream;
      await video.play();
      stage.style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
      $('#camera-empty').hidden = true;
      $('#start-camera').textContent = 'カメラを切り替え'; $('#stop-camera').disabled = false;
      await populateCameras();
      status(calibration ? '四隅は設定済みです。足が認識されるとプレビューに表示されます。' : '次に投影画面を開き、床の四隅を設定してください。', !!calibration);
      loadPose();
    } catch (error) {
      console.error(error);
      $('#camera-tag').textContent = '接続できません';
      status('カメラを起動できません。ブラウザの許可と、他のアプリで使用中でないか確認してください。');
    }
  }
  function stopCamera() {
    stream?.getTracks().forEach(t => t.stop()); stream = null; video.srcObject = null;
    $('#camera-empty').hidden = false; $('#camera-tag').textContent = '未接続'; $('#camera-tag').classList.remove('tag-success');
    $('#start-camera').textContent = 'カメラを起動'; $('#stop-camera').disabled = true;
    feet = []; previousFoot.clear();
  }
  $('#start-camera').addEventListener('click', startCamera);
  $('#stop-camera').addEventListener('click', stopCamera);
  $('#camera-select').addEventListener('change', () => { if (stream) startCamera(); });
  populateCameras();

  $('#open-projector').addEventListener('click', () => {
    const windowRef = window.open(`${location.pathname}?projector=1`, 'floor-soccer-projector', 'width=1280,height=720');
    if (!windowRef) status('ポップアップがブロックされました。ポップアップを許可してください。');
    else { windowRef.focus(); broadcast(true); }
  });
  $('#calibrate').addEventListener('click', () => {
    if (calibrating) { calibrating = false; calibrationPoints = []; status('四隅の設定を中止しました。'); }
    else if (!stream) { status('先にカメラを起動してください。'); return; }
    else { calibrating = true; calibrationPoints = []; status('カメラ映像で、投影された 1（左上）をクリックしてください。'); }
    updateCalibrationUI(); broadcast(true);
  });
  $('#clear-calibration').addEventListener('click', () => {
    calibration = null; calibrationPoints = []; calibrating = false; localStorage.removeItem('floor-soccer-calibration');
    updateCalibrationUI(); status('四隅の設定を消しました。'); broadcast(true);
  });
  stage.addEventListener('click', e => {
    if (!calibrating) return;
    const rect = video.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    calibrationPoints.push([x, y]);
    if (calibrationPoints.length === 4) {
      const homography = solveHomography(calibrationPoints);
      const area = Math.abs(calibrationPoints.reduce((sum, p, i) => { const q = calibrationPoints[(i + 1) % 4]; return sum + p[0] * q[1] - q[0] * p[1]; }, 0)) / 2;
      if (!homography || area < 0.015) { calibrationPoints = []; status('四隅が近すぎます。広い範囲を囲んで、もう一度 1 から指定してください。'); }
      else { calibration = [...calibrationPoints]; localStorage.setItem('floor-soccer-calibration', JSON.stringify(calibration)); calibrating = false; status('四隅を保存しました。足の位置を床に対応付けています。', true); }
    } else status(`次は ${calibrationPoints.length + 1}（${cornerNames[calibrationPoints.length]}）をクリックしてください。`);
    updateCalibrationUI(); broadcast(true);
  });

  function setMode(demo) {
    demoMode = demo; feet = []; previousFoot.clear(); pointerFoot = null;
    $('#camera-mode').classList.toggle('active', !demo); $('#demo-mode').classList.toggle('active', demo);
  $('#mode-hint').textContent = demo ? 'ボールをクリック、またはマウスを動かして蹴ってみよう。' : '足の動きがボールに当たるとシュートできます。';
    court.style.cursor = demo ? 'crosshair' : 'default';
  }
  $('#camera-mode').addEventListener('click', () => setMode(false));
  $('#demo-mode').addEventListener('click', () => setMode(true));

  function pointerPosition(event) {
    const rect = court.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  }
  court.addEventListener('pointerdown', event => {
    if (!demoMode) return;
    court.setPointerCapture(event.pointerId);
    lastPointer = { ...pointerPosition(event), time: performance.now() };
    pointerFoot = { id: 'demo', ...lastPointer, vx: 0, vy: 0 };
    if (game.running && Math.hypot(lastPointer.x - game.ball.x, lastPointer.y - game.ball.y) < .052) {
      const clickKick = { id: 'demo', x: game.ball.x, y: game.ball.y + .026, vx: (game.ball.x - lastPointer.x) * 2, vy: -.75 };
      stepGame(game, .001, [clickKick]).forEach(playSound);
    }
  });
  court.addEventListener('pointermove', event => {
    if (!demoMode || !lastPointer) return;
    const point = pointerPosition(event), now = performance.now(), dt = Math.max((now - lastPointer.time) / 1000, .016);
    pointerFoot = { id: 'demo', x: point.x, y: point.y, vx: Math.max(-2, Math.min(2, (point.x - lastPointer.x) / dt)), vy: Math.max(-2, Math.min(2, (point.y - lastPointer.y) / dt)), time: now };
    lastPointer = { ...point, time: now };
    // A quick mouse gesture may finish between animation frames.
    stepGame(game, .001, [pointerFoot]).forEach(playSound);
  });
  const clearPointer = () => { lastPointer = null; pointerFoot = null; };
  court.addEventListener('pointerup', clearPointer); court.addEventListener('pointercancel', clearPointer); court.addEventListener('pointerleave', e => { if (!court.hasPointerCapture(e.pointerId)) clearPointer(); });

  $('#start-game').addEventListener('click', () => {
    if (!demoMode && (!stream || !calibrated() || !landmarker)) { status('足で遊ぶには、カメラを起動して床の四隅を設定してください。モデルの読み込み完了も確認してください。'); return; }
    if (game.time === 0) game = createGame();
    game.running = !game.running;
    game.messageTime = 0;
    $('#start-game').textContent = game.running ? 'Ⅱ 一時停止' : '▶ 再開';
    broadcast(true);
  });
  $('#reset-game').addEventListener('click', () => { game = createGame(); $('#start-game').textContent = '▶ ゲームスタート'; broadcast(true); });
  $('#sensitivity').value = sensitivity;
  $('#sensitivity-value').textContent = `${sensitivity.toFixed(1)}×`;
  $('#sensitivity').addEventListener('input', e => { sensitivity = Number(e.target.value); $('#sensitivity-value').textContent = `${sensitivity.toFixed(1)}×`; localStorage.setItem('floor-soccer-sensitivity', String(sensitivity)); });
  $('#sound').checked = soundEnabled;
  $('#sound').addEventListener('change', e => { soundEnabled = e.target.checked; localStorage.setItem('floor-soccer-sound', soundEnabled ? 'on' : 'off'); });

  function detectFeet(now) {
    if (!stream || !landmarker || video.readyState < 2 || now - lastDetection < 65) return;
    lastDetection = now;
    try {
      const result = landmarker.detectForVideo(video, now);
      const h = calibrated();
      const detected = [];
      for (let person = 0; person < result.landmarks.length; person++) {
        const landmarks = result.landmarks[person];
        for (const [side, heel, toe] of [['left', 29, 31], ['right', 30, 32]]) {
          const point = footFromPose(landmarks, heel, toe);
          if (!point) continue;
          const id = person === 0 ? side : `${person}-${side}`;
          const prev = previousFoot.get(id);
          const smooth = prev ? { x: prev.x * .42 + point.x * .58, y: prev.y * .42 + point.y * .58 } : point;
          const floor = h ? mapPoint(h, smooth.x, smooth.y) : null;
          if (floor && floor.x > -.1 && floor.x < 1.1 && floor.y > -.1 && floor.y < 1.1) {
            const timeDelta = prev ? Math.max(.016, (now - prev.time) / 1000) : .066;
            const vx = prev?.floor ? Math.max(-2, Math.min(2, (floor.x - prev.floor.x) / timeDelta * sensitivity)) : 0;
            const vy = prev?.floor ? Math.max(-2, Math.min(2, (floor.y - prev.floor.y) / timeDelta * sensitivity)) : 0;
            detected.push({ id, x: floor.x, y: floor.y, vx, vy });
          }
          previousFoot.set(id, { ...smooth, floor, time: now });
        }
      }
      for (const [id, previous] of previousFoot) if (now - previous.time > 350) previousFoot.delete(id);
      if (!demoMode) feet = detected;
      $('#camera-tag').textContent = detected.length ? `足を ${detected.length} 点認識` : h ? '足を探しています' : '四隅を設定してください';
      drawCameraOverlay(result.landmarks, detected);
    } catch (error) { console.error(error); $('#camera-tag').textContent = '認識エラー'; }
  }
  function drawCameraOverlay(poses = []) {
    const ctx = overlay.getContext('2d');
    const rect = overlay.getBoundingClientRect(); const ratio = Math.min(devicePixelRatio || 1, 2);
    overlay.width = Math.round(rect.width * ratio); overlay.height = Math.round(rect.height * ratio);
    ctx.scale(overlay.width, overlay.height);
    if (calibration) {
      ctx.beginPath(); calibration.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
      ctx.fillStyle = 'rgba(77,255,159,.09)'; ctx.fill(); ctx.strokeStyle = '#8afaaf'; ctx.lineWidth = 3 / overlay.width; ctx.stroke();
    }
    calibrationPoints.forEach(([x, y], i) => {
      ctx.beginPath(); ctx.arc(x, y, 13 / overlay.width, 0, Math.PI * 2); ctx.fillStyle = '#dfff74'; ctx.fill();
      ctx.fillStyle = '#092719'; ctx.font = `${20 / overlay.width}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText(String(i + 1), x, y + 7 / overlay.height);
    });
    for (const landmarks of poses) for (const [index, color] of [[31, '#56d9ff'], [32, '#ff8b7b']]) {
      const p = landmarks[index]; if (!p || (p.visibility ?? 1) < .45) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 15 / overlay.width, 0, Math.PI * 2); ctx.strokeStyle = color; ctx.lineWidth = 4 / overlay.width; ctx.stroke();
    }
  }
  channel.onmessage = e => { if (e.data?.type === 'hello') broadcast(true); };
  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, .05); lastTime = now;
    detectFeet(now);
    if (demoMode) feet = pointerFoot ? [{ ...pointerFoot, vx: now - pointerFoot.time > 80 ? 0 : pointerFoot.vx, vy: now - pointerFoot.time > 80 ? 0 : pointerFoot.vy }] : [];
    const events = stepGame(game, dt, feet);
    events.forEach(playSound);
    if (events.includes('finish')) $('#start-game').textContent = '▶ もう一度';
    drawCourt(court);
    $('#score-value').textContent = String(game.score).padStart(2, '0');
    $('#shots-value').textContent = String(game.shots).padStart(2, '0');
    $('#time-value').textContent = String(Math.ceil(game.time)).padStart(2, '0');
    broadcast(); requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.addEventListener('beforeunload', stopCamera);
}
