/*
 * CivicWorkDesk update bootstrap (Phase 6), served by civic-server at /api/civic/start.
 *
 * The launcher and the installer's finish step open this page instead of the application root, because
 * after a program upgrade the root can keep running the previous version: the browser's service worker
 * answers navigations from its own cache until a newer worker is found and activated, and the previous
 * candidate showed that can take seconds or many minutes (docs/phase-5.1-runtime-update-safety.md, §1).
 * This page is under /api/, the one path the application's worker never answers with the application
 * shell, so it always comes from the server that is actually installed.
 *
 * Before entering the application it establishes that the interface generation the browser WILL run at
 * `/` is the generation the installed release expects:
 *
 *   1. the expected generation comes from the server (/api/civic/runtime), which reads the active
 *      release's app-generation.json;
 *   2. the generation the browser will run is read the way a navigation would get it: `/index.html`
 *      fetched by this page, which the controlling worker answers from its own cache exactly as it would
 *      answer a navigation to `/`;
 *   3. the browser is asked for an update now (registration.update()) instead of waiting for its own
 *      periodic check;
 *   4. when a newer worker is waiting, the waiting worker is asked which windows of the origin are open
 *      (CIVIC_WINDOW_CLIENTS, the Phase-5.1 protocol). Activation is offered only when no other
 *      application window is open, only as an explicit choice (进入新版本), and only after asking again.
 *      An answer that is missing, late, malformed or of another protocol version is unknown, never
 *      "no other window";
 *   5. after the switch, the generation the browser will run is read again; only a match enters `/`.
 *
 * Every wait is bounded and every failure ends on a stated page with a way to retry. Nothing here clears
 * a cache, touches IndexedDB, unregisters a worker, closes or reloads another page, or changes the origin.
 * The state is published on <body data-state> for the acceptance suites.
 */
