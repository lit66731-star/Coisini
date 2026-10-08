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

   当前阶段：骨架（数据模型 + 面板壳 + 每角色持久化）。
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
const VERSION = '0.1.0'; // 面板标题旁展示，更新时与 manifest.json 同步

// ---------------- 图标（线性极简：人格核心 = 核 + 恒定轨道） ----------------
const ICONS = {
    core: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="12" cy="12" r="3.4"/><ellipse cx="12" cy="12" rx="9" ry="4.6" transform="rotate(-24 12 12)"/><ellipse cx="12" cy="12" rx="9" ry="4.6" transform="rotate(48 12 12)"/></svg>',
    card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="14" rx="2.5"/><path d="M3.5 9.5h17M8 14h5"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.2-5 3.4 10 2.3-5H21"/></svg>',
    finger: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11a3 3 0 0 0-3 3v3a3 3 0 0 0 5.9.6M12 11a2 2 0 0 0-2 2M12 11a2 2 0 0 1 2 2M12 11V8a2 2 0 0 1 4 0v6M16 14a3 3 0 0 1 5 2.6c0 3-2 4.4-5 4.4H9c-3.5 0-6-2.6-6-6V9a3.5 3.5 0 0 1 7 0"/></svg>',
    grow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V11M10 20V5M16 20v-7M20 20H3"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 14a8 8 0 1 1 16 0"/><path d="M12 14l3.5-3.5"/><circle cx="12" cy="14" r="1.6"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 2.5 20h19L12 3z"/><path d="M12 10v4M12 17.2v.2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

// ---------------- 页签定义（对应框架 §十九 的六个核心页面） ----------------
const PAGES = [
    { id: 'core',       icon: ICONS.core,  name: '人格核心',   code: 'CORE' },
    { id: 'state',      icon: ICONS.pulse, name: '当前状态',   code: 'STATE' },
    { id: 'fingerprint', icon: ICONS.finger, name: '行为指纹', code: 'FINGERPRINT' },
    { id: 'evolution',  icon: ICONS.grow,  name: '人格成长',   code: 'EVOLUTION' },
    { id: 'monitor',    icon: ICONS.gauge, name: '一致性监控', code: 'MONITOR' },
    { id: 'violations', icon: ICONS.alert, name: '异常记录',   code: 'VIOLATIONS' },
];

// ==========================================================================
//  数据模型（框架 §十八 的核心数据结构）
// --------------------------------------------------------------------------
//  说明：
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
            emotion: {},       // 喜悦 / 愤怒 / 悲伤 / 恐惧 / 焦虑 / 羞耻 / 嫉妒 → 强度(0-10)
            psychology: {},    // 信任 / 戒备 / 安全感 / 压力 / 依赖 / 自我评价
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
    return (c && c.name) ? String(c.name) : '（未选择角色）';
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
    if (!s.profiles[id]) s.profiles[id] = defaultProfile();
    return s.profiles[id];
}

function saveProfile() { saveSettingsDebounced(); }

// ==========================================================================
//  面板
// ==========================================================================
function switchPage(name) {
    const panel = $('#st-coisini');
    if (!panel.length) return;
    panel.find('.co__page').removeClass('is-on').filter(`[data-page="${name}"]`).addClass('is-on');
    panel.find('.co__tab').removeClass('is-on').filter(`[data-page="${name}"]`).addClass('is-on');
}

function buildPanel() {
    if ($('#st-coisini').length) return;

    const tabs = PAGES.map((p, i) => `
        <button type="button" class="co__tab${i === 0 ? ' is-on' : ''}" data-page="${p.id}" title="${p.name}">
          ${p.icon}<span class="co__tab-label">${p.name}</span>
        </button>`).join('');

    const pages = PAGES.map((p, i) => `
        <section class="co__page${i === 0 ? ' is-on' : ''}" data-page="${p.id}">
          <div class="co__page-head">
            <span class="co__page-code">${p.code}</span>
            <span class="co__page-title">${p.name}</span>
          </div>
          <div class="co__empty">
            <div class="co__empty-msg">系统尚未加载此环节。</div>
            <div class="co__empty-sub">骨架阶段 · 引擎按增量接入</div>
          </div>
        </section>`).join('');

    const html = `
    <div id="st-coisini" class="co" style="display:none">
      <div class="co__head">
        <div class="co__brand">
          <span class="co__brand-icon">${ICONS.core}</span>
          <span class="co__brand-name">COISINI</span>
          <span class="co__brand-ver">v${VERSION}</span>
        </div>
        <div class="co__head-right">
          <div class="co__status"><span class="co__status-dot"></span><span class="co__status-text">STANDBY</span></div>
          <button type="button" class="co__close" title="关闭">${ICONS.close}</button>
        </div>
      </div>

      <div class="co__body">
        <div class="co__profile-bar">
          <span class="co__profile-label">角色</span>
          <span class="co__profile-name" id="co-profile-name">—</span>
        </div>
        <div class="co__pages">${pages}</div>
      </div>

      <div class="co__tabs">${tabs}</div>
    </div>`;
    $('body').append(html);
}

function renderProfileBar() {
    const panel = $('#st-coisini');
    if (!panel.length) return;
    const name = currentCharacterName();
    const hasProfile = Object.prototype.hasOwnProperty.call(getStore().profiles, currentChatId());
    panel.find('#co-profile-name').text(name);
    panel.find('.co__profile-label').text(hasProfile ? '角色 · 已建档' : '角色');
}

function togglePanel(force) {
    const panel = $('#st-coisini');
    if (!panel.length) return;
    const show = force === undefined ? !panel.is(':visible') : force;
    if (show) {
        renderProfileBar();
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
    // 确保 extension_settings 有本扩展的存储槽位，避免首屏 undefined
    getStore();
    buildButton();
    buildPanel();

    const panel = $('#st-coisini');
    panel.find('.co__tab').on('click', function () { switchPage($(this).data('page')); });
    panel.find('.co__close').on('click', () => togglePanel(false));
});

// ST 自动更新扩展后会调用 manifest.hooks.update 指向的这个函数，
// 在这里刷新页面以加载新版本，无需手动刷新。
export function reloadOnUpdate() {
    toastr.info('Coisini 已更新，正在刷新页面以应用新版本...', undefined, { timeOut: 1500 });
    setTimeout(() => location.reload(), 1500);
}
