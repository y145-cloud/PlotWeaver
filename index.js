/**
 * Plot Weaver / 伏笔导演
 * 长期剧情节奏控制扩展 for SillyTavern
 *
 * 设计要点：
 * 1) 绝不修改消息文本，也不依赖任何正则；每个回合只往提示词里注入一段“随进度变化”的导演指令。
 * 2) 目标与进度写在当前聊天的 chat_metadata 里，因此刷新、切楼、上百楼都不会丢失。
 * 3) 根据“已走楼层 / 总跨度”自动分阶段（起念→酝酿→推进→临门→触发），越接近目标越催，
 *    但每个阶段的措辞都会明确禁止 AI 提前把剧情点写完。
 */

import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
    saveMetadataDebounced,
} from '../../../extensions.js';
import {
    eventSource,
    event_types,
    saveSettingsDebounced,
    setExtensionPrompt,
    extension_prompt_types,
    extension_prompt_roles,
} from '../../../../script.js';

/* ================================================================== */
/* 常量                                                                */
/* ================================================================== */

const MODULE = 'plotWeaver';
const PROMPT_KEY = 'plot-weaver-director';
const STATE_VERSION = 1;

const DEFAULT_SETTINGS = {
    enabled: true,
    hud: true,
    hudCollapsed: false,
    position: 'in_chat',
    depth: 4,
    counting: 'all',
    floorOffset: 0,
    strictness: 'normal',
    hintNext: true,
    scanSeeds: true,
    seedChars: 80,
    earlyWarn: true,
    extra: '',
    defaultSpan: 40,
};

const STAGE_TABLE = [
    { key: 'seed', limit: 0.15, name: '起念期' },
    { key: 'brew', limit: 0.45, name: '酝酿期' },
    { key: 'push', limit: 0.75, name: '推进期' },
    { key: 'brink', limit: 0.95, name: '临门期' },
    { key: 'trigger', limit: Infinity, name: '触发期' },
];

const STAGE_TEXT = {
    seed: {
        soft: '可以埋一点与目标相关的细节、气氛或人物的小倾向，让读者隐约觉得有事要发生；尽量不要直接点名这件事。',
        normal: '只埋下与目标相关的细节、气氛与人物微妙倾向，让读者隐约觉得后面会出事。不要点名该事件，不要让人物提出这个计划，不要让事件开始。',
        hard: '本楼只做暗示：细节、气氛、人物微妙倾向。严禁点名该事件，严禁让角色提出计划或讨论其结果，严禁事件发生。',
    },
    brew: {
        soft: '可以开始出现相关线索、动机或征兆，让人物隐隐朝这个方向靠近。',
        normal: '让相关线索、动机、征兆逐渐浮现，人物开始有意无意朝这个方向靠近；但事件不能发生，计划不能成型。',
        hard: '逐步放出线索、动机与征兆，人物开始朝该方向行动。严禁事件发生，严禁计划成型，严禁角色明说结局。',
    },
    push: {
        soft: '可以制造通往该事件的条件、冲突或阻碍，把剧情往那个方向推。',
        normal: '明确制造通往该事件的条件、冲突与阻碍，把剧情往那个方向推；本楼只推进一小步，不要把准备工作一次做完。',
        hard: '本楼必须推进一个具体条件或制造一个具体阻碍，让局势明显朝该事件倾斜；严禁把准备一步做完，严禁事件完成。',
    },
    brink: {
        soft: '可以让条件接近齐备、气氛紧绷，把“即将发生”的瞬间停在门口。',
        normal: '让条件接近齐备、张力拉满，可以把“即将发生”的瞬间停在门口；不要跳过过程直接收尾，不要在本楼完成该事件。',
        hard: '把局势推到一触即发：条件齐备、气氛紧绷，停在门口。严禁在本楼完成事件，严禁用旁白概括代替场景。',
    },
    trigger: {
        soft: '现在可以让目标事件发生，用前文的铺垫自然接上。',
        normal: '现在让目标事件自然发生：顺着前文铺垫写出过程与因果，不要突兀跳转，也不要一笔带过。',
        hard: '本楼必须让目标事件发生或明确开始，写清触发与因果；严禁跳过过程，严禁突兀转换场景。',
    },
    overdue: {
        soft: '已经超过计划楼层，可以尽快让该事件发生，别再拖。',
        normal: '已经超过计划楼层，本楼必须让该事件发生或明确开始，用一两句交代因果即可，不要再拖。',
        hard: '已超期：本楼必须完成该事件的触发，不得再引入无关支线。',
    },
};

const STATUS_LABEL = {
    active: '进行中',
    paused: '已暂停',
    done: '已完成',
    archived: '已归档',
};

/* ================================================================== */
/* 基础工具                                                            */
/* ================================================================== */

function uid() {
    return 'pw_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cfg() {
    if (!extension_settings[MODULE] || typeof extension_settings[MODULE] !== 'object') {
        extension_settings[MODULE] = {};
    }
    const s = extension_settings[MODULE];
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (s[k] === undefined) s[k] = v;
    }
    return s;
}

function ctx() {
    try {
        return getContext() || {};
    } catch {
        return {};
    }
}

function state() {
    const meta = ctx().chatMetadata;
    if (!meta || typeof meta !== 'object') return null;
    let st = meta[MODULE];
    if (!st || typeof st !== 'object') {
        st = { version: STATE_VERSION, goals: [], activeId: null };
        meta[MODULE] = st;
        return st;
    }
    if (!Array.isArray(st.goals)) st.goals = [];
    st.version = STATE_VERSION;
    if (!('activeId' in st)) st.activeId = null;
    return st;
}

function persist() {
    try {
        saveMetadataDebounced();
    } catch (err) {
        console.warn('[PlotWeaver] 保存聊天元数据失败', err);
    }
}