(function () {
  'use strict';

  var PROTOCOL = { type: 'CIVIC_WINDOW_CLIENTS', version: 1 };
  var RESULT_TYPE = 'CIVIC_WINDOW_CLIENTS_RESULT';
  var KINDS = ['application', 'bootstrap', 'platform', 'service', 'outside-scope'];
  var ROUTES = ['dashboard', 'work', 'honors', 'ledger', 'reports', 'settings'];
  var GENERATION = /^ui-[A-Za-z0-9_-]{6,64}$/;
  var ENTRY = /assets\/index-([A-Za-z0-9_-]{6,64})\.js/;
  /* Installed Edge has held a first update() back for about 60 s after a fresh install and reload. */
  var LIMITS = { fetch: 10000, update: 150000, install: 60000, answer: 3000, switch: 30000 };
  var RELOAD_KEY = 'civic-start-reloaded';
  var DIAG = '请运行开始菜单中的“收集诊断信息”，并将生成的诊断文件（TXT）反馈给维护人员。';

  var MESSAGES = {
    checking: '正在检查程序版本…',
    updating: '正在检查新版本，可能需要一两分钟，请稍候…',
    opening: '正在打开政务工作记录台…',
    ready: '新版本已准备就绪。请点击“进入新版本”继续。',
    confirming: '正在确认没有其他政务工作记录台页面仍在打开…',
    switching: '正在切换到新版本，请稍候…',
    blocked:
      '检测到其他政务工作记录台页面仍在打开。请先保存其中尚未保存的内容并关闭这些页面，然后再进入新版本。',
    blockedCount: '仍在打开的其他页面：{0} 个。关闭后请点击“重试”。',
    unknown:
      '暂时无法确认是否还有其他政务工作记录台页面正在打开。请先保存并关闭其他政务工作记录台页面，然后点击“重试”。',
    runtime:
      '无法读取已安装程序的版本信息，为避免使用不一致的版本，暂不打开应用。请点击“重试”；如仍无法打开，' +
      DIAG,
    origin:
      '当前地址不是政务工作记录台的固定访问地址。记录保存在固定访问地址 {0} 下，请从开始菜单打开政务工作记录台。',
    incoherent:
      '本地服务提供的页面与已安装程序的版本不一致，暂不打开应用。请点击“重试”；如仍无法打开，' +
      DIAG,
    uncontrolled: '无法确认浏览器将使用的页面版本。请点击“重试”。',
    stale:
      '浏览器仍在使用旧版本页面，暂时未能取得新版本。请点击“重试”；如多次重试仍不成功，请关闭所有政务工作记录台页面后从开始菜单重新打开，或' +
      DIAG,
    updateTimeout: '检查新版本用时过长，尚未完成。请点击“重试”。',
    switchTimeout: '切换到新版本用时过长，尚未完成。请点击“重试”。',
    afterSwitch:
      '切换后浏览器提供的页面版本仍与已安装程序不一致，为避免使用旧版本，暂不进入应用。请点击“重试”；如仍不成功，' +
      DIAG,
    unexpected: '检查程序版本时出现意外错误，暂不打开应用。请点击“重试”；如仍不成功，' + DIAG,
  };

  var facts = {};
  var running = false;
  var switching = false;
  var recheck = false;

  function byId(id) {
    return document.getElementById(id);
  }

  function format(text, value) {
    return text.replace('{0}', String(value));
  }

  function show(state, message, options) {
    var opts = options || {};
    document.body.setAttribute('data-state', state);
    byId('message').textContent = message;
    byId('detail').textContent = opts.detail || '';
    byId('enter').hidden = !opts.enter;
    byId('enter').disabled = false;
    byId('retry').hidden = !opts.retry;
    byId('retry').disabled = false;
    byId('facts').textContent = Object.keys(facts)
      .map(function (key) {
        return key + ': ' + facts[key];
      })
      .join('\n');
  }

  function within(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        var error = new Error(label + ' timed out after ' + ms + ' ms');
        error.timedOut = true;
        reject(error);
      }, ms);
      promise.then(
        function (value) {
          clearTimeout(timer);
          resolve(value);
        },
        function (error) {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  function session(action, value) {
    try {
      if (action === 'get') return window.sessionStorage.getItem(RELOAD_KEY);
      if (action === 'set') window.sessionStorage.setItem(RELOAD_KEY, value);
      if (action === 'clear') window.sessionStorage.removeItem(RELOAD_KEY);
    } catch (error) {
      return null;
    }
    return null;
  }

  /* 1. What the installed release expects. */
  async function readExpected() {
    var response = await within(
      fetch('/api/civic/runtime', { cache: 'no-store', credentials: 'omit', redirect: 'error' }),
      LIMITS.fetch,
      'runtime',
    );
    if (!response.ok) throw new Error('runtime answered ' + response.status);
    var doc = await response.json();
    if (!doc || doc.schema !== 'civic-runtime/1' || !GENERATION.test(doc.appGeneration)) {
      throw new Error('runtime answer is malformed');
    }
    return doc;
  }

  /* 2. What a navigation to `/` would run, answered by the same worker that would answer it. */
  async function readServed() {
    var response = await within(
      fetch('/index.html', { cache: 'no-store', credentials: 'omit' }),
      LIMITS.fetch,
      'index.html',
    );
    if (!response.ok) throw new Error('index.html answered ' + response.status);
    var match = ENTRY.exec(await response.text());
    return match ? 'ui-' + match[1] : null;
  }

  function unknown(reason) {
    return { status: 'unknown', reason: reason };
  }

  /* The Phase-5.1 window-awareness answer, read strictly: anything short of it is unknown. */
  function interpret(data) {
    if (!data || typeof data !== 'object' || data.type !== RESULT_TYPE) return unknown('malformed');
    if (data.version !== PROTOCOL.version) return unknown('unsupported-version');
    if (data.worker !== 'installed' && data.worker !== 'unknown')
      return unknown('worker-not-waiting');
    if (!Array.isArray(data.windows)) return unknown('malformed');
    var requesters = 0;
    var others = 0;
    for (var i = 0; i < data.windows.length; i += 1) {
      var entry = data.windows[i];
      var valid =
        entry &&
        typeof entry === 'object' &&
        typeof entry.requester === 'boolean' &&
        KINDS.indexOf(entry.kind) !== -1 &&
        (entry.route === null || ROUTES.indexOf(entry.route) !== -1) &&
        (entry.visibility === 'visible' || entry.visibility === 'hidden') &&
        typeof entry.focused === 'boolean';
      if (!valid) return unknown('malformed');
      if (entry.requester) requesters += 1;
      else if (entry.kind === 'application') others += 1;
    }
    if (requesters !== 1)
      return unknown(requesters === 0 ? 'requester-not-identified' : 'malformed');
    return others === 0 ? { status: 'safe' } : { status: 'blocked', others: others };
  }

  /* 4. Ask the waiting worker which windows are open. Resolves, never rejects. */
  function askWindows(worker) {
    return new Promise(function (resolve) {
      var channel;
      try {
        channel = new MessageChannel();
      } catch (error) {
        resolve(unknown('query-failed'));
        return;
      }
      var settled = false;
      var timer = setTimeout(function () {
        finish(unknown('no-answer'));
      }, LIMITS.answer);
      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        channel.port1.onmessage = null;
        channel.port1.close();
        resolve(result);
      }
      channel.port1.onmessage = function (event) {
        finish(interpret(event.data));
      };
      try {
        worker.postMessage({ type: PROTOCOL.type, version: PROTOCOL.version }, [channel.port2]);
      } catch (error) {
        finish(unknown('query-failed'));
      }
    });
  }

  async function askFresh(registration) {
    var worker = registration.waiting;
    if (!worker) return unknown('no-waiting-worker');
    var answer = await askWindows(worker);
    // The answer is about that worker; a different one waiting now has not been asked.
    if (registration.waiting !== worker) return unknown('waiting-worker-changed');
    return answer;
  }

  function showAnswer(answer) {
    facts.windows =
      answer.status === 'blocked'
        ? 'blocked, ' + answer.others + ' other application window(s)'
        : answer.status === 'unknown'
          ? 'unknown (' + answer.reason + ')'
          : 'safe';
    if (answer.status === 'blocked') {
      show('blocked', MESSAGES.blocked, {
        detail: format(MESSAGES.blockedCount, answer.others),
        retry: true,
      });
    } else if (answer.status === 'unknown') {
      show('unknown', MESSAGES.unknown, { retry: true });
    } else {
      show('ready', MESSAGES.ready, { enter: true });
    }
  }

  function waitForInstall(registration) {
    var worker = registration.installing;
    if (!worker) return Promise.resolve();
    return within(
      new Promise(function (resolve) {
        function settle() {
          if (worker.state !== 'installing') {
            worker.removeEventListener('statechange', settle);
            resolve();
          }
        }
        worker.addEventListener('statechange', settle);
        settle();
      }),
      LIMITS.install,
      'installation',
    );
  }

  function waitForNewController(previous) {
    return within(
      new Promise(function (resolve) {
        if (navigator.serviceWorker.controller !== previous) {
          resolve();
          return;
        }
        navigator.serviceWorker.addEventListener('controllerchange', function once() {
          navigator.serviceWorker.removeEventListener('controllerchange', once);
          resolve();
        });
      }),
      LIMITS.switch,
      'switch',
    );
  }

  function enter() {
    switching = true;
    show('opening', MESSAGES.opening);
    window.location.replace('/');
  }

  async function check() {
    if (switching) return;
    if (running) {
      recheck = true;
      return;
    }
    running = true;
    try {
      show('checking', MESSAGES.checking);
      var expected;
      try {
        expected = await readExpected();
      } catch (error) {
        facts.runtime = String(error);
        show('error-runtime', MESSAGES.runtime, { retry: true });
        return;
      }
      facts.expected = expected.appGeneration;
      if (expected.releaseId) facts.release = expected.releaseId;
      if (expected.canonicalOrigin && window.location.origin !== expected.canonicalOrigin) {
        show('error-origin', format(MESSAGES.origin, expected.canonicalOrigin));
        return;
      }
      if (!('serviceWorker' in navigator)) {
        enter();
        return;
      }
      var registration = await navigator.serviceWorker.getRegistration('/');
      if (!registration) {
        // First run: nothing is cached, so `/` comes from the server itself.
        var first = await readServed();
        facts.served = String(first);
        if (first === expected.appGeneration) enter();
        else show('error-incoherent', MESSAGES.incoherent, { retry: true });
        return;
      }
      if (registration.active && !navigator.serviceWorker.controller) {
        // Loaded past the worker (a forced reload): what `/` will run cannot be read from here.
        if (session('get') !== '1') {
          session('set', '1');
          window.location.reload();
          return;
        }
        show('error-uncontrolled', MESSAGES.uncontrolled, { retry: true });
        return;
      }
      session('clear');

      show('updating', MESSAGES.updating);
      try {
        await within(registration.update(), LIMITS.update, 'update');
      } catch (error) {
        facts.update = String(error);
        if (error && error.timedOut) {
          show('error-update-timeout', MESSAGES.updateTimeout, { retry: true });
          return;
        }
        // An update check that fails outright (offline, for instance) leaves the installed state to judge.
      }
      try {
        await waitForInstall(registration);
      } catch (error) {
        facts.install = String(error);
        show('error-update-timeout', MESSAGES.updateTimeout, { retry: true });
        return;
      }

      var served = await readServed();
      facts.served = String(served);
      if (served === expected.appGeneration) {
        enter();
        return;
      }
      if (!registration.waiting) {
        show('error-stale', MESSAGES.stale, { retry: true });
        return;
      }
      showAnswer(await askFresh(registration));
    } catch (error) {
      facts.error = String(error);
      show('error-unexpected', MESSAGES.unexpected, { retry: true });
    } finally {
      running = false;
      if (recheck && !switching) {
        recheck = false;
        setTimeout(check, 0);
      }
    }
  }

  /* The user's explicit choice. Asks again, activates, then verifies before entering. */
  async function enterNewVersion() {
    if (running || switching) return;
    running = true;
    byId('enter').disabled = true;
    try {
      show('confirming', MESSAGES.confirming);
      var expected = await readExpected();
      var registration = await navigator.serviceWorker.getRegistration('/');
      if (!registration || !registration.waiting) {
        running = false;
        check();
        return;
      }
      var worker = registration.waiting;
      var answer = await askFresh(registration);
      if (answer.status !== 'safe') {
        showAnswer(answer);
        return;
      }
      switching = true;
      show('switching', MESSAGES.switching);
      var changed = waitForNewController(navigator.serviceWorker.controller);
      worker.postMessage({ type: 'SKIP_WAITING' });
      try {
        await changed;
      } catch (error) {
        switching = false;
        facts.switch = String(error);
        show('error-switch-timeout', MESSAGES.switchTimeout, { retry: true });
        return;
      }
      var served = await readServed();
      facts.served = String(served);
      if (served === expected.appGeneration) {
        enter();
        return;
      }
      switching = false;
      show('error-after-switch', MESSAGES.afterSwitch, { retry: true });
    } catch (error) {
      switching = false;
      facts.error = String(error);
      show('error-unexpected', MESSAGES.unexpected, { retry: true });
    } finally {
      running = false;
    }
  }

  byId('retry').addEventListener('click', function () {
    byId('retry').disabled = true;
    check();
  });
  byId('enter').addEventListener('click', function () {
    enterNewVersion();
  });
  if ('serviceWorker' in navigator) {
    // A switch made elsewhere (an older page's own 应用更新, say) changes what `/` would run: look again.
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!switching) check();
    });
  }
  check();
})();
