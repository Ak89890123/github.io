#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const DEFAULT_RUNS = 3;
const FRAME_BUDGET_MS = 1000 / 60;
const NAVIGATION_IDLE_MS = 1200;
const SCROLL_DURATION_MS = 7000;
const MOBILE_METRICS = {
  width: 390,
  height: 844,
  deviceScaleFactor: 1,
  mobile: true,
};
const DESKTOP_METRICS = {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false,
};

const BENCHMARK_SCRIPT = String.raw`(() => {
  if (window.__resumePerformanceBenchmark) return;

  const state = {
    mode: 'idle',
    startedAt: 0,
    frames: [],
    lastFrameTime: null,
    frameHandle: 0,
    observers: [],
    lcp: null,
    fcp: null,
    cls: 0,
    clsCulprits: [],
    longTasks: [],
    events: [],
  };

  const selectorFor = (element) => {
    if (!element || !element.tagName) return null;
    const id = element.id ? '#' + element.id : '';
    const className = typeof element.className === 'string'
      ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map((name) => '.' + name).join('')
      : '';
    return element.tagName.toLowerCase() + id + className;
  };

  const observe = (type, callback, options = { buffered: true }) => {
    if (!('PerformanceObserver' in window) || !PerformanceObserver.supportedEntryTypes?.includes(type)) return;
    const observer = new PerformanceObserver((list) => list.getEntries().forEach(callback));
    observer.observe({ type, ...options });
    state.observers.push(observer);
  };

  const stopFrameSampler = () => {
    if (state.frameHandle) cancelAnimationFrame(state.frameHandle);
    state.frameHandle = 0;
  };

  const sampleFrame = (time) => {
    if (state.mode === 'idle') return;
    if (state.lastFrameTime !== null) state.frames.push(time - state.lastFrameTime);
    state.lastFrameTime = time;
    state.frameHandle = requestAnimationFrame(sampleFrame);
  };

  const reset = (mode) => {
    stopFrameSampler();
    state.observers.forEach((observer) => observer.disconnect());
    state.observers = [];
    state.mode = mode;
    state.startedAt = performance.now();
    state.frames = [];
    state.lastFrameTime = null;
    state.lcp = null;
    state.fcp = null;
    state.cls = 0;
    state.clsCulprits = [];
    state.longTasks = [];
    state.events = [];
    performance.setResourceTimingBufferSize?.(2000);

    observe('largest-contentful-paint', (entry) => {
      state.lcp = {
        startTime: entry.startTime,
        size: entry.size,
        element: selectorFor(entry.element),
      };
    });
    observe('paint', (entry) => {
      if (entry.name === 'first-contentful-paint') state.fcp = entry.startTime;
    });
    observe('layout-shift', (entry) => {
      if (entry.hadRecentInput) return;
      state.cls += entry.value;
      entry.sources?.forEach((source) => {
        const selector = selectorFor(source.node);
        if (selector && !state.clsCulprits.includes(selector)) state.clsCulprits.push(selector);
      });
    });
    observe('longtask', (entry) => {
      if (entry.duration >= 50) state.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
    });
    observe('event', (entry) => {
      if (entry.duration >= 40) state.events.push({ name: entry.name, startTime: entry.startTime, duration: entry.duration });
    }, { buffered: true, durationThreshold: 40 });

    state.frameHandle = requestAnimationFrame(sampleFrame);
  };

  const snapshot = () => {
    const resources = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      initiatorType: entry.initiatorType,
      startTime: entry.startTime,
      responseEnd: entry.responseEnd,
      duration: entry.duration,
      transferSize: entry.transferSize || 0,
      encodedBodySize: entry.encodedBodySize || 0,
      decodedBodySize: entry.decodedBodySize || 0,
    }));
    const navigation = performance.getEntriesByType('navigation')[0];
    return {
      mode: state.mode,
      duration: performance.now() - state.startedAt,
      lcp: state.lcp,
      fcp: state.fcp,
      cls: state.cls,
      clsCulprits: state.clsCulprits,
      longTasks: state.longTasks,
      events: state.events,
      frames: state.frames,
      navigation: navigation ? {
        type: navigation.type,
        startTime: navigation.startTime,
        domContentLoadedEventEnd: navigation.domContentLoadedEventEnd,
        loadEventEnd: navigation.loadEventEnd,
        domInteractive: navigation.domInteractive,
        responseEnd: navigation.responseEnd,
        transferSize: navigation.transferSize || 0,
      } : null,
      resources,
    };
  };

  const lifecycle = () => ({
    domNodes: document.querySelectorAll('*').length,
    ...(globalThis.__resumeAnimationDebug?.() || {
      scrollTriggers: null,
      gsapAnimations: null,
    }),
    videos: [...document.querySelectorAll('video')].map((video) => ({
      source: video.currentSrc || video.src || null,
      paused: video.paused,
      readyState: video.readyState,
      currentTime: Number(video.currentTime.toFixed(3)),
    })),
    canvases: [...document.querySelectorAll('canvas')].map((canvas) => ({
      width: canvas.width,
      height: canvas.height,
    })),
    memory: performance.memory ? {
      usedJSHeapSize: performance.memory.usedJSHeapSize,
      totalJSHeapSize: performance.memory.totalJSHeapSize,
    } : null,
  });

  const mark = (name) => performance.mark('resume-benchmark:' + name);
  window.__resumePerformanceBenchmark = {
    start: reset,
    stop() {
      state.mode = 'idle';
      stopFrameSampler();
      state.observers.forEach((observer) => observer.disconnect());
      state.observers = [];
      return snapshot();
    },
    snapshot,
    lifecycle,
    mark,
  };

  if (location.search.includes('benchmark=1')) reset('navigation');
})();`;

