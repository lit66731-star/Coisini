/* ==========================================================================
   Coisini · 角色人格恒定引擎（Character Consistency Engine）
   --------------------------------------------------------------------------
   定位：防止长篇 RP 中角色随着楼层增加、上下文变长、模型偷懒而发生
         人格漂移、行为退化和严重 OOC。

   核心一句话：
     允许角色成长，但不允许角色在成长的过程中逐渐变成另一个人。

   总循环（框架 §二十）：
     角色卡 → 人格核心 → 人格状态 → 行为指纹 → 开始 RP
       → 当前剧情输入 → 人格状态读取 → 动态人格约束 → AI 生成
       → 一致性审计 → 漂移趋势分析 → 正常/纠偏/重写
       → 行为指纹更新 → 人格状态更新 → 成长事件记录 → 下一轮生成

   当前阶段：骨架（数据模型 + 完整面板 UI + 每角色持久化）。
   引擎各环节（角色卡解析 / 生成前守卫 / 生成后审计 / 漂移检测）按增量逐步接入。
   ========================================================================== */

import { extension_settings } from '../../../extensions.js';
import {
    characters,
    this_chid,
    chat_metadata,
    saveSettingsDebounced,
} from '../../../../script.js';

const extensionName = 'coisini';
const VERSION = '0.1.5'; // 面板标题旁展示，更新时与 manifest.json 同步

