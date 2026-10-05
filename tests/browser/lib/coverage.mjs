// Chrome JS coverage over the DevTools protocol that survives navigations.
//
// puppeteer's page.coverage only reports scripts still alive when coverage stops, so
// code run before a reload or page change is lost. This collector takes a V8
// precise-coverage snapshot right before every document unloads and once more at the
// end, and unions the used byte ranges per script URL.
//
// How the "before unload" snapshot works: every document gets a beforeunload listener
// with a `debugger;` statement. While the old document is paused there (its scripts
// still alive) we take the snapshot, then resume. Snapshots taken from navigation
// events instead arrive too late, and holding the navigation request with request
// interception blocks Profiler.takePreciseCoverage until the navigation times out.

export class Coverage {
  /**
   * @param page    puppeteer Page
   * @param filter  (url) => boolean — which scripts to record
   * @param keyOf   (url) => string — merge key (default: the URL)
   */
  constructor(page, filter, keyOf = url => url) {
    this.page = page;
    this.filter = filter;
    this.keyOf = keyOf;
    this.sources = new Map(); // scriptId → { key, url, text }
    this.pending = new Set();
    this.files = new Map(); // key → { url, text, used: Uint8Array }
  }

  async start() {
    const client = this.client = await this.page.createCDPSession();
    client.on("Debugger.scriptParsed", e => {
      if (!e.url || !this.filter(e.url)) return;
      const p = client.send("Debugger.getScriptSource", { scriptId: e.scriptId })
        .then(r => this.sources.set(e.scriptId, { key: this.keyOf(e.url), url: e.url, text: r.scriptSource }))
        .catch(() => {});
      this.pending.add(p);
      p.finally(() => this.pending.delete(p));
    });
    // Snapshot while the unloading document is paused, then let it go
    client.on("Debugger.paused", async () => {
      await this.snapshot();
      await client.send("Debugger.resume").catch(() => {});
    });
    await client.send("Debugger.enable");
    await client.send("Profiler.enable");
    await client.send("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
    await this.page.evaluateOnNewDocument(() => {
      addEventListener("beforeunload", () => { debugger; }); // eslint-disable-line no-debugger
    });
  }

  /** Merge the coverage counted since the last snapshot. */
  async snapshot() {
    try {
      await Promise.all([...this.pending]);
      const { result } = await this.client.send("Profiler.takePreciseCoverage");
      for (const script of result) {
        const src = this.sources.get(script.scriptId);
        if (!src) continue;
        let file = this.files.get(src.key);
        if (!file || file.text.length !== src.text.length) {
          file = { url: src.url, text: src.text, used: new Uint8Array(src.text.length) };
          this.files.set(src.key, file);
        }
        // V8 block ranges nest: paint outer ranges first, inner ones override
        const ranges = script.functions.flatMap(f => f.ranges)
          .sort((a, b) => a.startOffset - b.startOffset || b.endOffset - a.endOffset);
        const now = new Uint8Array(src.text.length);
        for (const r of ranges) now.fill(r.count > 0 ? 1 : 0, r.startOffset, r.endOffset);
        for (let i = 0; i < now.length; i++) if (now[i]) file.used[i] = 1;
      }
    } catch { /* page or session already closed */ }
  }

  /** Final snapshot; returns [{ url, text, ranges: [{start, end}] }] for the report. */
  async stop() {
    await this.snapshot();
    await this.client.detach().catch(() => {});
    return [...this.files.values()].map(f => ({ url: f.url, text: f.text, ranges: toRanges(f.used) }));
  }
}

function toRanges(used) {
  const ranges = [];
  let start = -1;
  for (let i = 0; i <= used.length; i++) {
    if (i < used.length && used[i]) { if (start < 0) start = i; }
    else if (start >= 0) { ranges.push({ start, end: i }); start = -1; }
  }
  return ranges;
}