function toast(message, type = 'info') {
    try {
        if (typeof toastr === 'undefined' || !toastr) return;
        const fn = typeof toastr[type] === 'function' ? toastr[type] : toastr.info;
        fn.call(toastr, message, '伏笔导演');
    } catch {
        /* 忽略 */
    }
}

function clip(str, n) {
    const t = String(str ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, Math.max(1, n - 1)) + '…' : t;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    }[ch]));
}

function toLines(v) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
    return String(v ?? '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
}

function toKeywords(v) {
    if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean).slice(0, 20);
    return String(v ?? '')
        .split(/[,，、;；\n]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 20);
}

/* ================================================================== */
/* 楼层与进度                                                          */
/* ================================================================== */

function floorStats() {
    const chat = ctx().chat || [];
    let total = 0;
    let sys = 0;
    let ai = 0;
    for (const m of chat) {
        if (!m) continue;
        total += 1;
        if (m.is_system) sys += 1;
        else if (!m.is_user) ai += 1;
    }
    return { total, sys, dialog: total - sys, ai };
}

/**
 * 当前楼层。
 *
 * 以前这里会跳过 is_system 的消息，但 ST 的 /hide 隐藏楼层、系统消息
 * 在聊天数组里仍然占位置（楼层管理器也把它们算进"共 N 层"），
 * 跳过之后楼层数会明显偏小，所以默认改成"聊天里有几条消息就是几楼"。
 *
 * floorOffset 用于对齐个人编号习惯：楼层管理器从 0 开始数，就填 -1。
 */
function currentFloor() {
    const s = floorStats();
    const mode = cfg().counting || 'all';
    let n = s.total;
    if (mode === 'ai') n = s.ai;
    else if (mode === 'dialog' || mode === 'round') n = s.dialog;
    return Math.max(0, n + (Number(cfg().floorOffset) || 0));
}

function evalStage(goal, floor) {
    const start = Number(goal.startFloor) || 0;
    const target = Number(goal.targetFloor) || start + 1;
    const span = Math.max(1, target - start);
    const remain = target - floor;
    if (remain <= 0) {
        return { key: 'overdue', name: '逾期收束', remain, percent: 100, ratio: 1 };
    }
    const ratio = (floor - start) / span;
    const stage = STAGE_TABLE.find((s) => ratio < s.limit) || STAGE_TABLE[STAGE_TABLE.length - 1];
    const clamped = Math.max(0, Math.min(1, ratio));
    return {
        key: stage.key,
        name: stage.name,
        remain,
        ratio: clamped,
        percent: Math.round(clamped * 100),
    };
}

function activeGoals(st) {
    if (!st) return [];
    return st.goals
        .filter((g) => g.status === 'active')
        .sort((a, b) => (a.targetFloor || 0) - (b.targetFloor || 0));
}

function currentGoal(st) {
    const list = activeGoals(st);
    if (!list.length) return null;
    const pinned = list.find((g) => g.id === st.activeId);
    return pinned || list[0];
}

function nextGoal(st, goal) {
    if (!st || !goal) return null;
    const list = activeGoals(st).filter((g) => g.id !== goal.id && (g.targetFloor || 0) > (goal.targetFloor || 0));
    return list[0] || null;
}

function normalizeGoal(raw) {
    const cur = currentFloor();
    const targetRaw = Number(raw?.targetFloor);
    const startRaw = Number(raw?.startFloor);
    const goal = {
        id: raw?.id || uid(),
        title: String(raw?.title || '').trim() || '未命名剧情点',
        desc: String(raw?.desc || '').trim(),
        startFloor: Number.isFinite(startRaw) && startRaw >= 0 ? Math.round(startRaw) : cur,
        targetFloor: Number.isFinite(targetRaw) && targetRaw > 0
            ? Math.round(targetRaw)
            : cur + Math.max(1, Number(cfg().defaultSpan) || 40),
        must: toLines(raw?.must),
        avoid: toLines(raw?.avoid),
        keywords: toKeywords(raw?.keywords),
        notes: String(raw?.notes || '').trim(),
        seeds: Array.isArray(raw?.seeds) ? raw.seeds.filter((s) => s && s.text).slice(-30) : [],
        status: ['active', 'paused', 'done', 'archived'].includes(raw?.status) ? raw.status : 'active',
        createdAt: raw?.createdAt || Date.now(),
        doneFloor: Number.isFinite(Number(raw?.doneFloor)) ? Number(raw.doneFloor) : null,
        lastStage: raw?.lastStage || '',
    };
    if (goal.targetFloor <= goal.startFloor) goal.targetFloor = goal.startFloor + 1;
    return goal;
}

/* ================================================================== */
/* 注入内容                                                            */
/* ================================================================== */

