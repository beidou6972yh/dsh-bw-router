window.__ModuleLoader__.load({
  id: "dsh-bw-router",
  factory(require) {
    const module = { exports: {} };
    const exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
      // dist/core/budget.js
      /** `$0.0600` — a plain amount with no claim about the future. */
      function formatUSD(amount) {
      	return `$${amount.toFixed(4)}`;
      }
      // dist/core/card.js
      /** Wallet line for the status bar: what has actually been booked so far. */
      function formatSpent(actualCost, unpricedStages) {
      	if (unpricedStages > 0) return `已花 ${formatUSD(actualCost)}+（${unpricedStages} 段无价）`;
      	return `已花 ${formatUSD(actualCost)}`;
      }
      /**
      * `[路由] 第 2/3 段 · 当前 DeepSeek Flash · 已花 $0.0060 · 下一段：出图/PPT`
      *
      * The spec's one-line bar. Kept honest where the spec is loose: it says "待开工"
      * before stage 1 rather than pretending a stage is running, and it prints the
      * real booked amount, not the plan-time guess.
      */
      function renderStatusBar$1(state) {
      	if (!state.active || state.total === 0) return null;
      	const head = state.cursor >= state.total ? "已完成" : `第 ${Math.min(state.cursor + 1, state.total)}/${state.total} 段`;
      	const running = state.current?.status === "running" ? state.current : void 0;
      	const model = running ? `${running.modelLabel}` : state.sessionModelLabel || state.current?.modelLabel || "—";
      	const unbooked = state.unbookedStages?.length ?? 0;
      	return `[路由] ${head} · 当前 ${model} · ${unbooked > 0 ? `${formatSpent(state.spent.actualCost, state.spent.unpricedStages)}（${unbooked} 段未记账）` : formatSpent(state.spent.actualCost, state.spent.unpricedStages)} · ${state.next ? `下一段：${state.next.title}` : "已是最后一段"}`;
      }
      // dist/plugin/client.js
      /** Endpoint base. Same origin as the host half: no cross-origin hop, no CORS. */
      const ROUTER_BASE = "/router";
      /** Wraps a fetch failure in the one sentence the UI is allowed to invent. */
      function describeFailure(error) {
      	return `加载失败：${(error instanceof Error ? error.message : String(error)) || "未知原因"}`;
      }
      /**
      * One call to the host half. Never throws: a dead endpoint, a 500, or a body
      * that is not JSON all come back as `state: 'error'` with the reason attached,
      * because a UI that throws cannot tell the user anything.
      */
      async function fetchView(path, options = {}) {
      	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
      	if (!fetchImpl) return {
      		state: "error",
      		message: "加载失败：当前环境没有 fetch"
      	};
      	const init = {
      		method: options.method ?? "GET",
      		headers: { accept: "application/json" }
      	};
      	if (options.body !== void 0) {
      		init.headers["content-type"] = "application/json";
      		init.body = JSON.stringify(options.body);
      	}
      	try {
      		const response = await fetchImpl(`${ROUTER_BASE}${path}`, init);
      		const payload = await response.json();
      		if (!response.ok || payload?.ok === false) return {
      			state: "error",
      			message: `加载失败：${payload?.error ?? `HTTP ${response.status ?? "?"}`}`,
      			...typeof response.status === "number" ? { status: response.status } : {}
      		};
      		return {
      			state: "ready",
      			value: payload
      		};
      	} catch (error) {
      		return {
      			state: "error",
      			message: describeFailure(error)
      		};
      	}
      }
      /** Status bar data. `state.active === false` => render nothing. */
      function requestState(planId, options = {}) {
      	return fetchView(`/state${planId ? `?planId=${encodeURIComponent(planId)}` : ""}`, options);
      }
      /**
      * The host-built plan card for the dock.
      *
      * `404 no-plan` is turned into `idle`, not `error`: "there is no plan yet" is
      * the normal state of a fresh session, and rendering it as a failure would put
      * an error banner in every new conversation. Every *other* failure stays an
      * error, because a dock that hides a broken endpoint is worse than one that
      * says so.
      */
      async function requestCard(planId, options = {}) {
      	const view = await fetchView(`/card${planId ? `?planId=${encodeURIComponent(planId)}` : ""}`, options);
      	if (view.state === "error" && view.status === 404) return { state: "idle" };
      	return view;
      }
      /**
      * The plan card as plain lines, top to bottom, in the order the dock draws them.
      *
      * Text, not JSX: the React component is a thin map over these lines, so the
      * wording can be tested without a DOM — and can't drift between the two halves.
      */
      function planCardLines(card) {
      	const lines = [`执行计划（可改）｜${card.title}`];
      	for (const row of card.rows) lines.push(rowLine(row));
      	lines.push(card.footer);
      	if (card.needsWizard) lines.push("未配置任何模型，请先完成向导");
      	else if (card.blockers.length > 0) lines.push(`无法开工：${card.blockers.join("；")}`);
      	else if (!card.checked) lines.push("无法开工：本计划没有预检窗口，模型是否吃不下未确认");
      	lines.push(card.canStart ? "[确认开工] [取消]" : "[取消]");
      	return lines;
      }
      /** One row: `① 需求文档 → 千问 Qwen ▾  ¥0.3`. */
      function rowLine(row) {
      	const number = `${row.index}`.padStart(2, " ");
      	const mark = row.optional ? "（可选）" : "";
      	const model = row.modelKey ? `${row.modelLabel} ▾` : "未分配";
      	return `${number}. ${row.title}${mark} → ${model}   ${row.cost}`;
      }
      /**
      * Status bar text. `null` when there is nothing honest to say.
      *
      * That null is the contract: the dock checks it and draws nothing, rather than
      * mounting a bar with placeholders.
      */
      function renderStatusBar(state) {
      	if (!state) return null;
      	return renderStatusBar$1(state);
      }
      /** The bar plus its one-off notices (a switch that dragged the global default). */
      function statusBarLines(state) {
      	const bar = renderStatusBar(state);
      	if (!bar) return [];
      	return [
      		bar,
      		...(state?.notices ?? []).map((notice) => `⚠ ${notice}`),
      		...state?.pricing?.notice ? [`⚠ ${state.pricing.notice}`] : []
      	];
      }
      // dist/plugin/client-entry.js
      /**
      * The two composer-dock entries (`package.json` declared these before the code
      * could fulfil them): the plan card above the status bar, 60 then 61.
      */
      const SLOT_REGISTRATIONS = [{
      	name: "conversation.composer.dock",
      	id: "router-plan-card",
      	order: 60,
      	component: "RouterPlanCard"
      }, {
      	name: "conversation.composer.dock",
      	id: "router-status-bar",
      	order: 61,
      	component: "RouterStatusBar"
      }];
      /** The cordis services this client plugin needs (`ctx.slots`). */
      const inject = ["slots"];
      /**
      * Plan-card lines from a fetch result.
      *
      * Exported and pure so the wording is testable without a DOM. `null` is the
      * contract: the dock draws nothing while the plan is unknown, rather than a
      * card with no rows (which is what the reported defect looked like).
      */
      function planCardView(view) {
      	if (view.state === "error") return [view.message];
      	if (view.state !== "ready") return null;
      	const lines = planCardLines(view.value.card);
      	return lines.length > 0 ? lines : null;
      }
      /** Status-bar lines from a fetch result; `null` when there is nothing honest to say. */
      function statusBarView(view) {
      	if (view.state === "error") return [view.message];
      	if (view.state !== "ready") return null;
      	const lines = statusBarLines(view.value.state);
      	return lines.length > 0 ? lines : null;
      }
      function reactRuntime() {
      	if (typeof require !== "function") return void 0;
      	try {
      		return require("react");
      	} catch {
      		return;
      	}
      }
      /**
      * Fetch-on-mount, in one place.
      *
      * While the request is in flight the view stays `loading`, and every consumer
      * renders nothing for it — no spinner, no placeholder text. That is deliberate:
      * a skeleton that never resolves is indistinguishable from a stuck plugin.
      */
      function useRouterView(react, load) {
      	const [view, setView] = react.useState({ state: "loading" });
      	react.useEffect(() => {
      		let live = true;
      		load().then((next) => {
      			if (live) setView(next);
      		});
      		return () => {
      			live = false;
      		};
      	}, []);
      	return view;
      }
      /** The components, built against the host's React. Exported for tests. */
      function createComponents(react) {
      	const h = react.createElement;
      	const lineList = (id, lines) => h("div", {
      		"data-dsh-router": id,
      		style: {
      			display: "flex",
      			flexDirection: "column",
      			gap: "2px",
      			fontSize: "12px",
      			lineHeight: "18px",
      			whiteSpace: "pre-wrap"
      		}
      	}, ...lines.map((line, index) => h("div", { key: `${id}-${index}` }, line)));
      	function RouterPlanCard() {
      		const lines = planCardView(useRouterView(react, () => requestCard()));
      		return lines === null ? null : lineList("router-plan-card", lines);
      	}
      	function RouterStatusBar() {
      		const lines = statusBarView(useRouterView(react, () => requestState()));
      		return lines === null ? null : lineList("router-status-bar", lines);
      	}
      	return {
      		RouterPlanCard,
      		RouterStatusBar
      	};
      }
      /**
      * Client entry the host calls.
      *
      * Registers both components into `conversation.composer.dock`. When React is not
      * reachable (an ESM import outside the browser) the function registers nothing
      * rather than throwing: a client plugin that breaks activation takes the whole
      * web UI's plugin table with it.
      */
      function apply(ctx, options = {}) {
      	options.fetchImpl;
      	const react = options.react ?? reactRuntime();
      	if (!react || !ctx?.slots) return;
      	const { RouterPlanCard, RouterStatusBar } = createComponents(react);
      	for (const slot of SLOT_REGISTRATIONS) {
      		const component = slot.component === "RouterPlanCard" ? RouterPlanCard : RouterStatusBar;
      		ctx.slots.inject(slot.name, () => ctx.slots.register({
      			name: slot.name,
      			id: slot.id,
      			order: slot.order
      		}, component));
      	}
      }
      exports.SLOT_REGISTRATIONS = SLOT_REGISTRATIONS;
      exports.apply = apply;
      exports.createComponents = createComponents;
      exports.inject = inject;
      exports.planCardView = planCardView;
      exports.statusBarView = statusBarView;
    return module.exports;
  },
});
