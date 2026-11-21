// core/score.js — 五维分数计算（服务端执行，防前端篡改）
// 维度顺序固定为 [O, C, E, A, S]
'use strict';

const DIMENSIONS = ['O', 'C', 'E', 'A', 'S'];
const DIMENSION_NAMES = {
  O: '开放性',
  C: '尽责性',
  E: '外向性',
  A: '宜人性',
  S: '情绪稳定性'
};

/**
 * 校验答案对象
 * @param {Object} answers { questionId: 1~5 }
 * @param {Array} questions 题库数组
 * @returns {Object} { valid: boolean, missing: string[], invalid: string[] }
 */
function validateAnswers(answers, questions) {
  if (!answers || typeof answers !== 'object') {
    return { valid: false, missing: questions.map(q => q.question_id), invalid: [] };
  }
  const missing = [];
  const invalid = [];
  for (const q of questions) {
    if (!q.enabled) continue;
    const v = answers[q.question_id];
    if (v === undefined || v === null) {
      missing.push(q.question_id);
    } else if (!Number.isInteger(v) || v < 1 || v > 5) {
      invalid.push(q.question_id);
    }
  }
  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid };
}

/**
 * 计算五维分数
 * @param {Object} answers { questionId: 1~5 }
 * @param {Array} questions 题库
 * @returns {Object} { scores: {O,C,E,A,S}, order: ['O','C','E','A','S'], detail: {dim: {total, avg, score}} }
 */
function computeDimensionScores(answers, questions) {
  const detail = {};
  for (const dim of DIMENSIONS) detail[dim] = { total: 0, count: 0, avg: 0, score: 0 };

  for (const q of questions) {
    if (!q.enabled) continue;
    let v = answers[q.question_id];
    if (q.reverse_scoring) v = 6 - v; // 反向计分：6 - 原始分
    detail[q.dimension].total += v;
    detail[q.dimension].count += 1;
  }

  const scores = {};
  for (const dim of DIMENSIONS) {
    const d = detail[dim];
    if (d.count !== 6) {
      throw new Error(`维度 ${dim} 有效题目数为 ${d.count}，应为 6，题库配置异常`);
    }
    d.avg = d.total / d.count;
    d.score = Math.round(((d.avg - 1) / 4) * 100); // (avg-1)/4*100 → 0-100，四舍五入
    scores[dim] = d.score;
  }

  return { scores, order: DIMENSIONS.slice(), detail };
}

module.exports = { DIMENSIONS, DIMENSION_NAMES, validateAnswers, computeDimensionScores };