export const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

export const percentile = (values, rank = 0.95) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * rank) - 1)];
};

export const summarizeFrames = (frames = []) => {
  const intervals = frames.slice(1).filter((value) => Number.isFinite(value) && value > 0);
  const dropped = intervals.reduce((total, interval) => (
    total + Math.max(0, Math.round(interval / FRAME_BUDGET_MS) - 1)
  ), 0);
  return {
    samples: intervals.length,
    fps: intervals.length ? 1000 / median(intervals) : null,
    medianFrameMs: median(intervals),
    p95FrameMs: percentile(intervals),
    maxFrameMs: intervals.length ? Math.max(...intervals) : null,
    droppedFrames: dropped,
    jankyFrameRatio: intervals.length ? intervals.filter((value) => value > FRAME_BUDGET_MS * 1.5).length / intervals.length : null,
  };
};

export const summarizeResources = (resources = []) => {
  const relevant = resources.filter((resource) => !resource.name.startsWith('data:'));
  const transferBytes = relevant.reduce((sum, resource) => sum + (resource.transferSize || 0), 0);
  const decodedBytes = relevant.reduce((sum, resource) => sum + (resource.decodedBodySize || 0), 0);
  const byType = {};
  relevant.forEach((resource) => {
    const type = resource.initiatorType || 'other';
    byType[type] = (byType[type] || 0) + (resource.transferSize || 0);
  });
  return {
    requests: relevant.length,
    transferBytes,
    decodedBytes,
    byType,
    largest: [...relevant]
      .sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0))
      .slice(0, 10)
      .map(({ name, initiatorType, transferSize, decodedBodySize, responseEnd }) => ({
        name,
        initiatorType,
        transferSize,
        decodedBodySize,
        responseEnd,
      })),
  };
};

export const summarizeTrace = (events = []) => {
  const timed = events.filter((event) => Number.isFinite(event.dur));
  const totalMs = (names) => timed
    .filter((event) => names.includes(event.name))
    .reduce((sum, event) => sum + event.dur / 1000, 0);
  const traceLongTasks = timed.filter((event) => event.name === 'RunTask' && event.dur >= 50000);
  return {
    eventCount: events.length,
    longTaskCount: traceLongTasks.length,
    longTaskMs: traceLongTasks.reduce((sum, event) => sum + event.dur / 1000, 0),
    forcedLayoutCount: timed.filter((event) => ['UpdateLayoutTree', 'Layout'].includes(event.name)).length,
    forcedLayoutMs: totalMs(['UpdateLayoutTree', 'Layout']),
    paintCount: timed.filter((event) => ['Paint', 'RasterTask', 'PaintImage'].includes(event.name)).length,
    paintMs: totalMs(['Paint', 'RasterTask', 'PaintImage']),
    compositeCount: timed.filter((event) => ['Layerize', 'Commit', 'BeginCommitCompositorFrame'].includes(event.name)).length,
    compositeMs: totalMs(['Layerize', 'Commit', 'BeginCommitCompositorFrame']),
  };
};

