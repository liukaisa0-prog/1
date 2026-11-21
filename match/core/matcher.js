// core/matcher.js — 人物匹配算法（加权欧氏距离 + 稳定性裁决）
'use strict';

const { DIMENSIONS } = require('./score');

// 五维权重（第一版均等）
const WEIGHTS = { O: 0.2, C: 0.2, E: 0.2, A: 0.2, S: 0.2 };
// 理论最大距离：每维满分差100，D = sqrt(5 * 0.2 * 100^2) = 100
const MAX_DISTANCE = 100;

/**
 * 加权欧氏距离
 * @param {Object} userScores {O,C,E,A,S}
 * @param {Object} charScores {O,C,E,A,S}
 * @returns {number} 距离（0~100）
 */
function weightedDistance(userScores, charScores) {
  let sum = 0;
  for (const dim of DIMENSIONS) {
    const diff = userScores[dim] - charScores[dim];
    sum += WEIGHTS[dim] * diff * diff;
  }
  return Math.sqrt(sum);
}

/**
 * 匹配指数：产品内部展示值（非心理学匹配概率）
 * matchIndex = 100 × [1 - min(D / Dmax, 1)]
 */
function distanceToMatchIndex(distance) {
  const d = Math.max(0, Math.min(distance, MAX_DISTANCE));
  // 保留1位小数
  return Math.round((100 * (1 - d / MAX_DISTANCE)) * 10) / 10;
}

/**
 * 在符合范围的人物列表中匹配
 * @param {Object} userScores {O,C,E,A,S}
 * @param {Array} characters 全部启用人物
 * @param {string} scope 'all' | 'male' | 'female'
 * @returns {Object} { matched, distance, matchIndex, ranked } matched 为唯一人物
 */
function matchCharacter(userScores, characters, scope) {
  const pool = characters.filter(c => {
    if (!c.status) return false;
    if (scope === 'all') return true;
    if (scope === 'male') return c.gender === 'male';
    if (scope === 'female') return c.gender === 'female';
    return false;
  });

  if (pool.length === 0) {
    const err = new Error('匹配范围内没有可用人物');
    err.code = 'EMPTY_POOL';
    throw err;
  }

  const ranked = pool
    .map(c => ({
      character: c,
      distance: weightedDistance(userScores, c.five_factor_scores)
    }))
    .sort((a, b) => compareCandidates(a, b, userScores));

  const top = ranked[0];
  return {
    matched: top.character,
    distance: Math.round(top.distance * 1000) / 1000,
    matchIndex: distanceToMatchIndex(top.distance),
    ranked // 供后续"相似人物榜"使用，第一版不返回给前端
  };
}

/** 用户高分维度（>=70）与人物五维表现的匹配数，作为同距离时的次级裁决依据 */
function tagMatchCount(character, userScores) {
  // 用户高分维度：>=70 视为显著特征
  const highDims = DIMENSIONS.filter(d => userScores[d] >= 70);
  // 简化规则：每个高分维度对应人物五维中 >=70 的表现 → 计入匹配数
  return DIMENSIONS.filter(d => highDims.includes(d) && character.five_factor_scores[d] >= 70).length;
}

/** 完整比较器：距离 → 标签匹配数 → 关键词命中数 → character_id */
function compareCandidates(a, b, userScores) {
  if (a.distance !== b.distance) return a.distance - b.distance;
  const ta = tagMatchCount(a.character, userScores);
  const tb = tagMatchCount(b.character, userScores);
  if (ta !== tb) return tb - ta;
  const ka = a.character.matching_keywords.length;
  const kb = b.character.matching_keywords.length;
  if (ka !== kb) return kb - ka;
  return a.character.character_id < b.character.character_id ? -1 : 1;
}

/**
 * 生成差异化匹配说明（基于用户实际分数）
 * @param {Object} userScores
 * @param {Object} character 匹配人物
 * @param {Object} detail score.js 返回的 detail（含各维度分数）
 * @returns {Object} { similar: string[], different: string[], insight: string }
 */
function buildExplanation(userScores, character, detail) {
  const names = { O: '开放性', C: '尽责性', E: '外向性', A: '宜人性', S: '情绪稳定性' };
  const diffs = DIMENSIONS.map(dim => ({
    dim,
    diff: Math.abs(userScores[dim] - character.five_factor_scores[dim])
  }));

  // 最接近的两个维度
  const closest = diffs.slice().sort((a, b) => a.diff - b.diff).slice(0, 2);
  // 差异最大的维度
  const mostDiff = diffs.slice().sort((a, b) => b.diff - a.diff)[0];

  const similar = closest.map(c => {
    const dimName = names[c.dim];
    const isHigh = userScores[c.dim] >= 60;
    const base = `你们在「${dimName}」上的得分非常接近（你 ${userScores[c.dim]} 分 / ${character.name} ${character.five_factor_scores[c.dim]} 分）`;
    return isHigh ? `${base}，这决定了你们看待事情的方式有天然的共鸣。` : `${base}，你们在这一点上有着相似的节奏。`;
  });

  const different = [
    `你们差异最大的地方是「${names[mostDiff.dim]}」（你 ${userScores[mostDiff.dim]} 分 / ${character.name} ${character.five_factor_scores[mostDiff.dim]} 分）。` +
    (userScores[mostDiff.dim] > character.five_factor_scores[mostDiff.dim]
      ? `你在这一点上比他更外放，这可能正是你们互相吸引的地方——他能补上你想慢下来的那部分。`
      : `他在这点上比你更鲜明，这份锋芒也许正是你心里藏着、却很少释放的力量。`)
  ];

  const tpl = character.matching_explanation_templates;
  const insight = tpl && tpl.length ? tpl[userScores.O % tpl.length] : '';

  return { similar, different, insight };
}

module.exports = {
  WEIGHTS,
  MAX_DISTANCE,
  weightedDistance,
  distanceToMatchIndex,
  matchCharacter,
  compareCandidates,
  buildExplanation
};
