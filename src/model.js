'use strict';
/*
 * 吊杆 Cue 预演计算内核（纯函数，Node 与浏览器共用）。
 *
 * 运动模型：梯形速度曲线（加速 -> 匀速 -> 减速）。
 *   距离不足以加到额定速度时退化为三角形曲线。
 *
 * 载荷模型（保守取值）：
 *   静态净载荷 base = |payload - counterweight|
 *   加/减速段载荷   = base + payload * a / g   （a 为该段加速度，g = 9.81）
 *   匀速段载荷      = base
 *   任意时刻载荷 > ratedLoad 即判定超载。
 *
 * 联动组策略：各杆保持自己的速度，终点对齐 ——
 *   组时长 = 组内各杆运动时间的最大值，快的杆延迟出发、同时到位，
 *   延迟时间记为该杆的"等待时间"，用时最长的杆标记为"拖后腿"。
 *
 * 确定性：无任何随机/时钟依赖，同一输入两次计算结果逐字节一致。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RigModel = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const G = 9.81;

  function round3(x) {
    return Math.round(x * 1000) / 1000;
  }

  // 梯形/三角形速度曲线。返回 { distance, duration, phases:[{kind,dur,v0,v1,dist}] }
  function moveProfile(distance, speed, accelTime) {
    const d = Math.abs(distance);
    if (d < 1e-9 || speed <= 0 || accelTime <= 0) {
      return { distance: d, duration: 0, phases: [] };
    }
    const accel = speed / accelTime;
    const dAcc = 0.5 * speed * accelTime;
    let phases;
    if (2 * dAcc <= d) {
      const tConst = (d - 2 * dAcc) / speed;
      phases = [
        { kind: 'accel', dur: accelTime, v0: 0, v1: speed },
        { kind: 'const', dur: tConst, v0: speed, v1: speed },
        { kind: 'decel', dur: accelTime, v0: speed, v1: 0 }
      ];
    } else {
      const tHalf = Math.sqrt(d / accel);
      const vPeak = accel * tHalf;
      phases = [
        { kind: 'accel', dur: tHalf, v0: 0, v1: vPeak },
        { kind: 'decel', dur: tHalf, v0: vPeak, v1: 0 }
      ];
    }
    let duration = 0;
    for (const p of phases) {
      p.dist = 0.5 * (p.v0 + p.v1) * p.dur;
      duration += p.dur;
    }
    return { distance: d, duration, phases };
  }

  function phaseAccel(p) {
    return p.dur > 0 ? Math.abs(p.v1 - p.v0) / p.dur : 0;
  }

  // 局部时刻 t 处完成的行程比例（0..1），供前端动画插值
  function positionAt(profile, t) {
    if (profile.duration <= 0) return 1;
    if (t <= 0) return 0;
    if (t >= profile.duration) return 1;
    let time = 0;
    let covered = 0;
    for (const p of profile.phases) {
      if (t <= time + p.dur) {
        const tau = t - time;
        const a = (p.v1 - p.v0) / p.dur;
        covered += p.v0 * tau + 0.5 * a * tau * tau;
        return covered / profile.distance;
      }
      covered += p.dist;
      time += p.dur;
    }
    return 1;
  }

  // rig: data/rig.json 内容; cues: data/cues.json 内容; order: cue id 数组
  function simulate(rig, cues, order) {
    const battens = new Map();
    for (const b of rig.battens) {
      battens.set(b.id, Object.assign({}, b, { height: b.homeHeight }));
    }
    const cueById = new Map(cues.map((c) => [c.id, c]));

    const result = {
      cues: [],
      segments: [],   // 载荷曲线分段 {cue,batten,t0,t1,phase,load,rated,overload}
      conflicts: [],  // 超载冲突（按 cue+batten 合并）
      syncIssues: [], // 联动速度不同步
      waits: {},      // 每根杆累计等待时间
      tracks: {},     // 每根杆的运动轨迹（供动画）
      log: [],
      totalDuration: 0
    };
    for (const b of rig.battens) {
      result.waits[b.id] = 0;
      result.tracks[b.id] = [];
    }

    let cursor = 0;
    for (const cueId of order) {
      const cue = cueById.get(cueId);
      if (!cue) throw new Error('未知 Cue: ' + cueId);
      const cueStart = cursor;
      let cueDur = 0;
      const cueEntry = { id: cue.id, name: cue.name, tStart: 0, tEnd: 0, groups: [] };
      result.log.push(`Cue ${cue.id}「${cue.name}」开始于 t=${round3(cueStart)}s`);

      for (const group of cue.groups) {
        const moves = group.moves.map((m) => {
          const bat = battens.get(m.batten);
          if (!bat) throw new Error('未知吊杆: ' + m.batten);
          const from = bat.height;
          const profile = moveProfile(m.to - from, m.speed, m.accelTime);
          return {
            batten: m.batten, from, to: m.to,
            speed: m.speed, accelTime: m.accelTime,
            profile, duration: profile.duration
          };
        });
        const groupDur = moves.reduce((mx, m) => Math.max(mx, m.duration), 0);

        let critical = null;
        for (const m of moves) {
          if (groupDur > 0 && m.duration === groupDur) { critical = m.batten; break; }
        }

        if (group.linked && moves.length > 1) {
          const speeds = moves.map((m) => m.speed);
          const maxS = Math.max.apply(null, speeds);
          const minS = Math.min.apply(null, speeds);
          if (maxS - minS > 1e-9) {
            const slow = moves.filter((m) => m.speed === minS).map((m) => m.batten);
            result.syncIssues.push({
              cue: cue.id, group: group.name || null,
              battens: slow, minSpeed: minS, maxSpeed: maxS, critical
            });
            result.log.push(
              `  联动组「${group.name}」速度不同步：${slow.join('/')} 仅 ${minS}m/s` +
              `（组内最快 ${maxS}m/s），${critical} 拖后腿`
            );
          }
        }

        const groupEntry = { name: group.name || null, linked: !!group.linked, duration: round3(groupDur), critical, moves: [] };
        for (const m of moves) {
          const bat = battens.get(m.batten);
          const delay = group.linked ? groupDur - m.duration : 0;
          const moveStart = cueStart + delay;
          const base = Math.abs(bat.payload - bat.counterweight);

          if (delay > 0) {
            result.waits[m.batten] += delay;
            result.log.push(
              `  ${m.batten} 等待 ${round3(delay)}s 后出发（${round3(m.from)}m -> ${round3(m.to)}m，` +
              `用时 ${round3(m.duration)}s），与联动组同时到位`
            );
          } else if (m.duration > 0) {
            result.log.push(
              `  ${m.batten} ${round3(m.from)}m -> ${round3(m.to)}m，` +
              `v=${m.speed}m/s，加减速 ${m.accelTime}s，用时 ${round3(m.duration)}s` +
              (group.linked && m.batten === critical ? '（拖后腿）' : '')
            );
          }

          let t = moveStart;
          for (const p of m.profile.phases) {
            const load = base + (p.kind === 'const' ? 0 : bat.payload * phaseAccel(p) / G);
            const overload = load > bat.ratedLoad;
            result.segments.push({
              cue: cue.id, batten: m.batten,
              t0: round3(t), t1: round3(t + p.dur),
              phase: p.kind, load: round3(load), rated: bat.ratedLoad, overload
            });
            if (overload) {
              result.log.push(
                `  !! 超载：${m.batten} 在 t=${round3(t)}~${round3(t + p.dur)}s ` +
                `载荷 ${round3(load)}kg > 额定 ${bat.ratedLoad}kg`
              );
            }
            t += p.dur;
          }

          if (m.duration > 0) {
            result.tracks[m.batten].push({
              cue: cue.id, t0: round3(moveStart), t1: round3(moveStart + m.duration),
              from: round3(m.from), to: m.to, profile: m.profile
            });
          }
          groupEntry.moves.push({
            batten: m.batten, from: round3(m.from), to: m.to,
            duration: round3(m.duration), delay: round3(delay)
          });
          bat.height = m.to;
        }
        cueEntry.groups.push(groupEntry);
        cueDur = Math.max(cueDur, groupDur);
      }

      cueEntry.tStart = round3(cueStart);
      cueEntry.tEnd = round3(cueStart + cueDur);
      result.log.push(`Cue ${cue.id} 结束于 t=${round3(cueStart + cueDur)}s（历时 ${round3(cueDur)}s）`);
      result.cues.push(cueEntry);
      cursor += cueDur;
    }

    // 超载冲突按 cue+batten 合并为一条
    const merged = new Map();
    for (const s of result.segments) {
      if (!s.overload) continue;
      const key = s.cue + '|' + s.batten;
      const cur = merged.get(key);
      if (!cur) {
        merged.set(key, {
          type: 'overload', cue: s.cue, batten: s.batten,
          t0: s.t0, t1: s.t1, tPeak: s.t0, peakLoad: s.load, rated: s.rated
        });
      } else {
        cur.t1 = s.t1;
        if (s.load > cur.peakLoad) { cur.peakLoad = s.load; cur.tPeak = s.t0; }
      }
    }
    result.conflicts = Array.from(merged.values()).sort((a, b) => a.t0 - b.t0 || a.batten.localeCompare(b.batten));

    for (const id of Object.keys(result.waits)) {
      result.waits[id] = round3(result.waits[id]);
    }
    result.totalDuration = round3(cursor);
    result.log.push(`全序列总时长 ${round3(cursor)}s，超载冲突 ${result.conflicts.length} 处`);
    return result;
  }

  return { G, round3, moveProfile, positionAt, simulate };
});