export const summarizeRun = (snapshot = {}) => ({
  lcpMs: snapshot.lcp?.startTime ?? null,
  fcpMs: snapshot.fcp ?? null,
  cls: snapshot.cls ?? null,
  longTaskCount: snapshot.longTasks?.length ?? 0,
  longTaskMs: (snapshot.longTasks || []).reduce((sum, task) => sum + task.duration, 0),
  inputDelayMs: snapshot.events?.length ? Math.max(...snapshot.events.map((event) => event.duration)) : null,
  frames: summarizeFrames(snapshot.frames),
  resources: summarizeResources(snapshot.resources),
  navigation: snapshot.navigation,
});

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return 'n/a';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 ** 2).toFixed(2)} MiB`;
};

const formatMs = (value) => Number.isFinite(value) ? `${value.toFixed(0)} ms` : 'n/a';

const parseArgs = (argv) => {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    runs: DEFAULT_RUNS,
    label: 'baseline',
    output: 'output/performance-benchmark',
    skipBuild: false,
    selfTest: false,
    compare: null,
    only: 'all',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--runs') options.runs = Math.max(1, Number(argv[++index]));
    else if (arg === '--label') options.label = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--compare') options.compare = argv[++index];
    else if (arg === '--only') options.only = argv[++index];
  }
  return options;
};

const runSelfTest = () => {
  assert.equal(median([4, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(summarizeFrames([0, 16.67, 33.34]).droppedFrames, 1);
  assert.equal(summarizeResources([{ name: '/a.js', initiatorType: 'script', transferSize: 100, decodedBodySize: 200 }]).transferBytes, 100);
  assert.equal(summarizeTrace([{ name: 'RunTask', dur: 50001 }]).longTaskCount, 1);
  console.log('performance-benchmark self-test: ok');
};

const sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

const waitForPort = async (port, host = DEFAULT_HOST) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`http://${host}:${port}/`);
      if (response.ok) return;
    } catch {
      // Preview is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Preview did not start on port ${port}`);
};

const findFreePort = async () => new Promise((resolvePromise, reject) => {
  const server = createServer();
  server.once('error', reject);
  server.listen(0, DEFAULT_HOST, () => {
    const { port } = server.address();
    server.close(() => resolvePromise(port));
  });
});

const startPreview = async (options) => {
  if (!options.skipBuild) {
    execFileSync(process.platform === 'win32' ? process.env.ComSpec : 'npm', process.platform === 'win32'
      ? ['/d', '/s', '/c', 'npm run build']
      : ['run', 'build'], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }
  const port = options.port || await findFreePort();
  const previewCommand = `npm run preview -- --host ${options.host} --port ${port} --strictPort`;
  const preview = spawn(process.platform === 'win32' ? process.env.ComSpec : 'npm', process.platform === 'win32'
    ? ['/d', '/s', '/c', previewCommand]
    : ['run', 'preview', '--', '--host', options.host, '--port', String(port), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForPort(port, options.host);
  return { process: preview, port };
};

const chromePath = () => {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.CHROME_PATH,
    process.platform === 'win32' ? `${process.env.PROGRAMFILES || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe` : null,
    process.platform === 'win32' ? `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe` : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate));
};

class CdpClient {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.subscriptions = new Set();
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', reject, { once: true });
    });
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
  }

  async connect() {
    await this.ready;
    return this;
  }

  handleMessage(data) {
    const message = JSON.parse(typeof data === 'string' ? data : data.toString());
    if (message.id && this.pending.has(message.id)) {
      const { resolvePromise, rejectPromise } = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) rejectPromise(new Error(message.error.message));
      else resolvePromise(message.result);
      return;
    }
    for (const subscription of this.subscriptions) {
      if (subscription.method !== message.method) continue;
      if (subscription.sessionId && subscription.sessionId !== message.sessionId) continue;
      subscription.callback(message.params || {});
    }
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const message = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolvePromise, rejectPromise) => {
      this.pending.set(id, { resolvePromise, rejectPromise });
      this.socket.send(JSON.stringify(message));
    });
  }

  waitFor(method, sessionId, timeout = 30000) {
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.subscriptions.delete(subscription);
        rejectPromise(new Error(`Timed out waiting for ${method}`));
      }, timeout);
      const subscription = {
        method,
        sessionId,
        callback: (params) => {
          clearTimeout(timer);
          this.subscriptions.delete(subscription);
          resolvePromise(params);
        },
      };
      this.subscriptions.add(subscription);
    });
  }

  close() {
    this.socket.close();
  }
}

