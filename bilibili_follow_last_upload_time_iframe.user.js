// ==UserScript==
// @name         Bilibili Follow Page - Last Upload Time (iframe)
// @namespace    https://github.com/ShineMinxing/BrowserJavaScript
// @version      1.0.0
// @author       ShineMinxing
// @description  在 B站关注页（/relation/follow）下方显示每个关注UP主最近一次投稿的时间。
// @description:zh-CN 在 B站关注页（/relation/follow）下方显示每个关注UP主最近一次投稿的时间。
//               通过隐藏 iframe 顺序打开各UP的 /upload/video 页面，从页面 DOM 中解析投稿时间，避免接口风控与 CORS 限制。
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
  banner.textContent = '【LastVideo iframe v1.0】';
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

  // 将时间戳转换为“xx分钟前 / xx天前 / xx个月前”等字符串
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
   * ========================= iframe 管理 =========================
   *
   * 核心思路：
   *  - 在同域（space.bilibili.com）下创建一个隐藏 iframe。
   *  - 依次将 iframe.src 设置为各个 UP 的 /upload/video 页面。
   *  - 等页面 onload + IFRAME_RENDER_WAIT 毫秒后，从 iframe 的 DOM 中读取视频卡片的时间字段。
   *  - 为了防止并发 & 过快请求导致风控，使用队列方式顺序加载，并在两个 UP 之间插入 LOAD_INTERVAL 间隔。
   */

  // 隐藏 iframe，只用于加载各个 UP 的 upload/video 页面
  const iframe = document.createElement('iframe');
  iframe.style.position = 'fixed';
  iframe.style.bottom = '0';
  iframe.style.right = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = 'none';
  iframe.style.visibility = 'hidden';
  // 不设置 sandbox，保持与顶层页面相同的权限，方便读取 contentDocument
  document.body.appendChild(iframe);

  let iframeBusy = false; // 简单的“锁”，保证同一时间只处理一个 mid
  const resultCache = new Map(); // mid -> { ts: number|null, why: string|null }

  /**
   * 加载单个 UP 的 upload/video 页面，并解析出最近一次投稿时间。
   * @param {string} mid - UP 主的 mid
   * @returns {Promise<{ts: number|null, why: string|null}>}
   */
  async function loadUploadDoc(mid) {
    // 先看缓存，避免重复解析同一 mid
    if (resultCache.has(mid)) {
      return resultCache.get(mid);
    }

    // 保证只会串行地使用 iframe
    while (iframeBusy) {
      await sleep(200);
    }
    iframeBusy = true;

    const url = `https://space.bilibili.com/${mid}/upload/video`;
    log('加载 upload/video 页面:', url);

    const result = { ts: null, why: null };

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

      // 解析 iframe 文档中的视频时间列表，返回最新一条的时间戳
      const ts = parseLastVideoTimeFromDoc(doc);
      if (!ts) {
        result.ts = null;
        result.why = 'parse_failed';
      } else {
        result.ts = ts;
        result.why = null;
      }
    } catch (e) {
      console.error('[LastVideo iframe] 加载 upload 页面失败 mid=', mid, e);
      result.ts = null;
      result.why = e && e.message ? e.message : 'load_error';
    } finally {
      iframeBusy = false;
      // 写入缓存
      resultCache.set(mid, result);
      // 两个 UP 之间插入间隔，防止频率过高
      await sleep(LOAD_INTERVAL);
    }

    return result;
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

  // 在关注卡片中为每个 UP 添加一行“最近投稿：xxx”
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

  // 从关注页的个人空间链接中抽取 mid
  function extractMidFromLink(link) {
    const href = link.href || link.getAttribute('href') || '';
    // 典型形式: https://space.bilibili.com/3537120496978247?spm_xxx
    const m = href.match(/space\.bilibili\.com\/(\d+)(?=[\/\?]|$)/);
    if (!m) return null;
    return m[1];
  }

  // 处理单个关注项
  async function processLink(link, idx, total) {
    const mid = extractMidFromLink(link);
    if (!mid) {
      log('解析 mid 失败 link=', link);
      return;
    }

    const line = ensureInfoLine(link);

    // 若已有缓存，先展示缓存结果，再异步刷新
    if (resultCache.has(mid)) {
      const cached = resultCache.get(mid);
      if (cached.ts) {
        const diff = formatDiff(cached.ts);
        const exact = new Date(cached.ts).toLocaleString();
        line.textContent = `最近投稿：${diff}（${exact}，缓存）`;
      } else {
        line.textContent = '最近投稿：无记录（缓存）';
      }
    } else {
      line.textContent = `最近投稿：加载中 (${idx + 1}/${total})…`;
    }

    const { ts, why } = await loadUploadDoc(mid);

    if (!ts) {
      if (why === 'parse_failed') {
        line.textContent = '最近投稿：解析失败';
      } else if (why === 'iframe_timeout') {
        line.textContent = '最近投稿：页面加载超时';
      } else if (why === 'iframe_onerror') {
        line.textContent = '最近投稿：页面错误';
      } else {
        line.textContent = `最近投稿：无法获取(${why || 'unknown'})`;
      }
    } else {
      const diff = formatDiff(ts);
      const exact = new Date(ts).toLocaleString();
      line.textContent = `最近投稿：${diff}（${exact}）`;
    }
  }

  // 扫描当前页所有关注的 UP，并串行处理
  async function scanAllLinks() {
    const links = Array.from(document.querySelectorAll('a.relation-card-info__uname'));
    infoSpan.textContent = ' | 本次扫描UP数：' + links.length;
    log('关注页扫描到 UP 数 =', links.length);

    let i = 0;
    for (const link of links) {
      await processLink(link, i, links.length);
      i++;
      // 间隔逻辑已在 loadUploadDoc 中实现，这里无需再额外 sleep
    }
  }

  // 简单的防抖封装：避免 MutationObserver 高频触发时重复扫描
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
