import { computeSchedule, stateAt, heightAtLocal, phaseAtLocal, round3 } from '/vendor/engine.js';

const state = {
  rig: null,
  cuesDoc: null,
  order: [],
  schedule: null,
  playing: false,
  playTime: 0,
  speed: 1,
  rafId: null,
  lastWall: 0,
  dragId: null
};

const $ = (id) => document.getElementById(id);

async function bootstrap() {
  try {
    const resp = await fetch('/api/data');
    if (!resp.ok) throw new Error(`数据加载失败 HTTP ${resp.status}`);
    const data = await resp.json();
    state.rig = data.rig;
    state.cuesDoc = data.cues;
    state.order = data.cues.cues.map((c) => c.id);
    recompute('初始加载');
    $('loadStatus').textContent =
      `已加载 ${state.rig.battens.length} 根吊杆、${state.cuesDoc.cues.length} 条 Cue（data/rig.json / data/cues.json）`;
    bindControls();
    requestAnimationFrame(tick);
  } catch (err) {
    $('loadStatus').textContent = `加载失败：${err.message}`;
  }
}

// 顺序一变就整条重算：所有时间点、过载段、冲突、等待排名全部刷新（不是只挪标签）。
async function recompute(reason) {
  // 与后端共用同一引擎；同时调用后端接口，保证页面与服务端逐字节同源。
  state.schedule = computeSchedule(state.rig, state.cuesDoc, state.order);
  fetch('/api/schedule', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ order: state.order })
  }).catch(() => {});
  renderAll(reason);
}

function bindControls() {
  $('btnPlay').addEventListener('click', startPlay);
  $('btnPause').addEventListener('click', pausePlay);
  $('btnReset').addEventListener('click', () => {
    pausePlay();
    state.playTime = 0;
    renderStage();
    updateClock();
  });
  $('playSpeed').addEventListener('change', (e) => {
    state.speed = Number(e.target.value);
  });
  $('btnSubmit').addEventListener('click', submitRehearsal);
}

function moveCue(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= state.order.length) return;
  const [id] = state.order.splice(index, 1);
  state.order.splice(target, 0, id);
  if (state.playTime > state.schedule.totalDuration) state.playTime = 0;
  recompute(delta < 0 ? `前移 ${id}` : `后移 ${id}`);
}

function startPlay() {
  if (!state.schedule) return;
  if (state.playTime >= state.schedule.totalDuration) state.playTime = 0;
  state.playing = true;
  state.lastWall = performance.now();
}

function pausePlay() {
  state.playing = false;
}

function tick(now) {
  if (state.playing && state.schedule) {
    const dt = (now - state.lastWall) / 1000;
    state.lastWall = now;
    state.playTime = Math.min(state.schedule.totalDuration, state.playTime + dt * state.speed);
    renderStage();
    updateClock();
    if (state.playTime >= state.schedule.totalDuration) {
      state.playing = false;
      showEndSummary();
    }
  }
  state.rafId = requestAnimationFrame(tick);
}

function updateClock() {
  $('clockText').textContent = `${round3(state.playTime).toFixed(1)}s`;
  $('totalText').textContent = `${round3(state.schedule?.totalDuration ?? 0).toFixed(1)}s`;
}

bootstrap();