const launchChrome = async (metrics) => {
  const executable = chromePath();
  if (!executable) throw new Error('Chrome/Edge was not found. Set CHROME_BIN to a Chromium executable.');
  const debugPort = await findFreePort();
  const userDataDir = await mkdtemp(join(tmpdir(), 'resume-benchmark-chrome-'));
  const browserProcess = spawn(executable, [
    '--headless=new',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-extensions',
    '--disable-sync',
    '--mute-audio',
    '--no-first-run',
    '--no-sandbox',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${metrics.width},${metrics.height}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });

  let version;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      version = await (await fetch(`http://${DEFAULT_HOST}:${debugPort}/json/version`)).json();
      break;
    } catch {
      await sleep(100);
    }
  }
  if (!version?.webSocketDebuggerUrl) throw new Error('Chrome remote debugging endpoint did not start');
  const browser = await new CdpClient(version.webSocketDebuggerUrl).connect();
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    send: (method, params = {}) => browser.send(method, params, sessionId),
    waitFor: (method, timeout) => browser.waitFor(method, sessionId, timeout),
    waitForGlobal: (method, timeout) => browser.waitFor(method, undefined, timeout),
    evaluate: async (expression, awaitPromise = false) => {
      const result = await browser.send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
      if (result.result?.subtype === 'error') throw new Error(result.result.description || 'Runtime.evaluate failed');
      return result.result?.value;
    },
  };
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Network.enable');
  await page.send('Performance.enable');
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: BENCHMARK_SCRIPT });
  await setMetrics(page, metrics, false);
  return {
    browser,
    browserVersion: version.Browser || 'unknown',
    browserProcess,
    page,
    targetId,
    userDataDir,
    async close() {
      try { await browser.send('Target.closeTarget', { targetId }); } catch { /* already closed */ }
      browser.close();
      browserProcess.kill();
      await Promise.race([
        new Promise((resolvePromise) => browserProcess.once('exit', resolvePromise)),
        sleep(1000),
      ]);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {
        // Crashpad can hold one metrics file briefly after Chrome exits.
      });
    },
  };
};

const setMetrics = async (page, metrics, reducedMotion) => {
  await page.send('Emulation.setDeviceMetricsOverride', metrics);
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: metrics.mobile });
  await page.send('Emulation.setCPUThrottlingRate', { rate: metrics.mobile ? 4 : 1 });
  await page.send('Network.emulateNetworkConditions', metrics.mobile
    ? {
      offline: false,
      latency: 150,
      downloadThroughput: 1.6 * 1024 * 1024 / 8,
      uploadThroughput: 750 * 1024 / 8,
    }
    : {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
  await page.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' }],
  });
};

const navigate = async (page, url, { cacheDisabled = false } = {}) => {
  await page.send('Network.setCacheDisabled', { cacheDisabled });
  if (cacheDisabled) await page.send('Network.clearBrowserCache');
  const load = page.waitFor('Page.loadEventFired', 30000);
  await page.send('Page.navigate', { url: `${url}?benchmark=1&run=${Date.now()}` });
  await load;
  await page.evaluate(`(async () => {
    await document.fonts?.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  })()`, true);
  await sleep(NAVIGATION_IDLE_MS);
};

const evaluate = (page, expression) => page.evaluate(expression, true);

const runLoad = async (page, url, metrics, cacheMode, run) => {
  console.log(`load ${metrics.mobile ? 'mobile' : 'desktop'} ${cacheMode} run ${run}`);
  await setMetrics(page, metrics, false);
  if (cacheMode === 'warm') await navigate(page, url, { cacheDisabled: false });
  await navigate(page, url, { cacheDisabled: cacheMode === 'cold' });
  const snapshot = await evaluate(page, `window.__resumePerformanceBenchmark?.stop()`);
  return {
    case: `${metrics.mobile ? 'mobile' : 'desktop'}-${cacheMode}`,
    run,
    metrics,
    cacheMode,
    summary: summarizeRun(snapshot),
    raw: snapshot,
  };
};

const traceEvents = [];

const startTrace = async (page) => {
  traceEvents.length = 0;
  await page.send('Tracing.start', {
    transferMode: 'ReportEvents',
    categories: 'devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing,loading,netlog',
  });
};