function buildInjection() {
    const s = cfg();
    if (!s.enabled) return '';
    const st = state();
    const goal = currentGoal(st);
    if (!goal) return '';

    const floor = currentFloor();
    const ev = evalStage(goal, floor);
    const strict = STAGE_TEXT[ev.key] || STAGE_TEXT.trigger;
    const guidance = strict[s.strictness] || strict.normal;

    const out = [];
    out.push('【伏笔导演｜长期剧情目标】');
    out.push('以下是一个尚未抵达的剧情目标，用来控制节奏：让故事持续朝它靠拢，但不要提前完成它。');
    out.push(`目标：${goal.title}`);
    if (goal.desc) out.push(`要点：${clip(goal.desc, 300)}`);
    const progress = ev.remain > 0 ? `还剩 ${ev.remain} 楼` : `已超期 ${-ev.remain} 楼`;
    out.push(`进度：第 ${floor} 楼（目标第 ${goal.targetFloor} 楼，${progress}，约 ${ev.percent}%）｜阶段：${ev.name}`);
    out.push(guidance);

    if (goal.must.length) {
        out.push(`必须包含：${goal.must.slice(0, 6).map((x) => clip(x, 60)).join('；')}`);
    }
    if (goal.avoid.length) {
        out.push(`禁止：${goal.avoid.slice(0, 6).map((x) => clip(x, 60)).join('；')}`);
    }
    if (goal.notes) {
        out.push(`已铺垫（作者记录，务必衔接）：${clip(goal.notes, 300)}`);
    }
    const seeds = mergeSeeds(goal);
    if (seeds.length) {
        out.push(`已出现过的相关片段（不要与之矛盾）：${seeds.join('；')}`);
    }
    const nxt = nextGoal(st, goal);
    if (s.hintNext && nxt) {
        out.push(`更远的目标（只可极轻微暗示，严禁展开或开始）：${clip(nxt.title, 60)}`);
    }
    if (s.extra) {
        out.push(`附加要求：${clip(s.extra, 400)}`);
    }
    if (ev.key === 'trigger' || ev.key === 'overdue') {
        out.push('叙述方式：本楼让这个目标事件自然发生，写足前因、过程与人物反应；化进正文的细节与对话里，不要输出提纲、编号或进度说明，不要提及本提示。');
    } else {
        out.push('叙述方式：把这些要求化进正文的细节、对话、动作与氛围，逐楼只推进一小步；不要输出提纲、编号或进度说明，不要提及本提示，不要用旁白预告“后面会发生什么”，也不要让事件在本楼收尾。');
    }
    return out.join('\n');
}

function mergeSeeds(goal) {
    const max = 4;
    const limit = Math.max(20, Number(cfg().seedChars) || 80);
    const list = (goal.seeds || []).slice(-max).map((x) => clip(x.text, limit)).filter(Boolean);
    return list;
}

function applyPrompt(text) {
    try {
        if (typeof setExtensionPrompt !== 'function') return;
        if (!text) {
            setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
            return;
        }
        const s = cfg();
        const position = s.position === 'in_prompt'
            ? extension_prompt_types.IN_PROMPT
            : extension_prompt_types.IN_CHAT;
        const depth = Math.max(0, Math.min(100, Number(s.depth) || 0));
        setExtensionPrompt(PROMPT_KEY, text, position, depth, false, extension_prompt_roles.SYSTEM);
    } catch (err) {
        console.warn('[PlotWeaver] 注入失败', err);
    }
}

/* ================================================================== */
/* 关键词扫描（伏笔片段 / 提前触发提醒）                                */
/* ================================================================== */

function splitSentences(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\*\*|__|\*/g, '')
        .split(/(?<=[。！？!?…；;\n])/)
        .map((t) => t.trim())
        .filter(Boolean);
}

