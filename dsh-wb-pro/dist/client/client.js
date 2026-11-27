window.__ModuleLoader__.load({
  id: "dsh-wb-pro",
  factory(require) {
    const React = require("react");
    const BASE = "/router";
    const PRO_KEY = "wb.pro.enabled";
    try { console.info("[WB-GearPilot] ui-a5 loaded · pro"); } catch {}
    const DEFAULT_STAGES = ["分析任务", "执行", "验收"];

    // ── 价格快照（2026-11-16 生成，来源 config/pricebook.json；客户端离线比价）──
    const WB_PRICES = {"generated_at":"2026-11-16T19:18:11+08:00","activity":{"provider_c":0.85,"provider_d":0.6},"models":{"model_a3":{"offers":[{"provider":"provider_a","model_id":"model_a1","billing":"per_token","confidence":0.99,"comparable":true,"estimated":false,"gp":{},"schedule":"peak_windows","price":{"input":{"peak":2,"offpeak":1},"cache_hit":{"peak":0.04,"offpeak":0.02},"output":{"peak":8,"offpeak":4}}},{"provider":"provider_c","model_id":"model_a3","billing":"expr","confidence":0.95,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"multipliers","price":{"input":1,"output":4,"cache_hit":0.02},"multipliers":[{"h0":14,"h1":18,"f":2},{"h0":9,"h1":12,"f":2}],"weekday_guard":false},{"provider":"provider_d","model_id":"org/Model_A3","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"hour_offpeak","price":{"input":{"peak":2,"offpeak":1},"cache_hit":{"peak":0.04,"offpeak":0.02},"output":{"peak":8,"offpeak":4}},"offpeak_hours":[[2,8]]}]},"model_a5":{"offers":[{"provider":"provider_a","model_id":"model_a5","billing":"per_token","confidence":0.99,"comparable":true,"estimated":false,"gp":{},"schedule":"peak_windows","price":{"input":{"peak":9,"offpeak":4.5},"cache_hit":{"peak":0.3,"offpeak":0.15},"output":{"peak":27,"offpeak":13.5}}},{"provider":"provider_c","model_id":"model_a5","billing":"expr","confidence":0.95,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"multipliers","price":{"input":4.5,"output":13.5,"cache_hit":0.15},"multipliers":[{"h0":14,"h1":18,"f":2},{"h0":9,"h1":12,"f":2}],"weekday_guard":false},{"provider":"provider_d","model_id":"org/Model_A5","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":12},"output":{"flat":24},"cache_hit":{"flat":1}}}]},"model_b1":{"offers":[{"provider":"provider_c","model_id":"model_b1","billing":"per_token","confidence":0.9,"comparable":true,"estimated":false,"gp":{"gc-chat":0.6,"default":1},"schedule":"flat","price":{"input":{"flat":8},"output":{"flat":28},"cache_hit":{"flat":2}}},{"provider":"provider_d","model_id":"org/Model_B1","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":8},"output":{"flat":28},"cache_hit":{"flat":2}}}]},"model_b2":{"offers":[{"provider":"provider_c","model_id":"model_b2","billing":"per_token","confidence":0.9,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"flat","price":{"input":{"flat":0.8},"output":{"flat":2.8},"cache_hit":{"flat":0.2}}},{"provider":"provider_d","model_id":"org/Model_B2","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":0.8},"output":{"flat":2.8},"cache_hit":{"flat":0.23}}}]},"model_d2":{"offers":[{"provider":"provider_c","model_id":"model_d2","billing":"per_token","confidence":0.9,"comparable":true,"estimated":false,"gp":{"default":1,"gc-chat":0.6},"schedule":"flat","price":{"input":{"flat":13},"output":{"flat":68},"cache_hit":{"flat":1.3}}}]},"model_c1":{"offers":[{"provider":"provider_d","model_id":"org/Model_C1","billing":"per_token","confidence":0.95,"comparable":true,"estimated":false,"gp":{},"schedule":"flat","price":{"input":{"flat":3},"output":{"flat":12}}}]}}};
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
      // 单位价（¥/百万 token）口径：3 位小数（早期约定）；"-" = 价目快照里没这一项（不是 0）。
      const f = (v) => (v === null || v === undefined ? "-" : Number(v).toFixed(3));
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


    // P3（10311）：宿主 useInput 的 draft 可能取空 ⇒ 从 composer 的 contenteditable 兜底读取真实草稿。
    function readDraftFromDom() {
      try {
        const nodes = document.querySelectorAll('[data-input-scroll] [contenteditable="true"], [contenteditable="true"][data-composer-input], textarea[data-composer-input]');
        for (const el of nodes) {
          const text = String(el.innerText || el.value || "").trim();
          if (text) return text;
        }
      } catch {}
      return "";
    }
    const draftFallback = (draftValue) => String(draftValue || "").trim() ? String(draftValue) : readDraftFromDom();
    const store = { view: undefined, listeners: new Set() };
    let lastTaskText = "";

    // ── 发送闸门（2026-11-16 约定）────────────────────────────
    // 1) 插件只负责确认模型与策略，不替代输入框「⬆️」；
    // 2) 勾选 Pro/Max 且计划未确认时，「⬆️」置灰不可点；
    // 3) 取消勾选 = 取消计划 + 恢复传统提交流程。
    // 历史坑：旧版每 800ms 轮询 /api/session/list，该请求不回，堆满浏览器
    // 同源 6 条连接后所有 fetch 挂死（表现为 Max 网关不可达 / 生成计划无反应）。
    const GATE_OWNER = "pro";
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
    const publish = (view) => { store.view = view; for (const fn of [...store.listeners]) fn(view); return view; };
    const subscribe = (fn) => { store.listeners.add(fn); return () => store.listeners.delete(fn); };
    const latest = () => store.view;

    async function post(path, body, signal) {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body || {}),
        signal,
      });
      let data = {};
      try { data = await r.json(); } catch { data = {}; }
      return { ok: r.ok && data?.ok !== false, status: r.status, data };
    }
    async function get(path) {
      const r = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" } });
      let data = {};
      try { data = await r.json(); } catch { data = {}; }
      return { ok: r.ok && data?.ok !== false, status: r.status, data };
    }
    const errorText = (r) => r?.data?.error || r?.data?.message || `HTTP ${r?.status ?? "?"}`;

    function inferStages(text) {
      const t = String(text || "").toLowerCase();
      if (/(代码|函数|脚本|python|sql|bug|测试|接口|实现|重构|报错|pytest)/.test(t)) return ["分析需求", "实现", "测试验收"];
      if (/(图片|图像|截图|视觉|看图|照片)/.test(t)) return ["识别输入", "分析判断", "输出结论"];
      if (/(写|文案|报告|总结|摘要|润色|邮件|文章)/.test(t)) return ["梳理提纲", "撰写正文", "校对收束"];
      return DEFAULT_STAGES;
    }
    function planRequestBody(text) {
      const task = String(text || "").trim();
      const stages = inferStages(task);
      return {
        taskId: `ui-${Date.now()}`,
        summary: task.slice(0, 240) || "UI 生成计划",
        stageNames: stages,
        estimatedInputTokens: Math.max(1000, Math.min(200000, Math.round(task.length / 1.8)))
      };
    }
    async function makePlan(text) {
      lastTaskText = String(text || "");
      try { if (planAbort) planAbort.abort(); } catch {}
      planAbort = typeof AbortController !== "undefined" ? new AbortController() : null;
      const signal = planAbort ? planAbort.signal : undefined;
      try {
        const r = await post("/plan", planRequestBody(text), signal);
        if (!r.ok) return publish({ state: "error", message: `加载失败：${errorText(r)}` });
        return publish({ state: "ready", value: r.data });
      } catch (e) {
        if (e && e.name === "AbortError") return undefined;
        return publish({ state: "error", message: `加载失败：${String(e && e.message || e)}` });
      }
    }

    let bridgeSessionId = "";
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

    function Checkbox(props) {
      const [on, setOn] = React.useState(() => {
        try { return localStorage.getItem(PRO_KEY) === "1"; } catch { return false; }
      });
      const [maxActive, setMaxActive] = React.useState(() => {
        try { return localStorage.getItem("wb.max.enabled") === "1"; } catch { return false; }
      });
      const [pending, setPending] = React.useState(false);
      const liveInput = typeof props?.useInput === "function" ? props.useInput((s) => s) : props?.input;
      const draft = draftFallback(liveInput?.draft);
      const lastPlanned = React.useRef("");
      const timer = React.useRef(null);

      React.useEffect(() => {
        const sync = () => {
          let active = false;
          try { active = localStorage.getItem("wb.max.enabled") === "1"; } catch {}
          setMaxActive(active);
          if (active) setOn(false);
        };
        sync();
        const h = (ev) => {
          if (ev?.detail && typeof ev.detail.max === "boolean") {
            setMaxActive(ev.detail.max);
            if (ev.detail.max) { setOn(false); publish(undefined); }
          }
        };
        window.addEventListener("wb-mode-changed", h);
        return () => window.removeEventListener("wb-mode-changed", h);
      }, []);
      React.useEffect(() => {
        setSendGate(on && !maxActive, on && !maxActive ? "先确认计划，再点 ⬆️ 发送" : "");
      }, [on, maxActive]);
      React.useEffect(() => {
        if (!on || maxActive) return;
        if (!draft.trim()) return;
        if (draft === lastPlanned.current) return;
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          lastPlanned.current = draft;
          setPending(true);
          makePlan(draft).finally(() => setPending(false));
        }, 900);
        return () => clearTimeout(timer.current);
      }, [on, maxActive, draft]);

      const abortPlan = () => {
        if (planAbort) { try { planAbort.abort(); } catch {} planAbort = null; }
        lastPlanned.current = "";
        setPending(false);
      };
      const enablePro = () => {
        try { localStorage.setItem(PRO_KEY, "1"); localStorage.setItem("wb.max.enabled", "0"); } catch {}
        window.dispatchEvent(new CustomEvent("wb-pro-enabled", { detail: { on: true } }));
        window.dispatchEvent(new CustomEvent("wb-mode-changed", { detail: { max: false } }));
        window.dispatchEvent(new CustomEvent("wb-max-plan", { detail: { plan: null } }));
        setMaxActive(false); setOn(true);
        setSendGate(true, "先确认计划，再点 ⬆️ 发送");
        if (draft.trim()) { lastPlanned.current = draft; setPending(true); makePlan(draft).finally(() => setPending(false)); }
        else publish({ state: "hint", message: "Pro 已开启 · 请先在输入框写任务，会自动生成计划（也可点「生成计划」）" });
      };
      const enableMax = () => {
        try { localStorage.setItem("wb.max.enabled", "1"); localStorage.setItem(PRO_KEY, "0"); } catch {}
        abortPlan(); setOn(false); setMaxActive(true); publish(undefined);
        window.dispatchEvent(new CustomEvent("wb-mode-changed", { detail: { max: true } }));
      };
      const disable = () => {
        try { localStorage.setItem(PRO_KEY, "0"); localStorage.setItem("wb.max.enabled", "0"); } catch {}
        abortPlan(); setOn(false); setMaxActive(false);
        setSendGate(false, ""); publish(undefined);
        window.dispatchEvent(new CustomEvent("wb-mode-changed", { detail: { max: false } }));
      };
      const generate = () => {
        if (!draft.trim()) {
          publish({ state: "hint", message: "请先在输入框写任务，再点「生成计划」；或输入后等待自动生成。" });
          return;
        }
        setPending(true);
        makePlan(draft).finally(() => setPending(false));
      };

      const segBtn = (key, label) => React.createElement("button", {
        key,
        type: "button",
        "aria-pressed": (key === "max" ? maxActive : key === "pro" ? (on && !maxActive) : (!on && !maxActive)) ? "true" : "false",
        title: key === "max" ? "切到 Max 路由（自动关闭 Pro 计划）" : key === "pro" ? "切到 Pro 路由（自动关闭 Max 计划）" : "关闭路由",
        onClick: key === "max" ? enableMax : key === "pro" ? enablePro : disable,
        style: (() => {
          const active = key === "max" ? maxActive : key === "pro" ? (on && !maxActive) : (!on && !maxActive);
          return { border: 0, background: active ? "#4f46e5" : "transparent", color: active ? "#fff" : "#64748b",
                   font: "inherit", fontSize: "11px", padding: "3px 10px", borderRadius: "7px", cursor: "pointer" };
        })()
      }, label);

      return React.createElement("div", {
        "data-dsh-pro": "toggle", "data-wb-ui": "ui-a5",
        style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", whiteSpace: "nowrap" }
      },
        React.createElement("div", {
          role: "radiogroup", "aria-label": "路由模式",
          style: { display: "flex", gap: "2px", background: "#f1f5f9", border: "1px solid #e2e8f0", borderRadius: "9px", padding: "2px" }
        }, segBtn("off", "关"), segBtn("pro", "Pro"), segBtn("max", "Max")),
        on && !maxActive ? React.createElement("button", {
          type: "button",
          disabled: pending,
          onClick: generate,
          style: { font: "inherit", fontSize: "11px", padding: "3px 9px", borderRadius: "7px", border: "1px solid #dbe3ec", background: "#fff", cursor: pending ? "progress" : "pointer" }
        }, pending ? "规划中…" : "生成计划") : null
      );
    }

    function useStore() {
      const [view, setView] = React.useState(latest());
      React.useEffect(() => subscribe(setView), []);
      return view;
    }
    function useModels() {
      const [models, setModels] = React.useState([]);
      React.useEffect(() => {
        get("/models").then((r) => {
          if (!r.ok) return;
          const rows = (r.data.models || [])
            .filter((m) => m && m.key && !String(m.key).startsWith("wb-gateway/"))
            .map((m) => ({
              key: m.key, label: m.label || m.key, provider: m.provider,
              contextWindow: m.context_window ?? m.contextWindow ?? null,
              modalities: (() => {
                const caps = Array.isArray(m.capabilities) ? m.capabilities
                  : (m.capabilities && m.capabilities.input) || [];
                return caps.includes("vision") || m.vision ? ["text", "vision"] : ["text"];
              })()
            }));
          setModels(rows);
        }).catch(() => {});
      }, []);
      return models;
    }
    function useStatus(planId, approved) {
      const [state, setState] = React.useState(null);
      React.useEffect(() => {
        if (!approved) return;
        let live = true;
        const tick = () => get(`/state?planId=${encodeURIComponent(planId)}`).then((r) => {
          if (live && r.ok) setState(r.data.state);
        }).catch(() => {});
        tick();
        const t = setInterval(tick, 2500);
        return () => { live = false; clearInterval(t); };
      }, [planId, approved]);
      return state;
    }

    /* ── 阶段探测（2026-11-17）───────────────────────────────
       宿主 ConversationRoot 会写 `data-phase`（DSH 源码
       dsh-client-ui-conversation/lib/client.js L17546/L17549），值域 hero|active|settling。
       hero = 新建对话/空会话。该阶段 InputBar 用 variant="hero"，
       `conversation.composer.dock` 只在 variant==="composer" 时渲染（L19164）⇒
       计划卡挂 composer.dock 时新对话下根本不渲染 ⇒ 发送闸门一直关着 = 死锁。
       修法：同一个 PlanCard 同时挂两个槽，用阶段决定哪一次渲染（见 PlanCard 的 slot 参数）。 */
    const WB_PHASES = ["hero", "active", "settling"];
    function readConversationPhase() {
      try {
        // 注意：输入框本身也带 data-phase（同值），第一个匹配到的祖先根节点在前面，取到哪个都同值。
        const nodes = document.querySelectorAll("[data-phase]");
        for (const node of nodes) {
          const v = node.getAttribute("data-phase");
          if (v && WB_PHASES.indexOf(v) >= 0) return v;
        }
      } catch {}
      // 读不到宿主根节点时按 active 处理 = 保持历史行为（只渲染 composer.dock），不改变既有会话。
      return "active";
    }
    function useConversationPhase() {
      const [phase, setPhase] = React.useState(readConversationPhase);
      React.useEffect(() => {
        let last = readConversationPhase();
        let queued = false;
        const sync = () => {
          if (queued) return;
          queued = true;
          const run = () => {
            queued = false;
            const now = readConversationPhase();
            if (now !== last) { last = now; setPhase(now); }
          };
          // rAF 节流：subtree 监听在流式输出时触发很密，一帧最多读一次 DOM。
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
          else setTimeout(run, 50);
        };
        const obs = new MutationObserver(sync);
        obs.observe(document.body, { attributes: true, attributeFilter: ["data-phase"], childList: true, subtree: true });
        // 兜底轮询：宿主换会话整棵重建时即使属性写回被合并也能跟上（纯 DOM 读，不发请求）。
        const timer = setInterval(sync, 1000);
        sync();
        return () => { obs.disconnect(); clearInterval(timer); };
      }, []);
      return phase;
    }

    function PlanCard(props) {
      const phase = useConversationPhase();
      const slot = props?.slot === "dock" ? "dock" : "composer";
      const [maxOn, setMaxOn] = React.useState(() => {
        try { return localStorage.getItem("wb.max.enabled") === "1"; } catch { return false; }
      });
      React.useEffect(() => {
        const h = (ev) => { if (ev?.detail && typeof ev.detail.max === "boolean") setMaxOn(ev.detail.max); };
        window.addEventListener("wb-mode-changed", h);
        return () => window.removeEventListener("wb-mode-changed", h);
      }, []);
      const view = useStore();
      const models = useModels();
      const [local, setLocal] = React.useState(null);
      const [approved, setApproved] = React.useState(false);
      const [overrides, setOverrides] = React.useState({});
      const [msg, setMsg] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [cmp, setCmp] = React.useState(false);
      const [collapsed, setCollapsed] = React.useState(() => { try { return localStorage.getItem("wb.pro.plan.collapsed") === "1"; } catch { return false; } });
      const card = local?.card || (view?.state === "ready" ? view.value.card : null);
      const planId = local?.planId || (view?.state === "ready" ? view.value.planId : null);
      const [bridgeSid, setBridgeSid] = React.useState(bridgeSessionId);
      React.useEffect(() => {
        const h = (ev) => setBridgeSid(String(ev?.detail?.sessionId || ""));
        window.addEventListener("wb-session-changed", h);
        return () => window.removeEventListener("wb-session-changed", h);
      }, []);
      const sessionId = props?.session?.sessionId || bridgeSid || bridgeSessionId;
      const state = useStatus(planId, approved);
      /* 2026-11-16 23:5x 维护者：删掉对 /api/session/list 的 900ms 轮询。
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
      const pullState = async () => {
        if (!planId) return null;
        const r = await get(`/state?planId=${encodeURIComponent(planId)}`);
        return r.ok ? r.data.state : null;
      };
      const refreshCard = async () => {
        const r = await get(`/card?planId=${encodeURIComponent(planId)}`);
        if (r.ok && r.data?.card) setLocal({ planId, card: r.data.card });
        return r.ok && r.data?.card ? r.data.card : null;
      };
      const doRecheck = async () => {
        if (!planId) return;
        setBusy(true); setMsg("");
        const next = await refreshCard();
        setBusy(false);
        setMsg(next ? "已重新校验计划" : "校验失败，请再点一次");
      };
      const doSwap = async (stageId, modelKey) => {
        if (!planId) return;
        if (running) { setMsg("当前回复执行中，等本段结束再换模型"); return; }
        setBusy(true); setMsg("");
        if (!approved) {
          const r = await post("/plan/swap", { planId, stageId, modelKey });
          if (!r.ok) { setBusy(false); setMsg(`换模型失败：${errorText(r)}`); return; }
          setLocal({ planId, card: r.data.card });
          await refreshCard();              // 换过模型的行要重新校验，否则确认按钮会被收起
          setBusy(false);
          setMsg(`已换 ${stageId} → ${modelKey}（单次任务）`);
          return;
        }
        // 已开工：不再要求「下一段」，下拉即切换
        const r = await post("/switch", { planId, stageId, modelKey, ...(sessionId ? { sessionId } : {}) });
        if (!r.ok) { setBusy(false); setMsg(`切换失败：${errorText(r)}`); return; }
        await refreshCard();
        setBusy(false);
        setMsg(`已切到 ${stageId} → ${modelKey}`);
      };
      const doConfirm = async (opts = {}) => {
        if (!planId || !card) return;
        if (running) { setMsg("当前回复执行中，等本段结束再开工"); return; }
        setBusy(true); setMsg("");
        const r = await post("/plan/confirm", {
          planId,
          ...(sessionId ? { sessionId } : {}),
          ...(opts.allowUnknownPricing ? { allowUnknownPricing: true } : {}),
        });
        if (!r.ok) { setBusy(false); setMsg(`确认失败：${errorText(r)}`); return; }
        setApproved(true);
        const first = card.rows && card.rows[0];
        if (first) {
          const sw = await post("/switch", { planId, stageId: first.stageId, ...(sessionId ? { sessionId } : {}) });
          if (!sw.ok) {
            setMsg(`第 1 段模型切换失败：${errorText(sw)}；请再点一次「确认模型与策略」`);
          } else {
            setSendGate(false, "");
            setMsg("已确认模型与策略；请点 ⬆️ 发送（发送按钮已解锁）");
          }
        } else {
          setSendGate(false, "");
          setMsg("已确认模型与策略；请点 ⬆️ 发送（发送按钮已解锁）");
        }
        setBusy(false);
      };
      const doNext = async () => {
        if (!planId || !card) return;
        if (running) { setMsg("当前段仍在执行，等回复结束再切下一段"); return; }
        setBusy(true); setMsg("");
        const st = state || await pullState();
        const cursor = Number(st?.cursor ?? 0);
        const rows = card.rows || [];
        const next = rows[cursor + 1] || rows[cursor];
        if (!next) { setMsg("已完成最后一段"); setBusy(false); return; }
        const picked = overrides[next.stageId] || next.modelKey;
        const r = await post("/switch", { planId, stageId: next.stageId, modelKey: picked, ...(sessionId ? { sessionId } : {}) });
        if (!r.ok) setMsg(`切段失败：${errorText(r)}`);
        else {
          setMsg(`已切到第 ${next.index} 段：${picked}`);
          setOverrides((prev) => { const copy = { ...prev }; delete copy[next.stageId]; return copy; });
        }
        setBusy(false);
      };
      const cancel = () => {
        if (planAbort) { try { planAbort.abort(); } catch {} planAbort = null; }
        try { localStorage.setItem(PRO_KEY, "0"); } catch {}
        window.dispatchEvent(new CustomEvent("wb-pro-enabled", { detail: { on: false } }));
        setSendGate(false, "");
        setLocal(null); setApproved(false); setMsg(""); publish(undefined);
      };
      // 阶段闸：一张计划卡在任何时刻只渲染一次。
      // hero 阶段 composer.dock 不渲染（宿主 L19164）⇒ 此时由 input.dock 上的实例出图；
      // active/settling 阶段反过来，保持既有会话的卡片位置与行为不变。
      // P2（10311）：hint/error 提示卡任何阶段都要可见；但只能出一份（防 hero/active 双卡）。
      // 单写者仲裁：dock 槽（hero 阶段唯一存在）负责渲染；composer 槽对提示一律让位。
      // 这样既不丢提示，也不会两张卡同时出现在同一会话里。
      const showNotice = view?.state === "hint" || view?.state === "error";
      if (showNotice) {
        if (slot !== "dock") return null;
      } else {
        if (slot === "composer" && phase === "hero") return null;
        if (slot === "dock" && phase !== "hero") return null;
      }
      if (maxOn) return null;
      if (!card) {
        if (view?.state === "error") return React.createElement("div", { "data-dsh-pro": "card", style: { fontSize: "12px", color: "#b42318" } }, view.message);
        // 2026-11-24：空草稿点 Pro 给明确提示，不再「无反应」。
        if (view?.state === "hint") return React.createElement("div", { "data-dsh-pro": "card", style: { fontSize: "12px", color: "#1d4ed8", background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: "8px", padding: "4px 9px", width: "fit-content" } }, view.message);
        return null;
      }
      if (collapsed) return React.createElement("div", { "data-dsh-pro": "card", style: { display: "flex", alignItems: "center", gap: "8px", border: "1px solid #e5e7eb", borderRadius: "10px", padding: "6px 10px", margin: "4px 0", background: "#fff", fontSize: "12px", width: "min(520px, 100%)", boxShadow: "0 4px 12px rgba(15,23,42,.06)" } },
        React.createElement("span", { style: { fontSize: "11px", fontWeight: 700, color: "#fff", background: "#4f46e5", padding: "1px 7px", borderRadius: "6px" } }, "Pro"),
        React.createElement("span", null, "路由计划已收起"),
        React.createElement("span", { title: "模型路由可能调用 DSH 直连模型与网关模型；直连段不进网关台账（无回退、无记账），为保证计费准确，建议优先使用网关模型。", style: { fontSize: "11px", color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "6px", padding: "1px 6px", whiteSpace: "nowrap", cursor: "help" } }, "ⓘ 建议用网关模型"),
        React.createElement("button", { type: "button", onClick: () => { setCollapsed(false); try { localStorage.setItem("wb.pro.plan.collapsed", "0"); } catch {} }, style: { marginLeft: "auto", font: "inherit", fontSize: "11px", padding: "2px 8px" } }, "展开"));
      const warnFor = (row, m) => {
        const need = Number(row.estimate?.inputTokens || 0) + Number(row.estimate?.outputTokens || 0);
        const wantsVision = /(图片|图像|截图|视觉|看图|照片)/.test(lastTaskText);
        if ((row.capability === "vision" || wantsVision) && Array.isArray(m.modalities) && !m.modalities.includes("vision")) return "不兼容视觉";
        if (m.contextWindow && need && need > Number(m.contextWindow)) return "上下文不足";
        return "";
      };
      const rows = (card.rows || []).map((row) => {
        const opts = models.length ? models : (row.alternatives || []).map((a) => ({ key: a.key, label: a.label }));
        const has = opts.some((o) => o.key === row.modelKey);
        const optionLabel = (o) => {
          const w = warnFor(row, o);
          return `${o.label}${wbPriceTag(o.key)}${w ? `（${w}，可强行选择）` : ""}`;
        };
        return React.createElement("div", { key: row.stageId, style: { display: "flex", flexWrap: "wrap", gap: "6px", alignItems: "center", margin: "5px 0", paddingBottom: "5px", borderBottom: "1px dashed #f1f5f9" } },
          React.createElement("div", { style: { fontSize: "12px", whiteSpace: "nowrap" } },
            `${row.index}. ${row.title} → ${row.modelLabel || row.modelKey || "未分配"}  ${row.cost || ""}`),
          React.createElement("select", {
            value: row.modelKey || "",
            disabled: busy || running,
            onChange: (e) => doSwap(row.stageId, e.target.value),
            style: { maxWidth: "220px", font: "inherit", fontSize: "12px", padding: "1px 4px" }
          }, [
            ...(has ? [] : [React.createElement("option", { key: "current", value: row.modelKey || "" }, row.modelLabel || row.modelKey || "未分配")]),
            ...opts.map((o) => React.createElement("option", { key: o.key, value: o.key }, optionLabel(o)))
          ])
        );
      });
      const cmpModel = (((card && card.rows) || [])[0] || {}).modelKey;
      const statusLine = state?.active
        ? `[WB-GearPilot] 第 ${Math.min((state.cursor || 0) + 1, state.total || 1)}/${state.total || 1} 段 · ${state.current?.modelLabel || state.stages?.[state.cursor]?.modelLabel || "—"}`
        : (approved ? "[WB-GearPilot] 已开工" : "");
      return React.createElement("div", {
        "data-dsh-pro": "card",
        style: { border: "1px solid #e5e7eb", borderRadius: "12px", padding: "10px 12px", margin: "6px 0 12px 0", background: "#fff", fontSize: "12px", display: "inline-flex", flexDirection: "column", width: "min(520px, 100%)", maxWidth: "100%", alignSelf: "flex-start", marginRight: "auto", boxShadow: "0 6px 18px rgba(15,23,42,.06)", maxHeight: cmp ? "72vh" : "34vh", overflowY: "auto", position: "relative", zIndex: 20 }
      },
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" } },
          React.createElement("span", { style: { fontSize: "11px", fontWeight: 700, color: "#fff", background: "#4f46e5", padding: "1px 7px", borderRadius: "6px" } }, "Pro"),
          React.createElement("span", { style: { fontWeight: 600 } }, card.title || "路由计划"),
          React.createElement("span", { style: { marginLeft: "auto", color: "#64748b", fontSize: "11px" } }, card.footer || ""),
          React.createElement("button", { type: "button", onClick: () => { setCollapsed(true); try { localStorage.setItem("wb.pro.plan.collapsed", "1"); } catch {} }, style: { font: "inherit", fontSize: "11px", padding: "1px 7px", border: "1px solid #dbe3ec", background: "#fff", borderRadius: "6px", cursor: "pointer" } }, "收起")),
        ...rows,

        React.createElement("div", { style: { color: "#9a3412", background: "#fff7ed", border: "1px solid #fed7aa", borderRadius: "6px", padding: "3px 7px", marginTop: "5px", fontSize: "11px", lineHeight: 1.45 } }, "模型路由可能调用 DSH 直连模型与网关模型；直连段不进网关台账（无回退、无记账），为保证计费准确，建议优先使用网关模型。"),
        (card.blockers && card.blockers.length)
          ? React.createElement("div", { style: { color: "#b45309", marginTop: "4px", fontSize: "11px" } }, "阻塞：" + card.blockers.join("；"))
          : null,
        msg ? React.createElement("div", { style: { color: "#a15c00", marginTop: "4px" } }, msg) : null,
        statusLine ? React.createElement("div", { style: { color: "#1d4ed8", marginTop: "4px" } }, statusLine) : null,
        React.createElement("div", { style: { display: "flex", alignItems: "center", gap: "8px", marginTop: "4px" } },
          React.createElement("button", { type: "button", onClick: () => setCmp((v) => !v), style: { font: "inherit", fontSize: "11px", padding: "2px 8px", borderRadius: "7px", border: "1px solid #dbe3ec", background: "#fff", cursor: "pointer" } }, cmp ? "收起比价" : "比价"),
          React.createElement("span", { style: { color: "#94a3b8", fontSize: "11px" } }, "价格快照 " + String(WB_PRICES.generated_at || "").slice(5, 16))),
        cmp ? React.createElement(PriceTable, { modelKey: cmpModel }) : null,
        React.createElement("div", { style: { display: "flex", gap: "8px", marginTop: "6px", flexWrap: "wrap" } },
          !approved && card.canStart !== false
            ? React.createElement("button", { type: "button", disabled: busy || running, onClick: () => doConfirm(), title: running ? "当前回复执行中" : "只确认模型与策略，不替你发送；确认后自己点 ⬆️", style: { font: "inherit", fontSize: "12px", padding: "2px 10px", background: "#2563eb", color: "#fff", border: 0, borderRadius: "6px", cursor: running ? "not-allowed" : "pointer", opacity: running ? 0.6 : 1 } }, running ? "等本段结束…" : "确认模型与策略")
            : null,
          !approved && card.canStart === false
            ? React.createElement("button", { type: "button", disabled: busy || running, onClick: () => doConfirm({ allowUnknownPricing: true }), title: "计划含未定价/未校验段；确认即按「允许未知价格」开工", style: { font: "inherit", fontSize: "12px", padding: "2px 10px", background: "#b45309", color: "#fff", border: 0, borderRadius: "6px", cursor: "pointer" } }, "确认计划（含未定价/未校验）")
            : null,
          !approved && card.canStart === false
            ? React.createElement("button", { type: "button", disabled: busy, onClick: doRecheck, title: "重新向宿主要一次卡片，看看能否恢复", style: { font: "inherit", fontSize: "12px", padding: "2px 10px", background: "#4f46e5", color: "#fff", border: 0, borderRadius: "6px", cursor: "pointer" } }, "重新校验计划")
            : null,
          approved
            ? React.createElement("span", { style: { color: "#64748b", fontSize: "11px", alignSelf: "center" } }, "已开工：直接改各段下拉即可切换，无需再点“下一段”")
            : null,
          React.createElement("button", { type: "button", onClick: cancel, style: { font: "inherit", fontSize: "12px", padding: "2px 10px" } }, "取消")
        )
      );
    }

    /* 同一个 PlanCard 的两个挂载点：靠 data-phase 各渲染一个（见 useConversationPhase）。
       composer.dock 的 id/order 保持原样，已有会话的位置与顺序不变（回归保护）。 */
    const PlanCardComposer = (props) => React.createElement(PlanCard, { ...(props || {}), slot: "composer" });
    const PlanCardDock = (props) => React.createElement(PlanCard, { ...(props || {}), slot: "dock" });

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
      if (!ctx?.slots) return;
      for (const slot of [
        { name: "conversation.input.right", id: "wb-pro-toggle", order: 30, component: Checkbox },
        { name: "conversation.input.dock", id: "wb-pro-bridge", order: 1, component: SessionBridge },
        // 已有会话（active）走这里，位置不变；hero 阶段该实例返回 null。
        { name: "conversation.composer.dock", id: "wb-pro-plan", order: 21, component: PlanCardComposer },
        // 新对话（hero）走这里：宿主的 conversation.input.dock 在 hero 与 active 都渲染
        // （L17842）。SessionBridge 占 order=1，计划卡用 order=2 排在它后面。
        { name: "conversation.input.dock", id: "wb-pro-plan-hero", order: 2, component: PlanCardDock }
      ]) {
        ctx.slots.inject(slot.name, () => ctx.slots.register({
          name: slot.name,
          id: slot.id,
          order: slot.order
        }, slot.component));
      }
      return () => { setSendGate(false, ""); publish(undefined); };
    }
    return { apply, inject: ["slots"] };
  }
});
