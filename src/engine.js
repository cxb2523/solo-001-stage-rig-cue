// 舞台吊杆 Cue 计算引擎：纯函数、无任何第三方依赖，Node 与浏览器共用。
// 高度坐标：距栅顶下放米数（0=栅顶最高，越大越低）。

export const GRAVITY = 9.81;
export const DEFAULT_SYNC_TOLERANCE = 2;

export function round3(value) {
  if (!Number.isFinite(value)) return value;
  return Math.round(value * 1000) / 1000;
}

// 梯形速度规划：加速 -> 匀速 -> 减速。距离太短走不完加减速时退化为三角形速度曲线。
export function planMove(distance, speed, accelTime, decelTime) {
  const dist = Math.abs(distance);
  if (dist === 0) {
    return {
      distance: 0, peakSpeed: 0, accelTime: 0, coastTime: 0, decelTime: 0,
      accelDist: 0, coastDist: 0, decelDist: 0, duration: 0
    };
  }
  if (!(speed > 0)) {
    throw new Error(`速度必须大于 0（distance=${distance}, speed=${speed}）`);
  }
  const ta = Math.max(0, accelTime);
  const td = Math.max(0, decelTime);
  const rampTotal = ta + td;
  let peakSpeed = speed;
  if (rampTotal > 0) {
    // 无匀速段的三角形曲线：v_p·(ta+td)/2 = dist
    peakSpeed = Math.min(speed, (2 * dist) / rampTotal);
  }
  const accelDist = (peakSpeed * ta) / 2;
  const decelDist = (peakSpeed * td) / 2;
  let coastDist = dist - accelDist - decelDist;
  if (coastDist < 0 && coastDist > -1e-9) coastDist = 0;
  const coastTime = coastDist > 0 ? coastDist / peakSpeed : 0;
  return {
    distance: dist,
    peakSpeed: round3(peakSpeed),
    accelTime: ta,
    coastTime: round3(coastTime),
    decelTime: td,
    accelDist: round3(accelDist),
    coastDist: round3(coastDist),
    decelDist: round3(decelDist),
    duration: round3(ta + coastTime + td)
  };
}

// 局部时刻（0=该杆启动）所在的速度规划阶段。
export function phaseAtLocal(plan, localTime) {
  const { accelTime, coastTime } = plan;
  if (localTime < accelTime) return 'accel';
  if (localTime < accelTime + coastTime) return 'coast';
  return 'decel';
}

// 局部时刻的高度。direction: +1 下放（高度增大），-1 提升（高度减小）。
export function heightAtLocal(plan, startHeight, direction, localTime) {
  if (plan.distance === 0) return startHeight;
  const t = Math.max(0, Math.min(plan.duration, localTime));
  const { accelTime: ta, coastTime: tc, decelTime: td, peakSpeed: v } = plan;
  let travelled;
  if (t < ta) {
    const accel = ta > 0 ? v / ta : 0;
    travelled = 0.5 * accel * t * t;
  } else if (t < ta + tc) {
    travelled = (v * ta) / 2 + v * (t - ta);
  } else {
    const u = t - ta - tc;
    const decel = td > 0 ? v / td : 0;
    travelled = (v * ta) / 2 + v * tc + v * u - 0.5 * decel * u * u;
  }
  return round3(startHeight + direction * Math.min(plan.distance, travelled));
}

// 吊点侧有效净载荷（kg）。accelDownSigned：向下为正的加速度（m/s²）。
// 加速下放/提升刹车时 a 向下为正，惯性使吊点拉力增大；提升启动时减小。
// 配重只平衡电机侧静载，不能替钢丝绳/卷扬机构卸力，因此超载以吊点侧拉力对额定载荷判定。
export function netLoad(counterWeight, payload, accelDownSigned, gravity) {
  return payload * (1 + accelDownSigned / gravity);
}

function loadPhases(move, plan, direction, batten, gravity) {
  const { accelTime: ta, coastTime: tc, decelTime: td, peakSpeed: v } = plan;
  const phases = [];
  const push = (kind, start, end, accelDownSigned) => {
    if (end <= start + 1e-9) return;
    phases.push({
      kind,
      start: round3(start),
      end: round3(end),
      netLoad: round3(netLoad(batten.counterWeight, move.payload, accelDownSigned, gravity)),
      accelDownSigned: round3(accelDownSigned)
    });
  };
  // 下放（direction>0）：启动加速向下(+)，刹车加速向上(-)；提升反之。
  const accelA = direction > 0 ? (ta > 0 ? v / ta : 0) : ta > 0 ? -v / ta : 0;
  const decelA = direction > 0 ? (td > 0 ? -v / td : 0) : td > 0 ? v / td : 0;
  push('accel', 0, ta, accelA);
  push('coast', ta, ta + tc, 0);
  push('decel', ta + tc, ta + tc + td, decelA);
  return phases;
}

function phaseLabel(kind) {
  if (kind === 'accel') return '加速';
  if (kind === 'decel') return '减速';
  return '匀速';
}

