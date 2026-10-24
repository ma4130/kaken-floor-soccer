import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { assignPoseTeams, createGame, footFromPose, mapPoint, solveHomography, stepGame } from './core.js';
import './style.css';

const CHANNEL = 'floor-soccer-v2';
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
  ctx.fillStyle = '#c8f3c1'; ctx.fillRect(0, 0, w, h);
  for (let i = 0; i < 10; i++) { ctx.fillStyle = i % 2 ? '#b5e9b1' : '#c7f0bd'; ctx.fillRect(72 + i * 146, 52, 146, 796); }
  ctx.fillStyle = 'rgba(73,183,236,.10)'; ctx.fillRect(72, 52, 728, 796);
  ctx.fillStyle = 'rgba(255,114,139,.10)'; ctx.fillRect(800, 52, 728, 796);
  ctx.strokeStyle = 'rgba(255,255,255,.98)'; ctx.lineWidth = 6;
  ctx.strokeRect(72, 52, 1456, 796);
  ctx.beginPath(); ctx.moveTo(800, 52); ctx.lineTo(800, 848); ctx.stroke();
  ctx.beginPath(); ctx.arc(800, 450, 112, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(800, 450, 9, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill();
  ctx.strokeRect(72, 245, 250, 410); ctx.strokeRect(1278, 245, 250, 410);
  ctx.strokeRect(72, 330, 104, 240); ctx.strokeRect(1424, 330, 104, 240);
  ctx.beginPath(); ctx.arc(245, 450, 8, 0, Math.PI * 2); ctx.arc(1355, 450, 8, 0, Math.PI * 2); ctx.fill();

  // The left and right goal colors match the team defending each side.
  ctx.shadowBlur = 32; ctx.shadowColor = '#19aee4';
  roundedRect(ctx, 9, 315, 80, 270, 21, '#2bb9ef', '#fff');
  ctx.shadowColor = '#ff6b8b';
  roundedRect(ctx, 1511, 315, 80, 270, 21, '#ff7793', '#fff');
  ctx.shadowBlur = 0;
  ctx.save(); ctx.translate(52, 450); ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#073b50'; ctx.textAlign = 'center'; ctx.font = '900 30px "Barlow Condensed", sans-serif'; ctx.fillText('BLUE GOAL', 0, 10); ctx.restore();
  ctx.save(); ctx.translate(1548, 450); ctx.rotate(Math.PI / 2);
  ctx.fillStyle = '#6d203a'; ctx.textAlign = 'center'; ctx.font = '900 30px "Barlow Condensed", sans-serif'; ctx.fillText('PINK GOAL', 0, 10); ctx.restore();

  ctx.textAlign = 'center'; ctx.font = '800 22px "Barlow Condensed", sans-serif';
  ctx.fillStyle = '#08739a'; ctx.fillText('BLUE →', 485, 820);
  ctx.fillStyle = '#b23c63'; ctx.fillText('← PINK', 1115, 820);

  const ball = state.ball;
  const bx = ball.x * w, by = ball.y * h;
  const velocity = Math.hypot(ball.vx, ball.vy);
  if (velocity > 0.04) {
    ctx.strokeStyle = 'rgba(255,184,50,.48)'; ctx.lineWidth = 26; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx - ball.vx * 175, by - ball.vy * 110); ctx.stroke();
  }
  ctx.shadowColor = '#ffc331'; ctx.shadowBlur = 35;
  ctx.fillStyle = '#fff2a1'; ctx.beginPath(); ctx.arc(bx, by, 31, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0; ctx.fillStyle = '#d87336';
  for (let i = 0; i < 5; i++) {
    const angle = i * Math.PI * 2 / 5 - Math.PI / 2;
    ctx.beginPath(); ctx.arc(bx + Math.cos(angle) * 15, by + Math.sin(angle) * 15, 4.5, 0, Math.PI * 2); ctx.fill();
  }

  for (const foot of players) {
    const x = foot.x * w, y = foot.y * h;
    if (x < 0 || x > w || y < 0 || y > h) continue;
    const color = foot.team === 'pink' ? '#f84f83' : '#009fd2';
    ctx.strokeStyle = color; ctx.lineWidth = 6; ctx.shadowColor = color; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(x, y, 38, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.shadowBlur = 0;
  }

  roundedRect(ctx, 120, 77, 222, 112, 20, '#e8fbff', '#45bce9');
  roundedRect(ctx, 1258, 77, 222, 112, 20, '#fff0f4', '#ff8ba9');
  roundedRect(ctx, 704, 78, 192, 86, 20, '#fffefa', '#c4dfbd');
  ctx.textAlign = 'left'; ctx.fillStyle = '#08789f'; ctx.font = '800 26px "Barlow Condensed", sans-serif'; ctx.fillText('BLUE', 146, 117);
  ctx.fillStyle = '#194353'; ctx.font = '900 68px "Barlow Condensed", sans-serif'; ctx.fillText(String(state.scores.blue).padStart(2, '0'), 144, 178);
  ctx.fillStyle = '#c94770'; ctx.font = '800 26px "Barlow Condensed", sans-serif'; ctx.fillText('PINK', 1284, 117);
  ctx.fillStyle = '#5b3346'; ctx.font = '900 68px "Barlow Condensed", sans-serif'; ctx.fillText(String(state.scores.pink).padStart(2, '0'), 1282, 178);
  ctx.textAlign = 'center'; ctx.fillStyle = '#48735b'; ctx.font = '800 22px "Barlow Condensed", sans-serif'; ctx.fillText('TIME', 800, 110);
  ctx.fillStyle = '#264238'; ctx.font = '900 48px "Barlow Condensed", sans-serif'; ctx.fillText(String(Math.ceil(state.time)).padStart(2, '0'), 800, 152);

  if (state.flash > 0) { ctx.fillStyle = state.flashTeam === 'pink' ? `rgba(255,106,151,${state.flash * .27})` : `rgba(80,196,255,${state.flash * .27})`; ctx.fillRect(0, 0, w, h); }
  if ((state.messageTime > 0 || !state.running) && !showCalibration) {
    const label = state.messageTime > 0 ? state.message : (state.time <= 0 ? 'TIME UP' : '1 VS 1');
    roundedRect(ctx, 470, 325, 660, 194, 32, 'rgba(255,255,255,.92)', 'rgba(255,255,255,.9)');
    ctx.textAlign = 'center'; ctx.font = '900 112px "Barlow Condensed", sans-serif';
    ctx.fillStyle = state.flashTeam === 'pink' ? '#cf466f' : '#1879a3'; ctx.fillText(label, 800, 433);
    ctx.fillStyle = '#477665';
    if (!state.running && state.time > 0) { ctx.font = '700 26px "Noto Sans JP", sans-serif'; ctx.fillText('2人で相手のゴールへシュート！', 800, 483); }
    if (!state.running && state.time === 0) { ctx.font = '700 26px "Barlow Condensed", sans-serif'; ctx.fillText(`BLUE ${state.scores.blue}  :  ${state.scores.pink} PINK`, 800, 484); }
  }
  if (showCalibration) {
    ctx.fillStyle = 'rgba(14,61,47,.45)'; ctx.fillRect(0, 0, w, h);
    const marks = [[72, 52], [1528, 52], [1528, 848], [72, 848]];
    marks.forEach(([x, y], i) => {
      ctx.strokeStyle = '#fff264'; ctx.lineWidth = 7; ctx.shadowColor = '#fff264'; ctx.shadowBlur = 25;
      ctx.beginPath(); ctx.arc(x, y, 30, 0, Math.PI * 2); ctx.stroke(); ctx.shadowBlur = 0;
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '900 26px "Barlow Condensed", sans-serif'; ctx.fillText(String(i + 1), x, y + 9);
    });
    roundedRect(ctx, 350, 390, 900, 100, 25, 'rgba(255,255,255,.94)');
    ctx.fillStyle = '#246550'; ctx.textAlign = 'center'; ctx.font = '700 36px "Noto Sans JP", sans-serif'; ctx.fillText('カメラ画面で 1 → 2 → 3 → 4 をクリック', 800, 453);
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
        <section class="hero"><div><div class="eyebrow"><span>01 / TWO PLAYER MATCH</span><span class="eyebrow-line"></span><span>CAMERA × PROJECTION</span></div><h1>ふたりで、<em>決めろ。</em></h1><p>床に映ったボールを足でキック。<br>青とピンクに分かれて、相手のゴールを狙おう！</p><div class="hero-actions"><button id="open-projector" class="button button-primary">↗ 投影画面を開く</button><a href="#setup" class="text-link">セットアップを見る <span>↓</span></a></div></div><div class="hero-decoration"><span class="orbit orbit-one"></span><span class="orbit orbit-two"></span><span class="hero-foot">⚽</span><span class="hero-deco-label">BLUE <b>VS</b> PINK<br>READY TO KICK?</span></div></section>
        <section class="workspace" id="setup">
          <div class="section-heading"><div><span class="section-kicker">PLAY STATION</span><h2>ゲームを準備する</h2></div><span class="section-note">上から順に設定してください <b>↓</b></span></div>
          <div class="workspace-grid">
            <div class="left-column">
              <article class="panel camera-panel"><div class="panel-heading"><div><span class="step">01</span><h3>カメラで2人を映す</h3></div><span class="tag" id="camera-tag">未接続</span></div><div class="camera-stage" id="camera-stage"><video id="camera-video" playsinline muted></video><canvas id="camera-overlay"></canvas><div class="camera-empty" id="camera-empty"><span class="camera-symbol">◉</span><strong>CAMERA OFFLINE</strong><small>2人の全身と足元が映る位置に設置</small></div></div><div class="camera-actions"><select id="camera-select" aria-label="カメラを選択"><option value="">標準のカメラ</option></select><button id="start-camera" class="button button-light">カメラを起動</button><button id="stop-camera" class="button button-quiet" disabled>停止</button></div><div class="team-guide"><span class="team-guide-blue">青チーム：左からスタート →</span><span class="team-guide-pink">← ピンクチーム：右からスタート</span></div><p class="hint">2人の全身と両足が入るよう、斜め上から床を撮影してください。</p></article>
              <article class="panel calibration-panel"><div class="panel-heading"><div><span class="step">02</span><h3>床の四隅を合わせる</h3></div><span class="tag" id="calibration-tag">未設定</span></div><p>投影画面に出る <b>1 → 2 → 3 → 4</b> の四隅を、上のカメラ映像で順にクリックします。</p><div class="calibration-progress" id="calibration-progress"><span>1</span><span>2</span><span>3</span><span>4</span></div><div class="calibration-actions"><button id="calibrate" class="button button-outline">四隅の設定を始める</button><button id="clear-calibration" class="button button-quiet">設定を消す</button></div><p class="inline-status" id="calibration-status">カメラと投影画面を開くと設定できます。</p></article>
            </div>
            <div class="right-column">
              <article class="panel game-panel"><div class="panel-heading"><div><span class="step">03</span><h3>2人で対戦</h3></div><span class="tag tag-accent">60 SEC MATCH</span></div><div class="game-screen"><canvas id="game-canvas" aria-label="床サッカー対戦フィールドのプレビュー"></canvas></div><div class="mode-tabs" role="group" aria-label="操作方法"><button id="camera-mode" class="mode active">◉ 2人の足で操作</button><button id="demo-mode" class="mode">⌨ キーボードで試す</button></div><p class="mode-hint" id="mode-hint">青は左、ピンクは右からスタート。相手のゴールへシュート！</p><div class="game-actions"><button id="start-game" class="button button-primary">▶ 対戦スタート</button><button id="reset-game" class="button button-quiet">↻ リセット</button></div><div class="game-stats"><div class="blue-stat"><span>BLUE GOALS</span><strong id="blue-score-value">00</strong><small id="blue-shots-value">0 SHOTS</small></div><div class="pink-stat"><span>PINK GOALS</span><strong id="pink-score-value">00</strong><small id="pink-shots-value">0 SHOTS</small></div><div><span>TIME LEFT</span><strong id="time-value">60</strong></div></div></article>
              <article class="panel settings-panel"><div class="panel-heading"><div><span class="step small-step">✦</span><h3>プレイ設定</h3></div></div><label class="setting-row" for="sensitivity"><span>キック感度<small>足の動きをボールに伝える強さ</small></span><span class="setting-control"><input id="sensitivity" type="range" min="0.5" max="1.8" step="0.1" value="1"><b id="sensitivity-value">1.0×</b></span></label><label class="setting-row" for="sound"><span>効果音<small>キック・ゴール音を再生</small></span><input id="sound" type="checkbox" checked></label></article>
            </div>
          </div>
        </section>
        <section class="howto"><span class="section-kicker">HOW TO PLAY</span><h2>相手のゴールへ、キック！</h2><div class="howto-grid"><div><span>01</span><strong>映す</strong><p>投影画面をプロジェクターへ移動して全画面に。</p></div><div><span>02</span><strong>分かれる</strong><p>青は左、ピンクは右。2人がカメラに映る位置へ。</p></div><div><span>03</span><strong>競う</strong><p>相手側のゴールへ蹴る。60秒後、得点が多い方の勝ち！</p></div></div></section>
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
  let teamCenters = {};
  let lastDetection = 0;
  const pressedKeys = new Set();
  let demoPlayers = createDemoPlayers();
  const calibrated = () => solveHomography(calibration);

  function createDemoPlayers() {
    return { blue: { id: 'blue-demo', team: 'blue', x: .31, y: .5, vx: 0, vy: 0 }, pink: { id: 'pink-demo', team: 'pink', x: .69, y: .5, vx: 0, vy: 0 } };
  }

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
    feet = []; previousFoot.clear(); teamCenters = {};
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
    demoMode = demo; feet = []; previousFoot.clear(); pressedKeys.clear(); demoPlayers = createDemoPlayers();
    $('#camera-mode').classList.toggle('active', !demo); $('#demo-mode').classList.toggle('active', demo);
    $('#mode-hint').textContent = demo ? '青：W A S D　／　ピンク：矢印キーで移動してキック。' : '青は左、ピンクは右からスタート。相手のゴールへシュート！';
  }
  $('#camera-mode').addEventListener('click', () => setMode(false));
  $('#demo-mode').addEventListener('click', () => setMode(true));

  const controlKeys = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowLeft', 'ArrowDown', 'ArrowRight']);
  window.addEventListener('keydown', event => {
    if (!demoMode || !controlKeys.has(event.code)) return;
    event.preventDefault();
    pressedKeys.add(event.code);
  });
  window.addEventListener('keyup', event => {
    if (!controlKeys.has(event.code)) return;
    pressedKeys.delete(event.code);
    if (demoMode) event.preventDefault();
  });
  window.addEventListener('blur', () => pressedKeys.clear());

  function updateDemoPlayers(dt) {
    const schemes = {
      blue: { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
      pink: { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }
    };
    for (const team of ['blue', 'pink']) {
      const player = demoPlayers[team];
      const keys = schemes[team];
      let dx = Number(pressedKeys.has(keys.right)) - Number(pressedKeys.has(keys.left));
      let dy = Number(pressedKeys.has(keys.down)) - Number(pressedKeys.has(keys.up));
      const magnitude = Math.hypot(dx, dy) || 1;
      player.vx = dx / magnitude * .74;
      player.vy = dy / magnitude * .74;
      player.x = Math.max(.075, Math.min(.925, player.x + player.vx * dt));
      player.y = Math.max(.085, Math.min(.915, player.y + player.vy * dt));
    }
    return Object.values(demoPlayers);
  }

  $('#start-game').addEventListener('click', () => {
    if (!demoMode && (!stream || !calibrated() || !landmarker)) { status('足で遊ぶには、カメラを起動して床の四隅を設定してください。モデルの読み込み完了も確認してください。'); return; }
    if (game.time === 0) game = createGame();
    game.running = !game.running;
    game.messageTime = 0;
    $('#start-game').textContent = game.running ? 'Ⅱ 一時停止' : '▶ 再開';
    broadcast(true);
  });
  $('#reset-game').addEventListener('click', () => { game = createGame(); demoPlayers = createDemoPlayers(); $('#start-game').textContent = '▶ 対戦スタート'; broadcast(true); });
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
      const candidates = [];
      for (const landmarks of result.landmarks) {
        const footPoints = [];
        for (const [side, heel, toe] of [['left', 29, 31], ['right', 30, 32]]) {
          const point = footFromPose(landmarks, heel, toe);
          if (!point) continue;
          const floor = h ? mapPoint(h, point.x, point.y) : null;
          if (floor && floor.x > -.1 && floor.x < 1.1 && floor.y > -.1 && floor.y < 1.1) footPoints.push({ side, point, floor });
        }
        if (footPoints.length) candidates.push({
          x: footPoints.reduce((sum, foot) => sum + foot.floor.x, 0) / footPoints.length,
          y: footPoints.reduce((sum, foot) => sum + foot.floor.y, 0) / footPoints.length,
          footPoints,
          landmarks
        });
      }
      const recentCenters = Object.fromEntries(Object.entries(teamCenters).filter(([, value]) => now - value.time < 500));
      const assigned = assignPoseTeams(candidates, recentCenters);
      for (const pose of assigned) {
        teamCenters[pose.team] = { x: pose.x, y: pose.y, time: now };
        for (const { side, point } of pose.footPoints) {
          const id = `${pose.team}-${side}`;
          const prev = previousFoot.get(id);
          const smooth = prev ? { x: prev.x * .42 + point.x * .58, y: prev.y * .42 + point.y * .58 } : point;
          const floor = h ? mapPoint(h, smooth.x, smooth.y) : null;
          if (floor && floor.x > -.1 && floor.x < 1.1 && floor.y > -.1 && floor.y < 1.1) {
            const timeDelta = prev ? Math.max(.016, (now - prev.time) / 1000) : .066;
            const vx = prev?.floor ? Math.max(-2, Math.min(2, (floor.x - prev.floor.x) / timeDelta * sensitivity)) : 0;
            const vy = prev?.floor ? Math.max(-2, Math.min(2, (floor.y - prev.floor.y) / timeDelta * sensitivity)) : 0;
            detected.push({ id, team: pose.team, x: floor.x, y: floor.y, vx, vy });
          }
          previousFoot.set(id, { ...smooth, floor, time: now });
        }
      }
      for (const [id, previous] of previousFoot) if (now - previous.time > 350) previousFoot.delete(id);
      if (!demoMode) feet = detected;
      const teamsSeen = [...new Set(detected.map(foot => foot.team))];
      $('#camera-tag').textContent = teamsSeen.length === 2 ? '青・ピンクを認識' : teamsSeen.length === 1 ? `${teamsSeen[0] === 'blue' ? '青' : 'ピンク'}を認識中` : h ? '2人を探しています' : '四隅を設定してください';
      drawCameraOverlay(assigned);
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
    for (const pose of poses) for (const index of [31, 32]) {
      const p = pose.landmarks[index]; if (!p || (p.visibility ?? 1) < .45) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 15 / overlay.width, 0, Math.PI * 2); ctx.strokeStyle = pose.team === 'pink' ? '#f84f83' : '#009fd2'; ctx.lineWidth = 4 / overlay.width; ctx.stroke();
    }
  }
  channel.onmessage = e => { if (e.data?.type === 'hello') broadcast(true); };
  function loop(now) {
    const dt = Math.min((now - lastTime) / 1000, .05); lastTime = now;
    detectFeet(now);
    if (demoMode) feet = updateDemoPlayers(dt);
    const events = stepGame(game, dt, feet);
    events.forEach(playSound);
    if (events.includes('finish')) $('#start-game').textContent = '▶ もう一度';
    drawCourt(court);
    $('#blue-score-value').textContent = String(game.scores.blue).padStart(2, '0');
    $('#pink-score-value').textContent = String(game.scores.pink).padStart(2, '0');
    $('#blue-shots-value').textContent = `${game.shots.blue} SHOTS`;
    $('#pink-shots-value').textContent = `${game.shots.pink} SHOTS`;
    $('#time-value').textContent = String(Math.ceil(game.time)).padStart(2, '0');
    broadcast(); requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.addEventListener('beforeunload', stopCamera);
}
