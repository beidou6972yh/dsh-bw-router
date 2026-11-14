import { planCardLines, requestCard, requestState, statusBarLines, } from './client.js';
/**
 * The two composer-dock entries (`package.json` declared these before the code
 * could fulfil them): the plan card above the status bar, 60 then 61.
 */
export const SLOT_REGISTRATIONS = [
    { name: 'conversation.composer.dock', id: 'router-plan-card', order: 60, component: 'RouterPlanCard' },
    { name: 'conversation.composer.dock', id: 'router-status-bar', order: 61, component: 'RouterStatusBar' },
];
/** The cordis services this client plugin needs (`ctx.slots`). */
export const inject = ['slots'];
/**
 * Plan-card lines from a fetch result.
 *
 * Exported and pure so the wording is testable without a DOM. `null` is the
 * contract: the dock draws nothing while the plan is unknown, rather than a
 * card with no rows (which is what the reported defect looked like).
 */
export function planCardView(view) {
    if (view.state === 'error')
        return [view.message];
    if (view.state !== 'ready')
        return null;
    const lines = planCardLines(view.value.card);
    return lines.length > 0 ? lines : null;
}
/** Status-bar lines from a fetch result; `null` when there is nothing honest to say. */
export function statusBarView(view) {
    if (view.state === 'error')
        return [view.message];
    if (view.state !== 'ready')
        return null;
    const lines = statusBarLines(view.value.state);
    return lines.length > 0 ? lines : null;
}
function reactRuntime() {
    // `require` is the module-table reader the loader passes into the bundle
    // factory, so it only exists inside the browser bundle. `typeof` keeps an
    // ESM import of this module (unit tests) from throwing at parse time.
    if (typeof require !== 'function')
        return undefined;
    try {
        return require('react');
    }
    catch {
        return undefined;
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
    const [view, setView] = react.useState({ state: 'loading' });
    react.useEffect(() => {
        let live = true;
        void load().then((next) => {
            if (live)
                setView(next);
        });
        return () => {
            live = false;
        };
        // `load` is a stable module-level function per path; the array keeps React
        // from re-fetching on every render.
    }, []);
    return view;
}
/** The components, built against the host's React. Exported for tests. */
export function createComponents(react) {
    const h = react.createElement;
    const lineList = (id, lines) => h('div', {
        'data-dsh-router': id,
        style: {
            display: 'flex',
            flexDirection: 'column',
            gap: '2px',
            fontSize: '12px',
            lineHeight: '18px',
            whiteSpace: 'pre-wrap',
        },
    }, ...lines.map((line, index) => h('div', { key: `${id}-${index}` }, line)));
    function RouterPlanCard() {
        const view = useRouterView(react, () => requestCard());
        const lines = planCardView(view);
        return lines === null ? null : lineList('router-plan-card', lines);
    }
    function RouterStatusBar() {
        const view = useRouterView(react, () => requestState());
        const lines = statusBarView(view);
        return lines === null ? null : lineList('router-status-bar', lines);
    }
    return { RouterPlanCard, RouterStatusBar };
}
/**
 * Client entry the host calls.
 *
 * Registers both components into `conversation.composer.dock`. When React is not
 * reachable (an ESM import outside the browser) the function registers nothing
 * rather than throwing: a client plugin that breaks activation takes the whole
 * web UI's plugin table with it.
 */
export function apply(ctx, options = {}) {
    void options.fetchImpl;
    // The bundle gets React from the module table; a test (or an embedded host)
    // injects it, so slot registration is testable without a browser.
    const react = options.react ?? reactRuntime();
    if (!react || !ctx?.slots)
        return;
    const { RouterPlanCard, RouterStatusBar } = createComponents(react);
    for (const slot of SLOT_REGISTRATIONS) {
        const component = slot.component === 'RouterPlanCard' ? RouterPlanCard : RouterStatusBar;
        ctx.slots.inject(slot.name, () => ctx.slots.register({ name: slot.name, id: slot.id, order: slot.order }, component));
    }
}
//# sourceMappingURL=client-entry.js.map