const runScroll = async (page, direction, duration = SCROLL_DURATION_MS) => {
  return evaluate(page, `(async () => {
    const direction = ${JSON.stringify(direction)};
    const duration = ${duration};
    const start = window.scrollY;
    const max = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const target = direction === 'forward' ? max : 0;
    const sections = ['hero', 'about', 'skills', 'experience', 'contact']
      .map((id) => document.getElementById(id))
      .filter(Boolean)
      .map((element) => ({ id: element.id, top: element.offsetTop }));
    const seen = new Set();
    const started = performance.now();
    window.__resumePerformanceBenchmark?.mark('scroll-' + direction + '-start');
    document.documentElement.style.scrollBehavior = 'auto';
    while (true) {
      const progress = Math.min(1, (performance.now() - started) / duration);
      const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
      const y = start + (target - start) * eased;
      window.scrollTo(0, y);
      sections.forEach((section) => {
        if (!seen.has(section.id) && Math.abs(y - section.top) < innerHeight * 0.45) {
          seen.add(section.id);
          window.__resumePerformanceBenchmark?.mark('section-' + section.id + '-' + direction);
        }
      });
      if (progress >= 1) break;
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    window.scrollTo(0, target);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.__resumePerformanceBenchmark?.mark('scroll-' + direction + '-end');
    return { maxScroll: max, finalScroll: window.scrollY };
  })()`);
};

const capture = async (page, outputPath) => {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, Buffer.from(data, 'base64'));
};

const runRuntime = async (page, url, metrics, outputDir, run) => {
  console.log(`runtime ${metrics.mobile ? 'mobile' : 'desktop'} run ${run}`);
  await setMetrics(page, metrics, false);
  await navigate(page, url, { cacheDisabled: false });
  await evaluate(page, `window.__resumePerformanceBenchmark?.start('runtime')`);
  await startTrace(page);
  await capture(page, join(outputDir, 'screenshots', `runtime-${metrics.mobile ? 'mobile' : 'desktop'}-${run}-hero.png`));
  const forward = await runScroll(page, 'forward');
  await capture(page, join(outputDir, 'screenshots', `runtime-${metrics.mobile ? 'mobile' : 'desktop'}-${run}-contact.png`));
  const reverse = await runScroll(page, 'reverse');
  await page.send('Tracing.end');
  await sleep(1500);
  const snapshot = await evaluate(page, `window.__resumePerformanceBenchmark?.stop()`);
  const tracePath = join(outputDir, 'traces', `runtime-${metrics.mobile ? 'mobile' : 'desktop'}-${run}.json`);
  await mkdir(dirname(tracePath), { recursive: true });
  await writeFile(tracePath, JSON.stringify({ traceEvents }, null, 2));
  return {
    case: `${metrics.mobile ? 'mobile' : 'desktop'}-runtime`,
    run,
    metrics,
    forward,
    reverse,
    trace: tracePath,
    traceEventCount: traceEvents.length,
    traceSummary: summarizeTrace(traceEvents),
    summary: summarizeRun(snapshot),
    raw: snapshot,
  };
};

const runLifecycle = async (page, url, metrics, run) => {
  console.log(`lifecycle run ${run}: navigate`);
  await setMetrics(page, metrics, false);
  await navigate(page, url, { cacheDisabled: false });
  await evaluate(page, `window.__resumePerformanceBenchmark?.start('lifecycle')`);
  const before = await evaluate(page, `window.__resumePerformanceBenchmark?.lifecycle()`);
  for (let cycle = 0; cycle < 3; cycle += 1) {
    console.log(`lifecycle run ${run}: scroll cycle ${cycle + 1}`);
    await runScroll(page, 'forward', 2600);
    await runScroll(page, 'reverse', 2600);
  }
  const afterScroll = await evaluate(page, `window.__resumePerformanceBenchmark?.lifecycle()`);
  console.log(`lifecycle run ${run}: mobile reduced-motion rebuild`);
  await setMetrics(page, MOBILE_METRICS, true);
  await sleep(500);
  await evaluate(page, `globalThis.ScrollTrigger?.refresh?.()`);
  const reducedMobile = await evaluate(page, `window.__resumePerformanceBenchmark?.lifecycle()`);
  console.log(`lifecycle run ${run}: restore desktop`);
  await setMetrics(page, DESKTOP_METRICS, false);
  await sleep(500);
  await evaluate(page, `globalThis.ScrollTrigger?.refresh?.()`);
  const after = await evaluate(page, `window.__resumePerformanceBenchmark?.lifecycle()`);
  const raw = await evaluate(page, `window.__resumePerformanceBenchmark?.stop()`);
  console.log(`lifecycle run ${run}: complete`);
  return {
    case: 'desktop-lifecycle',
    run,
    before,
    afterScroll,
    reducedMobile,
    after,
    summary: summarizeRun(raw),
    raw,
  };
};