// ---------- 舞台剖面：左吊杆、右配重 ----------
function renderStage() {
  if (!state.rig) return;
  const rig = state.rig;
  const W = 760;
  const margin = { top: 30, bottom: 40 };
  const H = 620;
  const plotH = H - margin.top - margin.bottom;
  const hMin = rig.stage.heightMin;
  const hMax = rig.stage.heightMax;
  const yOf = (h) => margin.top + ((h - hMin) / (hMax - hMin)) * plotH;

  const grid = [];
  for (let h = 0; h <= hMax; h += 2) {
    const y = yOf(h);
    grid.push(
      `<line class="grid-line" x1="120" y1="${y}" x2="${W - 60}" y2="${y}"/>`,
      `<text x="112" y="${y + 4}" text-anchor="end" fill="#7d8896" font-size="10">${h}m</text>`
    );
  }

  const positions = state.schedule ? stateAt(state.schedule, rig, state.playTime) : [];
  const posById = new Map(positions.map((p) => [p.battenId, p]));
  const overloadNow = new Set(
    (state.schedule?.overloadIntervals ?? [])
      .filter((seg) => state.playTime >= seg.start && state.playTime < seg.end)
      .map((seg) => seg.battenId)
  );
  const activeCueMotions = new Map();
  if (state.schedule) {
    for (const cue of state.schedule.cues) {
      if (state.playTime >= cue.start && state.playTime < cue.end) {
        for (const m of cue.motions) activeCueMotions.set(m.battenId, cue);
      }
    }
  }

  const rows = rig.battens.map((b, i) => {
    const xLeft = 150 + (i % 6) * 0; // 吊杆纵向等距排列由 y 高度体现，这里给每根杆独立槽位
    return battenRow(b, i, yOf, posById.get(b.id), overloadNow.has(b.id), activeCueMotions.get(b.id), W);
  });

  // 每根吊杆一个水平轨槽，避免重叠
  $('stageView').innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="舞台剖面">
      <rect x="0" y="0" width="${W}" height="${H}" fill="#10141b"/>
      ${grid.join('')}
      <line x1="120" y1="${margin.top}" x2="120" y2="${H - margin.bottom}" stroke="#5a6675"/>
      <line x1="${W - 60}" y1="${margin.top}" x2="${W - 60}" y2="${H - margin.bottom}" stroke="#5a6675"/>
      <text x="${W / 2 - 80}" y="18" fill="#9aa6b6" font-size="11">吊杆（吊点/灯杆/景片）</text>
      <text x="${W - 110}" y="18" fill="#9aa6b6" font-size="11">配重（对重架）</text>
      <line x1="120" y1="${yOf(hMax)}" x2="${W - 60}" y2="${yOf(hMax)}" stroke="#6b7686" stroke-width="2"/>
      <text x="${W / 2}" y="${H - 14}" text-anchor="middle" fill="#7d8896" font-size="10">台板</text>
      ${rows.join('')}
    </svg>`;
}

function battenRow(batten, index, yOf, pos, isOver, activeCue, W) {
  const laneTop = 26;
  const laneH = 44;
  const plotTop = 30;
  const plotBottom = 580;
  const usable = plotBottom - plotTop;
  const laneGap = usable / state.rig.battens.length;
  const laneY = plotTop + index * laneGap;
  const rodX = 250;
  const cwX = W - 190;
  const h = pos ? pos.height : batten.homeHeight ?? batten.minHeight;
  const clamped = Math.max(batten.minHeight, Math.min(batten.maxHeight, h));
  const y = laneY + (clamped / batten.maxHeight) * (laneH + 8);

  const moving = pos?.moving;
  const color = isOver ? '#e5484d' : moving ? '#f0b429' : '#5b8def';
  const isLaggard = activeCue?.laggardBattenIds.includes(batten.id) && moving;
  const cwColor = isOver ? '#e5484d' : moving ? '#f0b429' : '#7d8fa8';

  // 配重架按净配重反向位置示意：杆越低，配重架越靠近栅顶
  const cwY = laneY + laneH + 8 - (clamped / batten.maxHeight) * (laneH + 8);
  const rope =
    `<line x1="${rodX}" y1="${laneY - 8}" x2="${rodX}" y2="${y}" stroke="#8b95a5" stroke-width="1"/>` +
    `<line x1="${cwX}" y1="${laneY - 8}" x2="${cwX}" y2="${cwY}" stroke="#8b95a5" stroke-width="1"/>`;

  return `
    <g>
      <text x="128" y="${laneY + 14}" fill="#9aa6b6" font-size="10" text-anchor="start">${batten.id}</text>
      <text x="128" y="${laneY + 27}" fill="#67727f" font-size="9" text-anchor="start">${batten.name}</text>
      ${rope}
      <rect x="${rodX - 34}" y="${y - 4}" width="68" height="8" rx="3" fill="${color}"/>
      ${isLaggard ? '<circle cx="' + (rodX + 40) + '" cy="' + (y - 6) + '" r="4" fill="#b061ff"/>' : ''}
      <rect x="${cwX - 16}" y="${cwY - 6}" width="32" height="14" rx="2" fill="${cwColor}" opacity="0.9"/>
      <text x="${cwX + 24}" y="${cwY + 4}" fill="#67727f" font-size="9">${batten.counterWeight}/${batten.ratedLoad}kg</text>
    </g>`;
}

// ---------- Cue 卡片（可拖拽换序 + 上下按钮）----------
function renderCueList() {
  const list = $('cueList');
  list.innerHTML = '';
  state.schedule.cues.forEach((cue, index) => {
    const card = document.createElement('div');
    card.className =
      'cue-card' + (cue.blocking ? ' blocking' : '') +
      (cue.laggardBattenIds.length ? ' laggard-card' : '');
    card.draggable = true;
    card.dataset.cueId = cue.cueId;
    const tags =
      (cue.linked ? '<span class="tag tag-link">联动</span>' : '') +
      (cue.blocking ? '<span class="tag tag-block">过载禁提交</span>' : '');
    card.innerHTML = `
      <span class="cue-id">${cue.cueId}</span>
      <span class="cue-name">${cue.cueName}</span>
      ${tags}
      <span class="cue-time">${cue.start.toFixed(1)}–${cue.end.toFixed(1)}s · 杆数 ${cue.motions.length}${
        cue.maxWait > 0 ? ` · 最长等 ${cue.maxWait}s` : ''
      }</span>
      <button type="button" data-act="up" title="前移">↑</button>
      <button type="button" data-act="down" title="后移">↓</button>`;
    card.querySelector('[data-act="up"]').addEventListener('click', () => moveCue(index, -1));
    card.querySelector('[data-act="down"]').addEventListener('click', () => moveCue(index, 1));
    card.addEventListener('dragstart', (e) => {
      state.dragId = cue.cueId;
      card.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      document.querySelectorAll('.cue-card.drag-over').forEach((el) => el.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const from = state.order.indexOf(state.dragId);
      const to = state.order.indexOf(cue.cueId);
      if (from < 0 || from === to) return;
      const [id] = state.order.splice(from, 1);
      state.order.splice(to, 0, id);
      recompute(`拖拽：${state.dragId} → 第 ${to + 1} 位`);
    });
    list.appendChild(card);
  });
}

// ---------- 时间轴：按重算后的真实时间画块，红色为过载段 ----------
function renderTimeline() {
  const sched = state.schedule;
  const rowH = 22;
  const labelW = 56;
  const axisH = 26;
  const width = 640;
  const plotW = width - labelW - 10;
  const total = Math.max(sched.totalDuration, 1);
  const xOf = (t) => labelW + (t / total) * plotW;
  const height = axisH + sched.cues.length * rowH + 10;

  const gridLines = [];
  const step = total > 120 ? 30 : total > 60 ? 15 : 10;
  for (let t = 0; t <= total; t += step) {
    const x = xOf(t);
    gridLines.push(
      `<line class="grid-line" x1="${x}" y1="${axisH - 8}" x2="${x}" y2="${height - 4}"/>`,
      `<text x="${x + 2}" y="${axisH - 10}" fill="#7d8896" font-size="9">${t}s</text>`
    );
  }

  const blocks = sched.cues.map((cue, i) => {
    const x = xOf(cue.start);
    const w = Math.max(xOf(cue.end) - x, 2);
    const y = axisH + i * rowH;
    const overRects = (state.schedule.overloadIntervals || [])
      .filter((seg) => seg.cueId === cue.cueId)
      .map((seg) => {
        const sx = xOf(seg.start);
        const sw = Math.max(xOf(seg.end) - sx, 1.5);
        return `<rect class="over-seg" x="${sx}" y="${y + 2}" width="${sw}" height="${rowH - 6}" rx="2"/>`;
      })
      .join('');
    return `
      <g>
        <text x="6" y="${y + 15}" fill="#9aa6b6" font-size="10">${cue.cueId}</text>
        <rect class="cue-block-rect ${cue.linked ? 'linked' : ''}" x="${x}" y="${y + 2}"
              width="${w}" height="${rowH - 6}" rx="3"/>
        ${overRects}
        <text class="cue-label" x="${x + 4}" y="${y + 15}">${cue.cueName}${
          cue.maxWait > 0 ? `（等${cue.maxWait}s）` : ''
        }</text>
      </g>`;
  });

  const playX = xOf(Math.min(state.playTime, total));
  $('timelineView').innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" style="min-width:${width}px">
      ${gridLines.join('')}
      ${blocks.join('')}
      <line class="playhead-line" id="playhead" x1="${playX}" y1="${axisH - 12}" x2="${playX}" y2="${height - 4}"/>
    </svg>`;
}