// 计算单条 Cue：每根杆的速度规划、联动等待、配重越限段、冲突。
export function evaluateCue(cue, rig) {
  const gravity = rig.constants?.gravity ?? GRAVITY;
  const tolerance = rig.constants?.syncWaitToleranceSec ?? DEFAULT_SYNC_TOLERANCE;
  const battenById = new Map(rig.battens.map((b) => [b.id, b]));

  const moveResults = cue.moves.map((move) => {
    const batten = battenById.get(move.battenId);
    if (!batten) throw new Error(`Cue ${cue.id} 引用了不存在的吊杆 ${move.battenId}`);
    const direction = move.endHeight >= move.startHeight ? 1 : -1;
    const distance = move.endHeight - move.startHeight;
    const plan = planMove(Math.abs(distance), move.speed, move.accelTime, move.decelTime);
    const phases = loadPhases(move, plan, direction, batten, gravity);
    const overloadSegments = phases
      .filter((p) => p.netLoad > batten.ratedLoad)
      .map((p) => ({
        battenId: batten.id,
        start: p.start,
        end: p.end,
        phase: p.kind,
        netLoad: p.netLoad,
        ratedLoad: batten.ratedLoad
      }));
    const outOfRange =
      move.startHeight < batten.minHeight || move.startHeight > batten.maxHeight ||
      move.endHeight < batten.minHeight || move.endHeight > batten.maxHeight;
    return { move, batten, direction, plan, phases, overloadSegments, outOfRange };
  });

  const groupDuration = moveResults.reduce((max, r) => Math.max(max, r.plan.duration), 0);

  const motions = [];
  const cueConflicts = [];
  let blocking = false;

  for (const result of moveResults) {
    const { move, batten, plan, phases, overloadSegments, outOfRange } = result;
    const wait = cue.linked ? round3(groupDuration - plan.duration) : 0;
    const isLaggard = cue.linked && groupDuration > 0 && plan.duration === groupDuration;
    const delay = wait;

    motions.push({
      battenId: batten.id,
      startHeight: move.startHeight,
      endHeight: move.endHeight,
      direction: result.direction,
      plan,
      wait,
      isLaggard,
      delay,
      motionStart: round3(delay),
      motionEnd: round3(delay + plan.duration),
      phases: phases.map((p) => ({
        ...p,
        start: round3(delay + p.start),
        end: round3(delay + p.end)
      })),
      overloadSegments: overloadSegments.map((s) => ({
        ...s,
        start: round3(delay + s.start),
        end: round3(delay + s.end)
      }))
    });

    for (const segment of overloadSegments) {
      blocking = true;
      cueConflicts.push({
        type: 'overload',
        severity: 'blocking',
        battenId: batten.id,
        battenName: batten.name,
        phase: segment.phase,
        start: round3(delay + segment.start),
        end: round3(delay + segment.end),
        netLoad: segment.netLoad,
        ratedLoad: segment.ratedLoad,
        message:
          `${batten.id}（${batten.name}）在 ${cue.id} 的${phaseLabel(segment.phase)}段 ` +
          `${round3(delay + segment.start)}s–${round3(delay + segment.end)}s ` +
          `${segment.netLoad}kg 吊点拉力超过额定 ${batten.ratedLoad}kg`
      });
    }

    if (outOfRange) {
      cueConflicts.push({
        type: 'range',
        severity: 'warning',
        battenId: batten.id,
        battenName: batten.name,
        message: `${batten.id}（${batten.name}）行程超出 ${batten.minHeight}–${batten.maxHeight}m 限位`
      });
    }
  }

  const maxWait = motions.reduce((max, m) => Math.max(max, m.wait), 0);
  const laggards = motions.filter((m) => m.isLaggard).map((m) => m.battenId);
  if (cue.linked && maxWait > tolerance) {
    const waiters = motions.filter((m) => m.wait > 0);
    cueConflicts.push({
      type: 'sync',
      severity: 'warning',
      laggardBattenIds: laggards,
      maxWaitSec: maxWait,
      toleranceSec: tolerance,
      waiterBattenIds: waiters.map((m) => `${m.battenId}:${m.wait}s`),
      message:
        `联动不同步：${laggards.join('、')} 最慢拖后腿，终点对齐时最长等待 ${maxWait}s ` +
        `（容差 ${tolerance}s）；等待方 ${waiters.map((m) => `${m.battenId}=${m.wait}s`).join('，')}`
    });
  }

  return {
    cueId: cue.id,
    cueName: cue.name,
    linked: !!cue.linked,
    duration: groupDuration,
    maxWait,
    laggardBattenIds: laggards,
    motions,
    conflicts: cueConflicts,
    blocking
  };
}