function scanMessage(messageId) {
    const s = cfg();
    if (!s.scanSeeds) return;
    const c = ctx();
    const msg = (c.chat || [])[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    const st = state();
    if (!st) return;

    const sentences = splitSentences(msg.mes);
    if (!sentences.length) return;
    const floor = currentFloor();
    let changed = false;

    for (const goal of st.goals) {
        if (goal.status !== 'active' || !goal.keywords || !goal.keywords.length) continue;
        for (const sentence of sentences) {
            if (!goal.keywords.some((k) => k && sentence.includes(k))) continue;
            const text = clip(sentence, Math.max(20, Number(s.seedChars) || 80));
            if (!text) continue;
            if (goal.seeds.some((x) => x.text === text)) continue;
            goal.seeds.push({ floor, text, at: Date.now() });
            changed = true;
        }
        if (goal.seeds.length > 30) {
            goal.seeds = goal.seeds.slice(goal.seeds.length - 30);
            changed = true;
        }
    }
    if (changed) persist();
}

function checkEarlyTrigger(messageId) {
    if (!cfg().earlyWarn) return;
    const c = ctx();
    const msg = (c.chat || [])[messageId];
    if (!msg || msg.is_user || msg.is_system) return;
    const st = state();
    const goal = currentGoal(st);
    if (!goal || !goal.keywords || !goal.keywords.length) return;

    const floor = currentFloor();
    const ev = evalStage(goal, floor);
    if (ev.key === 'trigger' || ev.key === 'overdue' || ev.key === 'brink') return;

    const text = String(msg.mes || '');
    const hits = goal.keywords.filter((k) => k && text.includes(k)).length;
    if (hits >= 2) {
        toast(`可能提前触发了「${goal.title}」：本楼命中 ${hits} 个关键词，进度仅 ${ev.percent}%。如果不想这么快，可以擦除重写。`, 'warning');
    }
}

/* ================================================================== */
/* 界面渲染                                                            */
/* ================================================================== */

function renderAll() {
    renderCurrent();
    renderGoals();
    renderHud();
    renderPreview();
    renderQuickCurrent();
    syncFormHints();
}

function renderPreview() {
    const el = $('#pw-preview');
    if (!el.length) return;
    const text = buildInjection();
    el.text(text || '（未启用，或当前聊天没有进行中的目标）');
}

function renderCurrent() {
    const el = $('#pw-current');
    if (!el.length) return;
    const s = cfg();
    const st = state();

    if (!st || !s.enabled) {
        el.html('<div class="pw-empty">已关闭导演注入。</div>');
        return;
    }
    const goal = currentGoal(st);
    if (!goal) {
        el.html('<div class="pw-empty">当前聊天还没有目标剧情。在下面“添加剧情目标”里写一个，或用“大纲导入”粘贴大纲。</div>');
        return;
    }

    const floor = currentFloor();
    const ev = evalStage(goal, floor);
    const remainText = ev.remain > 0 ? `还剩 ${ev.remain} 楼` : `已超 ${-ev.remain} 楼`;
    const desc = goal.desc ? `<div class="pw-desc">${esc(clip(goal.desc, 180))}</div>` : '';
    const card = `
        <div class="pw-card">
            <div class="pw-card-head">
                <span class="pw-card-title">${esc(goal.title)}</span>
                <span class="pw-stage pw-stage-${ev.key}">${ev.name}</span>
            </div>
            <div class="pw-bar"><div class="pw-bar-fill pw-fill-${ev.key}" style="width:${ev.percent}%"></div></div>
            <div class="pw-meta">第 ${floor} 楼 / 目标 ${goal.targetFloor} 楼 · ${remainText} · ${ev.percent}%</div>
            ${desc}
            <div class="pw-row pw-actions">
                <button class="pw-btn" data-action="now" data-id="${esc(goal.id)}">立即触发</button>
                <button class="pw-btn" data-action="advance" data-id="${esc(goal.id)}">提前 10 楼</button>
                <button class="pw-btn" data-action="delay" data-id="${esc(goal.id)}">延后 10 楼</button>
                <button class="pw-btn" data-action="done" data-id="${esc(goal.id)}">已完成</button>
            </div>
        </div>`;
    el.html(card);
}

function renderGoals() {
    const el = $('#pw-goals');
    if (!el.length) return;
    const st = state();
    if (!st || !st.goals.length) {
        el.html('<div class="pw-empty">还没有任何目标。</div>');
        $('#pw-goals-count').text('0');
        return;
    }

    const visible = st.goals.filter((g) => g.status !== 'archived');
    const archived = st.goals.filter((g) => g.status === 'archived');
    $('#pw-goals-count').text(String(st.goals.length));

    const rows = visible.map((g) => {
        const isCurrent = currentGoal(st)?.id === g.id;
        const status = STATUS_LABEL[g.status] || g.status;
        const actions = [];
        if (g.status !== 'active') actions.push(`<button class="pw-btn pw-btn-xs" data-action="resume" data-id="${esc(g.id)}">恢复</button>`);
        if (g.status === 'active' && !isCurrent) actions.push(`<button class="pw-btn pw-btn-xs" data-action="setActive" data-id="${esc(g.id)}">设为当前</button>`);
        if (g.status === 'active') actions.push(`<button class="pw-btn pw-btn-xs" data-action="pause" data-id="${esc(g.id)}">暂停</button>`);
        actions.push(`<button class="pw-btn pw-btn-xs" data-action="edit" data-id="${esc(g.id)}">编辑</button>`);
        if (g.status !== 'done') actions.push(`<button class="pw-btn pw-btn-xs" data-action="done" data-id="${esc(g.id)}">完成</button>`);
        actions.push(`<button class="pw-btn pw-btn-xs" data-action="archive" data-id="${esc(g.id)}">归档</button>`);

        return `
            <div class="pw-goal ${isCurrent ? 'pw-goal-current' : ''}">
                <div class="pw-goal-main">
                    <div class="pw-goal-title">${isCurrent ? '<i class="fa-solid fa-location-dot"></i> ' : ''}${esc(g.title)}</div>
                    <div class="pw-goal-meta">第 ${g.targetFloor} 楼 · ${status}${g.doneFloor ? `（完成于第 ${g.doneFloor} 楼）` : ''}${g.keywords?.length ? ` · ${g.keywords.length} 个关键词` : ''}</div>
                </div>
                <div class="pw-goal-actions">${actions.join('')}</div>
            </div>`;
    });

    let html = rows.join('');
    if (archived.length) {
        html += `<details class="pw-details pw-details-inner"><summary>已归档 ${archived.length}</summary>`;
        html += archived.map((g) => `
            <div class="pw-goal pw-goal-archived">
                <div class="pw-goal-main"><div class="pw-goal-title">${esc(g.title)}</div>
                <div class="pw-goal-meta">第 ${g.targetFloor} 楼</div></div>
                <div class="pw-goal-actions"><button class="pw-btn pw-btn-xs" data-action="restore" data-id="${esc(g.id)}">恢复</button></div>
            </div>`).join('');
        html += '</details>';
    }
    el.html(html);
}

function renderHud() {
    const hud = $('#pw-hud-bar');
    if (!hud.length) return;
    const s = cfg();
    const st = state();
    const goal = currentGoal(st);
    if (!s.enabled || !s.hud || !goal) {
        hud.hide();
        return;
    }
    const floor = currentFloor();
    const ev = evalStage(goal, floor);
    const collapsed = !!s.hudCollapsed;
    hud.show().toggleClass('pw-hud-collapsed', collapsed);
    hud.html(`
        <div class="pw-hud-head" title="点击折叠/展开">
            <span class="pw-hud-name">${esc(clip(goal.title, 16))}</span>
            <span class="pw-hud-num">${ev.remain > 0 ? `剩 ${ev.remain}` : '到期'}</span>
            <span class="pw-hud-fold">${collapsed ? '▸' : '▾'}</span>
        </div>
        <div class="pw-hud-body">
            <div class="pw-bar pw-bar-sm"><div class="pw-bar-fill pw-fill-${ev.key}" style="width:${ev.percent}%"></div></div>
            <div class="pw-hud-meta">第 ${floor} 楼 · ${ev.name} · ${ev.percent}%</div>
            <div class="pw-row pw-hud-actions">
                <button class="pw-btn pw-btn-xs" data-action="now" data-id="${esc(goal.id)}">立即</button>
                <button class="pw-btn pw-btn-xs" data-action="delay" data-id="${esc(goal.id)}">+10</button>
                <button class="pw-btn pw-btn-xs" data-action="done" data-id="${esc(goal.id)}">完成</button>
            </div>
        </div>`);
}

/* ================================================================== */
/* 刷新                                                                */
/* ================================================================== */

let refreshTimer = null;

function refresh(options = {}) {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
        applyPrompt(buildInjection());
        if (options.fromMessage) notifyStageChange();
        renderAll();
    }, 80);
}

