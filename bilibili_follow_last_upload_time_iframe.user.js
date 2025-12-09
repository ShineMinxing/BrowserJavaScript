// ==UserScript==
// @name         Bilibili Follow Page - Last Upload Time (iframe+runtime-cache+risk)
// @namespace    https://github.com/ShineMinxing/BrowserJavaScript
// @version      1.3.0
// @author       ShineMinxing
// @description  在 B站关注页（/relation/follow）下方显示每个关注UP主最近一次投稿的时间（iframe 版，仅运行时缓存、解析失败可重试与风险识别）。
// @description:zh-CN 在 B站关注页（/relation/follow）下方显示每个关注UP主最近一次投稿的时间。
//               通过隐藏 iframe 顺序打开各UP的 /upload/video 页面，从页面 DOM 中解析投稿时间，避免接口风控与 CORS 限制。
//               使用运行时缓存避免重复访问，一旦关闭页面/浏览器即自动清空；同步检测 412 风控页面，触发后停止进一步请求。
// @match        https://space.bilibili.com/*/relation/follow*
// @run-at       document-end
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /**
   * ========================= 配置区域 =========================
   */

  // 两个 UP 之间的抓取间隔（毫秒）。数值越大，对 B 站压力越小、越不容易触发风控。
  const LOAD_INTERVAL = 1500;

  // iframe onload 后额外等待的渲染时间（毫秒）。
  // B 站个人空间多为前端渲染，这段等待是给 Vue/React 把视频列表挂到 DOM 的时间。
  const IFRAME_RENDER_WAIT = 1000;

  // 是否输出调试日志到控制台（F12 -> Console）
  const DEBUG = true;

  /**
   * ========================= 顶部调试条 =========================
   * 仅作为脚本运行状态与简单统计的可视化提示。
   */

  const banner = document.createElement('div');
  banner.textContent = '【LastVideo iframe v1.3】';
  Object.assign(banner.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: 999999,
    background: 'rgba(0,0,0,0.7)',
    color: '#fff',
    fontSize: '12px',
    padding: '4px 8px',
    pointerEvents: 'none',
  });
  document.body.appendChild(banner);

  const infoSpan = document.createElement('span');
  infoSpan.style.marginLeft = '8px';
  banner.appendChild(infoSpan);

  // 如果不是 /relation/follow 页面，只显示调试条，不执行后续逻辑
  if (!/\/relation\/follow/.test(location.pathname)) {
    infoSpan.textContent = '（非关注页，仅调试条）';
    return;
  }

  /**
   * ========================= 工具函数 =========================
   */

  function log(...args) {
    if (DEBUG) console.log('[LastVideo iframe]', ...args);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  function formatDiff(ts) {
    if (!ts) return '无投稿记录';
    let diff = Date.now() - ts;
    if (diff < 0) diff = 0;

    const sec = Math.floor(diff / 1000);
    if (sec < 60) return '刚刚';
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return `${d} 天前`;
    const m = Math.floor(d / 30);
    if (m < 12) return `${m} 个月前`;
    const y = Math.floor(m / 12);
    return `${y} 年前`;
  }

  /**
   * 将 upload/video 页面中时间文本解析为时间戳（毫秒）。
   * 支持格式：
   *   - "2024-12-23" / "2024/12/23"
   *   - "11-01" / "11/01"（默认今年）
   *   - "1小时前" / "30分钟前" / "2天前"
   *   - "刚刚"
   * 若遇到新的格式（如“昨天 13:20”），可在此函数中扩展解析逻辑。
   */
  function parseDateText(text) {
    if (!text) return null;
    text = text.trim();
    const now = new Date();

    if (DEBUG) log('解析时间文本:', text);

    // 刚刚
    if (text === '刚刚') {
      return Date.now();
    }

    // xx 分钟前
    let m = text.match(/^(\d+)\s*分钟前$/);
    if (m) {
      const mins = parseInt(m[1], 10);
      return Date.now() - mins * 60 * 1000;
    }

    // xx 小时前
    m = text.match(/^(\d+)\s*小时前$/);
    if (m) {
      const hours = parseInt(m[1], 10);
      return Date.now() - hours * 60 * 60 * 1000;
    }

    // xx 天前
    m = text.match(/^(\d+)\s*天前$/);
    if (m) {
      const days = parseInt(m[1], 10);
      return Date.now() - days * 24 * 60 * 60 * 1000;
    }

    // YYYY-MM-DD / YYYY/MM/DD
    m = text.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (m) {
      const year = parseInt(m[1], 10);
      const month = parseInt(m[2], 10) - 1;
      const day = parseInt(m[3], 10);
      return new Date(year, month, day, 0, 0, 0).getTime();
    }

    // MM-DD / MM/DD，默认当作“今年某月某日”
    m = text.match(/^(\d{1,2})[-\/](\d{1,2})$/);
    if (m) {
      const year = now.getFullYear();
      const month = parseInt(m[1], 10) - 1;
      const day = parseInt(m[2], 10);
      return new Date(year, month, day, 0, 0, 0).getTime();
    }

    // TODO: 可在此扩展“昨天 13:20”等格式
    return null;
  }

  /**
   * 风控页面识别：
   * 典型 B 站 412 风控页文案：
   *   - "错误号: 412"
   *   - "由于触发哔哩哔哩安全风控策略，该次访问请求被拒绝。"
   *   - "The request was rejected because of the bilibili security control policy."
   */
  function isRiskBlockedDoc(doc) {
    try {
      const body = doc && doc.body;
      if (!body) return false;
      const text = (body.innerText || body.textContent || '').trim();
      if (!text) return false;
      if (text.includes('错误号') && text.includes('412')) return true;
      if (text.includes('安全风控策略')) return true;
      if (text.includes('security control policy')) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * ========================= 缓存管理 =========================
   * 仅运行时缓存：Tab 关闭或刷新后自动清空。
   */

  // 运行时缓存：mid -> { ts: number|null, why: string|null }
  const runtimeCache = new Map();

  // 从运行时缓存中读取数据
  function getCached(mid) {
    if (runtimeCache.has(mid)) {
      const r = runtimeCache.get(mid);
      return { ts: r.ts, why: r.why, source: 'runtime' };
    }
    return null;
  }

  // 写运行时缓存
  function setRuntimeCache(mid, ts, why) {
    runtimeCache.set(mid, { ts, why: why || null });
  }

  /**
   * ========================= iframe 管理 =========================
   */

  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.bottom = '0';
  iframe.style.right = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  iframe.style.visibility = 'hidden';
  document.body.appendChild(iframe);

  let iframeBusy = false;         // 简单“锁”：保证同一时间只处理一个 mid
  let riskBlocked = false;        // 一旦检测到风险页，置为 true，后续不再请求

  // 可重试错误：解析失败、超时、iframe onerror、页面加载失败
  const RETRYABLE_ERRORS = new Set([
    'parse_failed',
    'iframe_timeout',
    'iframe_onerror',
    'load_error',
  ]);

  /**
   * 加载单个 UP 的 upload/video 页面，并解析出最近一次投稿时间。
   * 会优先使用运行时缓存；只有在没有缓存且未被标记 riskBlocked 时，才真正发起 iframe 加载。
   * 对于“解析失败/超时”这类软错误，会在下一次扫描时重试。
   * @param {string} mid - UP 主的 mid
   * @returns {Promise<{ts: number|null, why: string|null, from: string}>}
   */
  async function loadUploadDoc(mid) {
    // 1. 运行时缓存（本页已经查过）
    if (runtimeCache.has(mid)) {
      const r = runtimeCache.get(mid);

      // A. 有成功时间戳 → 直接用
      if (r.ts) {
        return { ts: r.ts, why: null, from: 'runtime' };
      }

      // B. 无 ts 且为“可重试错误” → 允许本次重新请求
      if (RETRYABLE_ERRORS.has(r.why)) {
        log(
          '检测到可重试错误，mid =',
          mid,
          'why =',
          r.why,
          '，本次将重新尝试加载。'
        );
        // 不 return，继续往下执行，重新加载 iframe
      } else {
        // C. 风控之类的“硬错误” → 直接返回缓存
        return { ts: null, why: r.why, from: 'runtime' };
      }
    }

    // 2. 若已经全局标记为风控阻断，不再发请求
    if (riskBlocked) {
      const why = 'risk_blocked';
      setRuntimeCache(mid, null, why);
      return { ts: null, why, from: 'blocked' };
    }

    // 3. 真正通过 iframe 串行加载 /upload/video
    // 保证只有一个 mid 在占用 iframe
    while (iframeBusy) {
      await sleep(200);
    }
    iframeBusy = true;

    const url = `https://space.bilibili.com/${mid}/upload/video`;
    log('加载 upload/video 页面:', url);

    let result = { ts: null, why: null };

    try {
      const doc = await new Promise((resolve, reject) => {
        let timeoutId = null;

        function cleanup() {
          iframe.onload = null;
          iframe.onerror = null;
          if (timeoutId) clearTimeout(timeoutId);
        }

        iframe.onload = () => {
          // onload 仅保证 HTML + 静态资源加载完成，并不保证前端框架渲染完毕。
          // 再等待 IFRAME_RENDER_WAIT 毫秒，让 Vue/React 把视频列表挂到 DOM 上。
          setTimeout(() => {
            try {
              const d = iframe.contentDocument || iframe.contentWindow.document;
              cleanup();
              resolve(d);
            } catch (e) {
              cleanup();
              reject(e);
            }
          }, IFRAME_RENDER_WAIT);
        };

        iframe.onerror = () => {
          cleanup();
          reject(new Error('iframe_onerror'));
        };

        // 超时保护，避免某些情况下 iframe 一直不触发 onload/onerror。
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error('iframe_timeout'));
        }, 15000);

        iframe.src = url;
      });

      // 先检查是否为 412 风控页面
      if (isRiskBlockedDoc(doc)) {
        log('检测到 B 站 412 风控页面，停止后续请求。');
        riskBlocked = true;
        result.ts = null;
        result.why = 'risk_page_412';
      } else {
        // 正常解析 upload/video 页面视频时间
        const ts = parseLastVideoTimeFromDoc(doc);
        if (!ts) {
          result.ts = null;
          result.why = 'parse_failed';
        } else {
          result.ts = ts;
          result.why = null;
        }
      }
    } catch (e) {
      console.error('[LastVideo iframe] 加载 upload 页面失败 mid=', mid, e);
      result.ts = null;
      result.why = e && e.message ? e.message : 'load_error';
    } finally {
      iframeBusy = false;
      // 写入运行时缓存
      setRuntimeCache(mid, result.ts, result.why);
      // 两个 UP 之间插入间隔，防止频率过高
      await sleep(LOAD_INTERVAL);
    }

    return { ts: result.ts, why: result.why, from: 'iframe' };
  }

  /**
   * 在 upload/video 的 DOM 中提取所有视频卡片的时间文本，
   * 解析为时间戳后取最大值，作为“最近一次投稿时间”。
   */
  function parseLastVideoTimeFromDoc(doc) {
    if (!doc) return null;

    // 选择器基于当前 B 站空间上传页 DOM 结构：
    // .space-upload .bili-video-card__details .bili-video-card__subtitle span
    const spans = doc.querySelectorAll(
      '.space-upload .bili-video-card__details .bili-video-card__subtitle span'
    );

    if (!spans || spans.length === 0) {
      log('未在 upload/video 页面找到任何时间 span');
      return null;
    }

    let bestTs = null;
    spans.forEach((span, idx) => {
      const text = span.textContent && span.textContent.trim();
      const ts = parseDateText(text);
      if (ts) {
        if (bestTs === null || ts > bestTs) {
          bestTs = ts;
        }
      }
      if (DEBUG) {
        log(
          '视频',
          idx,
          '时间文本=',
          text,
          '解析为=',
          ts ? new Date(ts).toLocaleString() : null
        );
      }
    });

    return bestTs;
  }

  /**
   * ========================= 关注页 DOM 处理 =========================
   */

  function ensureInfoLine(link) {
    const card =
      link.closest('.relation-card') ||
      link.closest('.follow-item') ||
      link.parentElement ||
      link;

    const infoParent = card.querySelector('.relation-card-info') || card;
    let line = infoParent.querySelector('.last-video-line');
    if (!line) {
      line = document.createElement('div');
      line.className = 'last-video-line';
      line.style.fontSize = '12px';
      line.style.color = '#999';
      line.style.marginTop = '2px';
      infoParent.appendChild(line);
    }
    return line;
  }

  function extractMidFromLink(link) {
    const href = link.href || link.getAttribute('href') || '';
    const m = href.match(/space\.bilibili\.com\/(\d+)(?=[\/\?]|$)/);
    if (!m) return null;
    return m[1];
  }

  async function processLink(link, idx, total) {
    const mid = extractMidFromLink(link);
    if (!mid) {
      log('解析 mid 失败 link=', link);
      return;
    }

    const line = ensureInfoLine(link);

    // 先尝试使用运行时缓存
    const cached = getCached(mid);
    if (cached && cached.ts) {
      const diff = formatDiff(cached.ts);
      const exact = new Date(cached.ts).toLocaleString();
      line.textContent = `最近投稿：${diff}（${exact}）（缓存）`;
    } else if (cached && !cached.ts) {
      line.textContent = '最近投稿：无记录（缓存）';
    } else {
      line.textContent = `最近投稿：加载中 (${idx + 1}/${total})…`;
    }

    // 然后再去真正加载（如果缓存中已有成功结果 / 已被 riskBlocked，会在内部直接返回，不再发起请求）
    const { ts, why, from } = await loadUploadDoc(mid);

    if (!ts) {
      if (why === 'parse_failed') {
        line.textContent = '最近投稿：解析失败（稍后将自动重试）';
      } else if (why === 'iframe_timeout') {
        line.textContent = '最近投稿：页面加载超时（稍后将自动重试）';
      } else if (why === 'iframe_onerror') {
        line.textContent = '最近投稿：页面错误（稍后将自动重试）';
      } else if (why === 'risk_page_412' || why === 'risk_blocked') {
        line.textContent = '最近投稿：接口风控，本页不再继续请求';
      } else if (why === 'load_error') {
        line.textContent = '最近投稿：页面加载失败（稍后将自动重试）';
      } else {
        // 如果 cached 存在且 ts 为 null，上面已经显示“缓存无记录”
        if (!cached || (cached && cached.ts)) {
          line.textContent = `最近投稿：无法获取(${why || 'unknown'})`;
        }
      }
    } else {
      const diff = formatDiff(ts);
      const exact = new Date(ts).toLocaleString();
      const suffix =
        from === 'runtime'
          ? '（缓存）'
          : '';
      line.textContent = `最近投稿：${diff}（${exact}）${suffix}`;
    }
  }

  async function scanAllLinks() {
    const links = Array.from(
      document.querySelectorAll('a.relation-card-info__uname')
    );
    infoSpan.textContent =
      ' | 本次扫描UP数：' +
      links.length +
      (riskBlocked ? '（已检测到风控，仅使用缓存）' : '');
    log('关注页扫描到 UP 数 =', links.length, 'riskBlocked =', riskBlocked);

    let i = 0;
    for (const link of links) {
      await processLink(link, i, links.length);
      i++;
      // 间隔逻辑已在 loadUploadDoc 内部处理，这里不再额外 sleep
    }
  }

  function debounce(fn, delay) {
    let timer = null;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  const debouncedScan = debounce(scanAllLinks, 500);

  /**
   * ========================= 启动与监听 =========================
   */

  // 初次进入关注页时执行扫描
  scanAllLinks();

  // 监听 SPA 内的 DOM 变化：翻页、切换分组、切换排序等操作会重新渲染列表
  const root = document.getElementById('app') || document.body;
  const observer = new MutationObserver(() => {
    debouncedScan();
  });
  observer.observe(root, { childList: true, subtree: true });

  log('脚本已挂载 MutationObserver');
})();
