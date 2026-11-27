window.__ModuleLoader__.load({
  id: "dsh-wb-max",
  factory(require) {
    const React = require("react");
    const MAX_KEY = "wb.max.enabled";
    try { console.info("[WB-UI] A5-20261117 loaded · max"); } catch {}

    // ── 价格快照（2026-11-16 生成，来源 config/pricebook.json；客户端离线比价）──
    const WB_PRICES = {"generated_at":"2026-11-16T19:18:11+08:00","activity":{"provider_c":0.85,"provider_d":0.6},"models":{"model_a3":{"offers":[{"provider":"provider_a","model_id":"model_a1","billing":"per_token","confidence":0.99,"comparable":true,"estimated":false,"gp":{},"schedule":"peak_windows","price":{"input":{"peak":2.0,"offpeak":1.0},"cache_hit":{"peak":0.04,"offpeak":0.02},"output":{"peak":8.0,"offpeak":4.0}}},{"provider":"provider_c","model_id":"model_a3","billing":"expr","confidence":0.95,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"multipliers","price":{"input":1.0,"output":4.0,"cache_hit":0.02},"multipliers":[{"h0":14,"h1":18,"f":2.0},{"h0":9,"h1":12,"f":2.0}],"weekday_guard":false},{"provider":"provider_d","model_id":"org/Model_A3","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"hour_offpeak","price":{"input":{"peak":2.0,"offpeak":1.0},"output":{"peak":8.0,"offpeak":4.0},"cache_hit":{"peak":0.04,"offpeak":0.02}},"offpeak_hours":[[2,8]]}]},"model_a5":{"offers":[{"provider":"provider_a","model_id":"model_a5","billing":"per_token","confidence":0.99,"comparable":true,"estimated":false,"gp":{},"schedule":"peak_windows","price":{"input":{"peak":9.0,"offpeak":4.5},"cache_hit":{"peak":0.3,"offpeak":0.15},"output":{"peak":27.0,"offpeak":13.5}}},{"provider":"provider_c","model_id":"model_a5","billing":"expr","confidence":0.95,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"multipliers","price":{"input":4.5,"output":13.5,"cache_hit":0.15},"multipliers":[{"h0":14,"h1":18,"f":2.0},{"h0":9,"h1":12,"f":2.0}],"weekday_guard":false},{"provider":"provider_d","model_id":"org/Model_A5","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":12.0},"output":{"flat":24.0},"cache_hit":{"flat":1.0}}}]},"model_b2":{"offers":[{"provider":"provider_c","model_id":"model_b2","billing":"per_token","confidence":0.9,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"flat","price":{"input":{"flat":0.8},"output":{"flat":2.8},"cache_hit":{"flat":0.2}}},{"provider":"provider_d","model_id":"org/Model_B2","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":0.8},"output":{"flat":2.8},"cache_hit":{"flat":0.23}}}]},"model_b1":{"offers":[{"provider":"provider_c","model_id":"model_b1","billing":"per_token","confidence":0.9,"comparable":true,"estimated":false,"gp":{"gc-chat":0.6,"default":1},"schedule":"flat","price":{"input":{"flat":8.0},"output":{"flat":28.0},"cache_hit":{"flat":2.0}}},{"provider":"provider_d","model_id":"org/Model_B1","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":8.0},"output":{"flat":28.0},"cache_hit":{"flat":2.0}}}]},"model_d2":{"offers":[{"provider":"provider_c","model_id":"model_d2","billing":"per_token","confidence":0.9,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"flat","price":{"input":{"flat":13.0},"output":{"flat":68.0},"cache_hit":{"flat":1.3}}}]},"model_c1":{"offers":[{"provider":"provider_d","model_id":"org/Model_C1","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":3.0},"output":{"flat":12.0}}}]}}};
    const WB_FAMILY = {
      "provider_a/model_a1": "model_a3",
      "provider_a/model_a2": "model_a3",
      "provider_c/model_a3": "model_a3",
      "provider_d/org/Model_A3": "model_a3",
      "provider_a/model_a5": "model_a5",
      "provider_c/model_a5": "model_a5",
      "provider_d/org/Model_A5": "model_a5",
      "provider_c/model_b1": "model_b1",
      "provider_d/org/Model_B1": "model_b1",
      "provider_c/model_b2": "model_b2",
      "provider_d/org/Model_B2": "model_b2",
      "provider_c/model_d2": "model_d2",
      "provider_d/org/Model_C1": "model_c1"
    };
    function wbNow() { return new Date(); }
    function wbEffective(offer, now) {
      const h = now.getHours(), d = now.getDay();
      const act = ((WB_PRICES.activity || {})[offer.provider]) || 1;
      const gp = (offer.gp && offer.gp.default) || 1;
      const out = { prices: {}, factor: act * gp, period: offer.schedule };
      const fill = (block) => { for (const k of ["input", "cache_hit", "output"]) { const v = block[k]; if (v !== null && v !== undefined) out.prices[k] = Math.round(v * act * gp * 1000) / 1000; } };
      if (offer.schedule === "multipliers") {
        let f = 1;
        for (const m of offer.multipliers || []) { if (h >= m.h0 && h < m.h1) f *= m.f; }
        out.factor = act * gp * f; out.period = "×" + (act * gp * f).toFixed(2);
        const scaled = {};
        for (const k of Object.keys(offer.price)) scaled[k] = offer.price[k] * f;
        fill(scaled);
      } else if (offer.schedule === "hour_offpeak") {
        const off = (offer.offpeak_hours || [[2, 8]]).some((w) => h >= w[0] && h < w[1]);
        const block = {};
        for (const k of Object.keys(offer.price)) block[k] = offer.price[k][off ? "offpeak" : "peak"];
        fill(block);
      } else if (offer.schedule === "peak_windows") {
        const wk = d >= 1 && d <= 5;
        const peak = wk && ((h >= 9 && h < 12) || (h >= 14 && h < 18));
        const block = {};
        for (const k of Object.keys(offer.price)) block[k] = offer.price[k][peak ? "peak" : "offpeak"];
        fill(block);
      } else {
        const block = {};
        for (const k of Object.keys(offer.price)) block[k] = offer.price[k] && offer.price[k].flat;
        fill(block);
      }
      return out;
    }
    function wbRows(modelKey) {
      const fam = WB_FAMILY[modelKey];
      let node = fam && WB_PRICES.models[fam];
      if (!node) {
        for (const n of Object.values(WB_PRICES.models || {})) {
          if ((n.offers || []).some((o) => `${o.provider}/${o.model_id}` === modelKey)) { node = n; break; }
        }
      }
      if (!node) return null;
      const now = wbNow();
      return node.offers
        .filter((o) => o.comparable && !o.estimated && o.price)
        .map((o) => ({ provider: o.provider, model_id: o.model_id, ...wbEffective(o, now) }))
        .sort((a, b) => ((a.prices.input ?? 1e9) - (b.prices.input ?? 1e9)));
    }
    function wbPriceTag(modelKey) {
      const rows = wbRows(modelKey);
      if (!rows || !rows.length) return "";
      const r = rows[0];
      const f = (v) => (v === null || v === undefined ? "-" : Number(v).toFixed(3));  // 单位价 3 位（2026-11-17 用户令）
      return ` · ¥${f(r.prices.input)}/${f(r.prices.output)}`;
    }
    function PriceTable(props) {
      const rows = wbRows(props.modelKey);
      if (!rows || !rows.length) return React.createElement("div", { style: { fontSize: "11px", color: "#94a3b8", marginTop: "4px" } }, "该模型暂无价目快照");
      return React.createElement("div", { style: { marginTop: "6px", border: "1px solid #e5e7eb", borderRadius: "8px", overflowX: "auto", overflowY: "visible" } },
        React.createElement("table", { style: { width: "100%", minWidth: "420px", borderCollapse: "collapse", fontSize: "11px" } },
          React.createElement("thead", null, React.createElement("tr", null,
            ["供应商", "当前有效价（入/缓/出）", "活动/倍率", "快照"].map((h, i) =>
              React.createElement("th", { key: i, style: { textAlign: "left", padding: "4px 8px", background: "#f8fafc", color: "#64748b", fontWeight: 600 } }, h)))),
          React.createElement("tbody", null, rows.map((r, i) => React.createElement("tr", { key: i },
            React.createElement("td", { style: { padding: "4px 8px", borderTop: "1px solid #f1f5f9", whiteSpace: "nowrap" } }, r.provider + (i === 0 ? " ★" : "")),
            React.createElement("td", { style: { padding: "4px 8px", borderTop: "1px solid #f1f5f9", whiteSpace: "nowrap" } },
              [r.prices.input, r.prices.cache_hit, r.prices.output].map((v) => (v === null || v === undefined ? "-" : Number(v).toFixed(3))).join(" / ")),
            React.createElement("td", { style: { padding: "4px 8px", borderTop: "1px solid #f1f5f9" } }, r.period || "—"),
            React.createElement("td", { style: { padding: "4px 8px", borderTop: "1px solid #f1f5f9", color: "#94a3b8", whiteSpace: "nowrap" } }, String(WB_PRICES.generated_at || "").slice(5, 16)))))));
    }

    const STRATEGY_LABELS = { auto: "自动", cost: "价格优先", capability: "能力优先", function: "预设功能", recommend: "推荐" };
    // [2026-11-20 用户令] 决策模型开关（可替换 decider 的用户级控制）：off 关 / shadow 只记录 / active 先判后用
    const DECIDER_KEY = "wb.decider.mode";
    const DECIDER_LABELS = { off: "决策·关", shadow: "决策·影子", active: "决策·生效" };
    function deciderMode() { try { const v = localStorage.getItem(DECIDER_KEY); return (v === "shadow" || v === "active") ? v : "off"; } catch { return "off"; } }
    // [2026-11-21 1.0.3.2 · T3/B3] 自动化档位：L1 严格（默认）/ L2 知会 / L3 草稿。
    // 档位只改确认/执行节奏，不改选模结果；L1 不向网关传任何档位字段或请求头
    // ⇒ plan 请求与 1.0.3.1 逐字节一致（零差异）。
    const AUTOMATION_KEY = "wb.automation.level";
    const ADVANCED_KEY = "wb.max.advanced.open";
    const AUTOMATION_LABELS = { L1: "L1 严格", L2: "L2 知会", L3: "L3 草稿" };
    function automationLevel() { try { const v = localStorage.getItem(AUTOMATION_KEY); return (v === "L2" || v === "L3") ? v : "L1"; } catch { return "L1"; } }
    function automationBody(body) { const lv = automationLevel(); return lv === "L1" ? body : { ...body, automation_level: lv }; }
    function automationHeaders() { const lv = automationLevel(); return lv === "L1" ? undefined : { "X-WB-Automation-Level": lv }; }
    const FUNCTIONS = ["vision", "coding", "code_testing", "long_context", "decision", "writing", "system_control", "memory"];
    const RECOMMEND_MODES = [["price", "价格优先"], ["capability", "能力优先"], ["preset", "预设功能"]];
    let sessionFace;
    let maxStrategy = "auto";
    let maxRecommendMode = "price";  // 推荐策略模式：price（默认，价格优先）/ capability / preset（用户 2026-11-17 定）
    let maxFunction = "coding";
    let bridgeSessionId = "";
    // 2026-11-24 会话钉选：三路模型按 stage id 存本地，出计划时随请求发给网关。
    // 只在显式选模/确认时写入，取消勾选或关闭路由时清空 ⇒ 不污染直连会话。
    const PINS_KEY = "wb.max.stage.models";
    function loadPins() { try { const raw = localStorage.getItem(PINS_KEY); const v = raw ? JSON.parse(raw) : null; return (v && typeof v === "object" && !Array.isArray(v)) ? v : {}; } catch { return {}; } }
    function savePins(pins) { try { const keep = {}; for (const k of Object.keys(pins || {})) { if (pins[k]) keep[k] = pins[k]; } if (Object.keys(keep).length) localStorage.setItem(PINS_KEY, JSON.stringify(keep)); else localStorage.removeItem(PINS_KEY); } catch {} }
    function clearPins() { try { localStorage.removeItem(PINS_KEY); } catch {} }
    // 2026-11-24：原生回落白名单不再写死 —— 由「网关已注册模型」里出现过的上游动态补齐。
    // 原缺陷：卡片选了白名单外的上游时只剩 wb-gateway 一条路，网关异常即无原生兜底。
    const KNOWN_EXTRA = new Set();
    function noteKnownProvider(key) {
      const s = String(key || "").replace(/^wb-gateway\//, "");
      const i = s.indexOf("/");
      if (i > 0) KNOWN_EXTRA.add(s.slice(0, i));
    }
    let bridgeRunning = false;
    function SessionBridge(props) {
      const sid = props?.session?.sessionId || "";
      const run = !!props?.session?.running;
      if (sid !== bridgeSessionId) {
        bridgeSessionId = sid;
        window.dispatchEvent(new CustomEvent("wb-session-changed", { detail: { sessionId: sid } }));
      }
      if (run !== bridgeRunning) {
        bridgeRunning = run;
        window.dispatchEvent(new CustomEvent("wb-running-changed", { detail: { running: run } }));
      }
      return null;
    }

    // ── 发送闸门（2026-11-16 用户令）────────────────────────────
    // 1) 插件只负责确认模型与策略，不替代输入框「⬆️」；
    // 2) 勾选 Max 且计划未确认时，「⬆️」置灰不可点；
    // 3) 取消勾选 = 取消计划 + 恢复传统提交流程。
    // 历史坑：旧版每 800ms 轮询 /api/session/list，该请求不回，堆满浏览器
    // 同源 6 条连接后所有 fetch 挂死（表现为 Max 网关不可达 / 生成计划无反应）。
    const GATE_OWNER = "max";
    const sendGate = { closed: false, hint: "" };
    let planAbort = null;
    function setSendGate(closed, hint) {
      sendGate.closed = !!closed;
      sendGate.hint = hint || "";
      applySendButtonState();
    }
    function sendButtonNode() {
      return document.querySelector('button[aria-label="Send message"], button[aria-label*="发送"]');
    }
    function applySendButtonState() {
      const btn = sendButtonNode();
      if (!btn) return;
      if (sendGate.closed) {
        if (!btn.disabled) btn.disabled = true;
        if (btn.getAttribute("data-wb-gated") !== GATE_OWNER) {
          btn.setAttribute("data-wb-gated", GATE_OWNER);
          btn.style.opacity = "0.45";
          btn.style.cursor = "not-allowed";
          btn.setAttribute("title", sendGate.hint || "先确认计划，再点发送");
        }
      } else if (btn.getAttribute("data-wb-gated") === GATE_OWNER) {
        btn.removeAttribute("data-wb-gated");
        // 另一个路由插件可能仍持有闸门（Pro/Max 共用同一个「⬆️」），不能替它解锁。
        if (!btn.hasAttribute("data-wb-gated")) {
          btn.style.opacity = "";
          btn.style.cursor = "";
          btn.removeAttribute("title");
          btn.disabled = false;
        }
      }
    }
    let gateInstalled = false;
    function installSendGate() {
      if (gateInstalled) return;
      gateInstalled = true;
      const tick = () => applySendButtonState();
      setInterval(tick, 400);
      // 只观察节点增删，不观察 disabled 属性：属性回写与宿主受控按钮会互相触发，
      // 实测会形成反馈环把渲染主线程卡死（2026-11-16）。
      new MutationObserver(tick).observe(document.body, { childList: true, subtree: true });
      document.addEventListener("keydown", (ev) => {
        if (!sendGate.closed) return;
        if (ev.key !== "Enter" || ev.shiftKey || ev.isComposing) return;
        const t = ev.target;
        if (t && t.closest && t.closest('[data-composer-input="true"], textarea')) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          window.dispatchEvent(new CustomEvent("wb-gate-block", { detail: { reason: sendGate.hint } }));
        }
      }, true);
      document.addEventListener("click", (ev) => {
        if (!sendGate.closed) return;
        const b = ev.target && ev.target.closest && ev.target.closest('button[aria-label="Send message"], button[aria-label*="发送"]');
        if (b) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          window.dispatchEvent(new CustomEvent("wb-gate-block", { detail: { reason: sendGate.hint } }));
        }
      }, true);
    }

    async function get(path) {
      const r = await fetch(path, { headers: { accept: "application/json" } });
      let data = {}; try { data = await r.json(); } catch {}
      return { ok: r.ok && data?.ok !== false, status: r.status, data };
    }
    async function post(path, body, signal, extraHeaders) {
      const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(extraHeaders || {}) }, body: JSON.stringify(body || {}), signal });
      let data = {}; try { data = await r.json(); } catch {}
      return { ok: r.ok && data?.ok !== false, status: r.status, data };
    }
    const err = (r) => r?.data?.error || r?.data?.message || `HTTP ${r?.status ?? "?"}`;
    // [2026-11-21 1.0.3.2 · T3/B3] 所有 plan 调用点的唯一出口：
    // L2/L3 ⇒ body.automation_level + 同名请求头（两者一致）；L1 ⇒ 原样（零差异）。
    // 旧网关若明确拒收该字段（400/422 且错误提到 automation/档位/unknown 等），
    // 自动按 L1 再发一次兜底（不伪造档位结果，只保证旧网关仍能出计划）。
    async function postPlan(body, signal) {
      const lv = automationLevel();
      const first = await post("/wb-max/plan", automationBody(body), signal, automationHeaders());
      if (first.ok || lv === "L1") return first;
      const text = String(first?.data?.error || first?.data?.message || "");
      const rejectedAsNew = first.status === 422 || (first.status === 400 && /automation|档位|level|unknown|unexpected|extra|未知|不支持/i.test(text));
      if (!rejectedAsNew) return first;
      const fallback = await post("/wb-max/plan", body, signal);
      if (fallback.ok) {
        try { console.info("[WB-UI] 网关不支持 automation_level，已按 L1 兼容重发（档位未生效）"); } catch {}
        return { ...fallback, automationFallback: true };
      }
      return first;
    }

    function planRows(plan) {
      return (plan?.stages || []).map((s) => ({
        stageId: s.stage_id,
        index: s.index,
        title: s.title,
        goal: s.goal,
        capability: s.capability,
        modelKey: s.model?.key,
        modelLabel: s.model?.label || s.model?.key,
        strategyModel: s.model?.strategy_model,
        contextWindow: s.model?.context_window,
        estimate: { inputTokens: s.estimate?.input_tokens || 0, outputTokens: s.estimate?.output_tokens || 0 },
        cost: (() => {
          const v = s.estimate?.cost_known;
          if (v === null || v === undefined) return "未估价";
          return `¥${Number(v).toFixed(3)}`;   // 2026-11-17 用户令：一律人民币、成本估算 3 位小数
        })(),
      }));
    }
    function useModels() {
      const [models, setModels] = React.useState([]);
      React.useEffect(() => {
        get("/wb-max/models").then((r) => {
          if (!r.ok) return;
          for (const m of (r.data.models || [])) noteKnownProvider(m && m.model);
          // 2026-11-17 用户令：虚拟模型（auto / auto-* / auto-fn-*）只用于网关与插件后台
          // 识别·控制·调度，**不进 DSH 前台**；计划卡下拉只列真实候选（provider/model）。
          setModels((r.data.models || []).filter((m) => String(m?.model || "").includes("/")).map((m) => ({
            key: m.model,
            display: m.key,
            label: m.label || m.model,
            contextWindow: m.context_window,
            modalities: (() => {
              const caps = Array.isArray(m.capabilities) ? m.capabilities : (m.capabilities && m.capabilities.input) || [];
              return caps.includes("vision") || m.vision ? ["text", "vision"] : ["text"];
            })(),
          })));
        }).catch(() => {});
      }, []);
      return models;
    }

    // [2026-11-21 1.0.3.2 · T2/B1] 同轮不换模的客户端可用信号：
    // DSH 客户端插件标准面只给「本 Session 是否在跑」（SessionBridge 转发的
    // wb-running-changed、props.session.running、useSessionStatus().running），
    // 没有 per-tool-call / turn-boundary 事件 ⇒ guard 用「回复进行中＝锁定切换」
    // 的最小可用版；轮次结束（running=false）即放行。
    function useRunning() {
      const [running, setRunning] = React.useState(bridgeRunning);
      React.useEffect(() => {
        const h = (ev) => { if (ev?.detail && typeof ev.detail.running === "boolean") setRunning(ev.detail.running); };
        window.addEventListener("wb-running-changed", h);
        return () => window.removeEventListener("wb-running-changed", h);
      }, []);
      return running;
    }

    function MaxToggle(props) {
      const [on, setOn] = React.useState(() => { try { return localStorage.getItem(MAX_KEY) === "1"; } catch { return false; } });
      const [pending, setPending] = React.useState(false);
      const [notice, setNotice] = React.useState("");
      const [strategy, setStrategy] = React.useState(maxStrategy);
      const [recMode, setRecMode] = React.useState(maxRecommendMode);
      const [fn, setFn] = React.useState(maxFunction);
      const [decMode, setDecMode] = React.useState(deciderMode);
      // [2026-11-21 1.0.3.2 · T3/B3] 自动化档位 + 高级入口折叠态
      const [autoLevel, setAutoLevel] = React.useState(automationLevel);
      const [advOpen, setAdvOpen] = React.useState(() => { try { return localStorage.getItem(ADVANCED_KEY) === "1"; } catch { return false; } });
      const running = useRunning() || !!props?.session?.running;
      const live = typeof props?.useInput === "function" ? props.useInput((s) => s) : props?.input;
      const draft = String(live?.draft || "");
      const last = React.useRef("");
      const timer = React.useRef(null);
      /* 261118 灰狼 · 修「点『关』报 RangeError: Maximum call stack size exceeded」：
         setMode 同步派发 `wb-mode-changed`，而本组件下面的 `h` 监听器在 React state
         尚未提交时仍读到旧值 on===true ⇒ 又调 setMode(false) ⇒ 同步无限递归。
         这里加一道防重入：重入调用直接忽略；外层调用随后照常完成 setSendGate 等清理。
         对外行为不变（不使用 ref 参与渲染，不影响任何其它监听者）。 */
      const applyingMode = React.useRef(false);
      function setMode(v) {
        if (applyingMode.current) return;
        applyingMode.current = true;
        try {
          setOn(v);
          try { localStorage.setItem(MAX_KEY, v ? "1" : "0"); } catch {}
          window.dispatchEvent(new CustomEvent("wb-mode-changed", { detail: { max: v } }));
        } finally {
          applyingMode.current = false;
        }
      }
      async function checkHealth() {
        try {
          const r = await get("/wb-max/health");
          if (!r.ok) { setNotice("Max 网关不可达，请切 Pro 或默认模型"); setMode(false); return false; }
          return true;
        } catch { setNotice("Max 网关不可达，请切 Pro 或默认模型"); setMode(false); return false; }
      }
      async function onChange(e) {
        const next = !!e.target.checked;
        if (next) {
          try { localStorage.setItem("wb.pro.enabled", "0"); } catch {}
          const ok = await checkHealth();
          if (!ok) { setSendGate(false, ""); return; }
          setMode(true);
          setSendGate(true, "先确认计划，再点 ⬆️ 发送");
          setNotice("");
          if (draft.trim()) makePlan(draft, strategy, fn);
          return;
        }
        if (planAbort) { try { planAbort.abort(); } catch {} planAbort = null; }
        last.current = "";
        setPending(false);
        setMode(false);
        setNotice("");
        setSendGate(false, "");
        window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: null } }));
      }
      React.useEffect(() => {
        if (!on || !draft.trim() || draft === last.current) return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => { last.current = draft; setPending(true); makePlan(draft, maxStrategy, maxFunction).finally(() => setPending(false)); }, 900);
        return () => clearTimeout(timer.current);
      }, [on, draft]);
      React.useEffect(() => {
        const h = (ev) => {
          if (ev?.detail && ev.detail.max === false && on) {
            if (planAbort) { try { planAbort.abort(); } catch {} planAbort = null; }
            last.current = "";
            setPending(false);
            setMode(false);
            setSendGate(false, "");
            window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: null } }));
          }
        };
        const proOn = () => {
          if (planAbort) { try { planAbort.abort(); } catch {} planAbort = null; }
          last.current = "";
          setPending(false);
          setMode(false);
          setSendGate(false, "");
          window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: null } }));
        };
        window.addEventListener("wb-pro-enabled", proOn);
        const fail = (ev) => {
          const reason = ev?.detail?.reason || "Max 不可用";
          setNotice(`${reason}，已回退 Pro/默认模型`);
          setMode(false);
          setSendGate(false, "");
        };
        const off = () => { setMode(false); setSendGate(false, ""); };
        const onMaxOn = (ev) => {
          if (!ev?.detail || ev.detail.max !== true || on) return;
          checkHealth().then((ok) => {
            if (!ok) return;
            setMode(true);
            setSendGate(true, "先确认计划，再点 ⬆️ 发送");
            setNotice("");
            if (draft.trim()) makePlan(draft, strategy, fn);
          });
        };
        window.addEventListener("wb-mode-changed", onMaxOn);
        window.addEventListener("wb-mode-changed", h);
        window.addEventListener("wb-max-unavailable", fail);
        window.addEventListener("wb-max-enabled", off);
        return () => {
          window.removeEventListener("wb-mode-changed", onMaxOn);
          window.removeEventListener("wb-mode-changed", h);
          window.removeEventListener("wb-max-unavailable", fail);
          window.removeEventListener("wb-max-enabled", off);
          window.removeEventListener("wb-pro-enabled", proOn);
        };
      }, [on]);
      React.useEffect(() => {
        if (!on) { if (!localStorage.getItem(MAX_KEY)) setSendGate(false, ""); return; }
        // 页面刷新后仍是勾选态：先静默探活，网关不可达就回退，避免用户被假状态卡住。
        let live = true;
        checkHealth().then((ok) => { if (!live) return; if (ok) setSendGate(true, "先确认计划，再点 ⬆️ 发送"); });
        return () => { live = false; };
      }, []);
      const strategyOptions = Object.entries(STRATEGY_LABELS).map(([k, v]) => React.createElement("option", { key: k, value: k }, v));
      const functionOptions = FUNCTIONS.map((k) => React.createElement("option", { key: k, value: k }, k));
      function pickStrategy(v) {
        if (guardSwitch("策略")) return;
        setStrategy(v); maxStrategy = v;
        window.dispatchEvent(new CustomEvent("wb-max-strategy", { detail: { strategy: v, function: fn } }));
        if (on && draft.trim()) makePlan(draft, v, fn);
      }
      function pickFunction(v) {
        if (guardSwitch("功能")) return;
        setFn(v); maxFunction = v;
        window.dispatchEvent(new CustomEvent("wb-max-strategy", { detail: { strategy: "function", function: v } }));
        if (on && draft.trim()) makePlan(draft, "function", v);
      }
      function pickDecider(v) {
        if (guardSwitch("决策模式")) return;
        setDecMode(v);
        try { localStorage.setItem(DECIDER_KEY, v); } catch {}
        if (on && draft.trim()) makePlan(draft, strategy, fn);
      }
      function pickRecommendMode(v) {
        if (guardSwitch("推荐模式")) return;
        setRecMode(v); maxRecommendMode = v;
        if (on && draft.trim() && strategy === "recommend") makePlan(draft, "recommend", fn);
      }
      // [2026-11-21 1.0.3.2 · T2/B1] 同轮不换模：当前 DSH 客户端插件只暴露「本 Session
      // 是否在跑」的布尔量（SessionBridge 的 wb-running-changed / props.session.running），
      // 拿不到 per-tool-call 事件 ⇒ 按「回复进行中＝锁定模型/策略切换，收到结束事件放行」实现。
      // 注意：档位只改确认节奏、不改选模结果，因此切档位不在此 guard 内。
      function guardSwitch(what) {
        if (!running) return false;
        const reason = `本段同轮不换模：当前回复未结束，暂不能切换${what}，等本段完成后再切`;
        setNotice(reason);
        window.dispatchEvent(new CustomEvent("wb-guard-block", { detail: { reason, what } }));
        return true;
      }
      function pickAutomation(v) {
        const lv = (v === "L2" || v === "L3") ? v : "L1";
        setAutoLevel(lv);
        try { localStorage.setItem(AUTOMATION_KEY, lv); } catch {}
        window.dispatchEvent(new CustomEvent("wb-automation-changed", { detail: { level: lv } }));
        // 执行中只落盘/显示，不打断本轮；下一份计划起带新档位。
        if (on && draft.trim() && !running) makePlan(draft, strategy, fn);
      }
      if (!on) {
        return notice ? React.createElement("span", { "data-dsh-max": "notice", style: { color: "#b42318", fontSize: "11px" } }, notice) : null;
      }
      // [2026-11-21 1.0.3.2 · T3/B3] 面板顶部＝自动化档位；原「策略/决策/功能/推荐」
      // 入口收进「高级」折叠（一版双写，保留既有功能，不删除）。
      const autoOptions = Object.entries(AUTOMATION_LABELS).map(([k, v]) => React.createElement("option", { key: k, value: k }, v));
      const advControls = advOpen ? [
        React.createElement("select", { key: "strategy", value: strategy, disabled: pending, onChange: (e) => pickStrategy(e.target.value), title: "Max 策略（高级入口，保留原有功能）", style: { fontSize: "11px", maxWidth: "72px" } }, strategyOptions),
        React.createElement("select", { key: "decider", value: decMode, disabled: pending, onChange: (e) => pickDecider(e.target.value), title: "决策模型：关/只记录/先判后用", style: { fontSize: "11px", maxWidth: "92px" } }, Object.entries(DECIDER_LABELS).map(([k, v]) => React.createElement("option", { key: k, value: k }, v))),
        strategy === "function" ? React.createElement("select", { key: "fn", value: fn, disabled: pending, onChange: (e) => pickFunction(e.target.value), title: "功能", style: { fontSize: "11px", maxWidth: "92px" } }, functionOptions) : null,
        strategy === "recommend" ? React.createElement("select", { key: "rec", value: recMode, disabled: pending, onChange: (e) => pickRecommendMode(e.target.value), title: "推荐模式", style: { fontSize: "11px", maxWidth: "84px" } }, RECOMMEND_MODES.map(([k, v]) => React.createElement("option", { key: k, value: k }, v))) : null,
        React.createElement("span", { key: "hint", style: { color: "#64748b", fontSize: "10px", whiteSpace: "nowrap" } }, "档位只改确认节奏，不改选模结果"),
      ] : [];
      return React.createElement("div", { "data-dsh-max": "toggle", "data-wb-ui": "A6-20261121", "data-wb-automation": autoLevel, style: { display: "flex", alignItems: "center", gap: "5px", padding: "0", fontSize: "11px", whiteSpace: "nowrap" } },
        React.createElement("select", { "data-wb-automation-level": autoLevel, value: autoLevel, disabled: pending, onChange: (e) => pickAutomation(e.target.value), title: "自动化档位：L1 严格（默认，每段确认）/ L2 知会（按已审计划自动执行，段末推送）/ L3 草稿（自动执行，结果进草稿待放行）。档位只改确认节奏，不改选模结果。", style: { fontSize: "11px", maxWidth: "96px" } }, autoOptions),
        React.createElement("button", { type: "button", "data-wb-advanced": advOpen ? "1" : "0", onClick: () => { const next = !advOpen; setAdvOpen(next); try { localStorage.setItem(ADVANCED_KEY, next ? "1" : "0"); } catch {} }, title: "高级：折叠保留原有 策略 / 决策模型 / 功能 / 推荐模式 入口", style: { font: "inherit", fontSize: "11px", padding: "2px 7px", borderRadius: "7px", border: "1px solid #dbe3ec", background: advOpen ? "#f1f5f9" : "#fff", cursor: "pointer" } }, advOpen ? "高级 ▾" : "高级 ▸"),
        ...advControls,
        React.createElement("span", { "data-wb-boundary": "1", title: "边界纪律（B1）：同一轮内不换模型。当前回复未结束时禁止切换模型/策略，收到本段结束事件（running=false）后自动放行。", style: { color: running ? "#b42318" : "#64748b", fontSize: "10px", whiteSpace: "nowrap" } }, running ? "本段执行中·不换模" : "本段同轮不换模"),
        React.createElement("button", { type: "button", disabled: pending || !draft.trim(), onClick: () => { setPending(true); makePlan(draft, strategy, fn).finally(() => setPending(false)); }, style: { font: "inherit", fontSize: "11px", padding: "2px 8px", borderRadius: "7px", border: "1px solid #dbe3ec", background: "#fff", cursor: "pointer" } }, pending ? "规划中…" : "生成计划"),
        notice ? React.createElement("span", { title: notice, style: { color: "#b42318", maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis" } }, notice) : null
      );
    }

    function useMaxOn() {
      const [on, setOn] = React.useState(() => { try { return localStorage.getItem(MAX_KEY) === "1"; } catch { return false; } });
      React.useEffect(() => {
        const h = (ev) => { if (ev?.detail && typeof ev.detail.max === "boolean") setOn(ev.detail.max); };
        window.addEventListener("wb-mode-changed", h);
        return () => window.removeEventListener("wb-mode-changed", h);
      }, []);
      return on;
    }

    // ── 会话阶段（2026-11-17 修「新建对话 Pro/Max 不能用」）─────────────────
    // DSH 的 conversation.composer.dock 只在 variant==="composer" 时渲染；
    // 新建对话/空会话走 hero 阶段（InputBar variant="hero"）⇒ 该槽不渲染
    // ⇒ 计划卡不可见、发送闸门却已关闭 = 死锁。
    // conversation.input.dock 在 hero 与 active 都渲染，故计划卡两个槽都注册、
    // 按 [data-phase] 各显示一个（hero→input.dock；active→composer.dock，位置不变）。
    function readPhase() {
      try {
        const el = document.querySelector('[data-phase]');
        return (el && el.getAttribute('data-phase')) || "active";
      } catch { return "active"; }
    }
    function useConversationPhase() {
      const [phase, setPhase] = React.useState(readPhase);
      React.useEffect(() => {
        const sync = () => setPhase((prev) => { const next = readPhase(); return next === prev ? prev : next; });
        sync();
        const obs = new MutationObserver(sync);
        obs.observe(document.body, { subtree: true, attributeFilter: ["data-phase"], attributes: true });
        return () => obs.disconnect();
      }, []);
      return phase;
    }
    function PlanCard(props) {
      const maxOn = useMaxOn();
      const phase = useConversationPhase();
      // slot="dock" → 只在新对话/空会话（hero）显示；slot="composer" → 只在已有会话显示（位置不变）
      const slot = props?.slot === "dock" ? "dock" : "composer";
      const phaseMatch = slot === "dock" ? phase === "hero" : phase !== "hero";
      const [plan, setPlan] = React.useState(null);
      const [approved, setApproved] = React.useState(false);
      const [current, setCurrent] = React.useState(0);
      const [busy, setBusy] = React.useState(false);
      const [cmp, setCmp] = React.useState(false);
      const [collapsed, setCollapsed] = React.useState(() => { try { return localStorage.getItem("wb.max.plan.collapsed") === "1"; } catch { return false; } });
      const [msg, setMsg] = React.useState("");
      // [2026-11-21 1.0.3.2 · T3/B3] 档位显示（只读，切换由 MaxToggle 落盘 + 事件广播）
      const [autoLevel, setAutoLevel] = React.useState(automationLevel);
      React.useEffect(() => {
        const h = (ev) => setAutoLevel(ev?.detail?.level || automationLevel());
        window.addEventListener("wb-automation-changed", h);
        return () => window.removeEventListener("wb-automation-changed", h);
      }, []);
      // 2026-11-24：钉选从本地恢复（新建会话/刷新后不再回退默认模型）。
      const [overrides, setOverrides] = React.useState(() => loadPins());
      const models = useModels();
      const [bridgeSid, setBridgeSid] = React.useState(bridgeSessionId);
      React.useEffect(() => {
        const h = (ev) => setBridgeSid(String(ev?.detail?.sessionId || ""));
        window.addEventListener("wb-session-changed", h);
        return () => window.removeEventListener("wb-session-changed", h);
      }, []);
      const sessionId = props?.session?.sessionId || bridgeSid || bridgeSessionId;
      const live = typeof props?.useInput === "function" ? props.useInput((s) => s) : props?.input;
      const draft = String(live?.draft || "");
      const rows = plan ? planRows(plan) : [];
      const cmpModel = ((rows[0] || {}).modelKey) || "";

      /* 2026-11-16 23:5x 灰狼：删掉对 /api/session/list 的 900ms 轮询。
         实测该旧接口在本机 38–43s、单包 9.3MB（2669 个会话全量构造）；900ms 一轮会把浏览器
         同源 6 条连接占满 ⇒ 整页「假死」、切模型/模型操作请求排队超时后报「模型操作失败」。
         running 改用宿主 session.running 或 SessionBridge 发出的 wb-running-changed 事件。 */
      const [remoteRunning, setRemoteRunning] = React.useState(bridgeRunning);
      React.useEffect(() => {
        const h = (ev) => { if (ev && ev.detail && typeof ev.detail.running === "boolean") setRemoteRunning(ev.detail.running); };
        window.addEventListener("wb-running-changed", h);
        return () => window.removeEventListener("wb-running-changed", h);
      }, []);
      const running = !!props?.session?.running || bridgeRunning || remoteRunning;
      React.useEffect(() => {
        const blocked = (ev) => setMsg((ev?.detail?.reason ? `${ev.detail.reason}；` : "") + "先确认计划，再点 ⬆️ 发送");
        window.addEventListener("wb-gate-block", blocked);
        return () => window.removeEventListener("wb-gate-block", blocked);
      }, []);
      // [2026-11-21 1.0.3.2 · T2/B1] 同轮切换被客户端 guard 拦下时，把原因放到计划卡状态栏
      React.useEffect(() => {
        const guard = (ev) => setMsg(ev?.detail?.reason || "本段同轮不换模：当前回复未结束，等本段完成后再切换");
        window.addEventListener("wb-guard-block", guard);
        return () => window.removeEventListener("wb-guard-block", guard);
      }, []);
      React.useEffect(() => {
        const h = (ev) => {
          const detail = ev?.detail || {};
          if (detail.plan) { setPlan(detail.plan); setApproved(false); setCurrent(0); setMsg(""); }
          else { setPlan(null); setApproved(false); setCurrent(0); setMsg(""); }
        };
        const strat = (ev) => {
          const d = ev?.detail || {};
          if (d.strategy && draft.trim()) replan(d.strategy, d.function || maxFunction);
        };
        window.addEventListener("wb-max-plan", h);
        window.addEventListener("wb-max-strategy", strat);
        return () => { window.removeEventListener("wb-max-plan", h); window.removeEventListener("wb-max-strategy", strat); };
      }, [draft]);

      async function replan(nextStrategy = maxStrategy, nextFn = maxFunction) {
        if (!draft.trim()) return;
        setBusy(true); setMsg("");
        try { if (planAbort) planAbort.abort(); } catch {}
        planAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
        // 2026-11-24：草稿直接出计划也带会话钉选（否则此路径仍会被策略链弹回）。
        const draftPins = loadPins();
        const r = await postPlan({ task: draft, strategy: nextStrategy, decider: deciderMode(), ...(Object.keys(draftPins).length ? { stage_models: draftPins } : {}), ...(nextStrategy === "function" ? { function: nextFn } : {}), ...(nextStrategy === "recommend" ? { mode: maxRecommendMode } : {}) }, planAbort ? planAbort.signal : undefined).catch((e) => ({ ok: false, data: { error: String(e && e.message || e) } }));
        setBusy(false);
        if (!r.ok) {
          if (r && r.data && r.data.aborted) return;
          // 计划失败时再探一次网关：若是网关掉线，按用户口径提示并回退，不把用户卡在勾选态。
          const healthy = await checkHealth();
          if (!healthy) { setSendGate(false, ""); return; }
          setMsg(`计划失败：${err(r)}`);
          setSendGate(true, "Max 计划失败，请重试或取消勾选");
          return;
        }
        setPlan(r.data); setApproved(false); setCurrent(0);
        setSendGate(true, "先确认计划，再点 ⬆️ 发送");
        window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: r.data } }));
      }
      function dshTargets(rawKey) {
        // 会话切模型必须给 DSH 的 (provider, model)。返回**有序候选**。
        // 2026-11-17 修（用户令第 1 条「新建对话 Pro/Max 不能用」）：
        //   原实现把网关注册的候选（如 provider_a/model_a5）直接当成
        //   「原生供应商 + 模型」下发，但原生 llm-deepseek 只声明了 model_a1 /
        //   model_a2 等，**没有 model_a5** ⇒ selectModel 回
        //   session/model-unavailable ⇒ 确认失败 ⇒ 发送闸门永久关闭。
        //   改为：先走网关（wb-gateway/<完整候选键>，即设计口径——会话持有候选，
        //   网关负责链内回落与记账），网关不认再退原生 provider。
        let key = String(rawKey || "").replace(/^wb-gateway\//, "");
        const slash = key.indexOf("/");
        const head = slash > 0 ? key.slice(0, slash) : "";
        const rest = slash > 0 ? key.slice(slash + 1) : "";
        const KNOWN = [...KNOWN_EXTRA, "provider_c", "provider_d", "provider_a", "provider_a",
                       "provider_i", "provider_h", "provider_b", "model_e1", "model_e2"];
        // provider_i / provider_h 是 DSH 直连桥，网关不代理 ⇒ 只能给原生 (provider, model)
        if (head === "provider_i" || head === "provider_h") return [{ provider: head, model: rest }];
        const out = [{ provider: "wb-gateway", model: key }];
        if (KNOWN.includes(head)) out.push({ provider: head, model: rest });
        return out;
      }
      function dshTarget(rawKey) { return dshTargets(rawKey)[0]; }

      async function switchTo(index, modelKey) {
        const row = rows[index]; if (!row) return false;
        // Browser-side session remote: same API path as the UI model selector.
        // The Host-side selectModel can hit a persistence write-handle lock while
        // the session is open in Web; this call runs through the client remote.
        try {
          const rpcId = (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID() : `rpc-${Date.now()}`;
          const targets = dshTargets(modelKey);
          let lastErr = "";
          for (const t of targets) {
            try {
              const resp = await fetch("/api/session/selectModel", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ type: "client-request", rpcId, method: "session/selectModel", payload: { args: { request: { sessionId, provider: t.provider, model: t.model } } } })
              });
              const data = await resp.json();
              if (data?.result?.ok) { setCurrent(index); return true; }
              lastErr = `${t.provider}/${t.model}: ${data?.result?.error?.message || data?.result?.error?.code || `HTTP ${resp.status}`}`;
            } catch (error) {
              lastErr = `${t.provider}/${t.model}: ${String(error?.message || error)}`;
            }
          }
          // 最后退 host 端点（服务端权威映射；原来这段在 return 之后，是死代码）
          const r = await post("/wb-max/switch", { sessionId, modelKey });
          if (!r.ok) { setMsg(`切段失败：${lastErr || err(r)}`); return false; }
          setCurrent(index);
          return true;
        } catch (error) {
          setMsg(`切段失败：${String(error?.message || error)}`);
          return false;
        }
      }
      async function annotate(index) {
        const row = rows[index]; if (!row || !plan) return;
        await post("/wb-max/annotation", {
          plan_id: plan.plan_id, stage_id: row.stageId, model_key: row.modelKey,
          confirmed: true, outcome: "ok", strategy: plan.resolved_strategy || plan.strategy,
          capability: row.capability, function: plan.function || undefined,
          usage: {},
        }).catch(() => {});
      }
      async function confirm() {
        if (!rows.length) return;
        if (running) { setMsg("当前回复执行中，等本段结束再开工"); return; }
        setBusy(true); setMsg("");
        const ok = await switchTo(0, overrides[rows[0].stageId] || rows[0].modelKey);
        if (ok) {
          setApproved(true);
          setSendGate(false, "");
          setMsg("已确认模型与策略；请点 ⬆️ 发送（发送按钮已解锁）");
        } else {
          setMsg("第 1 段模型切换失败；请再点一次「确认模型与策略」");
        }
        setBusy(false);
      }
      async function next() {
        if (!approved) return;
        if (running) { setMsg("当前段仍在执行，等回复结束再切下一段"); return; }
        setBusy(true); setMsg("");
        await annotate(current);
        const ni = current + 1;
        if (ni >= rows.length) { setMsg("已完成最后一段"); setBusy(false); return; }
        const row = rows[ni];
        const ok = await switchTo(ni, overrides[row.stageId] || row.modelKey);
        if (ok) setMsg(`已切到第 ${row.index} 段`);
        setBusy(false);
      }
      async function choose(row, modelKey) {
        // [2026-11-21 1.0.3.2 · T2/B1] 同轮不换模：回复进行中尝试换模 ⇒ 提示并阻止（不落任何切换）。
        if (running) { setMsg("本段同轮不换模：当前回复未结束，等本段完成后再切换模型"); return; }
        if (!approved) {
          // 2026-11-24：钉选落本地，重出计划时随 stage_models 发给网关，不再被策略链弹回。
          const next = { ...overrides, [row.stageId]: modelKey };
          setOverrides(next); savePins(next);
          setPlan((prev) => prev ? { ...prev, stages: prev.stages.map((s) => s.stage_id === row.stageId ? { ...s, model: { ...s.model, key: modelKey, label: modelKey } } : s) } : prev);
          return;
        }
        // 已开工：下拉即切换，不再要求「下一段」
        const idx = rows.indexOf(row);
        if (idx < 0) return;
        const ok = await switchTo(idx, modelKey);
        if (ok) setMsg(`已切到第 ${row.index} 段：${modelKey}`);
      }
      if (!phaseMatch) return null;
      if (!plan) return null;
      if (collapsed) return React.createElement("div", { "data-dsh-max": "card", style: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "6px 10px", margin: "4px 0", background: "#fff", fontSize: "12px", width: "min(520px, 100%)", boxShadow: "0 4px 12px rgba(15,23,42,.06)" } },
        React.createElement("span", { style: { fontSize: "11px", fontWeight: 700, color: "#fff", background: "#0f766e", padding: "1px 7px", borderRadius: "6px" } }, "Max"),
        React.createElement("span", null, "路由计划已收起 · ", `${STRATEGY_LABELS[plan.resolved_strategy] || plan.strategy}`),
        React.createElement("span", { style: { color: "#64748b", fontSize: "11px", whiteSpace: "nowrap" } }, `档位：${AUTOMATION_LABELS[autoLevel] || autoLevel}`),
        React.createElement("span", { "data-wb-boundary": "1", title: "边界纪律（B1）：同一轮内不换模型；当前回复未结束时禁止切换模型/策略，收到结束事件后放行。", style: { color: running ? "#b42318" : "#64748b", fontSize: "10px", whiteSpace: "nowrap" } }, running ? "执行中·不换模" : "本段同轮不换模"),
        React.createElement("span", { title: "模型路由可能调用 DSH 直连模型与网关模型；直连段不进网关台账（无回退、无记账），为保证计费准确，建议优先使用网关模型。", style: { fontSize: "11px", color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "6px", padding: "1px 6px", whiteSpace: "nowrap", cursor: "help" } }, "ⓘ 建议用网关模型"),
        React.createElement("button", { type: "button", onClick: () => { setCollapsed(false); try { localStorage.setItem("wb.max.plan.collapsed", "0"); } catch {} }, style: { marginLeft: "auto", font: "inherit", fontSize: "11px", padding: "2px 8px" } }, "展开"));
      const strategyOptions = Object.entries(STRATEGY_LABELS).map(([k, v]) => React.createElement("option", { key: k, value: k }, v));
      const functionOptions = FUNCTIONS.map((k) => React.createElement("option", { key: k, value: k }, k));
      const warn = (row, m) => {
        if (!m) return "";
        if (Array.isArray(m.modalities) && !m.modalities.includes("vision") && row.capability === "vision") return "（不兼容视觉）";
        return "";
      };
      const rowNodes = rows.map((row) => {
        const opts = models.map((m) => React.createElement("option", { key: m.key, value: m.key, title: m.label }, `${m.label}${wbPriceTag(m.key)}${warn(row, m)}`));
        const value = overrides[row.stageId] || row.modelKey;
        if (!models.some((m) => m.key === value)) opts.unshift(React.createElement("option", { key: "cur", value }, row.modelLabel || value));
        return React.createElement("div", { key: row.stageId, style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", margin: "3px 0" } },
          React.createElement("div", { style: { fontSize: "12px", whiteSpace: "nowrap" } }, `${row.index}. ${row.title} → ${row.modelLabel}  ${row.cost}`),
          React.createElement("select", { value, disabled: busy, title: running ? "本段同轮不换模：等本段结束再切换" : "选择本段模型", onChange: (e) => choose(row, e.target.value), style: { maxWidth: "220px", font: "inherit", fontSize: "12px" } }, opts));
      });
      if (!maxOn) return null;
      return React.createElement("div", { "data-dsh-max": "card", style: { border: "1px solid #e5e7eb", borderRadius: "12px", padding: "10px 12px", margin: "6px 0 12px 0", background: "#fff", fontSize: "12px", display: "inline-flex", flexDirection: "column", width: "min(520px, 100%)", maxWidth: "100%", alignSelf: "flex-start", marginRight: "auto", boxShadow: "0 6px 18px rgba(15,23,42,.06)", maxHeight: cmp ? "72vh" : "34vh", overflowY: "auto", position: "relative", zIndex: 20 } },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" } },
          React.createElement("span", { style: { fontSize: "11px", fontWeight: 700, color: "#fff", background: "#0f766e", padding: "1px 7px", borderRadius: "6px" } }, "Max"),
          React.createElement("span", { style: { fontWeight: 600 } }, "网关路由计划"),
          React.createElement("span", { style: { marginLeft: "auto", color: "#64748b", fontSize: "11px" } }, `策略：${STRATEGY_LABELS[plan.resolved_strategy] || plan.strategy}`),
          React.createElement("button", { type: "button", onClick: () => { setCollapsed(true); try { localStorage.setItem("wb.max.plan.collapsed", "1"); } catch {} }, style: { font: "inherit", fontSize: "11px", padding: "1px 7px", border: "1px solid #dbe3ec", background: "#fff", borderRadius: "6px", cursor: "pointer" } }, "收起")),
        React.createElement("div", { style: { color: "#64748b", fontSize: "11px", marginBottom: "3px" } }, `策略：${STRATEGY_LABELS[plan.resolved_strategy] || plan.strategy}${plan.function ? ` / ${plan.function}` : ""}`),
        // [2026-11-21 1.0.3.2 · T3/B3 + T2/B1] 状态栏：档位语义 + 同轮不换模
        React.createElement("div", { "data-wb-status": "1", style: { color: running ? "#b42318" : "#64748b", fontSize: "11px", marginBottom: "3px" } },
          `档位：${AUTOMATION_LABELS[autoLevel] || autoLevel} · 档位只改确认节奏，不改选模结果 · ${running ? "本段同轮不换模（执行中，切换已锁定）" : "本段同轮不换模"}`),
        ...rowNodes,
        React.createElement("div", { style: { color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "6px", padding: "3px 7px", marginTop: "5px", fontSize: "11px", lineHeight: 1.45 } }, "模型路由可能调用 DSH 直连模型与网关模型；直连段不进网关台账（无回退、无记账），为保证计费准确，建议优先使用网关模型。"),
        React.createElement("div", { style: { color: "#64748b", marginTop: "4px" } }, plan.pricing?.notice || ""),
        msg ? React.createElement("div", { style: { color: "#a15c00", marginTop: "4px" } }, msg) : null,
        approved ? React.createElement("div", { style: { color: "#1d4ed8", marginTop: "4px" } }, `[WB路由] 第 ${Math.min(current + 1, rows.length)}/${rows.length} 段`) : null,
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" } },
          React.createElement("button", { type: "button", onClick: () => setCmp((v) => !v), style: { font: "inherit", fontSize: "11px", padding: "2px 8px", borderRadius: "7px", border: "1px solid #dbe3ec", background: "#fff", cursor: "pointer" } }, cmp ? "收起比价" : "比价"),
          React.createElement("span", { style: { color: "#94a3b8", fontSize: "11px" } }, "价格快照 " + String(WB_PRICES.generated_at || "").slice(5, 16))),
        cmp ? React.createElement(PriceTable, { modelKey: cmpModel }) : null,
        React.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "6px" } },
          !approved ? React.createElement("button", { type: "button", disabled: busy || running, onClick: confirm, title: running ? "当前回复执行中" : "只确认模型与策略，不替你发送；确认后自己点 ⬆️", style: { fontSize: "12px", padding: "2px 10px", background: "#15803d", color: "#fff", border: 0, borderRadius: "6px", opacity: running ? 0.6 : 1 } }, running ? "等本段结束…" : "确认模型与策略") : null,
          approved ? React.createElement("span", { style: { color: "#64748b", fontSize: "11px", alignSelf: "center" } }, "已开工：直接改各段下拉即可切换，无需再点“下一段”") : null,
          React.createElement("button", { type: "button", disabled: busy, onClick: () => {
            if (planAbort) { try { planAbort.abort(); } catch {} planAbort = null; }
            try { localStorage.setItem(MAX_KEY, "0"); } catch {}
            setSendGate(false, "");
            clearPins();  // 2026-11-24：取消＝丢弃全部会话钉选，回到网关默认策略。
            window.dispatchEvent(new CustomEvent("wb-max-enabled", { detail: { on: false } }));
            setPlan(null); setApproved(false); setOverrides({}); setMsg("");
            window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: null } }));
          }, style: { fontSize: "12px", padding: "2px 10px" } }, "取消"))
      );
    }

    async function makePlan(text, strategy = "auto", functionKey = "") {
      try { if (planAbort) planAbort.abort(); } catch {}
      planAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
      const signal = planAbort ? planAbort.signal : undefined;
      try {
        // 2026-11-24：带上会话钉选的三路模型，避免重出计划时被网关策略链弹回官方默认。
        const pins = loadPins();
        const stageModels = Object.keys(pins).length ? pins : undefined;
        const r = await postPlan({ task: text, strategy, decider: deciderMode(), ...(stageModels ? { stage_models: stageModels } : {}), ...(strategy === "function" ? { function: functionKey } : {}), ...(strategy === "recommend" ? { mode: maxRecommendMode } : {}) }, signal);
        if (!r.ok) return { ok: false, error: err(r) };
        window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: r.data } }));
        return r;
      } catch (e) {
        if (e && e.name === "AbortError") return { ok: false, aborted: true };
        return { ok: false, error: String(e && e.message || e) };
      }
    }

    function apply(ctx) {
      installSendGate();
      try {
        if (!document.getElementById("wb-router-layout")) {
          const style = document.createElement("style");
          style.id = "wb-router-layout";
          style.textContent = "div[class*='composerStack']{transform:translateX(-90px)}@media (max-width:900px){div[class*='composerStack']{transform:none}}";
          document.head.appendChild(style);
        }
      } catch {}
      try {
        const get = ctx?.get;
        sessionFace = typeof get === "function" ? (get.call(ctx, "sessions") || undefined) : undefined;
      } catch { sessionFace = undefined; }
      if (!ctx?.slots) return;
      for (const slot of [
        { name: "conversation.input.dock", id: "wb-max-bridge", order: 1, component: SessionBridge },
        { name: "conversation.input.right", id: "wb-max-toggle", order: 31, component: MaxToggle },
        { name: "conversation.composer.dock", id: "wb-max-plan", order: 20,
          component: (p) => React.createElement(PlanCard, { ...p, slot: "composer" }) },
        { name: "conversation.input.dock", id: "wb-max-plan-hero", order: 2,
          component: (p) => React.createElement(PlanCard, { ...p, slot: "dock" }) },
      ]) {
        ctx.slots.inject(slot.name, () => ctx.slots.register({ name: slot.name, id: slot.id, order: slot.order }, slot.component));
      }
      return () => { setSendGate(false, ""); window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: null } })); };
    }
    return { apply, inject: ["slots"] };
  }
});


