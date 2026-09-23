/* global RigModel */
'use strict';

const state = {
  rig: null,
  cues: [],
  order: [],
  result: null,
  playing: false,
  time: 0,
  lastTick: 0,
  raf: null
};

const $ = (id) => document.getElementById(id);

async function boot() {
  const res = await fetch('/api/data');
  const data = await res.json();
  state.rig = data.rig;
  state.cues = data.cues;
  state.order = data.cues.map((c) => c.id);
  bindControls();
  recompute();
}

function bindControls() {
  $('btn-play').addEventListener('click', togglePlay);
  $('scrub').addEventListener('input', () => {
    pause();
    state.time = Number($('scrub').value);
    renderFrame();
  });
  $('btn-submit').addEventListener('click', () => {
    if (state.result.conflicts.length > 0) return;
    $('btn-submit').textContent = '已提交 ✓';
  });
}

// 顺序变化后整段重算：所有时间点、载荷曲线、冲突全部更新
function recompute() {
  state.result = RigModel.simulate(state.rig, state.cues, state.order);
  state.time = 0;
  pause();
  $('scrub').max = state.result.totalDuration;
  $('scrub').value = 0;
  renderTimeline();
  renderSummary();
  renderLog();
  renderFrame();
  updateSubmit();
}

/* ---------- 吊杆状态查询 ---------- */

function battenById(id) {
  return state.rig.battens.find((b) => b.id === id);
}

function heightAt(id, t) {
  const tracks = state.result.tracks[id];
  if (!tracks || tracks.length === 0) return battenById(id).homeHeight;
  if (t <= tracks[0].t0) return tracks[0].from;
  for (const tr of tracks) {
    if (t <= tr.t1) {
      const frac = RigModel.positionAt(tr.profile, t - tr.t0);
      return tr.from + (tr.to - tr.from) * frac;
    }
  }
  return tracks[tracks.length - 1].to;
}

function isMoving(id, t) {
  return (state.result.tracks[id] || []).some((tr) => t >= tr.t0 && t < tr.t1);
}

function loadAt(id, t) {
  const b = battenById(id);
  const base = Math.abs(b.payload - b.counterweight);
  const seg = state.result.segments.find((s) => s.batten === id && t >= s.t0 && t < s.t1);
  return seg ? seg.load : base;
}

/* ---------- 渲染 ---------- */

function renderFrame() {
  $('clock').textContent = state.time.toFixed(2) + 's';
  if (document.activeElement !== $('scrub')) $('scrub').value = state.time;
  drawStage();
  renderPanels();
  renderCursor();
}

function drawStage() {
  const cv = $('stage');
  const ctx = cv.getContext('2d');
  const W = cv.width, H = cv.height;
  const gridH = state.rig.stage.gridHeight;
  const margin = 28;
  const yOf = (h) => margin + (gridH - h) / gridH * (H - 2 * margin);

  ctx.clearRect(0, 0, W, H);
  ctx.strokeStyle = '#262b38';
  ctx.fillStyle = '#5b6376';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'left';
  for (let h = 0; h <= gridH; h += 2) {
    ctx.beginPath();
    ctx.moveTo(40, yOf(h));
    ctx.lineTo(W - 10, yOf(h));
    ctx.stroke();
    ctx.fillText(h + 'm', 8, yOf(h) + 3);
  }
  // 台面
  ctx.strokeStyle = '#3a4152';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(10, yOf(0));
  ctx.lineTo(W - 10, yOf(0));
  ctx.stroke();
  ctx.lineWidth = 1;

  for (const b of state.rig.battens) {
    const h = heightAt(b.id, state.time);
    const load = loadAt(b.id, state.time);
    const overloaded = load > b.ratedLoad;
    const moving = isMoving(b.id, state.time);
    ctx.strokeStyle = overloaded ? '#e5484d' : moving ? '#e8b93e' : '#4a90d9';
    ctx.lineWidth = overloaded ? 3 : 2;
    ctx.beginPath();
    ctx.moveTo(40, yOf(h));
    ctx.lineTo(W - 10, yOf(h));
    ctx.stroke();
    ctx.fillStyle = overloaded ? '#ff7a7e' : '#9fb4d8';
    ctx.textAlign = 'right';
    ctx.fillText(b.id, 36, yOf(h) + 3);
    ctx.lineWidth = 1;
  }
}

