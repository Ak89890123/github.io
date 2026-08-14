# Interactive Resume Performance Benchmark

The benchmark measures the production preview through a real Chromium session. It does not change the resume runtime and adds no browser or monitoring dependency to the app bundle.

## Run

```powershell
npm run benchmark:performance
```

The command builds the site, starts `vite preview`, runs three samples for desktop and mobile cold/warm loads, three full desktop/mobile forward/reverse scroll traces, and three lifecycle passes. It writes a timestamped, ignored artifact folder under `output/performance-benchmark/`:

- `report.md` — compact budget and comparison report.
- `results.json` — environment, raw browser observations, summaries, resource waterfall, and lifecycle snapshots.
- `lighthouse.json` — optional Lighthouse performance output when `lighthouse` or `LIGHTHOUSE_BIN` is available; otherwise the report records that native CDP lab metrics were used.
- `traces/*.json` — Chromium timeline trace events for runtime runs.
- `screenshots/*.png` — Hero and Contact checkpoints for visual QA.

For a faster local check:

```powershell
npm run benchmark:performance:check
node scripts/performance-benchmark.mjs --skip-build --runs 1 --label smoke
```

The runner uses Chromium or Edge from the standard Windows install locations. Set `CHROME_BIN` when the browser is elsewhere. Keep the same machine, browser version, viewport, CPU, network, and sample count for before/after comparisons:

```powershell
node scripts/performance-benchmark.mjs --skip-build --label after --compare output/performance-benchmark/<baseline>/results.json
```

## Signals

Load runs record LCP, FCP, CLS and layout-shift culprits, long tasks, slow event entries, navigation timing, and the complete `PerformanceResourceTiming` waterfall. Runtime runs record frame intervals, estimated FPS, p95/max frame time, dropped-frame estimates, long tasks, direction markers, Chromium trace files, and screenshots. Lifecycle runs compare DOM nodes, ScrollTrigger count, GSAP animation count, video state, canvas backing stores, and heap data when Chrome exposes `performance.memory`.

The benchmark uses native browser observers as its always-available lab path. If Lighthouse CLI is installed, the same run also writes Lighthouse FCP, LCP, Speed Index, TBT, and CLS metrics; no Lighthouse package is added to the app.

The acceptance budgets are LCP ≤ 2.5 s, CLS ≤ 0.10, long-task/TBT proxy ≤ 200 ms, and a desktop runtime target of 60 FPS. Mobile is reported independently. These are lab regression signals; field Core Web Vitals remain the final 75th-percentile measure.

The benchmark intentionally separates deployment size from actual first-load transfer. Optimize only resources visible in the waterfall or work visible in the runtime trace, then repeat the same flows with `--label after`.
