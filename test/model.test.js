'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Model = require('../src/model.js');

const rig = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'rig.json'), 'utf8'));
const cues = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cues.json'), 'utf8'));
const order = cues.map((c) => c.id);

test('样例数据规模：吊杆 >= 12，Cue >= 8', () => {
  assert.ok(rig.battens.length >= 12);
  assert.ok(cues.length >= 8);
});

test('同一份 Cue 表连算两次，结果完全一致', () => {
  const r1 = Model.simulate(rig, cues, order);
  const r2 = Model.simulate(rig, cues, order);
  assert.deepEqual(r1, r2);
  assert.equal(JSON.stringify(r1), JSON.stringify(r2));
});

test('埋入的两处配重超载被检出（B5@C3、B9@C6）', () => {
  const r = Model.simulate(rig, cues, order);
  assert.equal(r.conflicts.length, 2);
  const byBatten = Object.fromEntries(r.conflicts.map((c) => [c.batten, c]));
  assert.equal(byBatten.B5.cue, 'C3');
  assert.equal(byBatten.B9.cue, 'C6');
  // B5: base=120, a=1.2/0.5=2.4 -> 120 + 420*2.4/9.81 ≈ 222.752
  assert.ok(Math.abs(byBatten.B5.peakLoad - 222.752) < 0.001);
  assert.ok(byBatten.B5.peakLoad > byBatten.B5.rated);
  // B9: base=120, a=1.0/0.4=2.5 -> 120 + 380*2.5/9.81 ≈ 216.84
  assert.ok(Math.abs(byBatten.B9.peakLoad - 216.84) < 0.001);
});

test('埋入的联动速度不同步被检出（C5 中 B4 拖后腿）', () => {
  const r = Model.simulate(rig, cues, order);
  assert.equal(r.syncIssues.length, 1);
  const s = r.syncIssues[0];
  assert.equal(s.cue, 'C5');
  assert.deepEqual(s.battens, ['B4']);
  assert.equal(s.critical, 'B4');
  assert.equal(s.minSpeed, 0.35);
});

test('联动组终点对齐：同时到位，快杆等待、慢杆不等待', () => {
  const r = Model.simulate(rig, cues, order);
  const c5 = r.cues.find((c) => c.id === 'C5');
  const ends = ['B2', 'B3', 'B4'].map((id) =>
    r.tracks[id].find((t) => t.cue === 'C5').t1);
  assert.ok(Math.abs(ends[0] - ends[1]) < 1e-9);
  assert.ok(Math.abs(ends[1] - ends[2]) < 1e-9);
  assert.ok(r.waits.B2 > 0 && r.waits.B3 > 0);
  assert.equal(r.waits.B4, 0);
  assert.equal(c5.groups[0].critical, 'B4');
});

test('调整 Cue 顺序后所有时间点重算', () => {
  const r1 = Model.simulate(rig, cues, order);
  const reordered = ['C6'].concat(order.filter((id) => id !== 'C6'));
  const r2 = Model.simulate(rig, cues, reordered);
  const c6First = r2.cues.find((c) => c.id === 'C6');
  const c6Orig = r1.cues.find((c) => c.id === 'C6');
  assert.equal(c6First.tStart, 0);
  assert.ok(c6Orig.tStart > 0);
  // 顺序变化后冲突的绝对时刻也随之改变
  const tB9r1 = r1.conflicts.find((c) => c.batten === 'B9').t0;
  const tB9r2 = r2.conflicts.find((c) => c.batten === 'B9').t0;
  assert.notEqual(tB9r1, tB9r2);
});

test('Cue 顺序衔接：后一条的起点等于前一条的终点', () => {
  const r = Model.simulate(rig, cues, order);
  for (let i = 1; i < r.cues.length; i++) {
    assert.ok(Math.abs(r.cues[i].tStart - r.cues[i - 1].tEnd) < 1e-9);
  }
  assert.equal(r.totalDuration, r.cues[r.cues.length - 1].tEnd);
});

test('梯形速度曲线：长距离含匀速段，短距离退化为三角形', () => {
  const trap = Model.moveProfile(4, 0.8, 1.5);
  assert.equal(trap.phases.length, 3);
  assert.ok(Math.abs(trap.duration - (2 * 1.5 + (4 - 1.2) / 0.8)) < 1e-9);
  const tri = Model.moveProfile(0.1, 1, 1);
  assert.equal(tri.phases.length, 2);
  assert.ok(Math.abs(tri.duration - 2 * Math.sqrt(0.1)) < 1e-9);
  // 行程守恒
  const sum = trap.phases.reduce((s, p) => s + p.dist, 0);
  assert.ok(Math.abs(sum - 4) < 1e-9);
});

test('positionAt 端点与中点', () => {
  const p = Model.moveProfile(4, 0.8, 1.5);
  assert.equal(Model.positionAt(p, 0), 0);
  assert.equal(Model.positionAt(p, p.duration), 1);
  assert.equal(Model.positionAt(p, p.duration + 5), 1);
  const mid = Model.positionAt(p, p.duration / 2);
  assert.ok(mid > 0.4 && mid < 0.6);
});
