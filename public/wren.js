/**
 * wren.js — Declarative data binding for WREN
 *
 * Drop this into any HTML page served from (or pointed at) a WREN instance.
 * Web Components auto-detect the org from the URL and fetch data from the
 * public query API. No build step, no dependencies.
 *
 * Usage:
 *   <script src="/wren.js"></script>
 *
 *   <!-- List with projection -->
 *   <wren-list collection="events" select="name,date,city" limit="20">
 *     <template><tr><td>{{name}}</td><td>{{date}}</td><td>{{city}}</td></tr></template>
 *   </wren-list>
 *
 *   <!-- Query with aggregation -->
 *   <wren-query collection="events" q='{"aggregate":{"groupBy":["country"],"metrics":{"n":{"count":"name"}}}}'>
 *     <template><div>{{country}}: {{n}}</div></template>
 *   </wren-query>
 *
 *   <!-- Materialized view -->
 *   <wren-materialized collection="events" name="overview">
 *     <template><div>{{name}} — {{startDate}}</div></template>
 *   </wren-materialized>
 *
 * Configuration (on the <script> tag or on each component):
 *   data-base="https://wren.aemwip.com/api/v1/orgs/tkd"  — explicit API base (for custom domains)
 *   data-org="tkd"                                         — explicit org slug (auto-detected from URL if omitted)
 *   data-origin="https://wren.aemwip.com"                  — explicit WREN origin (for cross-origin)
 *
 * @license Apache-2.0
 */

