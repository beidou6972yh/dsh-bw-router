/* ============================================================================
 * WB驭档·模型智能换挡系统网关 · 管理界面 UI v2 交互层（源文件）
 * 建档 2026-11-17｜依据：SKILL「ui-consistency-redesign」G5 覆盖层实施
 *
 * 与 admin-v2.css 配套。铁律：
 *   1) 不改原 admin.html 的 <script> 业务逻辑一行；只做「包装 / 监听 / 增强」；
 *   2) 一切交给 v2 的行为都必须能通过 localStorage('admin.ui')='v1' 一键回到旧版；
 *   3) 覆盖层失败不得影响旧版可用（全部 try/catch 包裹，出错自动退回旧版）。
 * ========================================================================== */
(function () {
  "use strict";

  var KEY = "admin.ui";
  var V2 = "v2", V1 = "v1";

  function readPref() {
    try { return localStorage.getItem(KEY) === V1 ? V1 : V2; } catch (e) { return V2; }
  }
  function writePref(v) {
    try { localStorage.setItem(KEY, v); } catch (e) {}
  }

  /* ── 0. 开关闸门：非 v2 直接退出，DOM 一个字节都不动 ─────────────────── */
  var pref = readPref();
  document.documentElement.setAttribute("data-ui", pref);
  if (pref !== V2) return;

  var q = function (s, r) { return (r || document).querySelector(s); };
  var qa = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ── 1. toast：包装 alert，不再打断（原逻辑仍可调用 alert） ───────────── */
  var toastBox = null;
  function ensureToastBox() {
    if (toastBox) return toastBox;
    toastBox = document.createElement("div");
    toastBox.id = "v2ToastBox";
    toastBox.setAttribute("aria-live", "polite");
    toastBox.style.cssText = [
      "position:fixed", "right:24px", "bottom:24px", "z-index:9999",
      "display:flex", "flex-direction:column", "gap:8px", "align-items:flex-end",
      "pointer-events:none", "max-width:min(92vw,420px)"
    ].join(";");
    document.body.appendChild(toastBox);
    return toastBox;
  }
  function toast(msg, kind) {
    var box = ensureToastBox();
    var el = document.createElement("div");
    var bg = kind === "bad" ? "#b42318" : (kind === "warn" ? "#a15c00" : "#0f172a");
    el.textContent = String(msg == null ? "" : msg);
    el.style.cssText = [
      "background:" + bg, "color:#fff", "border-radius:8px",
      "padding:10px 12px", "font-size:13px", "line-height:1.5",
      "box-shadow:0 8px 24px rgba(15,23,42,.18)", "max-width:100%",
      "white-space:pre-wrap", "word-break:break-word", "opacity:0",
      "transition:opacity .16s ease"
    ].join(";");
    box.appendChild(el);
    requestAnimationFrame(function () { el.style.opacity = "1"; });
    setTimeout(function () {
      el.style.opacity = "0";
      setTimeout(function () { el.remove(); }, 200);
    }, kind === "bad" ? 6000 : 3600);
  }
  try {
    window.__v2NativeAlert = window.alert;
    window.alert = function (msg) { toast(msg); };
  } catch (e) {}

  /* ── 2. 移动端卡片列表：给表格单元格补 data-label（配合 v2.css 的 ::before） ── */
  var LABEL_BY_INDEX = {
    upstreamList: ["", "健康", "Base URL", "密钥", "模型", "操作"],
    keyList: ["名称", "前缀", "scope", "rpm", "状态", "最后使用", "操作"],
    learnedList: ["策略", "能力/节点", "function", "模型", "来源", "时间", "操作"]
  };
  var cellLabel = {};   // 表头文本缓存：按表格容器 id 记录

  function labelize(container) {
    if (!container) return;
    var table = q("table", container);
    if (!table) return;
    var heads = qa("thead th", table).map(function (th) { return th.textContent.trim(); });
    if (heads.length) cellLabel[container.id] = heads;
    var labels = heads.length ? heads : (LABEL_BY_INDEX[container.id] || []);
    if (!labels.length) return;
    qa("tbody tr", table).forEach(function (tr) {
      qa("td", tr).forEach(function (td, i) {
        if (!td.hasAttribute("data-label")) td.setAttribute("data-label", labels[i] || "");
      });
    });
  }

  var OBSERVE = ["upstreamList", "keyList", "learnedList"];
  function watchTables() {
    OBSERVE.forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      labelize(el);
      try {
        new MutationObserver(function () { labelize(el); })
          .observe(el, { childList: true, subtree: true });
      } catch (e) {}
    });
  }

  /* ── 2b. 供应商余额列（消费注入快照 window.__BALANCES__，不改原 renderList） ── */
  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function balanceMap() {
    var snap = window.__BALANCES__;
    if (!snap || !Array.isArray(snap.items)) return { map: new Map(), at: "" };
    var m = new Map();
    snap.items.forEach(function (it) { if (it && it.id) m.set(it.id, it); });
    return { map: m, at: snap.fetched_at || "" };
  }
  function decorateBalances() {
    var wrap = document.getElementById("upstreamList");
    if (!wrap) return;
    var table = q("table", wrap);
    if (!table) return;
    var bag = balanceMap();
    if (!bag.map.size) return;

    var headRow = q("thead tr", table);
    if (headRow && !q(".v2-bal-th", headRow)) {
      var th = document.createElement("th");
      th.className = "v2-bal-th";
      th.textContent = "余额/套餐";
      headRow.insertBefore(th, headRow.children[3] || headRow.lastElementChild);   // 插在「密钥」之后
    }

    qa("tbody tr", table).forEach(function (tr) {
      if (q(".v2-bal-td", tr)) return;
      var idEl = q("td b", tr);
      var id = idEl ? idEl.textContent.trim() : "";
      var it = bag.map.get(id);
      var td = document.createElement("td");
      td.className = "v2-bal-td";
      if (!it) {
        td.innerHTML = '<span class="v2-bal v2-bal-none" title="未取到余额/套餐快照">—</span>';
      } else {
        var cls = "v2-bal v2-bal-" + (it.state || "none");
        td.innerHTML = '<span class="' + cls + '" title="' + esc(it.detail || "") + '">' +
          esc(it.display || "—") + "</span>";
      }
      tr.insertBefore(td, tr.children[3] || tr.lastElementChild);
    });

    // 卡片头补「更新于」，让数据新鲜度可见（不假装实时）
    var card = wrap.closest(".card");
    if (card && bag.at && !q(".v2-bal-note", card)) {
      var note = document.createElement("p");
      note.className = "muted v2-bal-note";
      note.style.marginTop = "8px";
      note.textContent = "余额/套餐更新于 " + bag.at.slice(5, 16).replace("T", " ") +
        "（快照，非实时；由 scripts/balance_refresh.py 刷新）";
      card.appendChild(note);
    }
    // ── Q1-1（2026-11-18）：新鲜度徽标 ─────────────────────────────────────
    // 背景：余额快照曾经因为 cron 里 node 找不到而静默停在 24 小时前，页面照样显示旧数字。
    // 现在：>60 分钟即显示「陈旧」红标；>24 小时显示「严重陈旧」；并给出建议动作。
    // 只做展示，不改任何数据。
    if (card && !q(".v2-bal-stale", card)) {
      var ageMin = NaN;
      if (bag.at) { var t = Date.parse(bag.at); if (!isNaN(t)) ageMin = (Date.now() - t) / 60000; }
      var badge = document.createElement("span");
      badge.className = "v2-bal-stale";
      badge.style.marginLeft = "8px";
      badge.style.padding = "1px 6px";
      badge.style.borderRadius = "4px";
      badge.style.fontSize = "12px";
      badge.style.display = "inline-block";
      if (!isFinite(ageMin)) {
        badge.style.background = "#6b7280"; badge.style.color = "#fff";
        badge.textContent = "无时间戳";
        badge.title = "快照没有 fetched_at，无法判断新鲜度";
      } else if (ageMin > 24 * 60) {
        badge.style.background = "#b91c1c"; badge.style.color = "#fff";
        badge.textContent = "严重陈旧 " + Math.round(ageMin / 60) + " 小时前";
        badge.title = "余额/套餐快照超过 24 小时未更新，请检查 scripts/balance-cron.sh 的日志";
      } else if (ageMin > 60) {
        badge.style.background = "#d97706"; badge.style.color = "#fff";
        badge.textContent = "陈旧 " + Math.round(ageMin) + " 分钟前";
        badge.title = "余额/套餐快照超过 60 分钟未更新，请检查 scripts/balance-cron.sh 的日志";
      } else {
        badge.style.background = "#047857"; badge.style.color = "#fff";
        badge.textContent = Math.round(ageMin) + " 分钟前";
        badge.title = "余额/套餐快照较新（≤60 分钟）";
      }
      if (card) card.appendChild(badge);
    }
  }

  /* ── 3. 类型/危险动作的视觉分组：给操作列与危险按钮加语义类（不改行为） ── */
  function markDanger() {
    qa("button").forEach(function (b) {
      var t = (b.textContent || "").trim();
      if (!/删除|卸载|吊销|停用|重置|清空/.test(t)) return;
      if (!b.classList.contains("danger")) b.classList.add("danger");
    });
  }

  /* ── 4. 顶栏版本开关：新旧并存，一键互切（无需重启） ─────────────────── */
  function installSwitch() {
    var header = q("header");
    if (!header || q("#v2Switch")) return;
    var btn = document.createElement("button");
    btn.id = "v2Switch";
    btn.className = "small";
    btn.type = "button";
    btn.textContent = "回到旧版";
    btn.title = "切换管理界面外观（无需重启；新版为覆盖层，旧版功能完全保留）";
    btn.onclick = function () {
      writePref(V1);
      location.reload();
    };
    header.appendChild(btn);
  }

  /* ── 5. 旧版入口提示：若当前是 v1，注入「试用新版」按钮 ───────────────── */
  function installV1Switch() {
    // 本函数在 v1 分支不会执行（上面已 return），保留给 apply 脚本说明用途。
  }

  /* ── 5b. N3（2026-11-19）：余额改由「登录后的 API」拉取 ──────────────────
   * 背景：静态页/未登录响应里原本直接带 `window.__BALANCES__` 的余额金额明文
   *   （人民币与美元余额都在），未登录 curl 即可读到；而 /admin/api/balances 是 401。
   * 现在：页面里的 __BALANCES__ 只留骨架（fetched_at + 空 items）；金额一律由本函数
   *   在已登录会话下 GET /admin/api/balances 注入。401 / 网络失败 ⇒ 保持骨架，不显示任何数字。
   * 只在拿到非空 items 时才渲染，避免把空壳当"余额为 0"。
   */
  var _balFetched = false;
  function refreshBalancesFromApi() {
    if (_balFetched) return;
    try {
      if (!window.fetch) return;
      fetch("/admin/api/balances", { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(function (r) {
          if (!r.ok) return null;                  // 未登录 401 ⇒ 骨架保持
          return r.json();
        })
        .then(function (doc) {
          if (!doc || !doc.items || !doc.items.length) return;
          window.__BALANCES__ = doc;
          _balFetched = true;
          try { decorateBalances(); } catch (e) {}
        })
        .catch(function () { /* 网络失败：保持骨架，不报错、不伪造 */ });
    } catch (e) {}
  }

  /* ── 5c. N8③（2026-11-19）：面板补「插件状态」「backlog」只读区块 ────────
   * 均为只读展示，不提供任何操作按钮；数据来自登录后的管理 API。
   * 失败就显示「不可用」，绝不假装有数据。
   */
  var _panelDone = false;
  function _roRow(label, value, color) {
    var tr = document.createElement("tr");
    var td1 = document.createElement("td");
    td1.style.whiteSpace = "nowrap";
    td1.textContent = label;
    var td2 = document.createElement("td");
    if (color) td2.style.color = color;
    td2.textContent = String(value == null || value === "" ? "—" : value);
    tr.appendChild(td1); tr.appendChild(td2);
    return tr;
  }
  function installReadonlyPanels() {
    if (_panelDone) return;
    var main = document.getElementById("appMain");
    if (!main || main.classList.contains("hidden")) return;   // 未登录：不渲染
    var card = document.createElement("section");
    card.className = "card";
    card.id = "v2ReadonlyCard";
    var head = document.createElement("div");
    head.className = "card-head";
    var h2 = document.createElement("h2");
    h2.textContent = "插件状态 · backlog（只读）";
    head.appendChild(h2);
    card.appendChild(head);
    var wrap = document.createElement("div");
    wrap.className = "tablewrap";
    var table = document.createElement("table");
    table.id = "v2ReadonlyTable";
    var tbody = document.createElement("tbody");
    table.appendChild(tbody);
    wrap.appendChild(table);
    card.appendChild(wrap);
    var note = document.createElement("p");
    note.className = "muted";
    note.style.marginTop = "8px";
    note.textContent = "只读；数据来自 /admin/api/plugin-status 与 /admin/api/backlog。";
    card.appendChild(note);
    var logCard = document.getElementById("log");
    var logSection = logCard ? logCard.closest("section") : null;
    if (logSection && logSection.parentNode === main) main.insertBefore(card, logSection);
    else main.appendChild(card);
    _panelDone = true;
    _loadReadonly();
  }
  function _loadReadonly() {
    var tbody = document.querySelector("#v2ReadonlyTable tbody");
    if (!tbody) return;
    function jget(url) {
      return fetch(url, { credentials: "same-origin", headers: { accept: "application/json" } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    Promise.all([jget("/admin/api/plugin-status"), jget("/admin/api/backlog")]).then(function (res) {
      var ps = res[0], bl = res[1];
      if (!tbody) return;
      tbody.textContent = "";
      if (ps && ps.ok) {
        var c = ps.counts || {};
        var bad = (c.empty_mount || 0) + (c.dangling_symlink || 0);
        tbody.appendChild(_roRow("插件装配（profile=" + (ps.profile || "?") + "）",
          "目录 " + (c.dirs || 0) + "｜挂载 " + (c.mounted || 0) + "｜未挂载 " + (c.unmounted || 0) +
          "｜空挂载 " + (c.empty_mount || 0) + "｜悬空 " + (c.dangling_symlink || 0),
          bad ? "#b91c1c" : null));
        tbody.appendChild(_roRow("未挂载清单", (ps.unmounted || []).join(", ") || "无"));
        tbody.appendChild(_roRow("装配审计", ps.verdict || "—"));
        tbody.appendChild(_roRow("采样时间", (ps.at || "") + "（" + (ps.source || "") + "）"));
      } else {
        tbody.appendChild(_roRow("插件状态", "不可用（未登录或接口失败）", "#b91c1c"));
      }
      if (bl && bl.ok) {
        tbody.appendChild(_roRow("网关 backlog", (bl.listen_backlog == null ? "—" : bl.listen_backlog) +
          "（来源 " + (bl.listen_backlog_source || "?") + "）"));
        tbody.appendChild(_roRow("运行时长", (bl.uptime_s == null ? "—" : Math.round(bl.uptime_s) + " 秒")));
      } else {
        tbody.appendChild(_roRow("网关 backlog", "不可用（未登录或接口失败）", "#b91c1c"));
      }
    });
  }

  /* ── 6. 启动（全部包裹，失败不影响旧版） ─────────────────────────────── */
  function boot() {
    try { installSwitch(); } catch (e) {}
    try { watchTables(); } catch (e) {}
    try { markDanger(); } catch (e) {}
    try { decorateBalances(); } catch (e) {}
    try { refreshBalancesFromApi(); } catch (e) {}
    try { installReadonlyPanels(); } catch (e) {}
    try {
      // 策略页等异步渲染后可能出现新表格，做一次低频兜底
      setInterval(function () {
        try {
          watchTables(); markDanger(); decorateBalances();
          refreshBalancesFromApi(); installReadonlyPanels();
        } catch (e) {}
      }, 2500);
    } catch (e) {}
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }

  /* 供以外调试：v2 版本号 */
  window.__ADMIN_UI_V2__ = "早期.1";
})();

/* ============================================================================
 * v1 分支的「试用新版」入口：独立小段，只在 data-ui=v1 时注入，
 * 保证切回旧版后仍能一键切回新版（双向可逆）。
 * ========================================================================== */
(function () {
  "use strict";
  var V2 = "v2", V1 = "v1";
  var cur = null;
  try { cur = localStorage.getItem("admin.ui"); } catch (e) {}
  if (cur === V1) {
    // 旧版界面：注入一个不改变任何样式的入口按钮
    function add() {
      var header = document.querySelector("header");
      if (!header || document.getElementById("v2Switch")) return;
      var btn = document.createElement("button");
      btn.id = "v2Switch";
      btn.className = "small";
      btn.type = "button";
      btn.textContent = "试用新版";
      btn.title = "启用 UI v2 覆盖层（可随时切回）";
      btn.onclick = function () {
        try { localStorage.setItem("admin.ui", V2); } catch (e) {}
        location.reload();
      };
      header.appendChild(btn);
    }
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", add);
    else add();
  }
})();
