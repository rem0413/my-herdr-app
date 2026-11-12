// What the bar shows, chosen in the settings card. Stored in shared "usage.prefs";
// the layout block's props preset them until the person changes something. Pure.

export const DEFAULTS = {
  providers: { claude: true, codex: true }, // on the bar
  showBars: true,           // a small bar per provider for its first window
  showRemaining: false,     // "62% left" instead of "38%"
  showResetTime: false,     // time to reset on every window, not only amber/red ones
  session: [],              // "context" | "calls" | "compactions" on the bar
};

export const SESSION_ROWS = [
  { id: "context", label: "Context" },
  { id: "calls", label: "Calls" },
  { id: "compactions", label: "Compactions" },
];

const pick = (src) => {
  const out = {};
  if (src && typeof src === "object") {
    for (const k of Object.keys(DEFAULTS)) if (src[k] !== undefined) out[k] = src[k];
  }
  return out;
};

export function effective(saved, preset) {
  const p = { ...DEFAULTS, ...pick(preset), ...pick(saved) };
  return {
    providers: { ...DEFAULTS.providers, ...(p.providers ?? {}) },
    showBars: p.showBars !== false,
    showRemaining: p.showRemaining === true,
    showResetTime: p.showResetTime === true,
    session: Array.isArray(p.session) ? p.session : [],
  };
}

export const providerOn = (p, id) => p.providers[id] !== false;

const toggleIn = (list, item) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

export const toggleProvider = (p, id) => ({ ...p, providers: { ...p.providers, [id]: !providerOn(p, id) } });
export const toggleSession = (p, row) => ({ ...p, session: toggleIn(p.session, row) });
export const toggle = (p, key) => ({ ...p, [key]: !p[key] });
