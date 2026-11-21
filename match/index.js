// match/index.js — 匹配端点（POST /api/match）
// 移植自微信版 cloudfunctions/match/index.js，业务逻辑保持一致：
//   action: 'getQuestions'（公开）| 'submit'（需登录态）| 'logEvent' | 'getHistory'（需登录态）
// 算法核心 core/score.js、core/matcher.js 与题库/人物库 JSON 原样复用（纯 JS 零改动）。
//
// 与微信版的差异：
//   1. 身份来源：wx-server-sdk getWXContext() → 本端点用 x-token 换 openid（sessions 集合）
//   2. 数据库：微信云数据库 → 抖音云 MongoDB 组件（common/db.js 适配层）
'use strict';

const scoreCore = require('./core/score');
const matcher = require('./core/matcher');

const maleChars = require('./data/characters-male.json');
const femaleChars = require('./data/characters-female.json');
const questions = require('./data/questions.json');

const { collection } = require('../common/db');
const { parseRequest, resolveUser } = require('../common/ctx');

const ALL_CHARACTERS = [...maleChars, ...femaleChars];

module.exports = async (params, context) => {
  const req = parseRequest(params, context);
  const event = req.body || {};
  const { openid, token, tokenValid } = await resolveUser(req);

  // 带 token 但会话失效 → 让客户端重新登录（客户端会清缓存自动重试一次）
  if (token && !tokenValid) {
    return fail('TOKEN_INVALID', '登录态已过期，请重试');
  }

  // 严格用户身份：openid 是数据隔离的唯一依据。
  // 绝不做 'anonymous' 之类的兜底——否则所有取不到 openid 的用户会共用同一身份，
  // 导致互相看到对方的历史测试记录。
  try {
    switch (event.action) {
      case 'getQuestions':
        return ok({ questions: questions.filter(q => q.enabled).map(stripDesignNote) });

      case 'submit':
        return await handleSubmit(event, openid);

      case 'logEvent': {
        // 轻量埋点：card_saved / result_viewed 等，失败静默
        try {
          await collection('analytics_events').then(col => col.insertOne({
            event: String(event.event || 'unknown').slice(0, 32),
            user_id: openid,
            record_id: event.record_id || '',
            created_at: Date.now()
          }));
        } catch (e) {
          console.warn('[match] 埋点写入失败:', e.message);
        }
        return ok({ logged: true });
      }

      case 'getHistory': {
        // 仅返回当前用户自己的记录；识别不到身份时返回空列表（首次进入即空态）
        if (!openid) return ok({ items: [] });
        // v2：DB 未启用时优雅降级为空列表（云数据库开通后自动恢复持久化历史）
        try {
          const col = await collection('test_records');
          const rows = await col.find({ user_id: openid })
            .sort({ created_at: -1 })
            .limit(20)
            .toArray();
          const items = rows.map(r => {
          const char = ALL_CHARACTERS.find(c => c.character_id === r.matched_character_id);
          if (!char || !r.dimension_scores) return null;
          return {
            record_id: String(r._id),
            created_at: r.created_at,
            scope: r.scope,
            dimension_scores: r.dimension_scores,
            match_index: r.match_index,
            character: {
              character_id: char.character_id,
              name: char.name,
              gender: char.gender,
              category: char.category,
              personality_summary: char.personality_summary,
              personality_tags: char.personality_tags,
              five_factor_scores: char.five_factor_scores
            },
            explanation: matcher.buildExplanation(r.dimension_scores, char, null)
          };
        }).filter(Boolean);
        return ok({ items });
        } catch (dbErr) {
          console.warn('[match] getHistory 查询失败（DB 未启用）:', dbErr.message);
          return ok({ items: [], dbUnavailable: true });
        }
      }

      default:
        return fail('PARAM', `未知 action: ${event.action}`);
    }
  } catch (err) {
    if (err.code) return fail(err.code, err.message); // 业务错误（如 EMPTY_POOL）
    console.error('[match] 未预期错误:', err);
    // 调试期：把真实错误带回前端便于定位（上线前改回固定文案）
    return fail('INTERNAL', '服务开小差了：' + (err.message || '未知错误'));
  }
};

/** 提交测试：校验 → 计分 → 匹配 → 落库 → 返回结果 */
async function handleSubmit(event, openid) {
  const scope = ['all', 'male', 'female'].includes(event.scope) ? event.scope : 'all';

  // 1. 校验答案完整性（服务端强校验，不信任前端）
  const v = scoreCore.validateAnswers(event.answers, questions);
  if (!v.valid) {
    return fail('ANSWER_INVALID', `答案不完整或非法，缺失:${v.missing.join(',')} 非法:${v.invalid.join(',')}`);
  }

  // 2. 计算五维分数
  const { scores, detail } = scoreCore.computeDimensionScores(event.answers, questions);

  // 3. 匹配
  const result = matcher.matchCharacter(scores, ALL_CHARACTERS, scope);
  const explanation = matcher.buildExplanation(scores, result.matched, detail);

  // 4. 落库（无 openid 时不写库：宁可这条记录不入历史，也不能写进公共桶污染他人数据）
  let recordId = '';
  if (!openid) {
    console.warn('[match] 缺少 openid，本次结果不入库（避免污染他人历史）');
  } else {
    try {
      const now = Date.now();
      const col = await collection('test_records');
      const addRes = await col.insertOne({
        user_id: openid,
        scope,
        answers: event.answers,
        dimension_scores: scores,
        dimension_detail: detail,
        matched_character_id: result.matched.character_id,
        match_distance: result.distance,
        match_index: result.matchIndex,
        created_at: now
      });
      recordId = String(addRes.insertedId);

      // 更新统计（真实数据）
      const evCol = await collection('analytics_events');
      await evCol.insertOne({ event: 'test_completed', user_id: openid, record_id: recordId, created_at: now });
    } catch (dbErr) {
      console.warn('[match] 数据库写入失败（不影响匹配结果返回）:', dbErr.message);
    }
  }

  // 5. 组装返回（注意：不返回完整 ranked，防止遍历出全部人物分数）
  return ok({
    record_id: recordId,
    scope,
    dimension_scores: scores,
    matched: {
      character_id: result.matched.character_id,
      name: result.matched.name,
      gender: result.matched.gender,
      category: result.matched.category,
      personality_summary: result.matched.personality_summary,
      personality_tags: result.matched.personality_tags,
      thinking_style: result.matched.thinking_style,
      action_style: result.matched.action_style,
      social_style: result.matched.social_style,
      emotional_style: result.matched.emotional_style,
      values: result.matched.values,
      strengths: result.matched.strengths,
      weaknesses: result.matched.weaknesses,
      five_factor_scores: result.matched.five_factor_scores,
      character_bio: result.matched.character_bio,
      source_work: result.matched.source_work,
      era: result.matched.era,
      image_url: result.matched.image_url,
      match_index: result.matchIndex,
      match_distance: result.distance,
      explanation
    }
  });
}

/** 前端不需要 design_note，剥离减小包体 */
function stripDesignNote(q) {
  const { design_note, ...rest } = q;
  return rest;
}

function ok(data) { return { success: true, data }; }
function fail(code, message) { return { success: false, code, message }; }