const handleTraceEvent = (params) => {
  if (Array.isArray(params.value)) traceEvents.push(...params.value);
};

const aggregate = (runs) => {
  const summaries = runs.map((run) => run.summary).filter(Boolean);
  return {
    runs: summaries.length,
    lcpMs: median(summaries.map((summary) => summary.lcpMs)),
    fcpMs: median(summaries.map((summary) => summary.fcpMs)),
    cls: median(summaries.map((summary) => summary.cls)),
    longTaskCount: median(summaries.map((summary) => summary.longTaskCount)),
    longTaskMs: median(summaries.map((summary) => summary.longTaskMs)),
    fps: median(summaries.map((summary) => summary.frames.fps)),
    p95FrameMs: median(summaries.map((summary) => summary.frames.p95FrameMs)),
    droppedFrames: median(summaries.map((summary) => summary.frames.droppedFrames)),
    transferBytes: median(summaries.map((summary) => summary.resources.transferBytes)),
    decodedBytes: median(summaries.map((summary) => summary.resources.decodedBytes)),
  };
};

const diff = (before, after) => {
  if (!before || !after) return null;
  return {
    lcpMs: Number.isFinite(before.lcpMs) && Number.isFinite(after.lcpMs) ? after.lcpMs - before.lcpMs : null,
    fcpMs: Number.isFinite(before.fcpMs) && Number.isFinite(after.fcpMs) ? after.fcpMs - before.fcpMs : null,
    cls: Number.isFinite(before.cls) && Number.isFinite(after.cls) ? after.cls - before.cls : null,
    fps: Number.isFinite(before.fps) && Number.isFinite(after.fps) ? after.fps - before.fps : null,
    droppedFrames: Number.isFinite(before.droppedFrames) && Number.isFinite(after.droppedFrames) ? after.droppedFrames - before.droppedFrames : null,
    transferBytes: Number.isFinite(before.transferBytes) && Number.isFinite(after.transferBytes) ? after.transferBytes - before.transferBytes : null,
  };
};