function notifyStageChange() {
    const st = state();
    const goal = currentGoal(st);
    if (!goal) return;
    const ev = evalStage(goal, currentFloor());
    if (goal.lastStage && goal.lastStage !== ev.key) {
        toast(`「${goal.title}」进入${ev.name}（${ev.remain > 0 ? `还剩 ${ev.remain} 楼` : '已到期'}）`, 'info');
    }
    if (goal.lastStage !== ev.key) {
        goal.lastStage = ev.key;
        persist();
    }
}

/* ================================================================== */
/* 表单                                                                */
/* ================================================================== */

let editingId = null;

function syncFormHints() {
    const el = $('#pw-target');
    if (!el.length) return;
    const suggestion = currentFloor() + Math.max(1, Number(cfg().defaultSpan) || 40);
    el.attr('placeholder', `例：${suggestion}`);
    if (!el.val()) el.attr('placeholder', `默认 ${suggestion}（当前楼 + ${cfg().defaultSpan}）`);
}

function resetForm() {
    editingId = null;
    $('#pw-title').val('');
    $('#pw-desc').val('');
    $('#pw-target').val('');
    $('#pw-keywords').val('');
    $('#pw-must').val('');
    $('#pw-avoid').val('');
    $('#pw-notes').val('');
    $('#pw-form-title').text('添加剧情目标');
    $('#pw-save span').text('添加目标');
    $('#pw-cancel-edit').hide();
    syncFormHints();
}

