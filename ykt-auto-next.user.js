// ==UserScript==
// @name         雨课堂自动连播（播完点下一节）
// @name:en      Yuketang Auto Next
// @namespace    https://github.com/114514592/yuketang-auto-next
// @version      3.1.3
// @description  雨课堂视频播完后自动切到下一个视频：适配 2026 新版「学习空间」/ai-workspace/lms-graph，兼容 /pro/lms 与 v2/web 旧版
// @author       114514592
// @license      MIT
// @homepageURL  https://github.com/114514592/yuketang-auto-next
// @supportURL   https://github.com/114514592/yuketang-auto-next/issues
// @downloadURL  https://raw.githubusercontent.com/114514592/yuketang-auto-next/main/ykt-auto-next.user.js
// @updateURL    https://raw.githubusercontent.com/114514592/yuketang-auto-next/main/ykt-auto-next.user.js
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

/*
 * 适用页面
 *   新版：/ai-workspace/lms-graph/{classroomId}/{kind}/{leafId}   ← 2026「学习空间」
 *   旧版：/pro/lms/{sign}/{classroomId}/video/{leafId}
 *   长江：/v2/web/xcloud/video-student/{classroomId}/{leafId}
 *
 * 关键选择器（新版）
 *   当前目录项   .leaf-item.is-active
 *   下一节箭头   .control-right i.unit-arrow.arrow-reverse   （每讲只有一节时它是禁用的，只作兜底）
 *   完成度文字   .rate-detail .el-tooltip.text
 *   完成图标     .leaf-item-status i[class*="yuanquangou"]
 *
 * 切下一节的顺序（可用 CONFIG.PREFER 调整）
 *   1) api   —— 查 todo_list 未完成清单，挑下一个 type===0（视频）的 leaf，直接改 URL 跳过去
 *   2) leaf  —— 点左侧目录里 .leaf-item.is-active 的下一个 .leaf-item
 *   3) arrow —— 点「下一节」箭头（仅当它没被禁用）
 *
 * 排查：控制台输入 __YKT__.report()
 *
 * 选择器与接口用法参考了 GreasyFork「雨课堂连播助手」(MIT, 作者 Acac1a) 对新版学习空间的适配。
 */