(() => {
  "use strict";

  // ── Configuration resolution ───────────────────────────────────────────────

  // Find our own <script> tag to read data- attributes
  const selfScript = document.currentScript;

  /**
   * Resolve the API base URL for a given element.
   * Priority: element attribute > script attribute > auto-detect from URL.
   *
   * The base URL is the prefix for all API calls, e.g.:
   *   https://wren.aemwip.com/api/v1/orgs/tkd
   */
  function resolveBase(el) {
    // 1. Explicit data-base on the component
    const elBase = el?.getAttribute("data-base");
    if (elBase) return elBase.replace(/\/$/, "");

    // 2. Explicit data-base on the <script> tag
    const scriptBase = selfScript?.getAttribute("data-base");
    if (scriptBase) return scriptBase.replace(/\/$/, "");

    // 3. Explicit org + origin
    const org = el?.getAttribute("data-org") || selfScript?.getAttribute("data-org");
    const origin = el?.getAttribute("data-origin") || selfScript?.getAttribute("data-origin");
    if (org) {
      const base = origin || detectOrigin();
      return `${base}/api/v1/orgs/${org}`;
    }

    // 4. Auto-detect from current URL path: /orgs/{slug}/tree/...
    const match = location.pathname.match(/\/orgs\/([^/]+)\//);
    if (match) {
      const detectedOrigin = origin || detectOrigin();
      return `${detectedOrigin}/api/v1/orgs/${match[1]}`;
    }

    // 5. Auto-detect from the script src URL
    if (selfScript?.src) {
      try {
        const scriptUrl = new URL(selfScript.src);
        const srcMatch = scriptUrl.pathname.match(/\/orgs\/([^/]+)\//);
        if (srcMatch) {
          return `${scriptUrl.origin}/api/v1/orgs/${srcMatch[1]}`;
        }
        // Script is at the root — use the script's origin with no org
        // (authenticated mode, not public)
        return `${scriptUrl.origin}/api/v1`;
      } catch { /* ignore */ }
    }

    // 6. Fallback: same origin, no org (requires auth)
    return `${location.origin}/api/v1`;
  }

  function detectOrigin() {
    // If we're on a /orgs/ path, the origin is the current origin
    if (location.pathname.includes("/orgs/")) return location.origin;
    // If the script was loaded from a different origin, use that
    if (selfScript?.src) {
      try { return new URL(selfScript.src).origin; } catch { /* ignore */ }
    }
    return location.origin;
  }

  // ── Template rendering ─────────────────────────────────────────────────────

  /**
   * Render a template string with {{field}} placeholders replaced by data values.
   * Supports dot paths: {{report.name}} resolves data.report.name.
   * HTML-escapes values by default. Use {{{field}}} for raw HTML.
   */
  function renderTemplate(tmpl, data) {
    // Raw (unescaped) triples: {{{field}}}
    let result = tmpl.replace(/\{\{\{([^}]+)\}\}\}/g, (_, key) => {
      const val = resolvePath(data, key.trim());
      return val != null ? String(val) : "";
    });
    // Escaped doubles: {{field}}
    result = result.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const val = resolvePath(data, key.trim());
      return val != null ? escHtml(String(val)) : "";
    });
    return result;
  }

  function resolvePath(obj, path) {
    if (!obj || !path) return undefined;
    const parts = path.split(".");
    let current = obj;
    for (const part of parts) {
      if (current == null) return undefined;
      current = current[part];
    }
    return current;
  }

  function escHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ── Fetch helper ───────────────────────────────────────────────────────────

  async function wrenFetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { "Accept": "application/json", ...opts.headers },
    });
    if (!res.ok) throw new Error(`WREN fetch failed: ${res.status} ${res.statusText}`);
    return res.json();
  }

  // ── Loading / error states ─────────────────────────────────────────────────

  function showLoading(el) {
    const slot = el.querySelector('[slot="loading"]');
    if (slot) {
      slot.style.display = "";
      el._container.innerHTML = "";
    } else {
      el._container.innerHTML = '<span style="color:#888;font-size:.9em">Loading…</span>';
    }
  }

  function hideSlots(el) {
    el.querySelectorAll("[slot]").forEach(s => s.style.display = "none");
  }

  function showError(el, err) {
    hideSlots(el);
    const slot = el.querySelector('[slot="error"]');
    if (slot) {
      slot.style.display = "";
      slot.innerHTML = slot.innerHTML.replace("{{error}}", escHtml(err.message));
    } else {
      el._container.innerHTML = `<span style="color:#c00;font-size:.9em">Error: ${escHtml(err.message)}</span>`;
    }
  }

  function showEmpty(el) {
    hideSlots(el);
    const slot = el.querySelector('[slot="empty"]');
    if (slot) {
      slot.style.display = "";
    }
  }

  // ── Base component ─────────────────────────────────────────────────────────

  class WrenBase extends HTMLElement {
    connectedCallback() {
      // Create a container for rendered output (preserves the <template> and slots)
      this._container = document.createElement("div");
      this._container.style.display = "contents"; // invisible wrapper
      this.appendChild(this._container);

      // Get the template
      this._tmpl = this.querySelector("template");

      // Hide slot elements (loading/empty/error) — they're only shown by the helpers
      this.querySelectorAll("[slot]").forEach(s => s.style.display = "none");

      // Defer to allow the DOM to settle
      requestAnimationFrame(() => this._load());
    }

    _getTemplate() {
      return this._tmpl?.innerHTML ?? "{{.}}";
    }

    _renderItems(items) {
      hideSlots(this);
      const tmpl = this._getTemplate();
      if (!items || items.length === 0) {
        showEmpty(this);
        return;
      }
      const html = items.map(item => {
        // Flatten: merge item.data into item for easy access, plus item.key for aggregates
        const flat = { ...item, ...item.data, ...item.key };
        return renderTemplate(tmpl, flat);
      }).join("");

      // If we're inside a <table>/<tbody>/<thead>, insert rows directly into the
      // parent to avoid the browser moving <tr> elements out of the table.
      const parent = this.parentElement;
      if (parent && /^(TBODY|THEAD|TFOOT|TABLE|TR)$/i.test(parent.tagName)) {
        // Insert rendered HTML into parent, replace this element
        const marker = document.createComment("wren");
        parent.insertBefore(marker, this);
        marker.insertAdjacentHTML("afterend", html);
        this.style.display = "none";
      } else {
        this._container.innerHTML = html;
      }
    }
  }

  // ── <wren-list> ────────────────────────────────────────────────────────────
  //
  // Attributes:
  //   collection (required) — collection name
  //   select     — comma-separated field names
  //   where      — filter expression
  //   label      — version label
  //   limit      — max results (default 50)
  //   offset     — pagination offset
  //
  // Also supports data-base, data-org, data-origin for config.

  class WrenList extends WrenBase {
    async _load() {
      const base = resolveBase(this);
      const collection = this.getAttribute("collection");
      if (!collection) { showError(this, new Error("collection attribute required")); return; }

      const params = new URLSearchParams();
      const select = this.getAttribute("select");
      if (select) params.set("select", select);
      const where = this.getAttribute("where");
      if (where) params.set("where", where);
      const label = this.getAttribute("label");
      if (label) params.set("label", label);
      const limit = this.getAttribute("limit");
      if (limit) params.set("limit", limit);
      const offset = this.getAttribute("offset");
      if (offset) params.set("offset", offset);

      const url = `${base}/${collection}?${params}`;
      showLoading(this);

      try {
        const data = await wrenFetch(url);
        this._data = data;
        this._renderItems(data.items ?? []);

        // Dispatch event so parent code can access the raw data
        this.dispatchEvent(new CustomEvent("wren-load", { detail: data, bubbles: true }));
      } catch (err) {
        showError(this, err);
      }
    }
  }

  // ── <wren-query> ───────────────────────────────────────────────────────────
  //
  // Attributes:
  //   collection (required) — collection name
  //   select     — comma-separated field names (simple queries)
  //   where      — filter expression (simple queries)
  //   q          — full query body as JSON string (complex queries, overrides select/where)
  //   label      — version label
  //   limit      — max results
  //
  // For aggregation, use the q attribute with a JSON body.

  class WrenQuery extends WrenBase {
    async _load() {
      const base = resolveBase(this);
      const collection = this.getAttribute("collection");
      if (!collection) { showError(this, new Error("collection attribute required")); return; }

      const qAttr = this.getAttribute("q");
      let url;

      if (qAttr) {
        // Complex query via ?q= (base64url-encoded JSON) — cacheable GET
        const encoded = btoa(qAttr).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
        const params = new URLSearchParams();
        params.set("q", encoded);
        const label = this.getAttribute("label");
        if (label) params.set("label", label);
        url = `${base}/${collection}/_query?${params}`;
      } else {
        // Simple query via individual params
        const params = new URLSearchParams();
        const select = this.getAttribute("select");
        if (select) params.set("select", select);
        const where = this.getAttribute("where");
        if (where) params.set("where", where);
        const label = this.getAttribute("label");
        if (label) params.set("label", label);
        const limit = this.getAttribute("limit");
        if (limit) params.set("limit", limit);
        url = `${base}/${collection}/_query?${params}`;
      }

      showLoading(this);

      try {
        const data = await wrenFetch(url);
        this._data = data;

        // Aggregate responses have "rows", projection responses have "items"
        const items = data.rows ?? data.items ?? [];
        this._renderItems(items);

        this.dispatchEvent(new CustomEvent("wren-load", { detail: data, bubbles: true }));
      } catch (err) {
        showError(this, err);
      }
    }
  }

  // ── <wren-materialized> ────────────────────────────────────────────────────
  //
  // Attributes:
  //   collection (required) — source collection name
  //   name       (required) — materialized query name
  //
  // Renders the materialized result's items or rows.

  class WrenMaterialized extends WrenBase {
    async _load() {
      const base = resolveBase(this);
      const collection = this.getAttribute("collection");
      const name = this.getAttribute("name");
      if (!collection || !name) {
        showError(this, new Error("collection and name attributes required"));
        return;
      }

      const url = `${base}/${collection}/_materialized/${encodeURIComponent(name)}`;
      showLoading(this);

      try {
        const data = await wrenFetch(url);
        this._data = data;

        // Materialized result is at data.result.data, which has items or rows
        const result = data.result?.data ?? {};
        const items = result.rows ?? result.items ?? [];
        this._renderItems(items);

        this.dispatchEvent(new CustomEvent("wren-load", { detail: data, bubbles: true }));
      } catch (err) {
        showError(this, err);
      }
    }
  }

  // ── <wren-doc> ─────────────────────────────────────────────────────────────
  //
  // Fetches a single document by ID or natural key.
  //
  // Attributes:
  //   collection (required)
  //   id         — document UUID
  //   key        — natural key value (alternative to id)
  //   label      — version label

  class WrenDoc extends WrenBase {
    async _load() {
      const base = resolveBase(this);
      const collection = this.getAttribute("collection");
      if (!collection) { showError(this, new Error("collection attribute required")); return; }

      const id = this.getAttribute("id");
      const key = this.getAttribute("key");
      if (!id && !key) { showError(this, new Error("id or key attribute required")); return; }

      const label = this.getAttribute("label");
      const labelParam = label ? `?label=${encodeURIComponent(label)}` : "";

      const path = key
        ? `${base}/${collection}/by-key/${encodeURIComponent(key)}${labelParam}`
        : `${base}/${collection}/${id}${labelParam}`;

      showLoading(this);

      try {
        const data = await wrenFetch(path);
        this._data = data;

        const tmpl = this._getTemplate();
        const flat = { ...data, ...data.data };
        this._container.innerHTML = renderTemplate(tmpl, flat);

        this.dispatchEvent(new CustomEvent("wren-load", { detail: data, bubbles: true }));
      } catch (err) {
        showError(this, err);
      }
    }
  }

  // ── <wren-tree> ────────────────────────────────────────────────────────────
  //
  // Fetches a full tree snapshot and renders each node.
  //
  // Attributes:
  //   tree   (required) — tree name
  //   label  — version label

  class WrenTree extends WrenBase {
    async _load() {
      const base = resolveBase(this);
      const tree = this.getAttribute("tree");
      if (!tree) { showError(this, new Error("tree attribute required")); return; }

      const params = new URLSearchParams({ full: "true" });
      const label = this.getAttribute("label");
      if (label) params.set("label", label);

      // Tree endpoint is /tree/{name}, not /{collection}/{id}
      const url = `${base}/tree/${encodeURIComponent(tree)}?${params}`;
      showLoading(this);

      try {
        const data = await wrenFetch(url);
        this._data = data;

        const nodes = data.nodes ?? [];
        this._renderItems(nodes.map(n => ({
          path: n.path,
          documentId: n.documentId,
          ...n.document,
          ...n.document?.data,
        })));

        this.dispatchEvent(new CustomEvent("wren-load", { detail: data, bubbles: true }));
      } catch (err) {
        showError(this, err);
      }
    }
  }

  // ── Register components ────────────────────────────────────────────────────

  customElements.define("wren-list", WrenList);
  customElements.define("wren-query", WrenQuery);
  customElements.define("wren-materialized", WrenMaterialized);
  customElements.define("wren-doc", WrenDoc);
  customElements.define("wren-tree", WrenTree);

  // ── Expose globally for programmatic use ───────────────────────────────────

  window.Wren = {
    resolveBase,
    fetch: wrenFetch,
    renderTemplate,
    version: "0.1.0",
  };

})();
