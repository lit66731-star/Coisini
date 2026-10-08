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

   当前阶段：数据模型 + 全屏档案面板 + 每角色持久化 + 角色卡解析（规则版 +
   LLM 精炼：价值观 / 行为原则 / 人格锚点）。
   引擎其余环节（生成前守卫 / 生成后审计 / 漂移检测）按增量逐步接入。
   ========================================================================== */

import { extension_settings } from '../../../extensions.js';
import {
    characters,
    this_chid,
    chat_metadata,
    saveSettingsDebounced,
} from '../../../../script.js';

const extensionName = 'coisini';
const VERSION = '0.3.4'; // 面板标题旁展示，更新时与 manifest.json 同步

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

function currentCharacter() {
    return (this_chid !== undefined && this_chid !== null &&
        Array.isArray(characters) && characters[this_chid]) ? characters[this_chid] : null;
}

function currentChatId() {
    const c = currentCharacter();
    if (c && c.chat) return String(c.chat);
    if (chat_metadata && chat_metadata.integrity) return String(chat_metadata.integrity);
    return 'chat_' + (this_chid !== undefined && this_chid !== null ? this_chid : 'none');
}

function currentCharacterName() {
    const c = currentCharacter();
    return (c && c.name) ? String(c.name) : '';
}

function getStore() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    const s = extension_settings[extensionName];
    s.profiles = s.profiles || {};
    s.api = s.api || {};
    return s;
}

function getProfile() {
    const s = getStore();
    const id = currentChatId();
    if (!s.profiles[id]) {
        const p = defaultProfile();
        const c = currentCharacter();
        if (c) {
            p.core.identity.name = c.name || '';
            const personality = c.personality || (c.data && c.data.personality) || '';
            p.core.traits = splitTraits(personality);
        }
        s.profiles[id] = p;
    }
    return s.profiles[id];
}

function saveProfile() { saveSettingsDebounced(); }

