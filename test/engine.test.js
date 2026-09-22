import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  planMove,
  heightAtLocal,
  netLoad,
  evaluateCue,
  computeSchedule,
  stateAt
} from '../src/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const rig = JSON.parse(fs.readFileSync(path.join(root, 'data', 'rig.json'), 'utf-8'));
const cuesDoc = JSON.parse(fs.readFileSync(path.join(root, 'data', 'cues.json'), 'utf-8'));

test('样例台账：至少 12 根吊杆且字段完整', () => {
  assert.ok(rig.battens.length >= 12);
  for (const b of rig.battens) {
    assert.ok(b.id);
    assert.ok(b.name);
    assert.ok(b.ratedLoad > 0);
    assert.ok(b.counterWeight > 0);
    assert.ok(b.maxHeight > b.minHeight);
  }
});

test('样例 Cue：至少 8 条，每条都有独立的起止高度/速度/加减速', () => {
  assert.ok(cuesDoc.cues.length >= 8);
  for (const cue of cuesDoc.cues) {
    assert.ok(cue.moves.length >= 1);
    for (const move of cue.moves) {
      assert.notEqual(move.startHeight, move.endHeight);
      assert.ok(move.speed > 0);
      assert.ok(move.accelTime >= 0);
      assert.ok(move.decelTime >= 0);
    }
  }
});

test('梯形速度规划：总位移等于起止高度差', () => {
  const plan = planMove(10, 0.8, 2, 2);
  const total = plan.accelDist + plan.coastDist + plan.decelDist;
  assert.ok(Math.abs(total - 10) < 1e-6);
  const atEnd = heightAtLocal(plan, 0, 1, plan.duration);
  assert.ok(Math.abs(atEnd - 10) < 1e-6);
});

test('短距离自动削顶为三角形曲线，峰值速度不超过设定速度', () => {
  // 4s 加减速走完 0.4m：三角形峰值 v = 2d/(ta+td) = 0.2m/s
  const plan = planMove(0.4, 2, 2, 2);
  assert.equal(plan.coastTime, 0);
  assert.equal(plan.peakSpeed, 0.2);
  const total = plan.accelDist + plan.coastDist + plan.decelDist;
  assert.ok(Math.abs(total - 0.4) < 1e-6);
});

test('吊点侧净载：加速下放时惯性增大拉力，提升启动时减小', () => {
  assert.ok(netLoad(150, 180, 0.6, 9.81) > 180);
  assert.ok(netLoad(150, 180, -0.6, 9.81) < 180);
  assert.equal(netLoad(150, 180, 0, 9.81), 180);
});

test('整表：恰好两处过载（Q2/B02、Q5/B08 加速下放段）', () => {
  const sched = computeSchedule(rig, cuesDoc);
  const overloads = sched.conflicts.filter((c) => c.type === 'overload');
  assert.equal(overloads.length, 2);
  const overCues = [...new Set(overloads.map((c) => c.cueId))].sort();
  assert.deepEqual(overCues, ['Q2', 'Q5']);
  const overBattens = [...new Set(overloads.map((c) => c.battenId))].sort();
  assert.deepEqual(overBattens, ['B02', 'B08']);
  assert.deepEqual(overloads.map((c) => c.phase), ['accel', 'accel']);
});

test('过载段写明杆号与时刻，数值与物理公式一致（B02 加速段，时间轴 9.5–10.5s）', () => {
  const sched = computeSchedule(rig, cuesDoc);
  const first = sched.conflicts.find(
    (c) => c.type === 'overload' && c.cueId === 'Q2' && c.phase === 'accel'
  );
  assert.equal(first.battenId, 'B02');
  const expected = 195 * (1 + 0.6 / 9.81); // 206.927
  assert.ok(Math.abs(first.netLoad - Math.round(expected * 1000) / 1000) < 1e-9);
  assert.equal(first.start, 9.5);
  assert.equal(first.end, 10.5);
  assert.ok(first.netLoad > first.ratedLoad);
});

test('联动不同步：Q4 中 B03 拖后腿，B06 等待 47s 并报警', () => {
  const sched = computeSchedule(rig, cuesDoc);
  const q4 = sched.cues.find((c) => c.cueId === 'Q4');
  assert.deepEqual(q4.laggardBattenIds, ['B03']);
  const b06 = q4.motions.find((m) => m.battenId === 'B06');
  assert.equal(b06.wait, 47);
  const sync = sched.conflicts.find((c) => c.type === 'sync' && c.cueId === 'Q4');
  assert.ok(sync);
  assert.equal(sync.maxWaitSec, 47);
  assert.deepEqual(sync.laggardBattenIds, ['B03']);
});