// ---------------- 图标（线性极简：人格核心 = 核 + 恒定轨道） ----------------
const ICONS = {
    core: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3.4"/><ellipse cx="12" cy="12" rx="9" ry="4.6" transform="rotate(-24 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4.6" transform="rotate(48 12 12)"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.2-5 3.4 10 2.3-5H21"/></svg>',
    finger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11a3 3 0 0 0-3 3v3a3 3 0 0 0 5.9.6M12 11a2 2 0 0 0-2 2M12 11a2 2 0 0 1 2 2M12 11V8a2 2 0 0 1 4 0v6M16 14a3 3 0 0 1 5 2.6c0 3-2 4.4-5 4.4H9c-3.5 0-6-2.6-6-6V9a3.5 3.5 0 0 1 7 0"/></svg>',
    grow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V11M10 20V5M16 20v-7M20 20H3"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 14a8 8 0 1 1 16 0"/><path d="M12 14l3.5-3.5"/><circle cx="12" cy="14" r="1.6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4M12 17.2v.2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>',
};

// ---------------- 页签定义（对应框架 §十九 的六个核心页面） ----------------
const PAGES = [
    { id: 'core',        icon: ICONS.core,   name: '人格核心',   code: 'CORE' },
    { id: 'state',       icon: ICONS.pulse,  name: '当前状态',   code: 'STATE' },
    { id: 'fingerprint', icon: ICONS.finger, name: '行为指纹',   code: 'FINGERPRINT' },
    { id: 'evolution',   icon: ICONS.grow,   name: '人格成长',   code: 'EVOLUTION' },
    { id: 'monitor',     icon: ICONS.gauge,  name: '一致性监控', code: 'MONITOR' },
    { id: 'violations',  icon: ICONS.alert,  name: '异常记录',   code: 'VIOLATIONS' },
];

// 已知维度的固定键（让状态页 / 指纹页在空数据时也呈现「仪器化」结构，而非一片空白）
const EMOTION_KEYS = ['喜悦', '愤怒', '悲伤', '恐惧', '焦虑', '羞耻', '嫉妒'];
const PSYCH_KEYS = ['信任', '戒备', '安全感', '压力', '依赖', '自我评价'];
const SPEECH_KEYS = ['sentencePattern', 'wordChoice', 'address', 'tone'];
const SPEECH_LABELS = { sentencePattern: '句式', wordChoice: '用词', address: '称呼', tone: '语气' };
const BEHAVIOR_GROUPS = [
    { key: 'emotionExpression', name: '情绪表达', hint: '直接表达 / 间接表达 / 沉默 / 行动表达 / 讽刺 / 回避' },
    { key: 'conflict',          name: '冲突模式', hint: '回避 / 冷处理 / 谈判 / 威胁 / 反击 / 爆发' },
    { key: 'intimacy',          name: '亲密模式', hint: '主动 / 被动 / 克制 / 嘴硬 / 肢体表达 / 语言表达' },
    { key: 'decision',          name: '决策模式', hint: '理性优先 / 情感优先 / 利益优先 / 责任优先' },
];
const LEVEL_META = {
    0: { label: 'L0 · 正常',         cls: 'l0' },
    1: { label: 'L1 · 轻微偏离',      cls: 'l1' },
    2: { label: 'L2 · 明显偏离',      cls: 'l2' },
    3: { label: 'L3 · 严重人格冲突',  cls: 'l3' },
    4: { label: 'L4 · 灾难性 OOC',   cls: 'l4' },
};

// ==========================================================================
//  数据模型（框架 §十八 的核心数据结构）
// --------------------------------------------------------------------------
//  · core —— 人格核心，来自角色卡解析，是人格的「起点」，稳定。
//  · personalityState —— 当前人格状态，随剧情变化（可变）。
//  · behavior —— 行为指纹，滚动统计沉淀出「这个角色实际上怎么表现自己」。
//  · relationships —— 关系系统，角色对「不同的人」行为不同。
//  · evolution —— 人格成长时间线，每次变化都必须带 changeReason（剧情依据）。
//  · context —— 当前场景，判断 OOC 不能脱离场景。
//  · drift —— 漂移检测（最近 N 楼是不是越来越不像自己）。
//  · violations —— 异常记录（OOC 审计结果）。
//
//  TODO（后续增量）：core 应提升为「角色级」作用域（同一角色跨聊天共享），
//  而 personalityState/behavior/evolution 是「聊天级」（随剧情成长）。
//  当前骨架先统一按聊天隔离，避免过早引入迁移成本。
// ==========================================================================
function defaultProfile() {
    return {
        schema: 1,
        createdAt: Date.now(),

        core: {
            identity: { name: '', role: '', background: '', summary: '' },
            traits: [],        // 性格 / 气质 / 思维方式 / 情绪特征 / 社交方式 / 表达方式
            values: [],        // 重视 / 厌恶 / 追求 / 害怕 / 坚持
            principles: [],    // 危险 / 冲突 / 陌生人 / 亲近 / 背叛 / 示爱 / 失败 时的行为原则
            immutable: [],     // Immutable Traits —— 人格锚点，除非强改变事件否则不得漂移
        },

        personalityState: {
            emotion: {},       // 喜悦 / 愤怒 / ... → 强度(0-10)
            psychology: {},    // 信任 / 戒备 / ... → 强度(0-10)
            motivation: { current: '', shortTerm: '', longTerm: '', hidden: '' },
            condition: '',     // 生理/身体状态：疲惫、受伤、醉酒等
        },

        behavior: {
            speech: {
                sentencePattern: [],  // 句式特征
                wordChoice: [],       // 用词特征
                address: [],          // 称呼特征
                tone: [],             // 语气特征
                length: '',           // 说话长度（简短/中等/长篇）
                explain: null,        // 是否喜欢解释
                rhetorical: null,     // 是否喜欢反问
            },
            emotionExpression: [],    // 直接表达 / 间接表达 / 沉默 / 行动表达 / 讽刺 / 回避
            conflict: [],             // 回避 / 冷处理 / 谈判 / 威胁 / 反击 / 爆发
            intimacy: [],             // 主动 / 被动 / 克制 / 嘴硬 / 肢体表达 / 语言表达
            decision: [],             // 理性优先 / 情感优先 / 利益优先 / 责任优先
            baseline: null,           // 长期行为基线（由滚动统计沉淀）
        },

        relationships: {},  // key = 对方标识 → { type, trust, intimacy, dependence, guard,
                            //   respect, hostility, possessiveness, emotion, history:[], keyEvents:[] }

        evolution: {
            changes: [],    // { t, field, delta, reason, source }  source = 第 N 楼（剧情依据）
            causes: [],     // 关键改变事件（强改变事件，可撬动 immutable）
        },

        context: { scene: '', mood: '', updatedAt: 0 },

        drift: { index: 0, level: 'none', trends: [], updatedAt: 0 },

        violations: [],     // { t, level, reason, action, result }
    };
}

// ==========================================================================
//  持久化：按聊天隔离（extension_settings[coisini].profiles[chatId]）
// ==========================================================================
function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

function currentChatId() {
    const c = (this_chid !== undefined && this_chid !== null &&
        Array.isArray(characters) && characters[this_chid]) ? characters[this_chid] : null;
    if (c && c.chat) return String(c.chat);
    if (chat_metadata && chat_metadata.integrity) return String(chat_metadata.integrity);
    return 'chat_' + (this_chid !== undefined && this_chid !== null ? this_chid : 'none');
}

function currentCharacterName() {
    const c = (this_chid !== undefined && this_chid !== null &&
        Array.isArray(characters) && characters[this_chid]) ? characters[this_chid] : null;
    return (c && c.name) ? String(c.name) : '';
}

function getStore() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];
    s.profiles = s.profiles || {};
    return s;
}