function renderPanels() {
  const bl = $('batten-list');
  bl.innerHTML = '';
  for (const b of state.rig.battens) {
    const li = document.createElement('li');
    const h = heightAt(b.id, state.time);
    li.textContent = `${b.id} ${b.name} — ${h.toFixed(2)}m`;
    if (isMoving(b.id, state.time)) li.classList.add('moving');
    if (loadAt(b.id, state.time) > b.ratedLoad) li.classList.add('overloaded');
    bl.appendChild(li);
  }

  const wl = $('weight-list');
  wl.innerHTML = '';
  for (const b of state.rig.battens) {
    const load = loadAt(b.id, state.time);
    const overloaded = load > b.ratedLoad;
    const li = document.createElement('li');
    if (overloaded) li.classList.add('overloaded');
    const pct = Math.min(100, load / b.ratedLoad * 100);
    li.innerHTML =
      `${b.id} 配重 ${b.counterweight}kg / 吊挂 ${b.payload}kg` +
      `<br><small>净载荷 ${load.toFixed(1)}kg / 额定 ${b.ratedLoad}kg</small>` +
      `<div class="bar"><div style="width:${pct}%"></div></div>`;
    wl.appendChild(li);
  }
}

function renderTimeline() {
  const tl = $('timeline');
  tl.innerHTML = '';
  const total = state.result.totalDuration || 1;
  const conflictCues = new Set(state.result.conflicts.map((c) => c.cue));

  for (const entry of state.result.cues) {
    const chip = document.createElement('div');
    chip.className = 'cue-chip' + (conflictCues.has(entry.id) ? ' has-conflict' : '');
    chip.draggable = true;
    chip.dataset.cue = entry.id;
    chip.style.width = Math.max(72, (entry.tEnd - entry.tStart) / total * (tl.clientWidth || 900) - 4) + 'px';
    chip.innerHTML = `<strong>${entry.id}</strong> ${entry.name}` +
      `<span class="t">${entry.tStart.toFixed(2)}s → ${entry.tEnd.toFixed(2)}s</span>`;
    chip.addEventListener('dragstart', onDragStart);
    chip.addEventListener('dragover', onDragOver);
    chip.addEventListener('dragleave', (e) => e.currentTarget.classList.remove('drop-target'));
    chip.addEventListener('drop', onDrop);
    chip.addEventListener('dragend', (e) => e.currentTarget.classList.remove('dragging'));
    tl.appendChild(chip);
  }

  const lane = $('conflict-lane');
  lane.innerHTML = '';
  for (const c of state.result.conflicts) {
    const mark = document.createElement('div');
    mark.className = 'mark';
    mark.style.left = (c.t0 / total * 100) + '%';
    mark.style.width = Math.max(0.6, (c.t1 - c.t0) / total * 100) + '%';
    mark.title = `${c.cue} ${c.batten} 超载 ${c.peakLoad}kg > ${c.rated}kg @ ${c.tPeak}s`;
    lane.appendChild(mark);
  }

  const ruler = $('ruler');
  ruler.innerHTML = '';
  const step = total > 60 ? 10 : 5;
  for (let t = 0; t <= total; t += step) {
    const tick = document.createElement('span');
    tick.style.left = (t / total * 100) + '%';
    tick.textContent = t + 's';
    ruler.appendChild(tick);
  }
}

function renderCursor() {
  const wrap = $('timeline-wrap');
  let cursor = $('cursor');
  if (!cursor) {
    cursor = document.createElement('div');
    cursor.id = 'cursor';
    wrap.appendChild(cursor);
  }
  const total = state.result.totalDuration || 1;
  cursor.style.left = (state.time / total * 100) + '%';
}

/* ---------- 拖拽排序 ---------- */

let draggedId = null;