// ---------- 逐步计算过程：每条 Cue 每根杆的梯形速度规划与判定 ----------
function renderStepLog(reason) {
  const sched = state.schedule;
  const lines = [];
  lines.push(`<div class="step-ok">重算原因：${reason}；Cue 顺序：${sched.order.join(' → ')}；总时长 ${sched.totalDuration}s</div>`);

  for (const cue of sched.cues) {
    lines.push(`<div class="step-cue">${cue.cueId} ${cue.cueName}${cue.linked ? '（联动，终点对齐）' : ''}  时间窗 ${cue.start}s–${cue.end}s，组时长 ${cue.duration}s</div>`);
    for (const m of cue.motions) {
      const p = m.plan;
      const dirText = m.direction > 0 ? '下放' : '提升';
      lines.push(
        `<div class="step-line">· ${m.battenId} ${m.startHeight}m→${m.endHeight}m（${dirText} ${p.distance}m）：` +
        `加 ${p.accelTime}s（峰值 ${p.peakSpeed}m/s）/ 匀 ${p.coastTime}s / 减 ${p.decelTime}s，` +
        `单独走 ${p.duration}s${cue.linked ? `，等待 ${m.wait}s 后启动` : ''}${
          m.isLaggard ? '，【拖后腿】' : ''
        }</div>`
      );
      for (const phase of m.phases) {
        const over = phase.netLoad > findRated(m.battenId);
        lines.push(
          `  <div class="${over ? 'step-over' : 'step-line'}">    ${phaseName(phase.kind)}段 ${phase.start}s–${phase.end}s ` +
          `吊点拉力 ${phase.netLoad}kg / 额定 ${findRated(m.battenId)}kg${over ? ' → 超载染红，禁止提交' : ''}</div>`
        );
      }
    }
    const cueConflicts = sched.conflicts.filter((c) => c.cueId === cue.cueId);
    for (const c of cueConflicts) {
      lines.push(`<div class="${c.type === 'overload' ? 'step-over' : 'step-warn'}">  ⚠ ${c.message}</div>`);
    }
    if (!cueConflicts.length) {
      lines.push(`<div class="step-ok">  ✓ 该 Cue 无冲突</div>`);
    }
  }

  lines.push(
    `<div class="step-ok">汇总：冲突 ${sched.conflicts.length} 条；` +
    `最长等待 ${sched.longestWait}s（${
      sched.waitingRanking.length ? sched.waitingRanking.map((w) => w.battenId + '=' + w.totalWait + 's').join('，') : '无等待'
    }）；${sched.submittable ? '允许提交预演' : `存在过载，禁止提交：${sched.blockingCueIds.join('、')}`}</div>`
  );
  $('stepLog').innerHTML = lines.join('');
}