function fillForm(goal) {
    editingId = goal.id;
    $('#pw-title').val(goal.title);
    $('#pw-desc').val(goal.desc);
    $('#pw-target').val(goal.targetFloor);
    $('#pw-keywords').val((goal.keywords || []).join(','));
    $('#pw-must').val((goal.must || []).join('\n'));
    $('#pw-avoid').val((goal.avoid || []).join('\n'));
    $('#pw-notes').val(goal.notes || '');
    $('#pw-form-title').text(`编辑：${goal.title}`);
    $('#pw-save span').text('保存修改');
    $('#pw-cancel-edit').show();
    $('#pw-add-box').attr('open', 'open');
    document.querySelector('#pw-add-box')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * 统一的新建目标入口：设置面板表单与魔棒快捷弹窗共用。
 * 只负责写入 state，不负责保存与重绘（调用方自己 persist + refresh）。
 */
function createGoal(values) {
    const st = state();
    if (!st) {
        toast('还没有打开聊天', 'warning');
        return null;
    }
    const cur = currentFloor();
    const title = String(values.title || '').trim();
    if (!title) {
        toast('至少写一个标题', 'warning');
        return null;
    }
    const n = Number(values.targetFloor);
    const targetFloor = Number.isFinite(n) && n > 0
        ? Math.round(n)
        : cur + Math.max(1, Number(cfg().defaultSpan) || 40);
    const goal = normalizeGoal({
        title,
        desc: values.desc,
        targetFloor: Math.max(cur + 1, targetFloor),
        startFloor: cur,
        keywords: values.keywords,
        must: values.must,
        avoid: values.avoid,
        notes: values.notes,
        status: 'active',
    });
    st.goals.push(goal);
    const head = currentGoal(st);
    if (!head || (goal.targetFloor || 0) < (head.targetFloor || 0)) st.activeId = goal.id;
    return goal;
}

function saveForm() {
    const st = state();
    if (!st) {
        toast('还没有打开聊天', 'warning');
        return;
    }
    const cur = currentFloor();
    const title = String($('#pw-title').val() || '').trim();
    if (!title) {
        toast('至少写一个标题', 'warning');
        return;
    }
    const targetInput = Number($('#pw-target').val());
    const targetFloor = Number.isFinite(targetInput) && targetInput > 0
        ? Math.round(targetInput)
        : cur + Math.max(1, Number(cfg().defaultSpan) || 40);

    if (editingId) {
        const goal = st.goals.find((g) => g.id === editingId);
        if (goal) {
            goal.title = title;
            goal.desc = String($('#pw-desc').val() || '').trim();
            goal.targetFloor = Math.max(goal.startFloor + 1, targetFloor);
            goal.keywords = toKeywords($('#pw-keywords').val());
            goal.must = toLines($('#pw-must').val());
            goal.avoid = toLines($('#pw-avoid').val());
            goal.notes = String($('#pw-notes').val() || '').trim();
        }
        editingId = null;
    } else {
        createGoal({
            title,
            desc: $('#pw-desc').val(),
            targetFloor,
            keywords: $('#pw-keywords').val(),
            must: $('#pw-must').val(),
            avoid: $('#pw-avoid').val(),
            notes: $('#pw-notes').val(),
        });
    }

    persist();
    resetForm();
    refresh();
    toast('已保存', 'success');
}

function buildOutline() {
    const raw = String($('#pw-outline').val() || '');
    const lines = raw.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
    if (!lines.length) {
        toast('大纲是空的', 'warning');
        return;
    }
    const st = state();
    if (!st) {
        toast('还没有打开聊天', 'warning');
        return;
    }
    const gap = Math.max(1, Number($('#pw-outline-gap').val()) || 25);
    const cur = currentFloor();

    lines.forEach((line, index) => {
        st.goals.push(normalizeGoal({
            title: clip(line, 40),
            desc: line.length > 40 ? line : '',
            startFloor: cur,
            targetFloor: cur + gap * (index + 1),
            status: 'active',
        }));
    });

    if (!st.activeId) st.activeId = currentGoal(st)?.id || null;
    persist();
    refresh();
    toast(`已生成 ${lines.length} 个目标，每 ${gap} 楼一个`, 'success');
}

function exportJson() {
    const st = state();
    if (!st) {
        toast('还没有打开聊天', 'warning');
        return;
    }
    $('#pw-json').val(JSON.stringify({ version: STATE_VERSION, goals: st.goals }, null, 2));
    toast('已导出到文本框', 'success');
}

function importJson() {
    const st = state();
    if (!st) {
        toast('还没有打开聊天', 'warning');
        return;
    }
    let parsed;
    try {
        parsed = JSON.parse(String($('#pw-json').val() || ''));
    } catch {
        toast('JSON 解析失败', 'error');
        return;
    }
    const goals = Array.isArray(parsed) ? parsed : parsed?.goals;
    if (!Array.isArray(goals)) {
        toast('JSON 里没有 goals 数组', 'error');
        return;
    }
    if (!window.confirm(`将用 ${goals.length} 个目标覆盖当前聊天的全部目标，继续？`)) return;
    st.goals = goals.map((g) => normalizeGoal(g));
    st.activeId = currentGoal(st)?.id || null;
    persist();
    refresh();
    toast('已导入', 'success');
}

/* ================================================================== */
/* 设置面板绑定                                                        */
/* ================================================================== */

function bindToggle(selector, key) {
    const el = $(selector);
    if (!el.length) return;
    el.prop('checked', !!cfg()[key]);
    el.on('change', (ev) => {
        cfg()[key] = !!ev.target.checked;
        saveSettingsDebounced();
        refresh();
    });
}

function bindValue(selector, key, kind = 'text') {
    const el = $(selector);
    if (!el.length) return;
    el.val(cfg()[key]);
    el.on('change', (ev) => {
        cfg()[key] = kind === 'number' ? (Number(ev.target.value) || 0) : ev.target.value;
        saveSettingsDebounced();
        refresh();
    });
}

function bindSettings() {
    $('#pw-enabled').prop('checked', !!cfg().enabled);
    bindToggle('#pw-enabled', 'enabled');
    bindToggle('#pw-hud', 'hud');
    bindToggle('#pw-hint-next', 'hintNext');
    bindToggle('#pw-seeds', 'scanSeeds');
    bindToggle('#pw-earlywarn', 'earlyWarn');
    bindValue('#pw-position', 'position');
    bindValue('#pw-depth', 'depth', 'number');
    bindValue('#pw-counting', 'counting');
    bindValue('#pw-floor-offset', 'floorOffset', 'number');
    bindValue('#pw-strictness', 'strictness');
    bindValue('#pw-defaultspan', 'defaultSpan', 'number');
    bindValue('#pw-extra', 'extra');
}

function bindUi() {
    $(document).on('click', '.pw-btn', function () {
        handleAction(this.dataset.action || '', this.dataset.id || '');
    });

    $(document).on('click', '#pw-hud-bar .pw-hud-head', () => {
        cfg().hudCollapsed = !cfg().hudCollapsed;
        saveSettingsDebounced();
        renderHud();
    });
}

function handleAction(action, id) {
    switch (action) {
        case 'save': saveForm(); return;
        case 'cancel-edit': resetForm(); return;
        case 'outline': buildOutline(); return;
        case 'export': exportJson(); return;
        case 'import': importJson(); return;
        default: break;
    }

    const st = state();
    if (!st) {
        toast('还没有打开聊天', 'warning');
        return;
    }
    const goal = id ? st.goals.find((g) => g.id === id) : currentGoal(st);
    if (!goal) return;

    const cur = currentFloor();
    switch (action) {
        case 'now':
            goal.targetFloor = cur + 1;
            goal.status = 'active';
            st.activeId = goal.id;
            break;
        case 'advance':
            goal.targetFloor = Math.max(cur + 1, (goal.targetFloor || cur) - 10);
            break;
        case 'delay':
            goal.targetFloor = (goal.targetFloor || cur) + 10;
            break;
        case 'done':
            goal.status = 'done';
            goal.doneFloor = cur;
            if (st.activeId === goal.id) st.activeId = null;
            toast(`「${goal.title}」已标记完成`, 'success');
            break;
        case 'pause':
            goal.status = 'paused';
            break;
        case 'resume':
            goal.status = 'active';
            break;
        case 'archive':
            goal.status = 'archived';
            break;
        case 'restore':
            goal.status = 'active';
            st.activeId = goal.id;
            break;
        case 'setActive':
            goal.status = 'active';
            st.activeId = goal.id;
            break;
        case 'edit':
            fillForm(goal);
            return;
        default:
            return;
    }

    persist();
    refresh();
}

/* ================================================================== */
/* 事件                                                                */
/* ================================================================== */

function bindEvents() {
    if (!eventSource || !event_types) return;

    eventSource.on(event_types.CHAT_CHANGED, () => {
        editingId = null;
        resetForm();
        refresh();
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
        try {
            scanMessage(Number(messageId));
            checkEarlyTrigger(Number(messageId));
        } catch (err) {
            console.warn('[PlotWeaver] 消息扫描失败', err);
        }
        refresh({ fromMessage: true });
    });

    for (const evt of [event_types.MESSAGE_SENT, event_types.MESSAGE_EDITED, event_types.MESSAGE_DELETED, event_types.MESSAGE_SWIPED]) {
        if (evt) eventSource.on(evt, () => refresh());
    }

    if (event_types.GENERATION_AFTER_COMMANDS) {
        eventSource.on(event_types.GENERATION_AFTER_COMMANDS, () => {
            try {
                applyPrompt(buildInjection());
            } catch (err) {
                console.warn('[PlotWeaver] 生成前注入失败', err);
            }
        });
    }
}

/* ================================================================== */
/* 斜杠命令                                                            */
/* ================================================================== */

function statusText() {
    const st = state();
    const goal = currentGoal(st);
    if (!goal) return '当前没有进行中的剧情目标。';
    const floor = currentFloor();
    const ev = evalStage(goal, floor);
    return `「${goal.title}」第 ${floor} / ${goal.targetFloor} 楼，${ev.name}，${ev.remain > 0 ? `还剩 ${ev.remain} 楼` : `已超 ${-ev.remain} 楼`}（${ev.percent}%）`;
}

function registerSlash() {
    const c = ctx();
    try {
        const callback = (args, value) => {
            const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
            const sub = (parts.shift() || 'status').toLowerCase();
            const rest = parts.join(' ');

            switch (sub) {
                case 'status':
                case 's':
                    return statusText();
                case 'add': {
                    const st = state();
                    if (!st) return '还没有打开聊天。';
                    const [title, floors] = rest.split('|').map((x) => x.trim());
                    if (!title) return '用法：/plot add 标题 | 楼层数';
                    const cur = currentFloor();
                    const span = Number(floors) > 0 ? Number(floors) : Math.max(1, Number(cfg().defaultSpan) || 40);
                    const goal = normalizeGoal({ title, desc: title, startFloor: cur, targetFloor: cur + span, status: 'active' });
                    st.goals.push(goal);
                    if (!st.activeId) st.activeId = goal.id;
                    persist();
                    refresh();
                    return `已添加目标「${goal.title}」，目标第 ${goal.targetFloor} 楼。`;
                }
                case 'next': {
                    const st = state();
                    const goal = currentGoal(st);
                    if (!goal) return '没有进行中的目标。';
                    const list = activeGoals(st).filter((g) => g.targetFloor > goal.targetFloor);
                    return list.length ? `下一个目标：${list[0].title}（第 ${list[0].targetFloor} 楼）` : '已经没有更远的目标了。';
                }
                case 'done': {
                    const st = state();
                    const goal = currentGoal(st);
                    if (!goal) return '没有进行中的目标。';
                    goal.status = 'done';
                    goal.doneFloor = currentFloor();
                    st.activeId = null;
                    persist();
                    refresh();
                    return `已标记完成「${goal.title}」。`;
                }
                case 'delay': {
                    const st = state();
                    const goal = currentGoal(st);
                    if (!goal) return '没有进行中的目标。';
                    const n = Number(rest) || 10;
                    goal.targetFloor += n;
                    persist();
                    refresh();
                    return `「${goal.title}」已延后到第 ${goal.targetFloor} 楼。`;
                }
                case 'now': {
                    const st = state();
                    const goal = currentGoal(st);
                    if (!goal) return '没有进行中的目标。';
                    goal.targetFloor = currentFloor() + 1;
                    persist();
                    refresh();
                    return `「${goal.title}」已调整为立即触发。`;
                }
                default:
                    return '可用：status / add 标题 | 楼层 / next / done / delay 楼数 / now';
            }
        };

        if (typeof c.registerSlashCommand === 'function') {
            c.registerSlashCommand('plot', callback, ['pw'], '伏笔导演：查看/管理长期剧情目标', true, true);
        } else if (c.SlashCommandParser && c.SlashCommand) {
            c.SlashCommandParser.addCommandObject(c.SlashCommand.fromProps({
                name: 'plot',
                aliases: ['pw'],
                callback,
                helpString: '伏笔导演：/plot status · /plot add 标题 | 楼层 · /plot next · /plot done · /plot delay 楼数 · /plot now',
                returns: '状态文本',
            }));
        }
    } catch (err) {
        console.warn('[PlotWeaver] 斜杠命令注册失败', err);
    }
}

/* ================================================================== */
/* 初始化                                                              */
/* ================================================================== */

/* ================================================================== */
/* 魔棒快捷入口 + 快捷弹窗                                             */
/* ================================================================== */

function ensureWandItem() {
    if (document.getElementById('pw_wand_item')) return true;
    const menu = document.getElementById('extensionsMenu');
    if (!menu) return false;
    const holder = document.createElement('div');
    holder.className = 'extension_container';
    holder.innerHTML = '<div id="pw_wand_item" class="list-group-item flex-container flexGap5" role="button" tabindex="0">'
        + '<div class="fa-solid fa-clapperboard extensionsMenuExtensionButton"></div>'
        + '<span>伏笔导演</span></div>';
    const item = holder.firstElementChild;
    menu.appendChild(holder);
    item.addEventListener('click', () => openQuick());
    item.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openQuick();
        }
    });
    return true;
}