const writeReport = async (reportPath, report) => {
  const lines = [
    '# Interactive Resume Performance Benchmark',
    '',
    `Generated: ${report.generatedAt}`,
    `Label: ${report.label}`,
    `Browser: ${report.environment.browser}`,
    `Viewport policy: desktop ${DESKTOP_METRICS.width}×${DESKTOP_METRICS.height}; mobile ${MOBILE_METRICS.width}×${MOBILE_METRICS.height}, Slow 4G, 4× CPU`,
    '',
    '## Budgets',
    '',
    '| Signal | Budget | Result |',
    '| --- | ---: | ---: |',
    `| LCP | ≤ 2.5 s | ${formatMs(report.budgets.lcpMs)} |`,
    `| FCP | diagnostic | ${formatMs(report.budgets.fcpMs)} |`,
    `| CLS | ≤ 0.10 | ${report.budgets.cls == null ? 'n/a' : report.budgets.cls.toFixed(3)} |`,
    `| TBT proxy / long tasks | ≤ 200 ms | ${formatMs(report.budgets.longTaskMs)} |`,
    `| Desktop runtime FPS | ≥ 60 target | ${report.budgets.desktopFps == null ? 'n/a' : report.budgets.desktopFps.toFixed(1)} |`,
    '',
    '## Load',
    '',
    '| Case | Runs | LCP | FCP | CLS | Long tasks | Transfer |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  Object.entries(report.load).forEach(([name, summary]) => {
    lines.push(`| ${name} | ${summary.runs} | ${formatMs(summary.lcpMs)} | ${formatMs(summary.fcpMs)} | ${summary.cls == null ? 'n/a' : summary.cls.toFixed(3)} | ${formatMs(summary.longTaskMs)} | ${formatBytes(summary.transferBytes)} |`);
  });
  lines.push('', '## Runtime', '', '| Case | Runs | FPS | p95 frame | Dropped frames | Long tasks | Transfer |', '| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  Object.entries(report.runtime).forEach(([name, summary]) => {
    lines.push(`| ${name} | ${summary.runs} | ${summary.fps == null ? 'n/a' : summary.fps.toFixed(1)} | ${formatMs(summary.p95FrameMs)} | ${summary.droppedFrames == null ? 'n/a' : summary.droppedFrames.toFixed(0)} | ${formatMs(summary.longTaskMs)} | ${formatBytes(summary.transferBytes)} |`);
  });
  lines.push('', '## Lifecycle', '', '| Case | DOM before | DOM after | Triggers before | Triggers after | Heap after |', '| --- | ---: | ---: | ---: | ---: | ---: |');
  report.lifecycle.forEach((entry) => {
    const heap = entry.after?.memory?.usedJSHeapSize;
    lines.push(`| run ${entry.run} | ${entry.before?.domNodes ?? 'n/a'} | ${entry.after?.domNodes ?? 'n/a'} | ${entry.before?.scrollTriggers ?? 'n/a'} | ${entry.after?.scrollTriggers ?? 'n/a'} | ${formatBytes(heap)} |`);
  });
  lines.push('', '## Network waterfall', '', 'The raw JSON preserves every `PerformanceResourceTiming` entry. The ten largest resources for each run are in `results.json`; use those entries to separate deployment size from first-load transfer.', '', '## Trace and screenshots', '');
  [...report.runtimeRuns].forEach((entry) => lines.push(`- ${entry.case} run ${entry.run}: [trace](${entry.trace}), screenshots under ` + '`screenshots/`' + '.'));
  report.runtimeRuns.forEach((entry) => lines.push(`- ${entry.case} run ${entry.run}: trace long tasks ${entry.traceSummary.longTaskCount}, forced layout ${entry.traceSummary.forcedLayoutCount}, paint ${entry.traceSummary.paintCount}, composite ${entry.traceSummary.compositeCount}.`));
  lines.push('', '## Lighthouse', '', report.lighthouse.status === 'ok'
    ? `- [Lighthouse JSON](${report.lighthouse.report}) — FCP ${formatMs(report.lighthouse.metrics.fcpMs)}, LCP ${formatMs(report.lighthouse.metrics.lcpMs)}, Speed Index ${formatMs(report.lighthouse.metrics.speedIndexMs)}, TBT ${formatMs(report.lighthouse.metrics.tbtMs)}, CLS ${report.lighthouse.metrics.cls == null ? 'n/a' : report.lighthouse.metrics.cls.toFixed(3)}.`
    : `- ${report.lighthouse.status}: ${report.lighthouse.reason || report.lighthouse.error}`, '');
  lines.push('', '## Prioritized signals', '', ...report.prioritizedSignals.map((signal, index) => `${index + 1}. ${signal}`), '', '## Reproduce', '', '```powershell', 'npm run benchmark:performance', '```', '', 'Use `--label after --compare <baseline-results.json>` to create a before/after comparison. Keep the same browser, viewport, CPU, network, and run count when comparing.', '');
  if (report.comparison) {
    lines.push('## Comparison', '', '| Signal | Before | After | Delta |', '| --- | ---: | ---: | ---: |');
    for (const [name, value] of Object.entries(report.comparison)) {
      const before = report.comparisonBefore?.[name];
      const after = report.comparisonAfter?.[name];
      lines.push(`| ${name} | ${before == null ? 'n/a' : before.toFixed(2)} | ${after == null ? 'n/a' : after.toFixed(2)} | ${value == null ? 'n/a' : value.toFixed(2)} |`);
    }
    lines.push('');
  }
  await writeFile(reportPath, lines.join('\n'));
};