test('冲突总条数 = 3（2 过载 + 1 联动），最长等待 47s，Q2/Q5 禁止提交', () => {
  const sched = computeSchedule(rig, cuesDoc);
  assert.equal(sched.conflicts.length, 3);
  assert.equal(sched.longestWait, 47);
  assert.equal(sched.waitingRanking[0].battenId, 'B06');
  assert.equal(sched.submittable, false);
  assert.deepEqual(sched.blockingCueIds, ['Q2', 'Q5']);
});

test('其余联动组（Q3/Q6/Q8）等待均在容差内，不报不同步', () => {
  const sched = computeSchedule(rig, cuesDoc);
  for (const id of ['Q3', 'Q6', 'Q8']) {
    assert.equal(sched.conflicts.some((c) => c.type === 'sync' && c.cueId === id), false);
  }
});

test('非联动 Cue 不产生等待：Q1/Q2/Q5/Q7 等待为 0', () => {
  const sched = computeSchedule(rig, cuesDoc);
  for (const id of ['Q1', 'Q2', 'Q5', 'Q7']) {
    const cue = sched.cues.find((c) => c.cueId === id);
    assert.equal(cue.maxWait, 0);
    for (const motion of cue.motions) assert.equal(motion.wait, 0);
  }
});

test('同一份 Cue 表连算两次，载荷曲线与冲突清单完全一致', () => {
  const a = computeSchedule(rig, cuesDoc);
  const b = computeSchedule(rig, cuesDoc);
  assert.deepEqual(
    JSON.parse(JSON.stringify(a.overloadIntervals)),
    JSON.parse(JSON.stringify(b.overloadIntervals))
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(a.conflicts)),
    JSON.parse(JSON.stringify(b.conflicts))
  );
});

test('换序后时间点整体重算（不只是标签移动）', () => {
  const original = computeSchedule(rig, cuesDoc);
  const reordered = computeSchedule(rig, cuesDoc, ['Q4', ...original.order.filter((id) => id !== 'Q4')]);
  const q4Original = original.cues.find((c) => c.cueId === 'Q4');
  const q4Moved = reordered.cues.find((c) => c.cueId === 'Q4');
  assert.equal(q4Original.start, 41.167);
  assert.equal(q4Moved.start, 0);
  const q1Moved = reordered.cues.find((c) => c.cueId === 'Q1');
  assert.equal(q1Moved.start, q4Moved.end);
  const over = reordered.conflicts.find((c) => c.type === 'overload' && c.cueId === 'Q2');
  assert.ok(over.start !== original.conflicts.find((c) => c.type === 'overload' && c.cueId === 'Q2').start);
});

test('换序打断吊杆衔接时产生连续性冲突', () => {
  // Q8 的 B08 要求从 12m 开始，只有 Q5 之后才成立；把 Q8 提到最前必报连续性
  const reordered = computeSchedule(rig, cuesDoc, ['Q8', 'Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7']);
  const cont = reordered.conflicts.filter((c) => c.type === 'continuity');
  assert.ok(cont.some((c) => c.cueId === 'Q8' && c.battenId === 'B08'));
});

test('stateAt：过载区间内对应吊杆正在运动，全片结束时所有杆到位', () => {
  const sched = computeSchedule(rig, cuesDoc);
  const seg = sched.overloadIntervals.find((i) => i.battenId === 'B02' && i.phase === 'accel');
  const mid = (seg.start + seg.end) / 2;
  const moving = stateAt(sched, rig, mid).find((p) => p.battenId === 'B02');
  assert.equal(moving.moving, true);
  assert.ok(moving.height > 0 && moving.height < 10);
  const end = stateAt(sched, rig, sched.totalDuration);
  const b08 = end.find((p) => p.battenId === 'B08');
  assert.equal(b08.height, 5);
  const b12 = end.find((p) => p.battenId === 'B12');
  assert.equal(b12.height, 14);
});

test('evaluateCue 直接判定 Q2 为 blocking、Q1 不 block', () => {
  const q2 = evaluateCue(cuesDoc.cues.find((c) => c.id === 'Q2'), rig);
  assert.equal(q2.blocking, true);
  const q1 = evaluateCue(cuesDoc.cues.find((c) => c.id === 'Q1'), rig);
  assert.equal(q1.blocking, false);
  assert.equal(q1.conflicts.length, 0);
});