// 整条时间轴：给定 Cue 排列顺序，重算所有时间点、连续性、冲突与等待统计。
export function computeSchedule(rig, cuesDoc, order) {
  const orderedIds = order && order.length ? order : cuesDoc.cues.map((c) => c.id);
  const cueById = new Map(cuesDoc.cues.map((c) => [c.id, c]));
  for (const id of orderedIds) {
    if (!cueById.has(id)) throw new Error(`排列中存在未知 Cue：${id}`);
  }

  let clock = 0;
  let conflictSeq = 0;
  const cueResults = [];
  const motionIntervals = [];
  const overloadIntervals = [];
  const conflicts = [];
  const waitByBatten = new Map();
  const lastEndHeight = new Map();

  for (const cueId of orderedIds) {
    const cue = cueById.get(cueId);
    const evaluated = evaluateCue(cue, rig);
    const cueStart = round3(clock);
    const cueEnd = round3(clock + evaluated.duration);

    for (const motion of evaluated.motions) {
      const batten = rig.battens.find((b) => b.id === motion.battenId);
      const home = batten.homeHeight ?? batten.minHeight;
      const prev = lastEndHeight.has(motion.battenId) ? lastEndHeight.get(motion.battenId) : home;
      if (Math.abs(prev - motion.startHeight) > 1e-6) {
        evaluated.conflicts.push({
          type: 'continuity',
          severity: 'warning',
          battenId: motion.battenId,
          battenName: batten.name,
          message:
            `${motion.battenId}（${batten.name}）在 ${cueId} 的起点 ${motion.startHeight}m ` +
            `与上一位置 ${prev}m${lastEndHeight.has(motion.battenId) ? '（上一条 Cue 终点）' : '（台账家位）'}不一致，换序后需要重新接杆`
        });
      }
      lastEndHeight.set(motion.battenId, motion.endHeight);

      motionIntervals.push({
        battenId: motion.battenId,
        cueId,
        start: round3(cueStart + motion.motionStart),
        end: round3(cueStart + motion.motionEnd),
        startHeight: motion.startHeight,
        endHeight: motion.endHeight,
        direction: motion.direction,
        plan: motion.plan
      });

      for (const segment of motion.overloadSegments) {
        overloadIntervals.push({
          battenId: segment.battenId,
          cueId,
          phase: segment.phase,
          start: round3(cueStart + segment.start),
          end: round3(cueStart + segment.end),
          netLoad: segment.netLoad,
          ratedLoad: segment.ratedLoad
        });
      }

      if (motion.wait > 0) {
        const entry =
          waitByBatten.get(motion.battenId) ??
          { battenId: motion.battenId, totalWait: 0, details: [] };
        entry.totalWait = round3(entry.totalWait + motion.wait);
        entry.details.push({ cueId, waitSec: motion.wait });
        waitByBatten.set(motion.battenId, entry);
      }
    }

    for (const conflict of evaluated.conflicts) {
      conflicts.push({
        seq: ++conflictSeq,
        cueId,
        cueName: cue.name,
        ...conflict,
        ...(conflict.type === 'overload'
          ? { start: round3(cueStart + conflict.start), end: round3(cueStart + conflict.end) }
          : {})
      });
    }

    cueResults.push({
      cueId,
      cueName: cue.name,
      linked: evaluated.linked,
      start: cueStart,
      end: cueEnd,
      duration: evaluated.duration,
      maxWait: evaluated.maxWait,
      laggardBattenIds: evaluated.laggardBattenIds,
      blocking: evaluated.blocking,
      motions: evaluated.motions
    });

    clock = cueEnd;
  }

  const waitingRanking = [...waitByBatten.values()]
    .map((entry) => {
      const batten = rig.battens.find((b) => b.id === entry.battenId);
      return {
        battenId: entry.battenId,
        battenName: batten.name,
        totalWait: entry.totalWait,
        details: entry.details
      };
    })
    .sort((a, b) => b.totalWait - a.totalWait || a.battenId.localeCompare(b.battenId));

  const blockingCueIds = cueResults.filter((c) => c.blocking).map((c) => c.cueId);
  const totalDuration = cueResults.length ? cueResults[cueResults.length - 1].end : 0;

  return {
    order: orderedIds,
    totalDuration,
    cues: cueResults,
    motionIntervals,
    overloadIntervals,
    conflicts,
    waitingRanking,
    longestWait: waitingRanking.length ? waitingRanking[0].totalWait : 0,
    blockingCueIds,
    submittable: blockingCueIds.length === 0
  };
}

// 全局时刻每根杆的高度/配重状态，供剖面动画逐帧查询。
export function stateAt(schedule, rig, time) {
  const homeById = new Map(rig.battens.map((b) => [b.id, b.homeHeight ?? b.minHeight]));
  const heights = new Map(rig.battens.map((b) => [b.id, homeById.get(b.id)]));
  const active = new Map();

  for (const interval of schedule.motionIntervals) {
    if (time + 1e-9 < interval.start) {
      // 尚未开始：保持起点（上一轮 Cue 结束后 lastEnd 已在下面的区间推进中处理）
      continue;
    }
    if (time + 1e-9 >= interval.end) {
      heights.set(interval.battenId, interval.endHeight);
      continue;
    }
    const localTime = time - interval.start;
    const height = heightAtLocal(interval.plan, interval.startHeight, interval.direction, localTime);
    heights.set(interval.battenId, height);
    active.set(interval.battenId, { cueId: interval.cueId, height });
  }

  return rig.battens.map((batten) => ({
    battenId: batten.id,
    height: heights.get(batten.id),
    moving: active.has(batten.id),
    activeCueId: active.get(batten.id)?.cueId ?? null
  }));
}