const runOptionalLighthouse = async (url, outputDir) => {
  const command = process.env.LIGHTHOUSE_BIN || (process.platform === 'win32' ? 'lighthouse.cmd' : 'lighthouse');
  const probe = spawnSync(command, ['--version'], {
    stdio: 'ignore',
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  if (probe.error || probe.status !== 0) {
    return { status: 'not-installed', reason: 'Optional Lighthouse CLI was not found; native CDP lab metrics remain authoritative.' };
  }
  const outputPath = join(outputDir, 'lighthouse.json');
  const result = spawnSync(command, [
    url,
    '--quiet',
    '--output=json',
    `--output-path=${outputPath}`,
    '--only-categories=performance',
    '--chrome-flags=--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage',
  ], {
    encoding: 'utf8',
    windowsHide: true,
    shell: process.platform === 'win32',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    return { status: 'failed', error: (result.stderr || result.error?.message || 'Lighthouse failed').trim() };
  }
  try {
    const lighthouse = JSON.parse(await readFile(outputPath, 'utf8'));
    const auditValue = (id) => lighthouse.audits?.[id]?.numericValue ?? null;
    return {
      status: 'ok',
      version: lighthouse.lighthouseVersion || null,
      report: outputPath,
      metrics: {
        fcpMs: auditValue('first-contentful-paint'),
        lcpMs: auditValue('largest-contentful-paint'),
        speedIndexMs: auditValue('speed-index'),
        tbtMs: auditValue('total-blocking-time'),
        cls: auditValue('cumulative-layout-shift'),
      },
    };
  } catch (error) {
    return { status: 'failed', error: `Could not parse Lighthouse output: ${error.message}` };
  }
};

const main = async (options) => {
  const preview = await startPreview(options);
  const outputDir = resolve(ROOT, options.output, `${new Date().toISOString().replaceAll(':', '-')}-${options.label}`);
  await mkdir(outputDir, { recursive: true });
  const baseUrl = `http://${options.host}:${preview.port}`;
  const browser = await launchChrome(DESKTOP_METRICS);
  browser.browser.subscriptions.add({ method: 'Tracing.dataCollected', callback: handleTraceEvent });

  try {
    const loadRuns = [];
    const runtimeRuns = [];
    const lifecycleRuns = [];
    if (options.only === 'all' || options.only === 'load') {
      for (const metrics of [DESKTOP_METRICS, MOBILE_METRICS]) {
        for (const cacheMode of ['cold', 'warm']) {
          for (let run = 1; run <= options.runs; run += 1) loadRuns.push(await runLoad(browser.page, baseUrl, metrics, cacheMode, run));
        }
      }
    }
    if (options.only === 'all' || options.only === 'runtime') {
      for (const metrics of [DESKTOP_METRICS, MOBILE_METRICS]) {
        for (let run = 1; run <= options.runs; run += 1) runtimeRuns.push(await runRuntime(browser.page, baseUrl, metrics, outputDir, run));
      }
    }
    if (options.only === 'all' || options.only === 'lifecycle') {
      for (let run = 1; run <= options.runs; run += 1) lifecycleRuns.push(await runLifecycle(browser.page, baseUrl, DESKTOP_METRICS, run));
    }

    const load = Object.groupBy(loadRuns, (run) => run.case);
    const runtime = Object.groupBy(runtimeRuns, (run) => run.case);
    const report = {
      generatedAt: new Date().toISOString(),
      label: options.label,
      environment: {
        browser: browser.browserVersion,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        viewport: { desktop: DESKTOP_METRICS, mobile: MOBILE_METRICS },
        network: { mobile: 'Slow 4G, 150 ms latency, 1.6 Mbps down, 750 Kbps up', desktop: 'unthrottled' },
        cpu: { mobile: 4, desktop: 1 },
      },
      load: Object.fromEntries(Object.entries(load).map(([name, runs]) => [name, aggregate(runs)])),
      runtime: Object.fromEntries(Object.entries(runtime).map(([name, runs]) => [name, aggregate(runs)])),
      loadRuns,
      lifecycle: lifecycleRuns,
      runtimeRuns,
      lighthouse: await runOptionalLighthouse(baseUrl, outputDir),
      prioritizedSignals: [
        'Compare first-load transfer by initiator type before changing media; the raw waterfall identifies whether below-fold assets compete with Hero.',
        'Treat long-task clusters and p95 frame time as the runtime optimization seam; do not optimize static file size without a matching request or trace signal.',
        'Check lifecycle snapshots for trigger, DOM, canvas, video, and heap growth after three complete traversals and breakpoint/reduced-motion rebuilds.',
      ],
    budgets: {
        lcpMs: median(loadRuns.map((run) => run.summary.lcpMs)),
        fcpMs: median(loadRuns.map((run) => run.summary.fcpMs)),
        cls: median(loadRuns.map((run) => run.summary.cls)),
        longTaskMs: median(loadRuns.map((run) => run.summary.longTaskMs)),
        desktopFps: median((runtime['desktop-runtime'] || []).map((run) => run.summary.frames.fps)),
      },
    };
    if (options.compare) {
      const previous = JSON.parse(await readFile(resolve(options.compare), 'utf8'));
      report.comparison = diff(previous.budgets, report.budgets);
      report.comparisonBefore = previous.budgets;
      report.comparisonAfter = report.budgets;
      report.comparisonReference = resolve(options.compare);
    }
    const resultsPath = join(outputDir, 'results.json');
    const reportPath = join(outputDir, 'report.md');
    await writeFile(resultsPath, JSON.stringify(report, null, 2));
    await writeReport(reportPath, report);
    console.log(`Performance benchmark written to ${reportPath}`);
  } finally {
    await browser.close();
    preview.process.kill();
  }
};

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const options = parseArgs(process.argv.slice(2));
  if (options.selfTest) runSelfTest();
  else main(options).catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