function getProfile() {
    const s = getStore();
    const id = currentChatId();
    if (!s.profiles[id]) {
        const p = defaultProfile();
        p.core.identity.name = currentCharacterName();
        s.profiles[id] = p;
    }
    return s.profiles[id];
}

function saveProfile() { saveSettingsDebounced(); }

// ==========================================================================
//  渲染工具
// ==========================================================================
function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
}

function fmtTime(t) {
    if (!t) return '';
    const d = new Date(t);
    const p = n => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 段落卡片：title + 可选副题 + body
function card(title, subtitle, body, cls) {
    return `<section class="co__card${cls ? ' ' + cls : ''}">
      <header class="co__card-head">
        <span class="co__card-title">${title}</span>
        ${subtitle ? `<span class="co__card-sub">${subtitle}</span>` : ''}
      </header>
      <div class="co__card-body">${body}</div>
    </section>`;
}

// 内联空态（比整页空态更具体）
function inlineEmpty(msg) {
    return `<div class="co__inline-empty">${msg}</div>`;
}

// 标签 chip 列表
function chips(arr, emptyMsg, cls) {
    if (!Array.isArray(arr) || !arr.length) return inlineEmpty(emptyMsg);
    return `<div class="co__chips">${arr.map(x => `<span class="co__chip${cls ? ' ' + cls : ''}">${esc(x)}</span>`).join('')}</div>`;
}

// 0-10 强度仪表行
function meterRow(label, value) {
    const v = (value === null || value === undefined || value === '') ? null : Number(value);
    const w = v === null ? 0 : Math.max(0, Math.min(10, v)) * 10;
    const text = v === null ? '—' : v.toFixed(1);
    const cls = v === null ? 'is-null' : '';
    return `<div class="co__meter-row">
      <span class="co__meter-label">${esc(label)}</span>
      <div class="co__meter-track"><div class="co__meter-fill" style="width:${w}%"></div></div>
      <span class="co__meter-val ${cls}">${text}</span>
    </div>`;
}

// 百分比仪表（监控页）
function percentMeter(label, value) {
    const v = (value === null || value === undefined) ? null : Math.round(Number(value));
    const w = v === null ? 0 : Math.max(0, Math.min(100, v));
    const text = v === null ? '—' : v + '%';
    return `<div class="co__meter-row">
      <span class="co__meter-label">${esc(label)}</span>
      <div class="co__meter-track"><div class="co__meter-fill" style="width:${w}%"></div></div>
      <span class="co__meter-val ${v === null ? 'is-null' : ''}">${text}</span>
    </div>`;
}

// ==========================================================================
//  各页渲染（数据驱动：引擎尚未填充时渲染结构化空态，填充后自动呈现）
// ==========================================================================
function renderCore(p) {
    const c = p.core;
    const ident = c.identity || {};
    const identBody = `<dl class="co__kv">
      <div><dt>姓名</dt><dd>${esc(ident.name) || inlineEmpty('未解析')}</dd></div>
      <div><dt>身份 / 角色</dt><dd>${esc(ident.role) || inlineEmpty('未解析')}</dd></div>
      <div><dt>背景</dt><dd>${esc(ident.background) || inlineEmpty('未解析')}</dd></div>
      <div><dt>摘要</dt><dd>${esc(ident.summary) || inlineEmpty('未解析')}</dd></div>
    </dl>`;

    const toolbar = `<div class="co__toolbar">
      <button type="button" class="co__btn co__btn-primary co__parse-card">${ICONS.spark}从角色卡解析人格核心</button>
      <span class="co__toolbar-hint">解析将提取性格 / 价值观 / 行为原则 / 人格锚点（下一增量接入）</span>
    </div>`;

    return toolbar
        + card('身份', '这个人是谁', identBody)
        + card('性格', '性格 / 气质 / 思维方式 / 情绪特征 / 社交方式 / 表达方式', chips(c.traits, '尚未解析，点击上方「从角色卡解析」'))
        + card('价值观', '重视 / 厌恶 / 追求 / 害怕 / 坚持', chips(c.values, '尚未解析'))
        + card('核心行为原则', '危险 / 冲突 / 陌生人 / 亲近 / 背叛 / 示爱 / 失败 时怎么做', chips(c.principles, '尚未解析'))
        + card('不可漂移项 · 人格锚点', '除非出现足够强的改变事件，否则不得自然漂移', chips(c.immutable, '尚未设定人格锚点', 'is-anchor'));
}

function hasAny(obj) {
    return Object.keys(obj || {}).some(k => obj[k] !== undefined && obj[k] !== null && obj[k] !== '');
}

function renderState(p) {
    const st = p.personalityState;
    const emotion = st.emotion || {};
    const psych = st.psychology || {};
    const mot = st.motivation || {};

    // 情绪/心理：有数据才渲染仪表，空态只给一行说明，避免一排空进度条显得乱
    const emotionBody = hasAny(emotion)
        ? EMOTION_KEYS.filter(k => emotion[k] !== undefined && emotion[k] !== null && emotion[k] !== '')
            .map(k => meterRow(k, emotion[k])).join('')
        : inlineEmpty('暂无情绪快照 · 开始 RP 后采样');
    const psychBody = hasAny(psych)
        ? PSYCH_KEYS.filter(k => psych[k] !== undefined && psych[k] !== null && psych[k] !== '')
            .map(k => meterRow(k, psych[k])).join('')
        : inlineEmpty('暂无心理快照 · 开始 RP 后采样');
    const motBody = `<dl class="co__kv">
      <div><dt>当前目标</dt><dd>${esc(mot.current) || inlineEmpty('暂无')}</dd></div>
      <div><dt>短期目标</dt><dd>${esc(mot.shortTerm) || inlineEmpty('暂无')}</dd></div>
      <div><dt>长期目标</dt><dd>${esc(mot.longTerm) || inlineEmpty('暂无')}</dd></div>
      <div><dt>隐藏目标</dt><dd>${esc(mot.hidden) || inlineEmpty('暂无')}</dd></div>
    </dl>`;

    return card('情绪', '当前情绪强度（0–10）', emotionBody)
        + card('心理', '信任 / 戒备 / 安全感 / 压力 / 依赖 / 自我评价', psychBody)
        + card('动机', '当前 / 短期 / 长期 / 隐藏目标', motBody)
        + card('身体状况', '疲惫、受伤、醉酒等生理状态', esc(st.condition) ? esc(st.condition) : inlineEmpty('暂无记录'));
}

function renderFingerprint(p) {
    const b = p.behavior;
    const sp = b.speech || {};

    const speechChips = SPEECH_KEYS.map(k => `
        <div class="co__fp-line">
          <span class="co__fp-line-name">${SPEECH_LABELS[k]}</span>
          ${chips(sp[k], '未采样', '')}
        </div>`).join('');
    const speechMeta = `<div class="co__chips">
      ${sp.length ? `<span class="co__chip">说话长度：${esc(sp.length)}</span>` : ''}
      ${typeof sp.explain === 'boolean' ? `<span class="co__chip">${sp.explain ? '习惯解释' : '不习惯解释'}</span>` : ''}
      ${typeof sp.rhetorical === 'boolean' ? `<span class="co__chip">${sp.rhetorical ? '习惯反问' : '不习惯反问'}</span>` : ''}
    </div>`;

    const groups = BEHAVIOR_GROUPS.map(g => card(g.name, g.hint, chips(b[g.key], '未采样，开始 RP 后统计'))).join('');

    return card('语言', '句式 / 用词 / 称呼 / 语气 / 说话长度 / 解释 / 反问', speechChips + speechMeta)
        + groups;
}

function renderEvolution(p) {
    const changes = (p.evolution && p.evolution.changes) || [];
    if (!changes.length) {
        return inlineEmpty('暂无成长记录。人格变化必须由剧情事件驱动，产生后会出现在这里（字段 · 变化 · 原因 · 来源楼层）。');
    }
    const items = changes.slice().reverse().map(c => `
      <li class="co__evo-item">
        <span class="co__evo-time">${fmtTime(c.t)}</span>
        <span class="co__evo-field">${esc(c.field)}</span>
        <span class="co__evo-delta ${String(c.delta).startsWith('-') ? 'is-down' : 'is-up'}">${esc(c.delta)}</span>
        <span class="co__evo-reason">${esc(c.reason)}</span>
        <span class="co__evo-source">${esc(c.source)}</span>
      </li>`).join('');
    return `<ul class="co__evo-list">${items}</ul>`;
}

function renderMonitor(p) {
    const drift = p.drift || {};
    const driftIndex = (drift.index === null || drift.index === undefined) ? null : Number(drift.index);
    const stability = driftIndex === null ? null : Math.max(0, Math.min(100, 100 - driftIndex));

    const driftLevels = { none: '无漂移', low: '低', mid: '中', high: '高' };
    const driftLevel = driftLevels[drift.level] || '无数据';

    const bigGauge = `
      <div class="co__gauge-card">
        <div class="co__gauge-big">
          <div class="co__gauge-ring" style="--p:${stability === null ? 0 : stability}">
            <div class="co__gauge-center">
              <span class="co__gauge-num">${stability === null ? '—' : stability + '%'}</span>
              <span class="co__gauge-cap">人格稳定度</span>
            </div>
          </div>
        </div>
        <div class="co__gauge-meta">
          <div class="co__gauge-row"><span>人格漂移指数</span><b>${driftIndex === null ? '—' : driftIndex + '%'}</b></div>
          <div class="co__gauge-row"><span>漂移等级</span><b>${driftLevel}</b></div>
          <div class="co__gauge-row"><span>趋势</span><b>${(drift.trends && drift.trends.length) ? drift.trends.length + ' 项' : '无'}</b></div>
        </div>
      </div>`;

    const trends = (drift.trends && drift.trends.length)
        ? drift.trends.map(t => `<div class="co__trend">⚠ ${esc(t)}</div>`).join('')
        : inlineEmpty('暂无漂移趋势。开始 RP 后跨楼层对比「短期 / 中期 / 长期行为」与「人格基线」。');

    // 一致性指标：字段尚未在数据模型落地，骨架阶段给一行干净说明；采样接入后再渲染成仪表
    const consistency = drift.consistency || {};
    const meters = hasAny(consistency)
        ? percentMeter('语言一致性', consistency.language)
            + percentMeter('行为一致性', consistency.behavior)
            + percentMeter('关系一致性', consistency.relationship)
            + percentMeter('价值观一致性', consistency.value)
        : inlineEmpty('语言 / 行为 / 关系 / 价值观一致性在行为基线建立后统计（下一增量接入采样）。');

    return bigGauge
        + card('一致性指标', '语言 / 行为 / 关系 / 价值观', meters)
        + card('漂移趋势', '在角色彻底 OOC 之前拦截', trends);
}

function renderViolations(p) {
    const list = p.violations || [];
    if (!list.length) return inlineEmpty('暂无异常记录。生成后审计发现的偏离会按 L0–L4 分级记录在这里。');
    const items = list.slice().reverse().map(v => {
        const meta = LEVEL_META[v.level] || { label: 'L' + v.level, cls: '' };
        return `<li class="co__vio-item">
          <span class="co__vio-badge ${meta.cls}">${meta.label}</span>
          <div class="co__vio-body">
            <div class="co__vio-reason">${esc(v.reason)}</div>
            <div class="co__vio-meta">
              ${v.action ? `<span>处理：${esc(v.action)}</span>` : ''}
              ${v.result ? `<span>结果：${esc(v.result)}</span>` : ''}
              <span>${fmtTime(v.t)}</span>
            </div>
          </div>
        </li>`;
    }).join('');
    return `<ul class="co__vio-list">${items}</ul>`;
}

// ==========================================================================
//  面板
// ==========================================================================
function renderAll() {
    const panel = $('#st-coisini');
    if (!panel.length) return;
    const p = getProfile();
    panel.find('.co__pane[data-pane="core"]').html(renderCore(p));
    panel.find('.co__pane[data-pane="state"]').html(renderState(p));
    panel.find('.co__pane[data-pane="fingerprint"]').html(renderFingerprint(p));
    panel.find('.co__pane[data-pane="evolution"]').html(renderEvolution(p));
    panel.find('.co__pane[data-pane="monitor"]').html(renderMonitor(p));
    panel.find('.co__pane[data-pane="violations"]').html(renderViolations(p));

    // 顶栏角色名 / 页签角标
    panel.find('.co__char-name').text(currentCharacterName() || '未选择角色');
    const vcount = (p.violations || []).length;
    const vtab = panel.find('.co__tab[data-pane="violations"] .co__tab-badge');
    vtab.text(vcount ? vcount : '').toggle(vcount > 0);
}

function switchTab(name) {
    const panel = $('#st-coisini');
    if (!panel.length) return;
    panel.find('.co__pane').removeClass('is-on').filter(`[data-pane="${name}"]`).addClass('is-on');
    panel.find('.co__tab').removeClass('is-on').filter(`[data-pane="${name}"]`).addClass('is-on');
}

function buildPanel() {
    if ($('#st-coisini').length) return;

    const tabs = PAGES.map((p, i) => `
        <button type="button" class="co__tab${i === 0 ? ' is-on' : ''}" data-pane="${p.id}" title="${p.name}">
          ${p.icon}<span class="co__tab-label">${p.name}</span><span class="co__tab-badge"></span>
        </button>`).join('');

    const panes = PAGES.map((p, i) => `
        <section class="co__pane${i === 0 ? ' is-on' : ''}" data-pane="${p.id}"></section>`).join('');

    const html = `
    <div id="st-coisini" class="co" style="display:none">
      <header class="co__head">
        <div class="co__brand">
          <span class="co__brand-icon">${ICONS.core}</span>
          <span class="co__brand-name">Coisini</span>
          <span class="co__brand-ver">v${VERSION}</span>
        </div>
        <div class="co__head-right">
          <span class="co__char-name">—</span>
          <button type="button" class="co__close" title="关闭">${ICONS.close}</button>
        </div>
      </header>

      <nav class="co__tabs">${tabs}</nav>

      ${panes}
    </div>`;
    $('body').append(html);
}

function togglePanel(force) {
    const panel = $('#st-coisini');
    if (!panel.length) return;
    const show = force === undefined ? !panel.is(':visible') : force;
    if (show) {
        renderAll();
        panel.show();
    } else {
        panel.hide();
    }
    document.body.classList.toggle('st-coisini-open', show);
}

// ---------------- 顶栏入口按钮 ----------------
function buildButton() {
    const btn = $(`
        <div id="st-coisini-button" class="drawer" title="Coisini · 角色人格恒定引擎" tabindex="0" role="button">
            <div class="drawer-icon fa-solid fa-fingerprint fa-fw closedIcon interactable" title="Coisini"></div>
        </div>`);
    btn.on('click', () => togglePanel());
    const anchor = $('#ai-config-button');
    if (anchor.length) anchor.after(btn);
    else {
        const holder = $('#top-settings-holder');
        if (holder.length) holder.append(btn);
        else {
            const menu = $('#extensionsMenu');
            if (menu.length) menu.append(btn);
            else $('body').append(btn);
        }
    }
}

// ---------------- 初始化 ----------------
jQuery(() => {
    getStore();
    buildButton();
    buildPanel();

    const panel = $('#st-coisini');
    panel.find('.co__tab').on('click', function () { switchTab($(this).data('pane')); });
    panel.find('.co__close').on('click', () => togglePanel(false));
    panel.on('click', '.co__parse-card', function () {
        // 角色卡解析 = 下一增量的入口；此处先做真实可用的最小动作：写入姓名
        const p = getProfile();
        p.core.identity.name = currentCharacterName();
        saveProfile();
        renderAll();
        toastr.info('已写入当前角色姓名；完整人格解析（性格/价值观/行为原则/人格锚点）将在下一增量接入。', undefined, { timeOut: 3000 });
    });
});

// ST 自动更新扩展后会调用 manifest.hooks.update 指向的这个函数，
// 在这里刷新页面以加载新版本，无需手动刷新。
export function reloadOnUpdate() {
    toastr.info('Coisini 已更新，正在刷新页面以应用新版本...', undefined, { timeOut: 1500 });
    setTimeout(() => location.reload(), 1500);
}