// ==========================================================================
//  角色卡解析（规则版）→ 建立人格核心
// --------------------------------------------------------------------------
//  从角色卡提取「身份 + 性格标签」；价值观 / 行为原则 / 人格锚点需要模型
//  理解语义，留到后续增量接 LLM 精炼。此处先把「卡 → 核心」的管线建起来。
// ==========================================================================
function splitTraits(str) {
    if (!str) return [];
    const seen = new Set();
    const out = [];
    for (let raw of String(str).split(/[，,、；;|/\n\r]+/)) {
        const t = raw.replace(/^[\s：:·]+|[\s。.!！?？]+$/g, '').trim();
        if (!t || t.length > 30 || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

function parseCharacterCard() {
    const c = currentCharacter();
    if (!c) {
        toastr.warning('请先选择一个角色。', undefined, { timeOut: 2500 });
        return;
    }
    const p = getProfile();
    p.core.identity.name = c.name || '';

    // 身份摘要：取描述首段（压缩空白，截前 200 字）
    const desc = String(c.description || '').trim();
    if (desc) {
        const firstPara = desc.split(/\n\s*\n/)[0];
        p.core.identity.summary = firstPara.replace(/\s+/g, ' ').slice(0, 200);
    }

    // 性格标签：解析 personality 字段
    const personality = c.personality || (c.data && c.data.personality) || '';
    p.core.traits = splitTraits(personality);

    saveProfile();
    renderAll();
    const summaryNote = p.core.identity.summary ? ' + 身份摘要' : '';
    toastr.info(`已解析人格核心：${p.core.traits.length} 个性格标签${summaryNote}。价值观 / 行为原则 / 人格锚点可用「LLM 精炼」补全。`, undefined, { timeOut: 3500 });
}

// ==========================================================================
//  插件 API（独立 url/key/model，绝不回退到聊天 API —— 与 Serendipity 同一原则）
// --------------------------------------------------------------------------
//  参考 Serendipity 的思路：精炼引擎走插件自带 API，未配置就直接报错，
//  不偷用酒馆的聊天 API，避免把人格分析请求混进正常生成。
// ==========================================================================
function getApiCfg() {
    return getStore().api || {};
}
function apiConfigured() {
    const c = getApiCfg();
    return !!(c.url && c.model);
}
function apiEndpoint(url) {
    url = String(url || '').trim().replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(url)) return url;
    return url + '/chat/completions';
}
// 抹掉可能出现在报错里的密钥（报错会进 toast / 控制台，可能被截图转发）
function redactSecrets(text, key) {
    let t = String(text == null ? '' : text);
    const k = String(key || '').trim();
    if (k.length >= 6) t = t.split(k).join('***');
    return t
        .replace(/Bearer\s+[A-Za-z0-9._~+\/=-]{6,}/gi, 'Bearer ***')
        .replace(/\b(sk|rk|pk|ak)-[A-Za-z0-9_*-]{6,}/gi, '$1-***')
        .replace(/([?&](?:key|api[_-]?key|token|access_token)=)[^&\s"']+/gi, '$1***')
        .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*"?)[A-Za-z0-9._~+\/=-]{8,}/gi, '$1***');
}
function safeErrorText(e, key, max) {
    const raw = (e && e.message) ? e.message : e;
    const t = redactSecrets(raw, key).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const m = max || 120;
    return t.length > m ? t.slice(0, m) + '…' : t;
}
// 判断模型返回的是不是「内容安全策略拒绝」而非正常 JSON（如 Google/Gemini 的
// Prohibited Use Policy 拦截，返回的是一段自然语言报错）
function looksLikeRefusal(text) {
    const t = String(text || '');
    return /could not be submitted|prohibited use policy|content policy|violate|violates|safety settings|blocked|I cannot|I can't|无法提交|违反.*政策|内容安全|安全策略|被拦截|敏感词/i.test(t);
}
const LLM_TIMEOUT_MS = 120000; // 单次模型调用上限，防止请求挂起
async function callApi({ prompt, systemPrompt, cfg, jsonMode }) {
    const c = cfg || getApiCfg();
    const headers = { 'Content-Type': 'application/json' };
    if (c.key) headers.Authorization = 'Bearer ' + String(c.key).trim();
    const messages = [];
    // 附加 system 提示词（如破甲 / 越狱）拼在最前，让自定义约束先于本插件的分析指令生效
    let sys = systemPrompt || '';
    if (c.extraPrompt && String(c.extraPrompt).trim()) {
        sys = String(c.extraPrompt).trim() + (sys ? '\n\n' + sys : '');
    }
    if (sys) messages.push({ role: 'system', content: sys });
    messages.push({ role: 'user', content: prompt });

    // jsonMode：请求模型强制输出 JSON（response_format）。部分兼容端点不支持该字段会 400，
    // 此时去掉 response_format 再试一次，保证兼容性。
    const base = { model: String(c.model).trim(), messages, stream: false };
    const payloads = jsonMode
        ? [{ ...base, response_format: { type: 'json_object' } }, base]
        : [base];

    let res;
    for (let i = 0; i < payloads.length; i++) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
        try {
            res = await fetch(apiEndpoint(c.url), {
                method: 'POST',
                headers,
                body: JSON.stringify(payloads[i]),
                signal: ctrl.signal,
            });
        } catch (e) {
            clearTimeout(timer);
            if (e && e.name === 'AbortError') throw new Error('请求超时（' + Math.round(LLM_TIMEOUT_MS / 1000) + ' 秒）');
            throw new Error(safeErrorText(e, c.key) || '网络请求失败');
        }
        clearTimeout(timer);
        // 首拍被 response_format 拒绝（HTTP 400）→ 去掉后重试一次
        if (i === 0 && payloads.length > 1 && res.status === 400) {
            await res.text().catch(() => {});
            continue;
        }
        break;
    }
    if (!res.ok) {
        const t = await res.text().catch(() => '');
        const detail = safeErrorText(t, c.key);
        throw new Error('HTTP ' + res.status + (detail ? ' ' + detail : ''));
    }
    const d = await res.json();
    const out = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (!out) throw new Error('返回内容为空');
    return out;
}

// ==========================================================================
//  角色卡解析（LLM 精炼）→ 补全价值观 / 行为原则 / 人格锚点
// --------------------------------------------------------------------------
//  规则版只拿得到「身份摘要 + 性格标签」；价值观、行为原则、人格锚点需要
//  理解语义，交给模型提炼。这里把整张卡喂给插件 API，要求返回结构化 JSON。
// ==========================================================================
function normList(arr, max) {
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    const out = [];
    for (const x of arr) {
        const t = String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
        if (!t || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
        if (out.length >= (max || 40)) break;
    }
    return out;
}

function buildCardText(c) {
    // 只送「身份定义」字段：描述 + 性格。scenario / first_mes 是开场剧情而非人格，
    // 成人卡里这两个字段最容易触发内容安全拦截，故默认不送（后续可按需加回）。
    const parts = [];
    if (c.name) parts.push('姓名：' + String(c.name).trim());
    const desc = String(c.description || '').trim();
    if (desc) parts.push('角色描述：\n' + desc);
    const personality = c.personality || (c.data && c.data.personality) || '';
    if (personality) parts.push('性格（personality）：\n' + String(personality).trim());
    return parts.join('\n\n');
}

function parseJsonLoose(text) {
    if (!text) return null;
    const t = String(text).trim();

    // 1) 直接解析 / 剥掉首尾 ``` 代码块后解析（可能夹带语言标识或前后废话）
    const candidates = [t];
    candidates.push(t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/, ''));
    const fenced = t.match(/```[a-zA-Z]*\s*([\s\S]*?)\s*```/);
    if (fenced) candidates.push(fenced[1].trim());

    for (const cand of candidates) {
        if (!cand) continue;
        try { return JSON.parse(cand); } catch (e) { /* 换下一种 */ }
    }

    // 2) 提取「第一个 { 到最后一个 }」的平衡区间（正确处理嵌套、字符串内的括号）
    const sub = extractBalancedBraces(t);
    if (sub) {
        try { return JSON.parse(sub); } catch (e) { /* 仍失败则返回 null */ }
    }
    return null;
}

// 扫描文本，返回从第一个 '{' 开始、到与之配对的最后一个 '}' 为止的子串；无则 null
function extractBalancedBraces(text) {
    let start = -1, depth = 0, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (ch === '\\') esc = true;
            else if (ch === '"') inStr = false;
            continue;
        }
        if (ch === '"') { inStr = true; continue; }
        if (ch === '{') {
            if (depth === 0) start = i;
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0 && start >= 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

// 合并两组短语（去重、去空、去首尾空白），保留已有在前、新增在后
function mergeList(base, add) {
    const seen = new Set();
    const out = [];
    const push = arr => {
        for (const x of (arr || [])) {
            const t = String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
            if (t && !seen.has(t)) { seen.add(t); out.push(t); }
        }
    };
    push(base);
    push(add);
    return out;
}

async function refineCore() {
    if (!apiConfigured()) {
        toastr.warning('请先在下方「插件 API」配置并保存 url / 模型（不会回退到聊天 API）。', undefined, { timeOut: 3500 });
        return;
    }
    const c = currentCharacter();
    if (!c) {
        toastr.warning('请先选择一个角色。', undefined, { timeOut: 2500 });
        return;
    }
    const cardText = buildCardText(c);
    if (!cardText.trim()) {
        toastr.warning('当前角色卡没有可解析的文本。', undefined, { timeOut: 2500 });
        return;
    }

    const systemPrompt = [
        '你是角色人格分析师。你从角色卡中提取稳定的「人格核心」，用于防止长篇角色扮演中角色逐渐变成另一个人。',
        '只输出一个 JSON 对象，第一个字符必须是 {，不要任何解释、不要 Markdown 代码块、不要额外文字。',
        '忠实于角色卡：卡里没写的不要凭空编造，宁缺毋滥。',
    ].join('\n');

    const prompt = [
        '下面是一张角色卡，请提炼人格核心，按指定 JSON 结构输出：',
        '',
        cardText,
        '',
        'JSON 结构（数组每项用简短中文短语）：',
        '{',
        '  "identity": { "role": "角色在故事中的身份/职业/地位（一句话；卡里没有就写空字符串 \"\"）", "background": "角色背景（2–4 句概括；卡里没有就写空字符串 \"\"）" },',
        '  "traits": ["性格 / 气质 / 思维方式 / 情绪特征 / 社交方式 / 表达方式，6–15 项短语"],',
        '  "values": ["重视的", "厌恶的", "追求的", "害怕的", "坚持的"],',
        '  "principles": ["遇到危险时：…", "面对冲突时：…", "面对陌生人时：…", "面对亲近的人时：…", "被背叛时：…", "被示爱时：…", "面对失败时：…"],',
        '  "immutable": ["绝对不可漂移的人格锚点：身份认知 / 核心欲望 / 底线 / 说话方式等，除非极强改变事件否则永远不变，3–6 项"]',
        '}',
        '',
        '要求：',
        '1. identity.role / identity.background 若卡里没有明确信息，写空字符串 ""。',
        '2. traits / values / principles / immutable 是短语列表，不要写成长段落。',
        '3. immutable 只放最关键、最不能变的锚点，不要与 values 重复。',
    ].join('\n');

    const btn = $('.co__refine-core');
    if (btn.length) btn.prop('disabled', true);
    try {
        const raw = await callApi({ prompt, systemPrompt, jsonMode: true });
        const obj = parseJsonLoose(raw);
        if (!obj || typeof obj !== 'object') {
            if (looksLikeRefusal(raw)) {
                toastr.error('精炼失败：模型（疑似 Google/Gemini）因内容安全策略拒绝了这张角色卡。请把「插件 API」换成与你的 RP 聊天相同、能接受该内容的提供商 / 模型——Coisini 用独立 API，绝不回退聊天 API。', undefined, { timeOut: 9000 });
                return;
            }
            const preview = safeErrorText(raw, getApiCfg().key, 180);
            throw new Error('模型返回无法解析为 JSON（返回片段：' + preview + '）');
        }
        const p = getProfile();
        if (obj.identity && typeof obj.identity === 'object') {
            if (typeof obj.identity.role === 'string' && obj.identity.role.trim()) p.core.identity.role = obj.identity.role.trim();
            if (typeof obj.identity.background === 'string' && obj.identity.background.trim()) p.core.identity.background = obj.identity.background.trim();
        }
        if (obj.traits !== undefined) p.core.traits = mergeList(p.core.traits, normList(obj.traits));
        if (obj.values !== undefined) p.core.values = normList(obj.values);
        if (obj.principles !== undefined) p.core.principles = normList(obj.principles);
        if (obj.immutable !== undefined) p.core.immutable = normList(obj.immutable, 20);
        saveProfile();
        renderAll();
        toastr.info(`已精炼人格核心：性格 ${p.core.traits.length} · 价值观 ${p.core.values.length} · 行为原则 ${p.core.principles.length} · 锚点 ${p.core.immutable.length}`, undefined, { timeOut: 3500 });
    } catch (e) {
        toastr.error('精炼失败：' + safeErrorText(e, getApiCfg().key), undefined, { timeOut: 8000 });
    } finally {
        if (btn.length) btn.prop('disabled', false);
    }
}

// 读取 API 配置表单（供保存 / 测试用，测试不落盘，好让用户先试后存）
function readApiInputs() {
    const panel = $('#st-coisini');
    return {
        url: String(panel.find('.co__api-url').val() || '').trim(),
        model: String(panel.find('.co__api-model').val() || '').trim(),
        key: String(panel.find('.co__api-key').val() || '').trim(),
        extraPrompt: String(panel.find('.co__api-extra').val() || '').trim(),
    };
}
function saveApiConfig() {
    const v = readApiInputs();
    if (!v.url || !v.model) {
        toastr.warning('请填写 API 地址与模型。', undefined, { timeOut: 2500 });
        return;
    }
    getStore().api = { url: v.url, model: v.model, key: v.key, extraPrompt: v.extraPrompt };
    saveProfile();
    renderAll();
    toastr.info('插件 API 已保存。', undefined, { timeOut: 2000 });
}
function clearApiConfig() {
    getStore().api = {};
    saveProfile();
    renderAll();
    toastr.info('插件 API 已清空。', undefined, { timeOut: 2000 });
}
async function testApi() {
    const v = readApiInputs();
    if (!v.url || !v.model) {
        toastr.warning('请先填写 API 地址与模型。', undefined, { timeOut: 2500 });
        return;
    }
    const cfg = { url: v.url, model: v.model, key: v.key, extraPrompt: v.extraPrompt };
    const btn = $('.co__api-test');
    if (btn.length) btn.prop('disabled', true);
    try {
        await callApi({ prompt: '请只回复两个汉字：正常', systemPrompt: '你是连通性测试。', cfg });
        toastr.success('连接成功，模型可用。', undefined, { timeOut: 2500 });
    } catch (e) {
        toastr.error('测试失败：' + safeErrorText(e, cfg.key), undefined, { timeOut: 6000 });
    } finally {
        if (btn.length) btn.prop('disabled', false);
    }
}

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
      <button type="button" class="co__btn co__parse-card">${ICONS.spark}从角色卡解析（规则）</button>
      <button type="button" class="co__btn co__btn-primary co__refine-core">${ICONS.core}LLM 精炼人格核心</button>
      <span class="co__toolbar-hint">规则版提取身份摘要 + 性格标签；LLM 精炼补全价值观 / 行为原则 / 人格锚点</span>
    </div>`;

    return toolbar
        + card('身份', '这个人是谁', identBody)
        + card('性格', '性格 / 气质 / 思维方式 / 情绪特征 / 社交方式 / 表达方式', chips(c.traits, '尚未解析，点击上方「从角色卡解析」'))
        + card('价值观', '重视 / 厌恶 / 追求 / 害怕 / 坚持', chips(c.values, '尚未解析，点「LLM 精炼人格核心」补全'))
        + card('核心行为原则', '危险 / 冲突 / 陌生人 / 亲近 / 背叛 / 示爱 / 失败 时怎么做', chips(c.principles, '尚未解析，点「LLM 精炼人格核心」补全'))
        + card('不可漂移项 · 人格锚点', '除非出现足够强的改变事件，否则不得自然漂移', chips(c.immutable, '尚未设定人格锚点，点「LLM 精炼人格核心」补全', 'is-anchor'))
        + renderApiConfig();
}

function renderApiConfig() {
    const cfg = getApiCfg();
    const configured = apiConfigured();
    const statusText = configured ? '已配置' : '未配置';
    return card('插件 API · 精炼引擎', '独立 url / key / model，绝不回退到聊天 API', `
      <div class="co__api-grid">
        <div class="co__field co__field-span">
          <span class="co__field-label">API 地址（url）</span>
          <input class="co__input co__api-url" type="text" placeholder="https://…（可填到 /v1 或 /chat/completions）" value="${esc(cfg.url || '')}" autocomplete="off" spellcheck="false">
        </div>
        <div class="co__field">
          <span class="co__field-label">模型（model）</span>
          <input class="co__input co__api-model" type="text" placeholder="如 deepseek-chat" value="${esc(cfg.model || '')}" autocomplete="off" spellcheck="false">
        </div>
        <div class="co__field">
          <span class="co__field-label">密钥（key，可选）</span>
          <input class="co__input co__api-key" type="password" placeholder="sk-…" value="${esc(cfg.key || '')}" autocomplete="off" spellcheck="false">
        </div>
        <div class="co__field co__field-span">
          <span class="co__field-label">附加 System 提示词（破甲 / 越狱 / 自定义，可选）</span>
          <textarea class="co__input co__textarea co__api-extra" placeholder="粘贴你的破甲提示词，会拼在人格分析指令之前（与聊天预设里那段一致即可）" autocomplete="off" spellcheck="false">${esc(cfg.extraPrompt || '')}</textarea>
        </div>
      </div>
      <div class="co__api-actions">
        <button type="button" class="co__btn co__api-save">保存</button>
        <button type="button" class="co__btn co__api-test">测试连接</button>
        <button type="button" class="co__btn co__api-clear">清空</button>
        <span class="co__api-status${configured ? ' is-ok' : ''}">${statusText}</span>
      </div>`);
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
        parseCharacterCard();
    });
    panel.on('click', '.co__refine-core', function () {
        refineCore();
    });
    panel.on('click', '.co__api-save', function () {
        saveApiConfig();
    });
    panel.on('click', '.co__api-test', function () {
        testApi();
    });
    panel.on('click', '.co__api-clear', function () {
        clearApiConfig();
    });
});

// ST 自动更新扩展后会调用 manifest.hooks.update 指向的这个函数，
// 在这里刷新页面以加载新版本，无需手动刷新。
export function reloadOnUpdate() {
    toastr.info('Coisini 已更新，正在刷新页面以应用新版本...', undefined, { timeOut: 1500 });
    setTimeout(() => location.reload(), 1500);
}