function onDragStart(e) {
  draggedId = e.currentTarget.dataset.cue;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.currentTarget.classList.add('drop-target');
  e.dataTransfer.dropEffect = 'move';
}

function onDrop(e) {
  e.preventDefault();
  const target = e.currentTarget;
  target.classList.remove('drop-target');
  const targetId = target.dataset.cue;
  if (!draggedId || draggedId === targetId) return;
  const from = state.order.indexOf(draggedId);
  const to = state.order.indexOf(targetId);
  state.order.splice(from, 1);
  state.order.splice(to, 0, draggedId);
  draggedId = null;
  recompute();
}

/* ---------- 汇总与日志 ---------- */

function renderSummary() {
  const r = state.result;
  const el = $('summary-body');
  const nameOf = (id) => {
    const c = state.cues.find((x) => x.id === id);
    return c ? `${id}「${c.name}」` : id;
  };
  let html = `<p>总时长 <strong>${r.totalDuration.toFixed(2)}s</strong>，` +
    `超载冲突 <strong class="${r.conflicts.length ? 'bad' : ''}">${r.conflicts.length} 处</strong>，` +
    `联动不同步 <strong class="${r.syncIssues.length ? 'warn' : ''}">${r.syncIssues.length} 处</strong></p>`;

  if (r.conflicts.length) {
    html += '<table><tr><th>Cue</th><th>吊杆</th><th>时段(s)</th><th>峰值/额定(kg)</th></tr>';
    for (const c of r.conflicts) {
      html += `<tr class="bad"><td>${nameOf(c.cue)}</td><td>${c.batten}</td>` +
        `<td>${c.t0.toFixed(2)} ~ ${c.t1.toFixed(2)}（峰值@${c.tPeak.toFixed(2)}）</td>` +
        `<td>${c.peakLoad.toFixed(1)} / ${c.rated}</td></tr>`;
    }
    html += '</table><p class="bad">存在超载段落，禁止提交预演。</p>';
  }

  if (r.syncIssues.length) {
    html += '<table><tr><th>Cue</th><th>联动组</th><th>拖后腿</th><th>速度(慢/快)</th></tr>';
    for (const s of r.syncIssues) {
      html += `<tr class="warn"><td>${nameOf(s.cue)}</td><td>${s.group || '-'}</td>` +
        `<td>${s.critical}</td><td>${s.minSpeed} / ${s.maxSpeed} m/s</td></tr>`;
    }
    html += '</table>';
  }

  const waits = Object.entries(r.waits).sort((a, b) => b[1] - a[1]).filter(([, w]) => w > 0);
  html += '<p>等待最久：';
  html += waits.length
    ? waits.slice(0, 3).map(([id, w]) => `<strong>${id}</strong> ${w.toFixed(2)}s`).join('，')
    : '无（各联动组均同步）';
  html += '</p>';
  el.innerHTML = html;
}

function renderLog() {
  $('log-body').textContent = state.result.log.join('\n');
}

function updateSubmit() {
  const btn = $('btn-submit');
  const n = state.result.conflicts.length;
  btn.disabled = n > 0;
  btn.textContent = n > 0 ? `禁止提交（${n} 处超载）` : '提交预演';
}

/* ---------- 播放 ---------- */

function togglePlay() {
  if (state.playing) return pause();
  if (state.time >= state.result.totalDuration) state.time = 0;
  state.playing = true;
  state.lastTick = performance.now();
  $('btn-play').textContent = '⏸ 暂停';
  state.raf = requestAnimationFrame(tick);
}

function pause() {
  state.playing = false;
  $('btn-play').textContent = '▶ 预演';
  if (state.raf) cancelAnimationFrame(state.raf);
  state.raf = null;
}

function tick(now) {
  if (!state.playing) return;
  const dt = (now - state.lastTick) / 1000 * Number($('speed').value);
  state.lastTick = now;
  state.time = Math.min(state.result.totalDuration, state.time + dt);
  renderFrame();
  if (state.time >= state.result.totalDuration) return pause();
  state.raf = requestAnimationFrame(tick);
}

boot();
