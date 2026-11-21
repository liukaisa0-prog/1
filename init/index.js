// init/index.js — 一次性初始化端点（POST /api/init，幂等可重复执行）
// 移植自微信版 initData 云函数：清空种子集合后导入人物库 + 题库。
// 说明：match 端点的计分/匹配直接用函数内 JSON（不依赖这两个集合）；
//       此端点保留是为了与微信版数据职责对齐（人物详情等页面如需读集合时可用）。
'use strict';

const maleChars = require('./data/characters-male.json');
const femaleChars = require('./data/characters-female.json');
const questions = require('./data/questions.json');
const { getDb } = require('../common/db');

module.exports = async () => {
  const stats = { characters: 0, questions: 0, errors: [] };
  try {
    const db = await getDb();

    // 1. 人物集合（先清空再导入，幂等）
    const allChars = [...maleChars, ...femaleChars];
    await db.collection('characters').deleteMany({});
    for (let i = 0; i < allChars.length; i += 10) {
      const batch = allChars.slice(i, i + 10);
      await db.collection('characters').insertMany(batch);
      stats.characters += batch.length;
    }

    // 2. 题目集合
    await db.collection('questions').deleteMany({});
    const enabledQuestions = questions.filter(q => q.enabled);
    await db.collection('questions').insertMany(enabledQuestions);
    stats.questions = enabledQuestions.length;

    return { success: true, data: stats };
  } catch (e) {
    console.error('[init] 初始化失败:', e);
    stats.errors.push(e.message);
    return { success: false, code: 'INTERNAL', message: e.message, detail: stats };
  }
};