function findRated(battenId) {
  return state.rig.battens.find((b) => b.id === battenId).ratedLoad;
}

function phaseName(kind) {
  if (kind === 'accel') return '加速';
  if (kind === 'decel') return '减速';
  return '匀速';
}

// ---------- 冲突清单 + 等待排名 ----------
function renderSummary() {
  const sched = state.schedule;
  $('conflictCount').textContent = sched.conflicts.length;
  $('conflictList').innerHTML = sched.conflicts
    .map((c) => {
      const timeText = c.type === 'overload' ? `［${c.start}s–${c.end}s］` : '';
      return `<li class="${c.type}">${c.cueId} ${timeText}${c.message}</li>`;
    })
    .join('');

  const maxWait = sched.longestWait || 1;
  $('waitList').innerHTML = sched.waitingRanking
    .map(
      (w) =>
        `<li>${w.battenId}（${w.battenName}）累计等 ${w.totalWait}s ` +
        `<span class="wait-bar" style="width:${Math.round((w.totalWait / maxWait) * 90)}px"></span>` +
        `<div style="color:#67727f;font-size:11px">${w.details
          .map((d) => `${d.cueId}:${d.waitSec}s`)
          .join('，')}</div></li>`
    )
    .join('');
  $('longestWait').textContent = `${sched.longestWait}s${
    sched.waitingRanking.length ? `（${sched.waitingRanking[0].battenId} ${sched.waitingRanking[0].battenName}）` : ''
  }`;

  const btn = $('btnSubmit');
  btn.disabled = !sched.submittable;
  const result = $('submitResult');
  result.className = 'submit-result';
  result.textContent = sched.submittable
    ? ''
    : `过载段落存在，${sched.blockingCueIds.join('、')} 不可提交预演`;
}

function submitRehearsal() {
  const sched = state.schedule;
  const result = $('submitResult');
  if (sched.submittable) {
    result.className = 'submit-result ok';
    result.textContent = `提交成功：${sched.order.join(' → ')}，总时长 ${sched.totalDuration}s，冲突 ${sched.conflicts.length} 条（仅警告）。`;
  } else {
    result.className = 'submit-result bad';
    result.textContent = `已拦截：${sched.blockingCueIds.join('、')} 存在配重过载段，超载段落一律不许提交。`;
  }
}

function showEndSummary() {
  const sched = state.schedule;
  const result = $('submitResult');
  result.className = 'submit-result ok';
  result.textContent =
    `预演跑完：冲突 ${sched.conflicts.length} 条；最长等待 ${sched.longestWait}s` +
    (sched.waitingRanking.length ? `（${sched.waitingRanking[0].battenId}）` : '');
}

function renderAll(reason) {
  renderCueList();
  renderTimeline();
  renderStage();
  renderSummary();
  renderStepLog(reason ?? '重算');
  updateClock();
}