function scheduleWandItem(retries = 40) {
    if (ensureWandItem()) return;
    if (retries <= 0) {
        console.warn('[PlotWeaver] 找不到 #extensionsMenu，魔棒入口未挂载');
        return;
    }
    setTimeout(() => scheduleWandItem(retries - 1), 500);
}

function ensureQuick() {
    if ($('#pw-quick').length) return;
    const holder = document.createElement('div');
    holder.innerHTML = `
        <div id="pw-quick" class="pw-quick" style="display:none" role="dialog" aria-label="伏笔导演快捷面板">
            <div class="pw-quick-box">
                <div class="pw-quick-head">
                    <span class="pw-quick-title"><i class="fa-solid fa-clapperboard"></i> 伏笔导演</span>
                    <span class="pw-quick-x" title="关闭">✕</span>
                </div>
                <div id="pw-quick-current" class="pw-quick-current"></div>
                <div class="pw-quick-label">加一个「未来一定会发生、但现在不要演完」的剧情点</div>
                <input id="pw-q-title" class="text_pole pw-quick-input" type="text" placeholder="例：主角发现父亲藏起来的秘密" />
                <div class="pw-quick-row">
                    <input id="pw-q-target" class="text_pole pw-quick-input" type="number" min="1" placeholder="目标楼（留空=当前楼+40）" />
                    <input id="pw-q-keywords" class="text_pole pw-quick-input" type="text" placeholder="关键词，逗号分隔" />
                </div>
                <textarea id="pw-q-desc" class="text_pole pw-quick-input" rows="2" placeholder="具体要发生什么（可选）"></textarea>
                <div class="pw-quick-actions">
                    <button class="pw-btn menu_button" data-quick="add">加为目标</button>
                    <button class="pw-btn menu_button" data-quick="settings">打开完整设置</button>
                </div>
                <div class="pw-quick-tip">进度与目标存在当前聊天的元数据里，换聊天互不影响。</div>
            </div>
        </div>`;
    document.body.appendChild(holder.firstElementChild);
}