(function () {
  'use strict';

  // ======================= 配置区 =======================
  const CONFIG = {
    ENABLED: true,

    // 切下一节的优先级顺序
    PREFER: ['api', 'leaf', 'arrow'],

    // 完成度 ≥ 这个百分比就算本节完成
    DONE_PERCENT: 99,

    // 视频结束后等多久再切（给平台上报进度留时间）
    DELAY_MS: 3000,
    // 找不到目标时的重试窗口
    MAX_WAIT_MS: 15000,
    RETRY_EVERY_MS: 500,
    POLL_EVERY_MS: 1000,
    // 失败后隔多久才允许对同一个视频重试（避免刷屏）
    RETRY_COOLDOWN_MS: 60000,

    // 被暂停（切屏/弹题）后自动续播
    AUTO_RESUME: true,
    RESUME_DELAY_MS: 1500,

    // 1 = 原速。想倍速填 1.5 / 2
    SPEED: 1,
    // true = 静音播放
    MUTE: false,
  };
  // =====================================================

  const P = '[雨课堂连播]';
  const log = (fmt, ...a) => console.log(`${P} ${fmt}`, ...a);

  const doneVideos = new WeakSet();
  const boundVideos = new WeakSet();
  const lastAttempt = new WeakMap();
  const stats = { attached: 0, advanced: 0, navigated: 0, clicked: 0, apiFail: 0 };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el ? (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() : '');
  const qText = (sel, root) => textOf((root || document).querySelector(sel));

  function toast(msg) {
    let box = document.getElementById('__ykt_auto_next_toast__');
    if (!box) {
      box = document.createElement('div');
      box.id = '__ykt_auto_next_toast__';
      box.style.cssText =
        'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
        'background:rgba(20,20,20,.88);color:#fff;font:13px/1.5 system-ui,sans-serif;' +
        'padding:8px 12px;border-radius:8px;pointer-events:none;transition:opacity .3s;opacity:0;max-width:60vw;';
      document.body.appendChild(box);
    }
    box.textContent = msg;
    box.style.opacity = '1';
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (box.style.opacity = '0'), 2600);
  }

  // ---------- 页面上下文 ----------
  const reNew = /^\/ai-workspace\/lms-graph\/(\d+)\/([A-Za-z-]+)\/(\d+)/;
  const reNewCourse = /^\/ai-workspace\/lms-graph\/(\d+)/;
  const reLegacy = /^\/pro\/lms\/([^/]+)\/(\d+)\/video\/(\d+)/;
  const reCj = /^\/v2\/web\/xcloud\/video-student\/(\d+)\/(\d+)/;

  function parseContext(pathname) {
    const p = pathname || location.pathname;
    let m = p.match(reNew);
    if (m) return { version: 'new', classroomId: m[1], rawKind: m[2], leafId: m[3] };
    m = p.match(reNewCourse);
    if (m) return { version: 'new', classroomId: m[1], rawKind: 'course', leafId: null };
    m = p.match(reLegacy);
    if (m) return { version: 'legacy', sign: m[1], classroomId: m[2], rawKind: 'video', leafId: m[3] };
    m = p.match(reCj);
    if (m) return { version: 'cj', classroomId: m[1], rawKind: 'video', leafId: m[2] };
    return null;
  }

  function buildVideoUrl(ctx, leafId) {
    if (!ctx) return null;
    if (ctx.version === 'new') {
      return `https://${location.hostname}/ai-workspace/lms-graph/${ctx.classroomId}/video/${leafId}` +
             '?node_id=0&fromProIframe=1&isyth=1&is_chapter=1';
    }
    if (ctx.version === 'cj') {
      return `https://${location.hostname}/v2/web/xcloud/video-student/${ctx.classroomId}/${leafId}`;
    }
    return `https://${location.hostname}/pro/lms/${ctx.sign}/${ctx.classroomId}/video/${leafId}`;
  }

  // ---------- 接口 ----------
  function cookieVal(name) {
    const m = String(document.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  function apiHeaders() {
    return {
      xtbz: cookieVal('xtbz') || 'cloud',
      'university-id': cookieVal('university_id'),
      'platform-id': cookieVal('platform_id'),
      'x-client': 'web',
      'terminal-type': 'web',
      'x-csrftoken': cookieVal('csrftoken'),
      accept: 'application/json, text/plain, */*',
    };
  }

  async function apiGet(path) {
    const r = await fetch(path, { headers: apiHeaders(), credentials: 'include' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.success === false) throw new Error(j.msg || 'API error');
    return j;
  }

  async function getSkuId(classroomId) {
    const key = '_ykt_sku_' + classroomId;
    try {
      const cached = localStorage.getItem(key);
      if (cached) return cached;
    } catch (e) { /* 忽略 */ }
    const j = await apiGet(`/c27/online_courseware/course/classroom/${classroomId}/0/sku_list/?term=latest`);
    const sku = j && j.data && j.data.data_list && j.data.data_list[0] && j.data.data_list[0].sku_id;
    if (sku) {
      try { localStorage.setItem(key, String(sku)); } catch (e) { /* 忽略 */ }
    }
    return sku ? String(sku) : null;
  }

  /** 未完成清单，顺序即课程顺序。type: 0=视频 4=讨论 5=作业/考试 */
  async function getTodoList(classroomId) {
    const sku = await getSkuId(classroomId);
    if (!sku) throw new Error('没取到 sku_id');
    const j = await apiGet(
      `/c27/online_courseware/course/classroom/${classroomId}/${sku}/todo_list/?client_type=web&term=latest`
    );
    const list = (j && j.data && j.data.result) || [];
    return list.map((it) => ({ leafId: String(it.leaf_id), type: it.type, name: it.name }));
  }

  function pickNextVideo(list, currentLeafId) {
    const arr = Array.isArray(list) ? list : [];
    const videos = arr.filter((i) => i.type === 0);
    const cur = currentLeafId == null ? null : String(currentLeafId);
    const next = videos.find((v) => v.leafId !== cur) || null;
    return { next, videos };
  }

  // ---------- 完成状态 ----------
  function readStatus() {
    // 新版：顶部「完成度：3%」/「已完成」
    const t = qText('.rate-detail .el-tooltip.text');
    if (t) {
      if (/已(完成|学完)/.test(t)) return { completed: true, text: t, percent: 100 };
      const m = t.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
      if (m) return { completed: false, text: t, percent: parseFloat(m[1]) };
      return { completed: false, text: t, percent: null };
    }
    // 兜底：目录当前项的完成图标 / 进度饼
    const active = document.querySelector('.leaf-item.is-active');
    if (active) {
      if (active.querySelector('.leaf-item-status i[class*="yuanquangou"]')) {
        return { completed: true, text: '(leaf-icon)', percent: 100 };
      }
      const pie = active.querySelector('.status-pie');
      if (pie) {
        const m = (pie.getAttribute('style') || '').match(/--p:\s*([\d.]+)/);
        if (m) {
          const p = parseFloat(m[1]);
          return { completed: p >= CONFIG.DONE_PERCENT, text: '(pie ' + p + ')', percent: p };
        }
      }
      return { completed: false, text: '(leaf-empty)', percent: 0 };
    }
    // 旧版
    for (const sp of document.querySelectorAll('span.text')) {
      const tx = textOf(sp);
      if (tx === '已完成') return { completed: true, text: tx, percent: 100 };
      const m = tx.match(/(\d{1,3})%/);
      if (m) return { completed: false, text: tx, percent: parseInt(m[1], 10) };
    }
    if (document.querySelector('.finish')) return { completed: true, text: '(finish)', percent: 100 };
    return { completed: false, text: '', percent: null };
  }

  function statusDone() {
    const s = readStatus();
    return s.completed || (s.percent !== null && s.percent >= CONFIG.DONE_PERCENT);
  }

  function videoFinished(video) {
    if (video.ended) return true;
    const d = video.duration;
    if (d && isFinite(d) && d > 0 && d - video.currentTime <= 0.5) return true;
    return statusDone();
  }

  // ---------- 找“下一个” ----------
  // 目录项的文字通常以类型标签开头（如「视频 第十讲 …」「作业 第5章…」），
  // 所以这里锚定行首匹配，避免「作业 观看视频并提交心得」这种标题里的“视频”二字被误判。
  const RE_VIDEO_LEAF = /^\s*视频/;
  const RE_OTHER_LEAF = /^\s*(作业|讨论|考试|测验|问卷|直播|图文|文档|课件|课堂|公告|实验)/;

  /**
   * 目录：当前项后面第一个“视频”项。
   * 原则是「宁可不切，也绝不打开作业/讨论/考试」——
   * 所以最后一个候选兜底是 null，而不是相邻的下一项。
   */
  function findNextLeaf() {
    const items = Array.from(document.querySelectorAll('.leaf-item'));
    const idx = items.findIndex((el) => el.classList.contains('is-active'));
    if (idx < 0) return null;
    const rest = items.slice(idx + 1);
    if (!rest.length) return null;
    return (
      rest.find((el) => RE_VIDEO_LEAF.test(textOf(el))) ||
      rest.find((el) => !RE_OTHER_LEAF.test(textOf(el))) ||
      null
    );
  }

  function findNextArrow() {
    const el = document.querySelector('.control-right i.unit-arrow.arrow-reverse') ||
               document.querySelector('.btn-next');
    if (!el) return null;
    const cs = typeof el.className === 'string' ? el.className.split(/\s+/) : [];
    if (cs.includes('is-disable') || cs.includes('is-disabled') || el.disabled) return null;
    return el;
  }

  function safeClick(el) {
    const r = el.getBoundingClientRect();
    const opt = {
      bubbles: true, cancelable: true, view: window,
      clientX: Math.round(r.left + r.width / 2) || 9999,
      clientY: Math.round(r.top + r.height / 2) || 9999,
    };
    el.dispatchEvent(new MouseEvent('mouseover', opt));
    el.dispatchEvent(new MouseEvent('mousemove', opt));
    el.click();
  }

  // 接口连续失败若干次后，本会话不再尝试（省得每次都刷一条失败日志）
  let apiFailStreak = 0;
  let apiDisabled = false;

  /** 决定去哪里：返回 {mode, url|el, detail} */
  async function resolveNext() {
    const ctx = parseContext();

    for (const mode of CONFIG.PREFER) {
      if (mode === 'api') {
        if (apiDisabled) continue;
        if (!ctx || ctx.version !== 'new' || !ctx.classroomId) continue;
        try {
          const list = await getTodoList(ctx.classroomId);
          apiFailStreak = 0;
          const picked = pickNextVideo(list, ctx.leafId);
          if (picked.next) {
            return {
              mode: 'api',
              url: buildVideoUrl(ctx, picked.next.leafId),
              detail: '下一个未完成视频：' + (picked.next.name || picked.next.leafId) +
                      '（未完成视频共 ' + picked.videos.length + ' 个）',
            };
          }
          return { mode: 'none', detail: '未完成清单里已经没有别的视频了' };
        } catch (e) {
          stats.apiFail++;
          apiFailStreak++;
          log('调 todo_list 接口失败：%s，改用页面元素兜底', (e && e.message) || e);
          if (apiFailStreak >= 3) {
            apiDisabled = true;
            log('接口已连续失败 %d 次，本次会话不再尝试，直接用目录兜底。', apiFailStreak);
          }
        }
      }

      if (mode === 'leaf') {
        const leaf = findNextLeaf();
        if (leaf) return { mode: 'leaf', el: leaf, detail: '目录下一项：' + textOf(leaf).slice(0, 24) };
      }

      if (mode === 'arrow') {
        const arrow = findNextArrow();
        if (arrow) return { mode: 'arrow', el: arrow, detail: '“下一节”箭头（当前可用）' };
      }
    }
    return { mode: 'none', detail: '三个途径都没找到下一个视频' };
  }

  // ---------- 核心 ----------
  async function advance(video, why) {
    lastAttempt.set(video, Date.now());
    const st = readStatus();
    log('本节判定为完成（%s，状态「%s」），%d 毫秒后切下一个', why, st.text || '未知', CONFIG.DELAY_MS);
    toast('雨课堂连播：本节已完成，准备下一节');
    stats.advanced++;
    await sleep(CONFIG.DELAY_MS);

    const deadline = Date.now() + CONFIG.MAX_WAIT_MS;
    let target = await resolveNext();
    while (target.mode === 'none' && Date.now() < deadline) {
      await sleep(CONFIG.RETRY_EVERY_MS);
      target = await resolveNext();
    }

    if (target.mode === 'none') {
      log('没有找到下一个视频：%s', target.detail);
      log('等 %d 秒后会再试。', Math.round(CONFIG.RETRY_COOLDOWN_MS / 1000));
      toast('雨课堂连播：没找到下一个视频');
      doneVideos.delete(video);
      return;
    }

    if (target.mode === 'api') {
      log('跳转 → %s', target.detail);
      log('目标地址：%s', target.url);
      stats.navigated++;
      toast('雨课堂连播：正在打开下一个视频');
      location.href = target.url;
      return;
    }

    log('点击 → %s', target.detail);
    safeClick(target.el);
    stats.clicked++;

    await sleep(2000);
    if (video.isConnected && videoFinished(video)) {
      log('点击后页面没切换，%d 秒后会再试。', Math.round(CONFIG.RETRY_COOLDOWN_MS / 1000));
      toast('雨课堂连播：点击可能没生效');
      doneVideos.delete(video);
    } else {
      log('已切换到下一节 ✔');
    }
  }

  // ---------- 监听视频 ----------
  function collectVideos() {
    const list = Array.from(document.querySelectorAll('video'));
    document.querySelectorAll('iframe').forEach((f) => {
      try {
        const d = f.contentDocument;
        if (d) d.querySelectorAll('video').forEach((v) => list.push(v));
      } catch (e) { /* 跨域 iframe */ }
    });
    return list;
  }

  function attach(video) {
    if (!video || boundVideos.has(video)) return;
    boundVideos.add(video);
    stats.attached++;

    if (CONFIG.SPEED && CONFIG.SPEED !== 1) {
      try { video.playbackRate = CONFIG.SPEED; } catch (e) { /* 忽略 */ }
    }
    if (CONFIG.MUTE) { video.muted = true; video.volume = 0; }

    video.addEventListener('ended', () => {
      if (doneVideos.has(video)) return;
      doneVideos.add(video);
      advance(video, 'ended 事件');
    });

    if (CONFIG.AUTO_RESUME) {
      video.addEventListener('pause', () => {
        if (video.ended) return;
        setTimeout(() => {
          if (video.ended || !video.isConnected || !video.paused) return;
          video.play()
            .then(() => log('检测到暂停，已自动续播'))
            .catch(() => log('自动续播被浏览器拦截，请点一下页面'));
        }, CONFIG.RESUME_DELAY_MS);
      });
    }

    log('已监听到视频元素，时长 %s 秒', video.duration);
  }

  function scan() {
    if (!CONFIG.ENABLED) return;
    collectVideos().forEach(attach);
  }

  setInterval(() => {
    if (!CONFIG.ENABLED) return;
    collectVideos().forEach((video) => {
      if (!boundVideos.has(video)) attach(video);
      if (!videoFinished(video)) return;
      if (doneVideos.has(video)) return;
      if (Date.now() - (lastAttempt.get(video) || 0) < CONFIG.RETRY_COOLDOWN_MS) return;
      doneVideos.add(video);
      advance(video, '轮询兜底');
    });
  }, CONFIG.POLL_EVERY_MS);

  new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('loadedmetadata', scan, true);
  document.addEventListener('play', scan, true);

  scan();

  // 排查接口
  const api = {
    version: '3.1.3',
    CONFIG,
    stats,
    parseContext,
    buildVideoUrl,
    readStatus,
    statusDone,
    findNextLeaf,
    findNextArrow,
    getTodoList,
    resolveNext,
    report() {
      const ctx = parseContext();
      const v = collectVideos()[0];
      const leaves = Array.from(document.querySelectorAll('.leaf-item'));
      const activeIdx = leaves.findIndex((el) => el.classList.contains('is-active'));
      const nxt = findNextLeaf();
      return {
        url: location.href,
        页面版本: ctx ? ctx.version : '未识别',
        classroomId: ctx ? ctx.classroomId : null,
        当前leafId: ctx ? ctx.leafId : null,
        完成状态: readStatus(),
        视频: v ? { currentTime: +v.currentTime.toFixed(1), duration: v.duration, ended: v.ended, paused: v.paused } : null,
        目录项数量: leaves.length,
        当前目录项下标: activeIdx,
        当前目录项文字: activeIdx >= 0 ? textOf(leaves[activeIdx]).slice(0, 30) : null,
        目录下一项文字: nxt ? textOf(nxt).slice(0, 30) : null,
        下一节箭头可用: !!findNextArrow(),
        stats,
      };
    },
  };

  const ctx0 = parseContext();
  // 短别名，方便手敲：ykt.report() 等价于 __YKT__.report()
  window.__YKT__ = api;
  window.ykt = api;

  // ---------- 跨上下文排查通道 ----------
  // 雨课堂的 CSP 可能让油猴把脚本跑在隔离环境里，此时页面 console 取不到 window.__YKT__，
  // 但 DOM 是共享的，所以把报告写进一个隐藏节点，并支持派发事件让脚本自己打印。
  function publishReport() {
    try {
      let n = document.getElementById('__ykt_report__');
      if (!n) {
        n = document.createElement('div');
        n.id = '__ykt_report__';
        n.hidden = true;
        (document.body || document.documentElement).appendChild(n);
      }
      n.textContent = JSON.stringify(api.report());
    } catch (e) { /* 忽略 */ }
  }

  document.addEventListener('ykt-report', function () {
    try {
      const r = api.report();
      publishReport();
      console.log(P + ' 当前页面报告：', r);
    } catch (e) {
      console.log(P + ' 生成报告失败：', e);
    }
  });

  setInterval(publishReport, 3000);
  publishReport();

  log('v3.1.3 已启动（页面版本 %s）', ctx0 ? ctx0.version : '未识别');
  log('若 console 取不到 __YKT__，说明脚本在隔离环境，改用这两条之一：');
  log('  document.getElementById("__ykt_report__").textContent');
  log('  document.dispatchEvent(new Event("ykt-report"))');
})();
