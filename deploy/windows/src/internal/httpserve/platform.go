package httpserve

import (
	"fmt"
	"net/http"
	"strings"
)

// servePlatformPage serves the browser-platform field check at /__civic/platform.
//
// ## Why this page exists and why it is not part of the product
//
// Whether the browser on a colleague's machine really supports what CivicWorkDesk needs -- an origin
// that stays put, IndexedDB, a service worker, Cache Storage, Web Crypto -- can only be measured by
// code running in that browser at that origin. The Stage-A probe could not answer it, because there
// was no server to provide an origin. It is served from the deployment namespace rather than added to
// the application so that normal product UX is untouched: nothing in the app links here, and the page
// disappears when the deployment does.
//
// ## What it is careful not to break
//
// It never registers a service worker of its own, never unregisters the application's, and never
// deletes an application cache or database. Its two mutating probes create and then remove artefacts
// under names beginning `__civic_platform_probe`, which the application does not use. Confirming that
// IndexedDB and Cache Storage actually work requires writing something; confining the write to a
// private name and removing it is the least intrusive way to do that.
func servePlatformPage(w http.ResponseWriter, r *http.Request, cfg Config) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		methodNotAllowed(w)
		return
	}
	body := strings.ReplaceAll(platformHTML, "__EXPECTED_ORIGIN__", cfg.Health.CanonicalOrigin)
	body = strings.ReplaceAll(body, "__RELEASE_ID__", cfg.Health.ReleaseID)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", fmt.Sprint(len(body)))
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodGet {
		_, _ = w.Write([]byte(body))
	}
}

const platformHTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CivicWorkDesk 浏览器平台检查</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.7 "Microsoft YaHei", "Segoe UI", sans-serif; margin: 0; padding: 24px;
         max-width: 900px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #666; margin: 0 0 20px; }
  table { border-collapse: collapse; width: 100%; margin: 16px 0; }
  th, td { text-align: left; padding: 7px 10px; border-bottom: 1px solid rgba(128,128,128,.3);
           vertical-align: top; }
  th { font-weight: 600; white-space: nowrap; }
  td.v { font-family: Consolas, monospace; font-size: 13px; word-break: break-all; }
  .tag { display: inline-block; min-width: 88px; text-align: center; padding: 1px 8px;
         border-radius: 3px; font-family: Consolas, monospace; font-size: 12px; }
  .ok   { background: #d9f2d9; color: #14531d; }
  .bad  { background: #fadadd; color: #6b1420; }
  .warn { background: #fdf0d5; color: #6b4b14; }
  .info { background: #e6e9ef; color: #333; }
  section { border: 1px solid rgba(128,128,128,.35); border-radius: 6px; padding: 14px 18px;
            margin: 18px 0; }
  textarea { width: 100%; height: 220px; font-family: Consolas, monospace; font-size: 12px; }
  button { font: inherit; padding: 6px 14px; margin-right: 8px; }
  @media (prefers-color-scheme: dark) {
    .ok { background:#1d3a23; color:#bfe9c6 } .bad { background:#45191f; color:#f3c3c9 }
    .warn { background:#453619; color:#f0dcb0 } .info { background:#2b2f36; color:#dcdfe4 }
    p.sub { color:#9aa0a6 }
  }
</style>
</head>
<body>
<h1>CivicWorkDesk 浏览器平台检查</h1>
<p class="sub">这个页面只做测量，不改动你的记录，也不注册自己的 Service Worker。程序版本 <code>__RELEASE_ID__</code></p>

<table id="results"><tbody></tbody></table>

<section>
  <h2 style="font-size:16px;margin:0 0 8px">离线检查（需要手动一步）</h2>
  <p style="margin:0 0 8px">上面的检查都不需要断网。真正要确认的是：<b>本地服务停止之后，应用是否还能打开</b>。</p>
  <ol style="margin:0 0 8px;padding-left:22px">
    <li>先正常打开一次“政务工作记录台”，等页面完全加载；</li>
    <li>开始菜单 → 政务工作记录台 → 维护工具 → <b>停止本地服务</b>；</li>
    <li>回到应用页面按 <kbd>Ctrl</kbd>+<kbd>R</kbd> 刷新。</li>
  </ol>
  <p style="margin:0"><b>页面仍能打开</b>＝离线缓存生效；<b>页面打不开</b>＝请将该结果一并反馈。</p>
</section>

<section>
  <h2 style="font-size:16px;margin:0 0 8px">反馈</h2>
  <p style="margin:0 0 8px">点“复制全部结果”，将结果反馈给维护人员即可。</p>
  <button id="copy">复制全部结果</button>
  <button id="save">另存为 txt</button>
  <textarea id="text" readonly></textarea>
</section>

<script>
(function () {
  'use strict';
  var EXPECTED = '__EXPECTED_ORIGIN__';
  var PROBE = '__civic_platform_probe';
  var rows = [];
  var tbody = document.querySelector('#results tbody');

  function add(name, tag, value) {
    rows.push({ name: name, tag: tag, value: String(value) });
    var tr = document.createElement('tr');
    var th = document.createElement('th');
    th.textContent = name;
    var td1 = document.createElement('td');
    var span = document.createElement('span');
    span.className = 'tag ' + (tag === 'PASS' ? 'ok' : tag === 'FAIL' ? 'bad'
                              : tag === 'ABSENT' ? 'warn' : 'info');
    span.textContent = tag;
    td1.appendChild(span);
    var td2 = document.createElement('td');
    td2.className = 'v';
    td2.textContent = String(value);
    tr.appendChild(th); tr.appendChild(td1); tr.appendChild(td2);
    tbody.appendChild(tr);
    render();
  }

  function render() {
    var lines = ['CivicWorkDesk 浏览器平台检查', '程序版本: __RELEASE_ID__',
                 '采集时间: ' + new Date().toISOString(), ''];
    rows.forEach(function (r) {
      lines.push('[' + r.tag + '] ' + r.name + ': ' + r.value);
    });
    document.getElementById('text').value = lines.join('\n') + '\n';
  }

  // --- origin: the single hard compatibility invariant -------------------------------------------
  add('location.origin', location.origin === EXPECTED ? 'PASS' : 'FAIL',
      location.origin + (location.origin === EXPECTED ? '' : '  (应为 ' + EXPECTED + ')'));
  add('location.href', 'INFO', location.href);
  add('isSecureContext', window.isSecureContext ? 'PASS' : 'FAIL',
      String(window.isSecureContext) + '  (127.0.0.1 应视为安全上下文)');
  add('userAgent', 'INFO', navigator.userAgent);

  // --- Web Crypto -------------------------------------------------------------------------------
  if (!window.crypto) {
    add('crypto', 'ABSENT', 'window.crypto 不存在');
  } else {
    add('crypto.randomUUID', typeof crypto.randomUUID === 'function' ? 'PASS' : 'ABSENT',
        typeof crypto.randomUUID === 'function' ? '可用' : '不存在');
    if (crypto.subtle && typeof crypto.subtle.digest === 'function') {
      crypto.subtle.digest('SHA-256', new Uint8Array([1, 2, 3])).then(function (buf) {
        add('crypto.subtle.digest', buf && buf.byteLength === 32 ? 'PASS' : 'FAIL',
            'SHA-256 返回 ' + (buf ? buf.byteLength : 0) + ' 字节');
      }).catch(function (e) { add('crypto.subtle.digest', 'FAIL', String(e)); });
    } else {
      add('crypto.subtle', 'ABSENT', 'crypto.subtle 不存在（http 下部分浏览器会隐藏）');
    }
  }

  // --- IndexedDB: open a private probe database, then delete it ----------------------------------
  if (!window.indexedDB) {
    add('IndexedDB', 'ABSENT', 'window.indexedDB 不存在');
  } else {
    try {
      var req = indexedDB.open(PROBE, 1);
      req.onupgradeneeded = function () { req.result.createObjectStore('s'); };
      req.onsuccess = function () {
        var db = req.result;
        try {
          var tx = db.transaction('s', 'readwrite');
          tx.objectStore('s').put({ ok: true }, 'k');
          tx.oncomplete = function () {
            var tx2 = db.transaction('s', 'readonly');
            var get = tx2.objectStore('s').get('k');
            get.onsuccess = function () {
              add('IndexedDB 读写', get.result && get.result.ok ? 'PASS' : 'FAIL',
                  JSON.stringify(get.result));
              db.close();
              indexedDB.deleteDatabase(PROBE);
            };
            get.onerror = function () { add('IndexedDB 读写', 'FAIL', String(get.error)); };
          };
          tx.onerror = function () { add('IndexedDB 写入', 'FAIL', String(tx.error)); };
        } catch (e) { add('IndexedDB 事务', 'FAIL', String(e)); }
      };
      req.onerror = function () { add('IndexedDB 打开', 'FAIL', String(req.error)); };
      req.onblocked = function () { add('IndexedDB 打开', 'FAIL', 'blocked'); };
    } catch (e) { add('IndexedDB', 'FAIL', String(e)); }
  }

  // --- Cache Storage ----------------------------------------------------------------------------
  if (!window.caches) {
    add('Cache Storage', 'ABSENT', 'window.caches 不存在');
  } else {
    caches.open(PROBE).then(function (c) {
      return c.put(new Request('/__civic/platform'), new Response('probe'))
        .then(function () { return c.match('/__civic/platform'); })
        .then(function (m) {
          add('Cache Storage 读写', m ? 'PASS' : 'FAIL', m ? '命中' : '未命中');
          return caches.delete(PROBE);
        });
    }).catch(function (e) { add('Cache Storage', 'FAIL', String(e)); });

    caches.keys().then(function (keys) {
      var appKeys = keys.filter(function (k) { return k.indexOf(PROBE) !== 0; });
      add('已有缓存键数量', 'INFO', appKeys.length + ' 个: ' + (appKeys.join(', ') || '(无)'));
    }).catch(function (e) { add('缓存键列举', 'FAIL', String(e)); });
  }

  // --- Service Worker: read registrations, never touch them --------------------------------------
  if (!('serviceWorker' in navigator)) {
    add('Service Worker', 'ABSENT', 'navigator.serviceWorker 不存在');
  } else {
    add('Service Worker API', 'PASS', '可用');
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      add('Service Worker 注册数', regs.length > 0 ? 'PASS' : 'ABSENT',
          regs.length + ' 个' + (regs.length === 0 ? '（先正常打开一次应用再来看这一项）' : ''));
      regs.forEach(function (r, i) {
        var w = r.active || r.waiting || r.installing;
        add('注册 #' + (i + 1), 'INFO',
            'scope=' + r.scope + '  script=' + (w ? w.scriptURL : '?') +
            '  state=' + (w ? w.state : '?'));
      });
    }).catch(function (e) { add('Service Worker 注册', 'FAIL', String(e)); });
  }

  // --- storage estimate -------------------------------------------------------------------------
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then(function (e) {
      add('存储配额', 'INFO', '已用 ' + Math.round((e.usage || 0) / 1024) + ' KiB / 配额 ' +
          Math.round((e.quota || 0) / 1048576) + ' MiB');
    }).catch(function () {});
  }
  if (navigator.storage && navigator.storage.persisted) {
    navigator.storage.persisted().then(function (p) {
      add('持久化存储', 'INFO', p ? '已授予' : '未授予（浏览器可能在磁盘紧张时清理）');
    }).catch(function () {});
  }

  document.getElementById('copy').onclick = function () {
    var ta = document.getElementById('text');
    ta.select();
    try { document.execCommand('copy'); this.textContent = '已复制'; }
    catch (e) { this.textContent = '请手动全选复制'; }
  };
  document.getElementById('save').onclick = function () {
    var blob = new Blob([document.getElementById('text').value],
                        { type: 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'CivicWorkDesk-浏览器检查.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  };
  render();
})();
</script>
</body>
</html>
`