function renderQuickCurrent() {
    const el = $('#pw-quick-current');
    if (!el.length) return;
    const st = state();
    if (!st) {
        el.html('<div class="pw-empty">还没有打开聊天。</div>');
        return;
    }
    const goal = currentGoal(st);
    if (!goal) {
        el.html('<div class="pw-empty">当前聊天还没有目标，下面写一个就会开始铺垫。</div>');
        return;
    }
    const floor = currentFloor();
    const ev = evalStage(goal, floor);
    const remainText = ev.remain > 0 ? `还剩 ${ev.remain} 楼` : `已超 ${-ev.remain} 楼`;
    el.html(`
        <div class="pw-card">
            <div class="pw-card-head">
                <span class="pw-card-title">${esc(goal.title)}</span>
                <span class="pw-stage pw-stage-${ev.key}">${ev.name}</span>
            </div>
            <div class="pw-bar"><div class="pw-bar-fill pw-fill-${ev.key}" style="width:${ev.percent}%"></div></div>
            <div class="pw-meta">第 ${floor} 楼 / 目标 ${goal.targetFloor} 楼 · ${remainText} · ${ev.percent}%</div>
        </div>`);
}

function openQuick() {
    ensureQuick();
    const box = $('#pw-quick');
    if (!box.length) return;
    renderQuickCurrent();
    box.css('display', 'flex');
    setTimeout(() => $('#pw-q-title').trigger('focus'), 30);
}

function closeQuick() {
    $('#pw-quick').hide();
}

function openFullPanel() {
    closeQuick();
    const content = document.getElementById('rm_extensions_block');
    const drawer = document.getElementById('extensions-settings-button');
    if (content && content.classList.contains('closedDrawer')) {
        const toggle = drawer ? drawer.querySelector('.drawer-toggle') : null;
        if (toggle) toggle.click();
    }
    setTimeout(() => {
        // 本插件自己的折叠面板默认可能是收起的，先展开再定位
        const root = document.querySelector('.plot-weaver-settings');
        const inner = root ? root.querySelector('.inline-drawer') : null;
        const innerContent = inner ? inner.querySelector('.inline-drawer-content') : null;
        const collapsed = !innerContent || getComputedStyle(innerContent).display === 'none';
        if (collapsed && inner) {
            const innerToggle = inner.querySelector('.inline-drawer-toggle');
            if (innerToggle) innerToggle.click();
        }
        setTimeout(() => {
            const target = document.getElementById('pw-current') || document.getElementById('pw-add-box');
            if (!target) return;
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target.classList.add('pw-flash');
            setTimeout(() => target.classList.remove('pw-flash'), 1200);
        }, 200);
    }, 200);
}

function submitQuick() {
    const created = createGoal({
        title: $('#pw-q-title').val(),
        desc: $('#pw-q-desc').val(),
        targetFloor: $('#pw-q-target').val(),
        keywords: $('#pw-q-keywords').val(),
    });
    if (!created) return;
    $('#pw-q-title').val('');
    $('#pw-q-target').val('');
    $('#pw-q-keywords').val('');
    $('#pw-q-desc').val('');
    persist();
    refresh();
    toast(`已加为目标：${clip(created.title, 20)}`, 'success');
}

function bindQuick() {
    $(document).on('click', '[data-quick]', function (e) {
        e.preventDefault();
        const action = this.dataset.quick;
        if (action === 'add') submitQuick();
        else if (action === 'settings') openFullPanel();
    });
    $(document).on('click', '#pw-quick .pw-quick-x', (e) => {
        e.stopPropagation();
        closeQuick();
    });
    $(document).on('click', '#pw-quick', function (e) {
        if (e.target === this) closeQuick();
    });
    $(document).on('keydown.pwquick', (e) => {
        if (e.key === 'Escape' && $('#pw-quick').is(':visible')) closeQuick();
    });
}

function ensureHud() {
    if ($('#pw-hud-bar').length) return;
    $('body').append('<div id="pw-hud-bar" class="pw-hud" style="display:none"></div>');
}

let initialized = false;

/**
 * 面板 HTML 兜底加载。
 * SillyTavern 用 Handlebars 渲染 settings.html，TauriTavern 还会额外过一遍 DOMPurify。
 * 本插件模板不含任何 {{}} 变量，所以渲染器不可用时可以直接抓取原始文件，行为完全一致。
 */
async function loadSettingsHtml() {
    try {
        return await renderExtensionTemplateAsync('third-party/PlotWeaver', 'settings');
    } catch (err) {
        console.warn('[PlotWeaver] 模板渲染失败，改为直接读取 settings.html', err);
        const url = new URL('scripts/extensions/third-party/PlotWeaver/settings.html', location.href);
        const res = await fetch(url.href, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`settings.html HTTP ${res.status}`);
        return await res.text();
    }
}

async function init() {
    if (initialized) return;
    initialized = true;
    try {
        const html = await loadSettingsHtml();
        const host = $('#extensions_settings2').length
            ? $('#extensions_settings2')
            : $('#extensions_settings').length
                ? $('#extensions_settings')
                : $('#extensions_settings2, #extensions_settings').first();
        if (!host.length) throw new Error('找不到扩展设置容器 #extensions_settings2');
        host.append(html);
    } catch (err) {
        console.error('[PlotWeaver] 设置面板加载失败', err);
    }

    ensureHud();
    bindSettings();
    bindUi();
    bindQuick();
    bindEvents();
    registerSlash();
    resetForm();
    applyPrompt(buildInjection());
    renderAll();
    scheduleWandItem();
    console.log('[伏笔导演] 已加载');
}

jQuery(async () => {
    await init();
});
