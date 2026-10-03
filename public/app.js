// Kids Animation Studio UI — vanilla JS, no build step. All dynamic text goes through textContent (never innerHTML).

const STEP_LABELS = { poem: "Poem", scenes: "Scenes", character: "Character", audio: "Audio", clips: "Clips", final: "Final video" };
const STATUS_BADGE = {
  running: ["⏳ running", "bg-amber-100 text-amber-800"],
  review: ["👀 needs review", "bg-sky-100 text-sky-800"],
  done: ["✅ done", "bg-emerald-100 text-emerald-800"],
  failed: ["⚠️ failed", "bg-red-100 text-red-700"],
  paused: ["⏸ paused", "bg-stone-200 text-stone-700"],
  new: ["• new", "bg-stone-100 text-stone-600"],
};

let config = { providers: [], hasApiKey: false, steps: [] };
let events = null;
let refreshTimer = null;
let currentProject = null;

// ---------- helpers ----------
const $ = (sel, el = document) => el.querySelector(sel);

/** h("div", {class: "x", onclick}, child, "text") */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}

/** replaceChildren that skips null/false children (plain replaceChildren would render them as "null"). */
function mount(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: opts.body ? { "content-type": "application/json" } : {} });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.details = data.details;
    throw err;
  }
  return data;
}
const post = (path, body = {}, method = "POST") => api(path, { method, body: JSON.stringify(body) });
const enc = encodeURIComponent;
const mediaUrl = (id, rel, bust) => `/media/${enc(id)}/${rel.split("/").map(enc).join("/")}${bust ? `?v=${enc(bust)}` : ""}`;

function badge(status) {
  const [text, cls] = STATUS_BADGE[status] ?? [status, "bg-stone-100"];
  return h("span", { class: `rounded-full px-2 py-0.5 text-xs font-medium ${cls}`, text });
}

function errorBox(err) {
  return h("div", { role: "alert", class: "rounded-xl border border-red-200 bg-red-50 p-3 text-red-700" },
    h("p", { class: "font-semibold", text: err.message }),
    err.details?.length ? h("ul", { class: "mt-1 list-disc pl-5 text-sm" }, err.details.map((d) => h("li", { text: d }))) : null,
    billingHelp(err.message));
}

const extLink = (href, text) => h("a", { href, target: "_blank", rel: "noopener noreferrer", class: "font-semibold underline" }, text, h("span", { class: "sr-only", text: " (opens in a new tab)" }), " ↗");

/**
 * Point to where Google account problems are fixed: rate limits (429 / RESOURCE_EXHAUSTED quota) vs.
 * billing (unpaid/overdue bill or empty Prepay credit: 402/403). A 429 also says "billing details", so check it first.
 */
function billingHelp(message) {
  const text = String(message ?? "");
  if (/\b429\b|RESOURCE_EXHAUSTED|exceeded your current quota|rate limit/i.test(text) && !/spend(ing)? cap|dunning/i.test(text)) {
    return h("div", { class: "mt-2 rounded-lg bg-white/70 p-2 text-sm text-ink" },
      h("p", { text: "This is a Google rate limit (too many requests for this model), not a payment problem. Finished work is kept. Wait and try again, or pick a model with higher limits:" }),
      h("p", { class: "mt-1 flex flex-wrap gap-x-4 gap-y-1" },
        extLink("https://aistudio.google.com/rate-limit", "Your rate limits"),
        extLink("https://aistudio.google.com/usage", "Usage"),
        h("a", { href: "#/models", class: "font-semibold underline", text: "Models page" })));
  }
  if (!/dunning|billing|prepay|credit balance|payment required|\b402\b|spend(ing)? cap/i.test(text)) return null;
  return h("div", { class: "mt-2 rounded-lg bg-white/70 p-2 text-sm text-ink" },
    h("p", { text: /spend(ing)? cap/i.test(text)
      ? "Your Google AI project reached the monthly spending cap you set, so Google stops further requests until next month. Nothing in the app needs changing: raise the cap in AI Studio (Spend), then try again:"
      : "This looks like a Google billing problem (unpaid or overdue bill, declined card, or no Prepay credits). Nothing in the app needs changing; fix it here, then try again in a few minutes:" }),
    h("p", { class: "mt-1 flex flex-wrap gap-x-4 gap-y-1" },
      /spend(ing)? cap/i.test(text) ? extLink("https://ai.studio/spend", "Spend cap") : null,
      extLink("https://aistudio.google.com/billing", "AI Studio billing"),
      extLink("https://console.cloud.google.com/billing", "Google Cloud billing"),
      extLink("https://aistudio.google.com/usage", "Usage")));
}

function setNav(section) {
  document.querySelectorAll("[data-nav]").forEach((a) => {
    const on = a.dataset.nav === section;
    on ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current");
  });
}

function closeEvents() {
  events?.close();
  events = null;
  clearTimeout(refreshTimer);
}

// ---------- channels: everything (videos, plans, prompts, branding) belongs to the selected channel ----------
let channels = [];
let channel = localStorage.getItem("kas.channel") || null;
const currentKit = () => channels.find((k) => k.id === channel) ?? null;
const planApi = (path = "") => `/api/channels/${enc(channel)}/plans${path}`;
const withChannel = (path) => `${path}${path.includes("?") ? "&" : "?"}channel=${enc(channel ?? "")}`;

function selectChannel(id) {
  channel = id;
  if (id) localStorage.setItem("kas.channel", id);
  else localStorage.removeItem("kas.channel");
  renderSwitcher();
}

async function loadChannels() {
  channels = await api("/api/channels");
  if (!channels.some((k) => k.id === channel)) selectChannel(channels[0]?.id ?? null);
  else renderSwitcher();
}

/** Top of the sidebar: pick the channel to work on, or make a new one. */
function renderSwitcher() {
  const box = $("#channel-switcher");
  if (!box) return;
  const kit = currentKit();
  const NEW = "__new__";
  const select = h("select", { id: "channel-select", class: "field mt-1 py-1.5 text-sm font-semibold" },
    channels.map((k) => h("option", { value: k.id, text: k.name, selected: k.id === channel })),
    h("option", { value: NEW, text: "＋ New channel…", selected: !kit }));
  select.addEventListener("change", () => {
    if (select.value === NEW) {
      location.hash = "#/channel/new";
      return;
    }
    selectChannel(select.value);
    // Pages of one video or month belong to the old channel: go to the section's start page.
    const [, section] = location.hash.split("/");
    const target = section === "project" ? "#/new" : section === "plan" ? "#/plan" : section === "channel" ? "#/channel" : location.hash || "#/new";
    if (location.hash === target) route();
    else location.hash = target;
  });
  mount(box,
    h("div", { class: "flex items-center gap-2.5 px-1" },
      kit?.logo ? h("img", { src: channelMediaUrl(kit.id, kit.logo), alt: "", class: "size-9 rounded-full border border-orange-100" })
        : h("span", { "aria-hidden": "true", class: "grid size-9 place-items-center rounded-xl bg-coral/15 text-xl", text: "🎈" }),
      h("div", { class: "leading-tight" }, h("p", { class: "text-xs font-bold", text: "Kids Animation Studio" }), h("p", { class: "text-xs text-stone-500", text: kit ? `${kit.videos} video${kit.videos === 1 ? "" : "s"}` : "No channel yet" }))),
    h("label", { for: "channel-select", class: "mt-3 block px-1 text-[11px] font-bold uppercase tracking-wider text-stone-400", text: "Channel" }),
    select);
}

/** Shown on channel pages when there is no channel yet. */
function needChannel() {
  mount($("#sidebar"));
  mount($("#main"), h("section", { class: "card space-y-3" },
    h("h2", { class: "text-xl font-bold", text: "Start with a channel" }),
    h("p", { class: "text-stone-600", text: "Each YouTube channel has its own videos, monthly plans, prompts and branding. Create your first channel to begin." }),
    h("a", { href: "#/channel/new", class: "btn" }, "＋ Create a channel")));
}

// ---------- router ----------
async function route() {
  const [, section, arg, sub] = (location.hash || "#/new").split("/").map(decodeURIComponent);
  clearTimeout(channelPoll);
  // Switching between a project's step pages keeps its live event stream open.
  if (!(section === "project" && arg && arg === currentProject)) {
    closeEvents();
    currentProject = null;
  }
  try {
    if (section === "models") await showModels();
    else if (section === "channel" && arg === "new") await showNewChannel();
    else if (section === "channel" && arg) await showChannel(arg);
    else if (section === "project" && arg) await showProject(arg, sub);
    else if (!channel) needChannel();
    else if (section === "prompts") await showPrompts(arg);
    else if (section === "channel") await showChannel(channel);
    else if (section === "plan") await showPlan(arg);
    else await showNewVideo();
  } catch (err) {
    const back = section === "channel" ? h("a", { href: "#/channel", class: "btn mt-4", text: "← Back to the channel" })
      : section === "plan" ? h("a", { href: "#/plan", class: "btn mt-4", text: "← Back to ideas & schedule" })
      : h("a", { href: "#/new", class: "btn mt-4", text: "← Back to videos" });
    mount($("#main"), errorBox(err), back);
    if (!channel) return;
    if (section === "channel") await renderChannelList().catch(() => {});
    else if (section === "plan") await renderPlanList().catch(() => {});
    else if (section !== "prompts" && section !== "models") await renderProjectList().catch(() => {});
  }
}
window.addEventListener("hashchange", route);

// ---------- Videos ----------
let projectFilter = "";

async function renderProjectList() {
  if (!channel) return mount($("#sidebar"));
  const list = await api(withChannel("/api/projects"));
  const ul = h("ul", { class: "space-y-1" });
  const fill = () => {
    const q = projectFilter.trim().toLowerCase();
    const shown = list.filter((p) => !q || `${p.title ?? ""} ${p.topic}`.toLowerCase().includes(q));
    mount(ul, ...(shown.length ? shown.map(projectItem) : [h("li", { class: "px-2 py-3 text-sm text-stone-500", text: list.length ? "No matches." : "No videos yet — make your first one!" })]));
  };
  const search = h("input", { type: "search", class: "field mb-3 py-1.5 text-sm", placeholder: "Search videos…", "aria-label": "Search videos", value: projectFilter });
  search.addEventListener("input", () => { projectFilter = search.value; fill(); });
  fill();
  mount($("#sidebar"), 
    h("a", { href: "#/new", class: "btn mb-4 w-full justify-center" }, "＋ New video"),
    h("div", { class: "side-heading flex items-center justify-between" }, h("span", { text: "Your videos" }), h("span", { class: "font-normal normal-case tracking-normal", text: String(list.length) })),
    list.length > 5 ? search : null,
    ul,
  );
}

function projectItem(p) {
  const steps = config.steps.length || 6;
  const pct = Math.round((p.completed.length / steps) * 100);
  const status = p.running ? "running" : p.status;
  const bar = status === "failed" ? "bg-red-400" : status === "done" ? "bg-emerald-400" : "bg-coral";
  return h("li", {},
    h("a", { href: `#/project/${enc(p.id)}`, class: "side-item", "aria-current": p.id === currentProject ? "page" : null },
      h("span", { class: "line-clamp-2 text-sm font-semibold leading-snug", lang: p.language, text: p.title || p.topic }),
      p.title ? h("span", { class: "mt-0.5 line-clamp-1 text-xs text-stone-500", text: p.topic }) : null,
      h("span", { class: "mt-1.5 flex items-center gap-2 text-xs text-stone-500" }, badge(status), h("span", { text: p.language === "am" ? "አማርኛ" : "EN" })),
      h("span", { class: "mt-2 block h-1 overflow-hidden rounded-full bg-stone-100", role: "progressbar", "aria-label": "Progress", "aria-valuenow": pct, "aria-valuemin": 0, "aria-valuemax": 100 },
        h("span", { class: `block h-full rounded-full ${bar} ${status === "running" ? "animate-pulse" : ""}`, style: `width:${pct}%` }))));
}

// ---------- audio choices (same lists as src/domain/project/project.model.ts) ----------
const AUDIO_MODES = [
  ["song", "Song — sung by the music AI (Lyria)"],
  ["music_voice", "Rhyme over music — clear voice + instrumental music (best for Amharic)"],
  ["narration", "Narrated story — a narrator reads, the character acts it out"],
  ["character", "The character speaks — she says the words herself in the video (lip-sync; needs Veo)"],
];
const SINGERS = [["auto", "Any (let the AI choose)"], ["woman", "Woman"], ["man", "Man"], ["girl", "Girl (child)"], ["boy", "Boy (child)"], ["kids", "Group of children"]];
const TTS_VOICES = {
  Zephyr: "female, bright", Kore: "female, firm", Leda: "female, youthful", Aoede: "female, breezy", Callirrhoe: "female, easy-going",
  Autonoe: "female, bright", Despina: "female, smooth", Erinome: "female, clear", Laomedeia: "female, upbeat", Achernar: "female, soft",
  Gacrux: "female, mature", Pulcherrima: "female, forward", Vindemiatrix: "female, gentle", Sulafat: "female, warm",
  Puck: "male, upbeat", Charon: "male, informative", Fenrir: "male, excitable", Orus: "male, firm", Enceladus: "male, breathy",
  Iapetus: "male, clear", Umbriel: "male, easy-going", Algieba: "male, smooth", Algenib: "male, gravelly", Rasalgethi: "male, informative",
  Alnilam: "male, firm", Schedar: "male, even", Achird: "male, friendly", Zubenelgenubi: "male, casual", Sadachbia: "male, lively", Sadaltager: "male, knowledgeable",
};
const VOICE_OPTIONS = [["", "Matching the singer (recommended)"], ...Object.entries(TTS_VOICES).map(([v, d]) => [v, `${v} — ${d}`])];
const AUDIO_LABEL = { song: "song", music_voice: "rhyme over music", narration: "narrated story", character: "the character speaks" };
const SINGER_HINT = "Songs: the singer is described to the music AI (it has no voice setting, so it's a strong hint). Rhyme over music and narration: also picks a matching voice.";

// Same rules as the server (src/domain/project/project.model.ts): ½–10 minutes, one scene per ~10 s (song) / ~12 s (story).
const lengthSecondsOf = (minutes) => Math.min(600, Math.max(30, Math.round((Number(minutes) || 0.5) * 60)));
const autoScenes = (seconds, mode) => Math.min(40, Math.max(2, Math.round(seconds / (mode === "song" ? 10 : 12))));
const formatLength = (seconds) => (seconds < 60 ? `${seconds}-second` : `${+(seconds / 60).toFixed(1)}-minute`);

async function showNewVideo() {
  setNav("videos");
  await renderProjectList();
  // The channel's defaults fill the form (a bilingual channel starts with Amharic).
  const d = (await api(`/api/channels/${enc(channel)}`)).input;
  const lang = d.language === "both" ? "am" : d.language;
  const field = (id, label, control, hint) => h("div", {}, h("label", { for: id, class: "label", text: label }), control, hint ? h("p", { class: "mt-1 text-xs text-stone-500", text: hint }) : null);
  const select = (id, name, options, value) => h("select", { id, name, class: "field" }, options.map(([v, t]) => h("option", { value: v, text: t, selected: v === value })));
  const status = h("p", { role: "status", class: "text-sm" });
  const form = h("form", { class: "card space-y-5", novalidate: true },
    h("div", {}, h("h2", { class: "text-xl font-bold", text: "Make a new video" }),
      h("p", { class: "mt-1 text-sm text-stone-500", text: `For ${currentKit()?.name ?? "this channel"}. The channel's settings fill this form; change them on the Channel & branding page.` })),
    config.hasApiKey ? null : h("div", { class: "rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm" },
      "No GEMINI_API_KEY found. Add it to .env and restart, or choose the Mock provider to try things offline."),
    field("f-topic", "What is the video about?", h("textarea", { id: "f-topic", name: "topic", required: true, minlength: 3, rows: 2, class: "field", placeholder: "e.g. Washing hands before eating / እጅ መታጠብ" })),
    h("div", { class: "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" },
      field("f-language", "Language", select("f-language", "language", [["en", "English"], ["am", "አማርኛ (Amharic)"]], lang)),
      field("f-audio", "Audio", select("f-audio", "audioMode", AUDIO_MODES, d.audioMode ?? (lang === "am" ? "music_voice" : "song"))),
      field("f-singer", "Singer / voice", select("f-singer", "singer", SINGERS, d.singer ?? "auto"), SINGER_HINT),
      field("f-voice", "Exact voice (optional)", select("f-voice", "voice", VOICE_OPTIONS, d.voice ?? ""), "For rhyme over music and narrated stories."),
      field("f-video", "Visuals", select("f-video", "videoMode", [["still", "Animated pictures — still images with camera motion (fast)"], ["veo", "Moving video clips — Veo (slow, uses more credits)"]])),
      field("f-scenes", "Scenes", h("input", { id: "f-scenes", name: "sceneCount", type: "number", min: 2, max: 40, class: "field", placeholder: "Auto" }),
        "Leave empty: one picture about every 10 s (song) or 12 s (story)."),
      field("f-length", "Video length (minutes)", h("input", { id: "f-length", name: "lengthMinutes", type: "number", min: 0.5, max: 10, step: 0.5, value: d.videoMinutes ?? 0.5, class: "field", "aria-describedby": "f-length-plan" }),
        "From ½ to 10 minutes."),
      field("f-age", "Age range", h("input", { id: "f-age", name: "ageRange", value: d.ageRange ?? "3-6", class: "field" })),
      field("f-aspect", "Shape", select("f-aspect", "aspectRatio", [["16:9", "Landscape 16:9 (YouTube)"], ["9:16", "Portrait 9:16 (Shorts)"]])),
      h("div", { class: "flex items-start gap-2 self-end pb-2" },
        h("input", { id: "f-subs", name: "subtitles", type: "checkbox", value: "on", class: "mt-1 size-4 accent-coral" }),
        h("label", { for: "f-subs", class: "text-sm" }, h("span", { class: "font-semibold", text: "Show lyrics on the video" }),
          h("span", { class: "block text-xs text-stone-500", text: "Off by default. You can turn it on later on the Final video page." }))),
    ),
    h("div", { class: "grid gap-4 sm:grid-cols-2" },
      field("f-character", "Main character (optional)", h("input", { id: "f-character", name: "characterHint", class: "field", value: d.mainCharacter ?? "", placeholder: "a curious little goat named Abeba" })),
      field("f-style", "Art style", h("input", { id: "f-style", name: "style", class: "field", value: d.style })),
    ),
    field("f-mode", "Mode", select("f-mode", "reviewMode", [["manual", "Manual — stop after each step so I can review and edit"], ["auto", "Auto — make the whole video in one go"]], "manual"),
      "Every step also has its own page (Poem, Scenes, Character, Audio, Clips, Final video) where you can make, edit or redo it on its own."),
    field("f-provider", "Provider", select("f-provider", "provider", [["gemini", "Gemini (real AI)"], ["mock", "Mock (offline test)"]], config.hasApiKey ? "gemini" : "mock"),
      "Prompts come from the Prompts page and models from the Models page."),
    h("p", { id: "f-length-plan", role: "status", "aria-live": "polite", class: "rounded-xl bg-sky-50 p-3 text-sm text-sky-900" }),
    h("div", { class: "flex items-center gap-3" }, h("button", { type: "submit", class: "btn" }, "Create video ✨"), status),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const input = Object.fromEntries([...fd.entries()].filter(([k, v]) => k !== "provider" && k !== "lengthMinutes" && String(v).trim() !== ""));
    if (input.sceneCount) input.sceneCount = Number(input.sceneCount);
    input.subtitles = fd.get("subtitles") === "on";
    input.lengthSeconds = lengthSecondsOf(fd.get("lengthMinutes"));
    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    mount(status, "Starting…");
    try {
      const p = await post("/api/projects", { input, provider: fd.get("provider"), channelId: channel });
      location.hash = `#/project/${enc(p.id)}`;
    } catch (err) {
      mount(status, errorBox(err));
      btn.disabled = false;
    }
  });
  mount($("#main"), form);
  const updateLengthPlan = () => {
    const seconds = lengthSecondsOf($("#f-length").value);
    const mode = $("#f-audio").value;
    const scenes = Number($("#f-scenes").value) || autoScenes(seconds, mode);
    const veo = $("#f-video").value === "veo";
    $("#f-length-plan").textContent = `${formatLength(seconds)} video · ${scenes} scenes (${scenes} pictures${veo ? `, ${scenes} paid Veo clips` : ""}). `
      + (mode === "song"
        ? (seconds > 180
            ? `Google's song models make at most about 3 minutes per song, so this song is made in ${Math.ceil(seconds / 180)} parts that are joined (with Lyria 3 Clip: ${Math.ceil(seconds / 30)} parts of 30 s, and the tune may change between parts). Pick Lyria 3 Pro or 3.5 on the Models page for long songs.`
            : seconds > 30 ? "Pick Lyria 3 Pro or 3.5 on the Models page: Lyria 3 Clip makes 30-second songs, so longer ones are joined from several 30 s parts." : "")
        : mode === "character"
          ? `In every scene Veo makes ${$("#f-character").value.trim() || "the character"} say that scene's words herself, with her lips in sync, plus soft background music. Each scene is one 8-second Veo clip, so this needs Visuals = Veo (${scenes} paid clips). Veo's Amharic speech isn't documented: try a short video first.`
          : mode === "music_voice"
          ? "The rhyme is chanted clearly by the voice AI over instrumental music from the music AI (one music piece, looped). Amharic words come out clear, because the voice AI speaks Amharic while the music AI can't sing it well."
          : "The story is written to be read aloud in about this time; the exact length depends on the voice.");
    $("#f-voice").closest("div").hidden = mode === "song" || mode === "character";
    if (mode === "character") $("#f-video").value = "veo";
  };
  for (const id of ["#f-length", "#f-audio", "#f-scenes", "#f-video"]) $(id).addEventListener("input", updateLengthPlan);
  // Amharic is better as a rhyme over music: suggest it when switching the language (unless the channel chose otherwise).
  $("#f-language").addEventListener("change", () => {
    if (!d.audioMode && $("#f-language").value === "am" && $("#f-audio").value === "song") { $("#f-audio").value = "music_voice"; updateLengthPlan(); }
  });
  updateLengthPlan();
  $("#f-topic").focus();
}

// ---------- Project: one page per step ----------
const STEP_ICONS = { poem: "✍️", scenes: "🗺️", character: "🧸", audio: "🎵", clips: "🎞️", final: "🎬" };
const STEP_HELP = {
  poem: "The words of the song or story, one stanza per scene. Edit any line, or write a new poem.",
  scenes: "What each scene sings or says, and what its picture shows. Edit them, or plan the scenes again.",
  character: "The main character, drawn once and reused in every picture. Change the name or look and redraw it.",
  audio: "The song, or the narration for each scene. Listen, and make a new one if you don't like it.",
  clips: "One clip per scene, timed to the audio. Remake any scene you don't like.",
  final: "All clips joined with the audio into one MP4. Lyrics / captions on the video are optional.",
};
const MAKE_LABEL = { poem: "✨ Write the poem", scenes: "✨ Plan the scenes", character: "✨ Design the character", audio: "✨ Make the audio", clips: "✨ Make the clips", final: "🎬 Build the final video" };
const REDO_LABEL = { poem: "↻ Write a new poem", scenes: "↻ Plan the scenes again", character: "↻ Design a new character", audio: "↻ Make new audio", clips: "↻ Remake all clips", final: "↻ Build again" };
const SKIP = Symbol("skip");

let currentStep = null;
const stepUrl = (id, step) => `#/project/${enc(id)}/${step}`;
const prevStep = (s) => config.steps[config.steps.indexOf(s) - 1];
const nextStepOf = (s) => config.steps[config.steps.indexOf(s) + 1];

// Same estimate as the server (src/domain/ports/generator.port.ts): one Ge'ez letter ≈ 0.8 syllable,
// sung clearly for kids at 2.5 syllables/second plus ~4 s of intro and ending.
const syllables = (text) => Math.round([...text].filter((c) => /[\u1200-\u139F\u2D80-\u2DDF\uAB00-\uAB2F]/.test(c)).length * 0.8)
  + (text.match(/[a-z]+/gi) ?? []).reduce((n, w) => n + Math.max(1, (w.toLowerCase().replace(/(?<![^aeiou]l)e$/, "").match(/[aeiouy]+/g) ?? []).length), 0);
const singableSeconds = (texts) => Math.ceil(texts.reduce((n, t) => n + syllables(t), 0) / 2.5 + 4);

/** Song mode: how long the words need to be sung clearly, vs. the chosen song length. */
function paceNote(p) {
  if (p.input.audioMode !== "song") return null;
  const el = h("p", { role: "status", "aria-live": "polite", class: "rounded-xl p-3 text-sm" });
  return { el, update(texts) {
    const need = singableSeconds(texts), have = p.input.songSeconds;
    const ok = need <= have;
    el.className = `rounded-xl p-3 text-sm ${ok ? "bg-emerald-50 text-emerald-900" : "bg-amber-50 text-amber-900"}`;
    el.textContent = ok
      ? `🎵 These words take about ${need} s to sing clearly; the song is ${have} s. Good pace.`
      : `🎵 These words take about ${need} s to sing clearly, but the song is ${have} s, so the singer would rush and blur the words. `
        + `Use shorter lines or fewer scenes, or make a new video with a longer length.`;
  } };
}

/** A step's output can be edited when it's done and nothing is running. */
const editable_ = (p, step) => !p.running && p.completed.includes(step);

/** Step to open when the URL doesn't name one: the one under review, the one being made, or the last one made. */
function defaultStep(p) {
  return p.awaitingReview ?? (p.running ? p.nextStep : null) ?? p.completed.at(-1) ?? "poem";
}

async function showProject(id, step) {
  setNav("videos");
  const opening = currentProject !== id || !events;
  currentProject = id;
  currentStep = config.steps.includes(step) ? step : null;
  await renderProject(id);
  $("#main").focus();
  if (opening) watch(id);
}

/** (Re)subscribe to live events. Call after starting a run: a stream opened while idle gets no events. */
function watch(id) {
  closeEvents();
  events = new EventSource(`/api/projects/${enc(id)}/events`);
  events.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const s = $("#run-status");
    if (s) {
      if (e.type === "progress") s.textContent = `${STEP_LABELS[e.step]}: ${e.message} (${e.done}/${e.total})`;
      else if (e.type === "step-start") s.textContent = `${STEP_LABELS[e.step]}…`;
      else if (e.type === "done") s.textContent = "Done! 🎉";
      else if (e.type === "review") s.textContent = `${STEP_LABELS[e.step]} is ready for your review`;
      else if (e.type === "stopped") s.textContent = `${STEP_LABELS[e.step]} is ready ✓`;
      else if (e.type === "error") s.textContent = e.message;
    }
    // Coalesce refreshes so pictures appear as they're painted.
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => currentProject === id && renderProject(id, true), e.type === "progress" ? 500 : 80);
  };
}

async function renderProject(id, keepStatus = false) {
  const p = await api(`/api/projects/${enc(id)}`);
  if (currentProject !== id) return;
  // Opening a video of another channel switches to that channel.
  if (p.channelId && p.channelId !== channel && channels.some((k) => k.id === p.channelId)) selectChannel(p.channelId);
  if (!currentStep) {
    currentStep = defaultStep(p);
    history.replaceState(null, "", stepUrl(id, currentStep));
  }
  const step = currentStep;
  const prevStatus = keepStatus ? $("#run-status")?.textContent : null;
  const lang = p.input.language;
  const manual = p.input.reviewMode === "manual";

  const controls = h("div", { class: "mt-4 flex flex-wrap items-center gap-2" },
    p.running
      ? h("button", { type: "button", class: "btn-danger", onclick: () => post(`/api/projects/${enc(id)}/cancel`) }, "■ Stop")
      : [
          p.status === "done" ? null : h("button", { type: "button", class: "btn-soft", onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await post(`/api/projects/${enc(id)}/resume`, { provider: $("#prov").value });
              watch(id);
              await renderProject(id);
            } catch (err) { mount($("#run-status"), errorBox(err)); e.target.disabled = false; }
          } }, manual ? "▶ Continue (stops after each step)" : "▶ Make the rest automatically"),
          h("select", { id: "prov", class: "field w-auto py-1.5 text-sm", "aria-label": "Provider" }, config.providers.map((n) => h("option", { value: n, text: n, selected: n === p.provider }))),
          h("button", { type: "button", class: "btn-soft px-3 py-1.5 text-sm", title: "Manual: Continue stops after each step. Auto: it runs to the final video.", onclick: async () => {
            await post(`/api/projects/${enc(id)}/review-mode`, { mode: manual ? "auto" : "manual" }, "PUT");
            await renderProject(id);
          } }, manual ? "Mode: manual review" : "Mode: auto"),
        ],
    h("span", { id: "run-status", role: "status", "aria-live": "polite", class: "text-sm text-stone-600" }),
  );

  const header = h("section", { class: "card" },
    h("div", { class: "flex flex-wrap items-center gap-3" }, h("h2", { class: "text-2xl font-bold", lang, text: p.poem?.title || p.topic }), badge(p.running ? "running" : p.status)),
    h("p", { class: "mt-1 text-sm text-stone-500", text: [manual ? "manual review" : "auto", lang === "am" ? "አማርኛ" : "English", AUDIO_LABEL[p.input.audioMode] ?? p.input.audioMode, p.song?.source === "upload" ? "your recording" : null, p.input.lengthSeconds ? `${formatLength(p.input.lengthSeconds)} target` : null, `${p.input.sceneCount} scenes`, p.input.videoMode === "veo" ? "Veo video" : "animated pictures", p.input.aspectRatio, `provider: ${p.provider}`].filter(Boolean).join(" · ") }),
    controls,
    p.running ? null : settingsPanel(p),
    p.running ? null : videoAdmin(p),
    p.error && !p.running && p.error !== "cancelled" ? h("div", { class: "mt-3" }, errorBox({ message: p.error })) : null,
  );

  const tabs = h("nav", { "aria-label": "Steps", class: "mb-4" },
    h("ol", { class: "flex flex-wrap gap-2" }, config.steps.map((s, i) => {
      const done = p.completed.includes(s);
      const state = s === p.awaitingReview ? "review" : done ? "done" : p.running && s === p.nextStep ? "active" : "todo";
      const cls = { review: "bg-sky-100 text-sky-800", done: "bg-emerald-50 text-emerald-800", active: "bg-orange-100 text-orange-800 animate-pulse", todo: "bg-white text-stone-500" }[state];
      const mark = { review: "👀", done: "✓", active: "⏳", todo: String(i + 1) }[state];
      const label = { review: "needs review", done: "done", active: "in progress", todo: "not made yet" }[state];
      return h("li", {},
        h("a", { href: stepUrl(id, s), "aria-current": s === step ? "page" : null, "aria-label": `${STEP_LABELS[s]} (${label})`,
          class: `step-tab ${cls}` },
          h("span", { "aria-hidden": "true", class: "text-xs", text: mark }), h("span", { "aria-hidden": "true", text: STEP_ICONS[s] }), STEP_LABELS[s]));
    })));

  const oldVideo = $("#final-video");
  const videoKey = `${id}|${p.updatedAt}`;
  const keepVideo = oldVideo && (oldVideo.dataset.key === videoKey || p.running) ? oldVideo : null; // never interrupt playback

  const wasOpen = $("#gen-log")?.open;
  const settingsOpen = $("#settings-panel")?.open;
  mount($("#main"), header, tabs, stepPage(p, step, keepVideo, videoKey), generationLog(id, step));
  if (wasOpen) $("#gen-log").open = true;
  if (settingsOpen && $("#settings-panel")) $("#settings-panel").open = true;
  if (prevStatus) $("#run-status").textContent = prevStatus;
  await renderProjectList();
}

/** The page for one step: what it made, how to edit or redo it, and the way to the next step. */
function stepPage(p, step, keepVideo, videoKey) {
  const id = p.id, lang = p.input.language;
  const done = p.completed.includes(step);
  const prev = prevStep(step), next = nextStepOf(step);
  const ready = !prev || p.completed.includes(prev);
  const making = p.running && p.nextStep === step;
  const idle = !p.running;
  const reviewing = p.awaitingReview === step;
  const status = h("div", { role: "status", "aria-live": "polite", class: "mt-3 text-sm" });

  /** Button handler: disables while working, shows errors, re-renders. `starts` = it begins a background run. */
  const act = (fn, starts = true) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    mount(status, "Working…");
    try {
      if ((await fn()) === SKIP) { mount(status); btn.disabled = false; return; }
      if (starts) watch(id);
      await renderProject(id);
    } catch (err) { mount(status, errorBox(err)); btn.disabled = false; }
  };
  const provider = () => $("#prov")?.value;
  const laterDone = config.steps.slice(config.steps.indexOf(step) + 1).filter((s) => p.completed.includes(s));
  const laterNote = laterDone.length ? ` ${laterDone.map((s) => STEP_LABELS[s]).join(", ")} will need to be made again.` : "";
  // Pictures / Veo videos already made. A new song never deletes them; a poem change can keep them too.
  const hasVisuals = p.media.scenes.some((m) => m.image || m.video);
  const veoKept = p.media.scenes.filter((m) => m.video).length;
  const keepBox = step === "poem" && editable_(p, step) && hasVisuals && p.completed.includes("scenes") && p.input.audioMode !== "character"
    ? h("input", { id: "keep-visuals", type: "checkbox", checked: true, class: "mt-1 size-4 accent-coral" }) : null;
  const keeping = () => Boolean(keepBox?.checked);
  const keepNote = " The pictures and video clips are kept; the song, clip timing and final video are made again.";
  const changeNote = () => (keeping() ? keepNote : step === "audio" && hasVisuals ? `${laterNote} The pictures${veoKept ? ` and ${veoKept} Veo animation${veoKept === 1 ? "" : "s"}` : ""} are kept (no new AI cost); the clips are only re-timed to the new audio.` : laterNote);
  
  // Audio page: extra wishes for the song / music / voice, remembered for this video.
  const wish = step === "audio" && idle && ready
    ? h("input", { id: "audio-wish", class: "field", lang: p.input.language, maxlength: 500, value: p.input.audioRequest ?? "", placeholder: "e.g. slower and happier · more krar and kebero · a softer, sleepy lullaby · louder clapping · speak more slowly" })
    : null;
  const generate = (label = MAKE_LABEL[step], cls = "btn") => h("button", { type: "button", class: cls, onclick: act(async () => {
    if (done && !confirm(`Throw this ${STEP_LABELS[step].toLowerCase()} away and make a new one?${changeNote()}`)) return SKIP;
    if (step === "clips" && p.input.videoMode === "veo" && !confirm(`This makes ${p.scenes.scenes.length} Veo video requests (slow, uses paid credits). Continue?`)) return SKIP;
    await post(`/api/projects/${enc(id)}/steps/${step}/generate`, { provider: provider(), keepVisuals: keeping(), audioRequest: wish ? wish.value : undefined });
  }) }, label);

  // Each step fills in: body (what was made), save (returns a function that saves the edits, or null when
  // nothing changed), extra buttons, and an `after` block.
  let body = null, save = () => null, extra = [], after = null;
  const editable = editable_(p, step);

  if (step === "poem" && p.poem) {
    if (editable) {
      const title = h("input", { class: "field text-lg font-semibold", lang, value: p.poem.title, "aria-label": "Title" });
      const stanzas = p.poem.stanzas.map((st, i) => h("textarea", { class: "field text-lg leading-relaxed", lang, rows: Math.max(2, st.lines.length), "aria-label": `Stanza ${i + 1}`, value: st.lines.join("\n") }));
      const read = () => ({ title: title.value.trim(), moral: p.poem.moral, stanzas: stanzas.map((t) => ({ lines: t.value.split("\n").map((l) => l.trim()).filter(Boolean) })) });
      const changed = () => JSON.stringify(read()) !== JSON.stringify({ title: p.poem.title, moral: p.poem.moral, stanzas: p.poem.stanzas });
      save = () => changed() ? () => post(`/api/projects/${enc(id)}/poem`, { poem: read(), keepVisuals: keeping() }, "PUT") : null;
      const pace = paceNote(p);
      const updatePace = () => pace?.update(read().stanzas.map((st) => st.lines.join(" ")));
      stanzas.forEach((t) => t.addEventListener("input", updatePace));
      updatePace();
      const draft = () => ({ ...read(), stanzas: read().stanzas.map((st, i) => (st.lines.length ? st : p.poem.stanzas[i])) });
      body = h("div", { class: "space-y-3" }, h("label", { class: "label", text: "Title" }), title,
        stanzas.map((t, i) => {
          const rw = rewriteControl(p, i, t, draft, "stanza");
          return h("div", {},
            h("div", { class: "mb-1 flex items-center gap-2" }, h("p", { class: "label mb-0 flex-1", text: `Stanza ${i + 1} (scene ${i + 1})` }), rw.toggle),
            t, rw.box, rw.note);
        }),
        pace?.el,
        keepBox ? h("div", { class: "flex items-start gap-2 rounded-xl bg-violet-50 p-3 text-sm" }, keepBox,
          h("label", { for: "keep-visuals" }, h("span", { class: "font-semibold", text: "Keep the pictures and video clips" }),
            h("span", { class: "block text-stone-600", text: "Only the words, the song and the clip timing change (stanza 1 stays on scene 1, and so on). Applies to Save and to Write a new poem. Untick to plan new scenes with new pictures." }))) : null);
    } else {
      const pace = paceNote(p);
      pace?.update(p.poem.stanzas.map((st) => st.lines.join(" ")));
      body = h("div", {}, h("div", { class: "whitespace-pre-line text-lg leading-relaxed", lang, text: p.poem.stanzas.map((s) => s.lines.join("\n")).join("\n\n") }), pace?.el);
    }
  } else if (step === "scenes" && p.scenes) {
    if (editable) {
      const rows = p.scenes.scenes.map((sc) => ({
        sc,
        text: h("textarea", { class: "field", lang, rows: 2, "aria-label": `Scene ${sc.index + 1} words`, value: sc.text }),
        visual: h("textarea", { class: "field text-sm", rows: 3, "aria-label": `Scene ${sc.index + 1} picture description`, value: sc.visualPrompt }),
      }));
      const read = () => ({ scenes: rows.map((r) => ({ ...r.sc, text: r.text.value.trim(), visualPrompt: r.visual.value.trim() })) });
      save = () => JSON.stringify(read()) !== JSON.stringify({ scenes: p.scenes.scenes }) ? () => post(`/api/projects/${enc(id)}/scenes`, { scenes: read() }, "PUT") : null;
      // The scenes' words are the poem's stanzas: rewrite one in the context of the others.
      const draft = () => ({ title: p.poem?.title ?? p.topic, moral: p.poem?.moral, stanzas: rows.map((r) => {
        const lines = r.text.value.split("\n").map((l) => l.trim()).filter(Boolean);
        return { lines: lines.length ? lines : r.sc.text.split("\n").filter(Boolean) };
      }) });
      body = h("div", { class: "space-y-4" }, rows.map((r) => {
        const rw = rewriteControl(p, r.sc.index, r.text, draft, "scene");
        return h("div", { class: "rounded-xl border border-orange-100 p-3" },
        h("div", { class: "mb-2 flex items-center gap-2" }, h("p", { class: "flex-1 font-semibold", text: `Scene ${r.sc.index + 1}` }), rw.toggle),
        h("p", { class: "label", text: "Sung / spoken" }), r.text, rw.box, rw.note,
        h("p", { class: "label mt-2", text: "What the picture shows (English)" }), r.visual);
      }));
    } else {
      body = h("ol", { class: "space-y-3" }, p.scenes.scenes.map((sc) => h("li", { class: "rounded-xl border border-orange-100 p-3" },
        h("p", { class: "whitespace-pre-line font-semibold", lang, text: `${sc.index + 1}. ${sc.text}` }),
        h("p", { class: "mt-1 text-sm text-stone-600", text: sc.visualPrompt }))));
    }
  } else if (step === "character" && p.character && (done || making)) {
    const img = p.media.characterImage
      ? h("img", { src: mediaUrl(id, p.media.characterImage, p.updatedAt), alt: `Character sheet for ${p.character.name}`, class: "w-56 self-start rounded-xl border border-orange-100" })
      : h("div", { class: "grid size-56 place-items-center rounded-xl bg-stone-100 text-sm text-stone-500", text: making ? "drawing…" : "no picture" });
    if (editable) {
      const name = h("input", { class: "field", lang, value: p.character.name, "aria-label": "Name" });
      const desc = h("textarea", { class: "field", rows: 4, value: p.character.description, "aria-label": "Look (English)" });
      const changed = () => name.value.trim() !== p.character.name || desc.value.trim() !== p.character.description;
      body = h("div", { class: "flex flex-col gap-4 sm:flex-row" }, img,
        h("div", { class: "flex-1 space-y-2" }, h("p", { class: "label", text: "Name" }), name, h("p", { class: "label", text: "Look (English, used for every picture)" }), desc));
      extra = [h("button", { type: "button", class: "btn-soft", onclick: act(async () => {
        if (!changed()) { mount(status, "Nothing changed — edit the name or look first."); return SKIP; }
        await post(`/api/projects/${enc(id)}/character`, { character: { name: name.value.trim(), description: desc.value.trim() } }, "PUT");
      }) }, "🎨 Save & redraw picture")];
    } else {
      body = h("div", { class: "flex flex-col gap-4 sm:flex-row" }, img,
        h("div", {}, h("h4", { class: "text-lg font-bold", lang, text: p.character.name }), h("p", { class: "text-stone-600", text: p.character.description })));
    }
  }
  if (step === "character" && idle && p.completed.includes("scenes")) after = characterUpload(p, act, done);
  if (step === "audio" && done) {
    body = p.song
      ? h("div", { class: "space-y-2" }, h("audio", { controls: true, class: "w-full", src: mediaUrl(id, p.song.file, p.updatedAt) }),
          h("p", { class: "text-sm text-stone-500", text: `${{ upload: "Your recording", music_voice: "Rhyme over music", ai: "Song" }[p.song.source ?? "ai"]} · ${p.song.duration.toFixed(1)} seconds` }),
          h("a", { class: "btn-soft", href: mediaUrl(id, p.song.file, p.updatedAt), download: "" }, "⬇ Download audio"))
      : h("ol", { class: "space-y-3" }, (p.scenes?.scenes ?? []).map((sc) => {
          const a = p.media.scenes.find((m) => m.index === sc.index)?.audio;
          return h("li", { class: "rounded-xl border border-orange-100 p-3" },
            h("p", { class: "mb-2 whitespace-pre-line text-sm", lang, text: `${sc.index + 1}. ${sc.text}` }),
            a ? h("audio", { controls: true, preload: "none", class: "w-full", src: mediaUrl(id, a, p.updatedAt), "aria-label": `Scene ${sc.index + 1} narration` }) : h("p", { class: "text-sm text-stone-500", text: "missing" }));
        }));
  } else if (step === "clips" && p.scenes && (done || making || p.media.scenes.some((m) => m.image || m.clip))) {
    body = h("div", { class: "grid gap-4 sm:grid-cols-2" }, p.scenes.scenes.map((sc) => {
      const m = p.media.scenes.find((x) => x.index === sc.index);
      // Finished clip; else the Veo animation it's made from (kept when the audio changes, re-timed later); else the picture.
      const media = m?.clip ? h("video", { controls: true, preload: "metadata", class: "aspect-video w-full bg-black", src: mediaUrl(id, m.clip, p.updatedAt), "aria-label": `Scene ${sc.index + 1} clip` })
        : m?.video ? h("div", { class: "relative" },
            h("video", { controls: true, muted: true, loop: true, preload: "metadata", class: "aspect-video w-full bg-black", src: mediaUrl(id, m.video, p.updatedAt), "aria-label": `Scene ${sc.index + 1} Veo animation` }),
            h("span", { class: "absolute top-2 left-2 rounded-full bg-black/60 px-2 py-0.5 text-xs text-white", text: "🎞️ Veo animation · timed to the audio when the clips are made" }))
        : m?.image ? h("img", { src: mediaUrl(id, m.image, p.updatedAt), alt: sc.visualPrompt, class: "aspect-video w-full object-cover" })
        : h("div", { class: "grid aspect-video place-items-center bg-stone-100 text-sm text-stone-500", text: making ? "painting…" : "not made yet" });
      return h("figure", { class: "overflow-hidden rounded-xl border border-orange-100" }, media,
        h("figcaption", { class: "flex items-start gap-2 p-3 text-sm" },
          h("span", { class: "flex-1 whitespace-pre-line", lang, text: `${sc.index + 1}. ${sc.text}` }),
          idle && p.completed.includes("audio") ? h("button", { type: "button", class: "btn-soft shrink-0 px-3 py-1 text-xs", onclick: act(async () => {
            const cost = p.input.videoMode === "veo" ? " This makes 1 new Veo clip (paid)." : "";
            if (!confirm(`Remake scene ${sc.index + 1} (new picture and clip)?${cost}`)) return SKIP;
            await post(`/api/projects/${enc(id)}/scenes/${sc.index + 1}/redo`);
          }) }, "↻ Remake") : null));
    }));
    if (idle && p.completed.includes("audio")) extra = [visualsSwitch(p, act)];
  } else if (step === "final" && p.media.final) {
    const video = keepVideo || h("video", { id: "final-video", "data-key": videoKey, controls: true, preload: "metadata", class: "w-full rounded-xl bg-black", src: mediaUrl(id, p.media.final, p.updatedAt) },
      p.media.subtitles && p.input.subtitles ? h("track", { kind: "subtitles", label: p.input.audioMode === "song" ? "Lyrics" : "Captions", srclang: lang, src: mediaUrl(id, "subtitles.vtt", p.updatedAt), default: true }) : null);
    body = h("div", {}, video, h("div", { class: "mt-3 flex flex-wrap gap-2" },
      h("a", { class: "btn", href: mediaUrl(id, p.media.final, p.updatedAt), download: `${id}.mp4` }, "⬇ Download MP4"),
      p.song ? h("a", { class: "btn-soft", href: mediaUrl(id, p.song.file, p.updatedAt), download: "" }, "♪ Song only") : null,
      p.media.subtitles ? h("a", { class: "btn-soft", href: mediaUrl(id, p.media.subtitles, p.updatedAt), download: `${id}.srt` }, "⬇ Lyrics file (.srt)") : null));
  }
  if (step === "final" && idle) after = subtitlesToggle(p, act);
  if (step === "audio" && idle && p.completed.includes("character")) after = audioUpload(p, act, done);

  // What to do on this page.
  let buttons = [];
  if (making) {
    body ??= h("p", { class: "text-stone-600", text: "Making it now… it appears here when ready." });
  } else if (p.running) {
    body ??= h("p", { class: "text-stone-500", text: `Waiting: ${STEP_LABELS[p.nextStep] ?? "another step"} is being made.` });
  } else if (!ready && !done) {
    body = h("p", { class: "text-stone-600" }, "Make the ", h("a", { href: stepUrl(id, prev), class: "font-semibold underline", text: STEP_LABELS[prev] }), " first.");
  } else if (!done) {
    body = body ? h("div", {}, h("p", { class: "mb-3 text-sm text-stone-500", text: "Not finished yet — make it to continue." }), body) : null;
    // Scenes kept from before (new poem, same pictures): the words just go into them.
    buttons = [generate(step === "scenes" && p.scenes ? "✨ Put the new words into the scenes (keeps the pictures)" : MAKE_LABEL[step])];
  } else {
    const saveBtn = step === "poem" || step === "scenes" ? h("button", { type: "button", class: "btn", onclick: act(async () => {
      const saving = save();
      if (!saving) { mount(status, "Nothing changed."); return SKIP; }
      const note = step === "poem" ? changeNote() : laterNote;
      if (laterDone.length && !confirm(`Save your changes?${note}`)) return SKIP;
      await saving();
    }, false) }, "💾 Save changes") : null;
    const approve = reviewing ? h("button", { type: "button", class: "btn", onclick: act(async () => {
      await save()?.();
      await post(`/api/projects/${enc(id)}/approve`, { step });
    }) }, next ? `✓ Approve & make ${STEP_LABELS[next]}` : "✓ Approve") : null;
    buttons = [approve, saveBtn, ...extra, generate(REDO_LABEL[step], "btn-soft")];
    extra = [];
  }
  if (extra.length) buttons.push(...extra);

  const nextLink = next && done && !p.running
    ? h("a", { href: stepUrl(id, next), class: p.completed.includes(next) ? "btn-soft ml-auto" : "btn ml-auto" }, `Next: ${STEP_ICONS[next]} ${STEP_LABELS[next]} →`)
    : null;

  return h("section", { class: `card ${reviewing ? "border-2 border-sky-200 bg-sky-50/40" : ""}`, "aria-labelledby": "step-title" },
    h("div", { class: "mb-1 flex flex-wrap items-center gap-2" },
      h("span", { "aria-hidden": "true", class: "text-xl", text: STEP_ICONS[step] }),
      h("h3", { id: "step-title", class: "text-xl font-bold", text: STEP_LABELS[step] }),
      reviewing ? h("span", { class: "chip bg-sky-100 text-sky-800", text: "👀 needs your review" }) : done ? h("span", { class: "chip bg-emerald-100 text-emerald-800", text: "✓ done" }) : null),
    h("p", { class: "mb-4 text-sm text-stone-600", text: STEP_HELP[step] }),
    body,
    wish && buttons.length ? h("div", { class: "mt-5 rounded-xl bg-violet-50 p-3" },
      h("label", { for: "audio-wish", class: "label", text: done ? "What should be different this time? (optional)" : "Anything special for the audio? (optional)" }), wish,
      h("p", { class: "mt-1 text-xs text-stone-500", text: "Added to the song / music / voice prompt (in English or Amharic). It's remembered for this video; clear it to go back to the normal prompt." })) : null,
    buttons.length || nextLink ? h("div", { class: "mt-5 flex flex-wrap items-center gap-2" }, buttons, nextLink) : null,
    status,
    after);
}

/**
 * "↻ Rewrite" for one stanza / scene: the AI writes just that one again (with an optional wish), the new words go
 * into the box as an unsaved draft with Undo; "Save changes" keeps them. `draft()` = the poem as it is in the editor.
 */
function rewriteControl(p, index, textarea, draft, what) {
  const id = `rw-${what}-${index}`;
  const hint = h("input", { id, class: "field py-1.5 text-sm", lang: p.input.language, maxlength: 500, placeholder: "Optional: what should change? e.g. make it funnier · mention the goat · simpler words" });
  const note = h("p", { role: "status", "aria-live": "polite", class: "text-sm" });
  let before = null;
  const undo = h("button", { type: "button", class: "btn-soft px-3 py-1 text-xs", hidden: true, onclick: () => {
    textarea.value = before;
    textarea.dispatchEvent(new Event("input"));
    textarea.classList.remove("ring-2", "ring-violet-300");
    undo.hidden = true;
    note.textContent = "Back to the previous words.";
  } }, "↶ Undo");
  const go = h("button", { type: "button", class: "btn px-3 py-1 text-sm", onclick: async () => {
    go.disabled = true;
    note.className = "text-sm text-stone-600";
    note.textContent = "Writing a new version…";
    try {
      const r = await post(`/api/projects/${enc(p.id)}/poem/stanzas/${index + 1}/rewrite`, { poem: draft(), hint: hint.value.trim() || undefined, provider: $("#prov")?.value });
      before = textarea.value;
      textarea.value = r.lines.join("\n");
      textarea.rows = Math.max(2, r.lines.length);
      textarea.dispatchEvent(new Event("input"));
      textarea.classList.add("ring-2", "ring-violet-300");
      undo.hidden = false;
      note.className = "text-sm text-violet-800";
      note.textContent = "✨ New words, not saved yet. Click “Save changes” below to keep them, rewrite again, or undo.";
    } catch (err) { mount(note, errorBox(err)); }
    go.disabled = false;
  } }, "✨ Rewrite");
  hint.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); go.click(); } });
  const box = h("div", { class: "mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-violet-50 p-2", hidden: true },
    h("label", { for: id, class: "sr-only", text: "What should change?" }), h("div", { class: "min-w-56 flex-1" }, hint), go, undo);
  const toggle = h("button", { type: "button", class: "btn-soft px-3 py-1 text-xs", "aria-expanded": "false", onclick: () => {
    box.hidden = !box.hidden;
    toggle.setAttribute("aria-expanded", String(!box.hidden));
    if (!box.hidden) hint.focus();
  } }, `↻ Rewrite ${what} ${index + 1}`);
  return { toggle, box, note };
}

/** Move the video to another channel, or delete it with all its files. */
function videoAdmin(p) {
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const others = channels.filter((k) => k.id !== p.channelId);
  const target = others.length ? h("select", { id: "mv-channel", class: "field w-auto py-1.5 text-sm" }, others.map((k) => h("option", { value: k.id, text: k.name }))) : null;
  const move = target ? h("button", { type: "button", class: "btn-soft px-3 py-1.5 text-sm", onclick: async () => {
    const name = others.find((k) => k.id === target.value)?.name;
    if (!confirm(`Move this video to "${name}"? It keeps everything it made; anything made again from now on uses ${name}'s prompts.`)) return;
    try {
      await post(`/api/projects/${enc(p.id)}/channel`, { channelId: target.value }, "PUT");
      await loadChannels();
      selectChannel(target.value);
      await renderProject(p.id);
    } catch (err) { mount(status, errorBox(err)); }
  } }, "Move") : null;
  const del = h("button", { type: "button", class: "btn-danger px-3 py-1.5 text-sm", onclick: async () => {
    const title = p.poem?.title || p.topic;
    if (!confirm(`Delete "${title}"? The poem, pictures, song and video files are deleted for good.`)) return;
    try {
      await post(`/api/projects/${enc(p.id)}`, {}, "DELETE");
      await loadChannels();
      location.hash = "#/new";
    } catch (err) { mount(status, errorBox(err)); }
  } }, "🗑 Delete video");
  const keepPoem = h("input", { id: "rc-poem", type: "checkbox", class: "size-4 accent-coral", checked: false, disabled: !p.poem || null });
  const keepChar = h("input", { id: "rc-char", type: "checkbox", class: "size-4 accent-coral", checked: Boolean(p.character) || null, disabled: !p.character || null });
  const recreate = h("button", { type: "button", class: "btn px-3 py-1.5 text-sm", onclick: async () => {
    const kept = [keepPoem.checked && "the same words", keepChar.checked && `the same character (${p.character?.name})`].filter(Boolean);
    if (!confirm(`Make a new copy of this video with the same settings${kept.length ? `, keeping ${kept.join(" and ")}` : ""}? Everything else is made again${p.input.videoMode === "veo" ? ` (including ${p.input.sceneCount} paid Veo clips)` : ""}. This video stays as it is.`)) return;
    recreate.disabled = true;
    mount(status, "Creating the copy…");
    try {
      const copy = await post(`/api/projects/${enc(p.id)}/recreate`, { keepPoem: keepPoem.checked, keepCharacter: keepChar.checked, provider: $("#prov")?.value });
      await loadChannels();
      location.hash = `#/project/${enc(copy.id)}`;
    } catch (err) { mount(status, errorBox(err)); recreate.disabled = false; }
  } }, "🔁 Re-create video");
  return h("details", { class: "mt-3 rounded-xl border border-orange-100 p-4" },
    h("summary", { class: "cursor-pointer font-semibold", text: "📦 Re-create, move or delete this video" }),
    h("div", { class: "mt-3 space-y-2 rounded-xl bg-violet-50 p-3 text-sm" },
      h("p", { class: "font-semibold", text: "Re-create: make this video again as a new copy (same settings and channel)" }),
      h("div", { class: "flex flex-wrap items-center gap-x-5 gap-y-2" },
        h("label", { for: "rc-poem", class: "flex items-center gap-2" }, keepPoem, "Keep the same words (poem)"),
        h("label", { for: "rc-char", class: "flex items-center gap-2" }, keepChar, "Keep the same character"),
        recreate)),
    h("div", { class: "mt-3 flex flex-wrap items-center gap-2" },
      target ? [h("label", { for: "mv-channel", class: "text-sm", text: "Move to channel" }), target, move, h("span", { class: "mx-2 h-6 w-px bg-orange-100", "aria-hidden": "true" })] : null,
      del),
    status);
}

/**
 * Change the video's settings after it was started (length, scenes, language, song/story, style, shape…).
 * Shows what will have to be made again before saving; nothing is generated until you ask.
 */
function settingsPanel(p) {
  const id = p.id, inp = p.input;
  const f = (key, label, control, hint) => h("div", {}, h("label", { for: `ps-${key}`, class: "label", text: label }), control, hint ? h("p", { id: `ps-${key}-hint`, class: "mt-1 text-xs text-stone-500", text: hint }) : null);
  const sel = (key, options, value) => h("select", { id: `ps-${key}`, class: "field" }, options.map(([v, t]) => h("option", { value: v, text: t, selected: v === value })));
  const els = {
    topic: h("textarea", { id: "ps-topic", class: "field", rows: 2, lang: inp.language, value: inp.topic }),
    language: sel("language", [["en", "English"], ["am", "አማርኛ (Amharic)"]], inp.language),
    audioMode: sel("audioMode", AUDIO_MODES, inp.audioMode),
    singer: sel("singer", SINGERS, inp.singer ?? "auto"),
    voice: sel("voice", VOICE_OPTIONS, inp.voice ?? ""),
    length: h("input", { id: "ps-length", type: "number", min: 0.5, max: 10, step: 0.5, class: "field", value: inp.lengthSeconds ? inp.lengthSeconds / 60 : inp.audioMode === "song" ? inp.songSeconds / 60 : "", placeholder: "not set" }),
    sceneCount: h("input", { id: "ps-sceneCount", type: "number", min: 2, max: 40, class: "field", value: inp.sceneCount, placeholder: "Auto" }),
    ageRange: h("input", { id: "ps-ageRange", class: "field", value: inp.ageRange }),
    aspectRatio: sel("aspectRatio", [["16:9", "Landscape 16:9 (YouTube)"], ["9:16", "Portrait 9:16 (Shorts)"]], inp.aspectRatio),
    characterHint: h("input", { id: "ps-characterHint", class: "field", value: inp.characterHint ?? "", placeholder: "a curious little goat named Abeba" }),
    style: h("input", { id: "ps-style", class: "field", value: inp.style }),
  };
  const keepBox = h("input", { id: "ps-keep", type: "checkbox", checked: true, class: "mt-1 size-4 accent-coral" });
  const keepRow = h("div", { class: "flex items-start gap-2 rounded-xl bg-violet-50 p-3 text-sm", hidden: true }, keepBox,
    h("label", { for: "ps-keep" }, h("span", { class: "font-semibold", text: "Keep the poem and the pictures" }),
      h("span", { class: "block text-stone-600", text: "Only the length changes: the same words are sung or read over the new length, and the clips are re-timed. Untick to write a new poem that fits the new length." })));
  const impact = h("p", { role: "status", "aria-live": "polite", class: "rounded-xl bg-sky-50 p-3 text-sm text-sky-900" });
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });

  const read = () => {
    const minutes = Number(els.length.value);
    return {
      topic: els.topic.value.trim(), language: els.language.value, audioMode: els.audioMode.value, ageRange: els.ageRange.value.trim() || "3-6",
      aspectRatio: els.aspectRatio.value, characterHint: els.characterHint.value.trim() || null, style: els.style.value.trim(),
      singer: els.singer.value, voice: els.voice.value || null,
      lengthSeconds: minutes ? lengthSecondsOf(minutes) : null,
      sceneCount: els.sceneCount.value ? Number(els.sceneCount.value) : null,
    };
  };
  const changedKeys = () => {
    const next = read();
    const autoCount = next.sceneCount ?? autoScenes(next.lengthSeconds ?? inp.songSeconds, next.audioMode);
    const cur = { ...inp, characterHint: inp.characterHint ?? null, lengthSeconds: inp.lengthSeconds ?? null, singer: inp.singer ?? "auto", voice: inp.voice ?? null };
    return Object.keys(next).filter((k) => k === "sceneCount" ? autoCount !== inp.sceneCount
      : k === "lengthSeconds" ? next.lengthSeconds !== (cur.lengthSeconds ?? (inp.audioMode === "song" ? inp.songSeconds : null))
      : String(next[k] ?? "") !== String(cur[k] ?? ""));
  };
  const LABEL = { poem: "Poem", character: "Character", audio: "Audio", clips: "Clips" };
  const lengthOnly = () => {
    const keys = changedKeys();
    return keys.length > 0 && keys.every((k) => k === "lengthSeconds") && Boolean(p.poem) && p.completed.includes("scenes");
  };
  const redoFrom = (keys) => {
    if (!keys.length) return null;
    const has = (list) => keys.some((k) => list.includes(k));
    if (has(["topic", "language", "audioMode", "lengthSeconds", "sceneCount", "ageRange"])) return lengthOnly() && keepBox.checked ? "audio" : "poem";
    if (has(["style", "characterHint"])) return "character";
    if (has(["singer", "voice"])) return "audio";
    return "clips";
  };
  const update = () => {
    const keys = changedKeys();
    const next = read();
    const auto = autoScenes(next.lengthSeconds ?? inp.songSeconds, next.audioMode);
    keepRow.hidden = !lengthOnly();
    const from = redoFrom(keys);
    const scenesNote = keys.includes("lengthSeconds") && !keys.includes("sceneCount") && from === "poem" ? ` It will have ${auto} scenes for this length.` : "";
    const later = from ? config.steps.slice(config.steps.indexOf(from)).filter((s) => p.completed.includes(s)) : [];
    impact.textContent = !from ? "Nothing changed yet."
      : from === "poem" ? `A new poem is written for these settings, then the scenes, audio and clips are made again.${scenesNote} The character (${p.character?.name ?? "not made yet"}) is kept.${later.length ? "" : " Nothing has been made yet, so nothing is lost."}`
      : from === "character" ? "The poem and scenes are kept. The character is drawn again in the new style, then the audio and clips are made again."
      : from === "audio" ? "The poem and pictures are kept. The song or voice is made again with the new length or voice, and the clips are re-timed."
      : "The poem, character and audio are kept. The pictures and clips are made again in the new shape.";
  };
  for (const el of Object.values(els)) el.addEventListener("input", update);
  keepBox.addEventListener("change", update);

  const save = h("button", { type: "button", class: "btn", onclick: async () => {
    const keys = changedKeys();
    if (!keys.length) { status.textContent = "Nothing changed."; return; }
    const from = redoFrom(keys);
    const lost = config.steps.slice(config.steps.indexOf(from)).filter((s) => p.completed.includes(s));
    if (lost.length && !confirm(`Save the new settings? ${lost.map((s) => STEP_LABELS[s]).join(", ")} will need to be made again.`)) return;
    save.disabled = true;
    mount(status, "Saving…");
    try {
      const all = read();
      const patch = Object.fromEntries(keys.map((k) => [k, all[k]]));
      // New length without keeping the poem: pick the scene count from the length (unless one was typed).
      if (keys.includes("lengthSeconds") && !keys.includes("sceneCount") && !(lengthOnly() && keepBox.checked)) patch.sceneCount = null;
      const r = await post(`/api/projects/${enc(id)}/settings`, { settings: patch, keepPoem: lengthOnly() && keepBox.checked }, "PUT");
      currentStep = r.redoFrom ?? currentStep;
      location.hash = stepUrl(id, currentStep);
      await renderProject(id);
      const s = $("#run-status");
      if (s && r.redoFrom) s.textContent = `Settings saved ✓ Next: ${LABEL[r.redoFrom] ?? STEP_LABELS[r.redoFrom]}.`;
    } catch (err) { mount(status, errorBox(err)); save.disabled = false; }
  } }, "💾 Save settings");

  const panel = h("details", { id: "settings-panel", class: "mt-4 rounded-xl border border-orange-100 p-4" },
    h("summary", { class: "cursor-pointer font-semibold", text: "⚙️ Video settings: length, scenes, language, style…" }),
    h("div", { class: "mt-4 space-y-4" },
      f("topic", "What is the video about?", els.topic),
      h("div", { class: "grid gap-4 sm:grid-cols-3" },
        f("language", "Language", els.language), f("audioMode", "Audio", els.audioMode), f("aspectRatio", "Shape", els.aspectRatio)),
      h("div", { class: "grid gap-4 sm:grid-cols-2" }, f("singer", "Singer / voice", els.singer, SINGER_HINT), f("voice", "Exact voice (rhyme over music, narration)", els.voice)),
      h("div", { class: "grid gap-4 sm:grid-cols-3" },
        f("length", "Video length (minutes)", els.length, "½ to 10 minutes."),
        f("sceneCount", "Scenes", els.sceneCount, "Empty = picked from the length."),
        f("ageRange", "Age range", els.ageRange)),
      h("div", { class: "grid gap-4 sm:grid-cols-2" }, f("characterHint", "Main character", els.characterHint), f("style", "Art style", els.style)),
      keepRow, impact,
      h("div", { class: "flex flex-wrap items-center gap-3" }, save, status)));
  update();
  return panel;
}

/** Lyrics / captions on the video: off by default; switching only rebuilds the final video (quick, no AI). */
function subtitlesToggle(p, act) {
  const on = Boolean(p.input.subtitles);
  const what = p.input.audioMode === "song" ? "lyrics" : "captions";
  const ready = p.completed.includes("clips");
  return h("div", { class: "mt-5 flex flex-wrap items-center gap-3 rounded-xl bg-violet-50 p-3 text-sm" },
    h("span", { class: "flex-1", text: on ? `The ${what} are shown on the video.` : `No ${what} on the video.` }),
    h("button", { type: "button", class: "btn-soft", "aria-pressed": String(on), onclick: act(async () => {
      await post(`/api/projects/${enc(p.id)}/subtitles`, { on: !on }, "PUT");
    }, ready) }, on ? `Remove ${what}` : `Add ${what}`, ready ? " (rebuilds the video)" : ""));
}

const MAX_UPLOAD_MB = 8;
const MAX_AUDIO_MB = 30;

/** Use your own recording (you or your child singing or reading the poem) as the audio. */
function audioUpload(p, act, done) {
  const file = h("input", { id: "au-file", type: "file", accept: "audio/*,.m4a,.mp3,.wav,.ogg,.webm", class: "field text-sm", "aria-describedby": "au-help" });
  const preview = h("audio", { controls: true, hidden: true, class: "w-full" });
  const msg = h("p", { role: "status", "aria-live": "polite", class: "text-sm" });
  let url = null;
  file.addEventListener("change", () => {
    if (url) URL.revokeObjectURL(url);
    const f = file.files[0];
    url = f ? URL.createObjectURL(f) : null;
    preview.hidden = !url;
    if (url) preview.src = url;
    msg.textContent = f && f.size > MAX_AUDIO_MB * 1024 * 1024 ? `That file is too big (max ${MAX_AUDIO_MB} MB).` : "";
  });
  const useIt = h("button", { type: "button", class: "btn", onclick: act(async () => {
    const f = file.files[0];
    if (!f) { msg.textContent = "Choose a recording first."; file.focus(); return SKIP; }
    if (f.size > MAX_AUDIO_MB * 1024 * 1024) { msg.textContent = `That file is too big (max ${MAX_AUDIO_MB} MB).`; return SKIP; }
    if (done && !confirm("Use this recording instead of the current audio? The clips and final video are made again (pictures are kept).")) return SKIP;
    msg.textContent = "Uploading…";
    await post(`/api/projects/${enc(p.id)}/audio/upload`, { audio: await fileToDataUrl(f) }, "PUT");
  }, false) }, "📤 Use this recording");
  return h("details", { class: "mt-5 rounded-xl border border-dashed border-orange-200 p-4", open: !done || null },
    h("summary", { class: "cursor-pointer font-semibold", text: "🎙️ Use your own recording instead" }),
    h("p", { id: "au-help", class: "mt-2 text-sm text-stone-600", text: `Sing or read the poem yourself (or with your child), record it on your phone, and upload it here: MP3, M4A, WAV, OGG or WebM, up to ${MAX_AUDIO_MB} MB. Sing the stanzas in order; each scene gets a share of the time that matches its words. The pictures are kept, the clips are timed to your recording.` }),
    h("div", { class: "mt-3 space-y-2" }, h("label", { for: "au-file", class: "label", text: "Recording" }), file, preview),
    h("div", { class: "mt-3 flex flex-wrap items-center gap-3" }, useIt, msg));
}

/** Upload your own picture as the main character (instead of, or replacing, the designed one). */
function characterUpload(p, act, done) {
  const id = p.id, lang = p.input.language;
  const file = h("input", { id: "up-file", type: "file", accept: "image/png,image/jpeg,image/webp", class: "field text-sm", "aria-describedby": "up-help" });
  const name = h("input", { id: "up-name", class: "field", lang, value: p.character?.name ?? "", placeholder: "e.g. Selam" });
  const desc = h("textarea", { id: "up-desc", class: "field text-sm", rows: 3, placeholder: "Leave empty and the AI looks at the picture and describes it." });
  const preview = h("img", { alt: "Preview of the chosen picture", hidden: true, class: "max-h-56 self-start rounded-xl border border-orange-100" });
  const msg = h("p", { role: "status", "aria-live": "polite", class: "text-sm" });
  let url = null;
  file.addEventListener("change", () => {
    if (url) URL.revokeObjectURL(url);
    const f = file.files[0];
    url = f ? URL.createObjectURL(f) : null;
    preview.hidden = !url;
    if (url) preview.src = url;
    msg.textContent = f && f.size > MAX_UPLOAD_MB * 1024 * 1024 ? `That picture is too big (max ${MAX_UPLOAD_MB} MB).` : "";
  });
  const readDataUrl = (f) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(f);
  });
  const useIt = h("button", { type: "button", class: "btn", onclick: act(async () => {
    const f = file.files[0];
    if (!f) { msg.textContent = "Choose a picture first."; file.focus(); return SKIP; }
    if (f.size > MAX_UPLOAD_MB * 1024 * 1024) { msg.textContent = `That picture is too big (max ${MAX_UPLOAD_MB} MB).`; return SKIP; }
    const later = ["clips", "final"].filter((s) => p.completed.includes(s));
    if (later.length && !confirm("Use this picture? The clips and final video will need to be made again (the song is kept).")) return SKIP;
    msg.textContent = desc.value.trim() ? "Uploading…" : "Uploading… the AI is looking at the picture.";
    await post(`/api/projects/${enc(id)}/character/upload`, { image: await readDataUrl(f), name: name.value.trim(), description: desc.value.trim(), provider: $("#prov")?.value }, "PUT");
  }, false) }, "📤 Use this picture");

  return h("details", { class: "mt-5 rounded-xl border border-dashed border-orange-200 p-4", open: !done || null },
    h("summary", { class: "cursor-pointer font-semibold", text: done ? "📤 Upload your own character picture instead" : "📤 …or upload your own character picture" }),
    h("p", { id: "up-help", class: "mt-2 text-sm text-stone-600", text: `PNG, JPEG or WebP, up to ${MAX_UPLOAD_MB} MB. A clear, full-body picture of one character on a plain background works best. Every scene is drawn in the project's art style, using this picture as the reference.` }),
    h("div", { class: "mt-3 flex flex-col gap-4 sm:flex-row" },
      h("div", { class: "flex-1 space-y-2" },
        h("label", { for: "up-file", class: "label", text: "Picture" }), file,
        h("label", { for: "up-name", class: "label", text: "Name (optional)" }), name,
        h("label", { for: "up-desc", class: "label", text: "Look, in English (optional)" }), desc),
      preview),
    h("div", { class: "mt-3 flex flex-wrap items-center gap-3" }, useIt, msg));
}

/** Switch visuals without redoing the poem, song or pictures. */
function visualsSwitch(p, act) {
  const veoCount = p.media.scenes.filter((m) => m.video).length;
  const sceneCount = p.scenes?.scenes.length ?? p.input.sceneCount;
  const toVeo = p.input.videoMode !== "veo" || veoCount < sceneCount;
  return h("div", { class: "mt-2 flex w-full flex-wrap items-center gap-3 rounded-xl bg-violet-50 p-3 text-sm" },
    h("span", { class: "flex-1", text: toVeo
      ? (p.input.videoMode === "veo"
          ? `${veoCount} of ${sceneCount} scenes have Veo video. Retry to make the missing ones. The poem, song and pictures are kept.`
          : `These are animated pictures. Turn each of the ${sceneCount} scenes into a moving AI video clip with Veo? The poem, song and pictures are kept.`)
      : "These clips use Veo. Switch back to animated pictures (fast, free)?" }),
    h("button", { type: "button", class: toVeo ? "btn" : "btn-soft", onclick: act(async () => {
      if (toVeo && !confirm(`This makes ${sceneCount} Veo video requests, which is slow (a few minutes) and uses paid credits. Continue?`)) return SKIP;
      await post(`/api/projects/${enc(p.id)}/visuals`, { videoMode: toVeo ? "veo" : "still" });
    }) }, toVeo ? (p.input.videoMode === "veo" ? "🎞️ Retry Veo" : "🎞️ Animate with Veo") : "🖼️ Use animated pictures"));
}

/** Prompts sent to the AI for this step only. */
function generationLog(id, step) {
  const log = h("details", { class: "card", id: "gen-log" }, h("summary", { class: "cursor-pointer font-bold", text: `Prompts sent to the AI for ${STEP_LABELS[step]}` }), h("div", { class: "mt-3 space-y-3", text: "Loading…" }));
  log.addEventListener("toggle", async () => {
    if (!log.open) return;
    const list = (await api(`/api/projects/${enc(id)}/generations`)).filter((g) => g.step === step);
    mount($("div", log), ...(list.length ? list.map((g) => h("div", { class: "rounded-xl bg-stone-50 p-3" },
      h("p", { class: "mb-1 text-xs text-stone-500" },
        g.sceneIndex != null ? `scene ${g.sceneIndex + 1} · ` : "",
        h("a", { href: `#/prompts/${enc(g.promptKey)}`, class: "underline", text: `${g.promptKey} v${g.promptVersion}` }),
        g.model ? ` · ${g.model}` : "",
        ` · ${new Date(g.createdAt).toLocaleString()}`),
      h("pre", { class: "whitespace-pre-wrap font-mono text-xs", text: g.prompt }))) : [h("p", { class: "text-sm text-stone-500", text: step === "final" ? "This step doesn't use AI." : "Nothing yet." })]));
  });
  return log;
}

// ---------- Prompts ----------
async function showPrompts(key) {
  setNav("prompts");
  const prompts = await api(withChannel("/api/prompts"));
  const selected = prompts.find((p) => p.key === key) ?? prompts[0];
  mount($("#sidebar"), 
    h("div", { class: "side-heading", text: "Prompt library" }),
    h("p", { class: "mb-3 px-2 text-xs text-stone-500", text: `Prompts used by ${currentKit()?.name ?? "this channel"}. Each one is shared by every channel until you edit it here; then this channel gets its own copy. Changes apply to the next run.` }),
    h("ul", { class: "space-y-1" }, prompts.map((p) => h("li", {},
      h("a", { href: `#/prompts/${enc(p.key)}`, "aria-current": p.key === selected?.key ? "page" : null, class: "side-item" },
        h("span", { class: "block text-sm font-semibold", text: p.title }),
        h("span", { class: "mt-1 flex items-center gap-1.5 text-xs text-stone-500" }, h("span", { text: `v${p.version}` }),
          p.scope === "channel" ? h("span", { class: "rounded-full bg-violet-100 px-1.5 text-violet-800", text: "this channel" })
            : p.isDefault ? null : h("span", { class: "rounded-full bg-amber-100 px-1.5 text-amber-800", text: "shared, edited" })))))),
  );
  if (selected) renderPromptEditor(selected);
}

function renderPromptEditor(p) {
  const textarea = h("textarea", { id: "tpl", class: "field min-h-72 font-mono text-sm leading-relaxed", spellcheck: "false", "aria-describedby": "tpl-help", value: p.template });
  const note = h("input", { id: "note", class: "field", placeholder: "What did you change? (optional)" });
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const preview = h("pre", { class: "min-h-24 whitespace-pre-wrap rounded-xl bg-stone-50 p-3 font-mono text-xs", text: "Click Preview to see the final prompt with sample values." });
  const lang = h("select", { class: "field w-auto", "aria-label": "Preview language" }, h("option", { value: "en", text: "English" }), h("option", { value: "am", text: "Amharic" }));
  const mode = h("select", { class: "field w-auto", "aria-label": "Preview audio mode" }, h("option", { value: "song", text: "song" }), h("option", { value: "music_voice", text: "rhyme over music" }), h("option", { value: "narration", text: "narration" }));
  const dirty = () => textarea.value !== p.template;
  const saveBtn = h("button", { type: "button", class: "btn", disabled: true }, "💾 Save new version");
  textarea.addEventListener("input", () => { saveBtn.disabled = !dirty(); status.textContent = dirty() ? "Unsaved changes" : ""; });

  const insert = (text) => {
    const { selectionStart: a, selectionEnd: b, value } = textarea;
    textarea.value = value.slice(0, a) + text + value.slice(b);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = a + text.length;
    textarea.dispatchEvent(new Event("input"));
  };

  const run = (fn) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    mount(status, "Working…");
    try { await fn(); } catch (err) { mount(status, errorBox(err)); } finally { btn.disabled = false; }
  };

  saveBtn.addEventListener("click", run(async () => {
    const saved = await post(withChannel(`/api/prompts/${enc(p.key)}`), { template: textarea.value, note: note.value || undefined, expectedVersion: p.version }, "PUT");
    await showPrompts(saved.key);
    $("#prompt-status").textContent = `Saved as v${saved.version} ✓`;
  }));

  const history = h("details", { class: "card" }, h("summary", { class: "cursor-pointer font-bold", text: "Version history" }), h("ol", { class: "mt-3 space-y-2" }));
  history.addEventListener("toggle", async () => {
    if (!history.open) return;
    const versions = await api(withChannel(`/api/prompts/${enc(p.key)}/history`));
    mount($("ol", history), ...versions.map((v) => h("li", { class: "rounded-xl bg-stone-50 p-3" },
      h("div", { class: "mb-1 flex flex-wrap items-center gap-2 text-sm" },
        h("strong", { text: `v${v.version}` }), h("span", { class: "text-stone-500", text: new Date(v.createdAt).toLocaleString() }),
        v.note ? h("span", { class: "chip", text: v.note }) : null,
        v.version === p.version ? h("span", { class: "chip bg-emerald-100 text-emerald-800", text: "current" })
          : h("button", { type: "button", class: "btn-soft ml-auto px-3 py-1 text-sm", onclick: run(async () => { await post(withChannel(`/api/prompts/${enc(p.key)}/restore`), { version: v.version }); await showPrompts(p.key); }) }, "Restore")),
      h("pre", { class: "max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-stone-600", text: v.template }))));
  });

  mount($("#main"), 
    h("section", { class: "card space-y-4" },
      h("div", { class: "flex flex-wrap items-center gap-3" },
        h("h2", { class: "text-xl font-bold", text: p.title }),
        h("span", { class: "chip", text: `v${p.version}` }),
        p.scope === "channel" ? h("span", { class: "chip bg-violet-100 text-violet-800", text: `only ${currentKit()?.name ?? "this channel"}` })
          : h("span", { class: "chip", text: p.isDefault ? "shared · built-in default" : "shared by all channels" })),
      h("p", { class: "text-stone-600", text: p.description }),
      h("p", { class: "rounded-xl bg-sky-50 p-3 text-sm text-sky-900", text: p.scope === "channel"
        ? `${currentKit()?.name ?? "This channel"} has its own copy of this prompt; other channels use the shared one.`
        : `All channels share this prompt. Saving an edit here makes a copy just for ${currentKit()?.name ?? "this channel"}; the other channels are not changed.` }),
      h("label", { for: "tpl", class: "label", text: "Template" }),
      textarea,
      h("div", { id: "tpl-help", class: "space-y-2 text-sm" },
        h("p", { class: "text-stone-500" }, "Click to insert. Variables: ", h("code", { text: "{{name}}" }), " · Conditions: ", h("code", { text: "{{#if am}}…{{else}}…{{/if}}" })),
        h("div", { class: "flex flex-wrap gap-1.5" }, p.vars.map((v) => h("button", { type: "button", class: "rounded-full bg-sky-100 px-2.5 py-0.5 font-mono text-xs text-sky-900 hover:bg-sky-200", onclick: () => insert(`{{${v}}}`), text: `{{${v}}}` }))),
        h("div", { class: "flex flex-wrap gap-1.5" }, p.flags.map((f) => h("button", { type: "button", class: "rounded-full bg-amber-100 px-2.5 py-0.5 font-mono text-xs text-amber-900 hover:bg-amber-200", onclick: () => insert(`{{#if ${f}}}…{{/if}}`), text: `#if ${f}` })))),
      h("label", { for: "note", class: "label", text: "Change note" }), note,
      h("div", { class: "flex flex-wrap items-center gap-2" },
        saveBtn,
        h("button", { type: "button", class: "btn-soft", onclick: () => { textarea.value = p.template; textarea.dispatchEvent(new Event("input")); } }, "Discard changes"),
        p.scope !== "channel" ? null : h("button", { type: "button", class: "btn-soft", onclick: run(async () => {
          if (!confirm("Stop using this channel's own copy and go back to the shared prompt? This channel's copy and its history are deleted.")) return;
          await post(withChannel(`/api/prompts/${enc(p.key)}/reset`));
          await showPrompts(p.key);
        }) }, "↺ Use the shared prompt")),
      h("div", { id: "prompt-status" }), status,
    ),
    h("section", { class: "card space-y-3" },
      h("div", { class: "flex flex-wrap items-center gap-2" },
        h("h3", { class: "mr-auto text-lg font-bold", text: "Preview" }), lang, mode,
        h("button", { type: "button", class: "btn-soft", onclick: run(async () => {
          const r = await post(withChannel(`/api/prompts/${enc(p.key)}/preview`), { template: textarea.value, input: { language: lang.value, audioMode: mode.value } });
          preview.textContent = r.text;
          status.textContent = "";
        }) }, "👁 Preview")),
      preview),
    history,
  );
}

// ---------- Models ----------
const CAPABILITY_LABEL = { text: "Text", image: "Image", tts: "Speech", music: "Music", video: "Video" };
const CAPABILITY_ICON = { text: "✍️", image: "🎨", tts: "🗣️", music: "🎵", video: "🎞️" };

async function showModels() {
  setNav("models");
  mount($("#sidebar"), 
    h("div", { class: "side-heading", text: "Models" }),
    h("p", { class: "px-2 text-xs leading-relaxed text-stone-500" },
      "Choose which AI model does each job. Choices are saved in Postgres and used from the next run; a running video keeps the models it started with."),
  );
  mount($("#main"), h("p", { class: "text-stone-500", text: "Loading models…" }));
  const [settings, available] = await Promise.all([api("/api/models/settings"), api(`/api/models/available?provider=gemini`)]);
  const rows = settings.map((s) => modelRow(s, available.byCapability[s.capability] ?? []));
  mount($("#main"), ...[
    h("div", { class: "mb-6" },
      h("h2", { class: "text-2xl font-bold", text: "Models" }),
      h("p", { class: "text-stone-600", text: "One model per task. The list shows the models your Gemini key can use." })),
    available.warning ? h("div", { class: "mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm" },
      h("p", { text: available.warning + " — you can still type a model id." }), billingHelp(available.warning)) : null,
    h("div", { class: "card divide-y divide-orange-100 p-0" }, rows),
  ].filter(Boolean));
}

function modelRow(s, options) {
  const CUSTOM = "__custom__";
  const known = options.some((o) => o.id === s.model);
  const select = h("select", { class: "field", "aria-label": `Model for ${s.title}` },
    !known ? h("option", { value: s.model, text: `${s.model} (current)` }) : null,
    options.map((o) => h("option", { value: o.id, selected: o.id === s.model, text: o.id === s.defaultModel ? `${o.id} — default` : o.id })),
    h("option", { value: CUSTOM, text: "Other model id…" }));
  select.value = s.model;
  const custom = h("input", { class: "field mt-2 font-mono text-sm", placeholder: "e.g. gemini-3.1-pro-preview", hidden: true, "aria-label": `Custom model id for ${s.title}` });
  const status = h("span", { role: "status", "aria-live": "polite", class: "text-sm" });
  const reset = h("button", { type: "button", class: "btn-soft px-3 py-1 text-sm", hidden: s.isDefault }, "↺ Default");

  const save = async (model) => {
    status.className = "text-sm text-stone-500";
    status.textContent = "Saving…";
    try {
      const saved = await post(`/api/models/settings/${enc(s.task)}`, { model }, "PUT");
      Object.assign(s, saved);
      reset.hidden = saved.isDefault;
      status.className = "text-sm text-emerald-700";
      status.textContent = "Saved ✓";
    } catch (err) {
      status.className = "text-sm text-red-700";
      status.textContent = err.message;
      select.value = s.model;
    }
  };
  select.addEventListener("change", () => {
    custom.hidden = select.value !== CUSTOM;
    if (select.value === CUSTOM) return custom.focus();
    save(select.value);
  });
  custom.addEventListener("keydown", (e) => { if (e.key === "Enter" && custom.value.trim()) save(custom.value.trim()); });
  custom.addEventListener("change", () => custom.value.trim() && save(custom.value.trim()));
  reset.addEventListener("click", async () => {
    try {
      const saved = await post(`/api/models/settings/${enc(s.task)}/reset`);
      Object.assign(s, saved);
      if (![...select.options].some((o) => o.value === saved.model)) select.prepend(h("option", { value: saved.model, text: saved.model }));
      select.value = saved.model;
      custom.hidden = true;
      reset.hidden = true;
      status.className = "text-sm text-emerald-700";
      status.textContent = "Back to default ✓";
    } catch (err) { status.textContent = err.message; }
  });

  return h("div", { class: "grid gap-3 p-5 sm:grid-cols-[1fr_minmax(0,22rem)] sm:items-start" },
    h("div", {},
      h("div", { class: "flex items-center gap-2" },
        h("span", { "aria-hidden": "true", text: CAPABILITY_ICON[s.capability] }),
        h("h3", { class: "font-semibold", text: s.title }),
        h("span", { class: "chip px-2 py-0 text-xs", text: CAPABILITY_LABEL[s.capability] })),
      h("p", { class: "mt-1 text-sm text-stone-500", text: s.description })),
    h("div", {}, select, custom, h("div", { class: "mt-2 flex items-center gap-2" }, reset, status)));
}

// ---------- Channel art (YouTube brand kit) ----------
const CHANNEL_ASSETS = {
  details: { icon: "📝", title: "Channel name & description", help: "Name, handle, description and keywords for YouTube Studio → Customisation → Basic info.", make: "✨ Write the channel text", redo: "↻ Write new text" },
  logo: { icon: "🟠", title: "Profile picture (logo)", size: "800 × 800 PNG", help: "Shown as a circle next to your name and on every video. Upload in YouTube Studio → Customisation → Branding → Picture.", make: "✨ Make the logo", redo: "↻ Make a new logo" },
  banner: { icon: "🖼️", title: "Banner", size: "2560 × 1440 JPG", help: "The image across the top of your channel. Phones and computers only show the middle strip (dashed box). Upload in Customisation → Branding → Banner image.", make: "✨ Make the banner", redo: "↻ Make a new banner" },
  watermark: { icon: "💧", title: "Video watermark", size: "150 × 150 PNG", help: "A small subscribe button shown in the corner of your videos. Made from the logo (no AI). Upload in Customisation → Branding → Video watermark.", make: "✨ Make from the logo", redo: "↻ Make again from the logo" },
  thumbnail: { icon: "🎞️", title: "Video thumbnail", size: "1280 × 720 JPG", help: "A sample thumbnail in your channel's look, with a title of your choice. Upload on a video's details page in YouTube Studio → Content.", make: "✨ Make a thumbnail", redo: "↻ Make a new thumbnail" },
};
/** "Make everything": text first (it names the channel), the logo next (the other pictures copy it), the watermark last (made from the logo). */
const MAKE_ALL_ORDER = [["details"], ["logo"], ["banner", "thumbnail"], ["watermark"]];
const DETAILS_LIMITS = { name: 100, description: 1000, keywords: 500 };

let channelState = null; // { kit, pending: Set, errors: {}, title }
let channelPoll = null;
let autoMakeAll = null;

const channelMediaUrl = (id, m) => `/channel-media/${enc(id)}/${enc(m.file)}?v=${enc(m.version)}`;
const kitName = (kit) => kit.details?.name || kit.input.name || "New channel";
/** `lang` attribute for the kit's text; none for bilingual text (Amharic + English mixed). */
const kitLang = (kit) => (kit.input.language === "both" ? null : kit.input.language);
const hasAsset = (kit, a) => (a === "details" ? Boolean(kit.details) : Boolean(kit.media[a]));

function fileToDataUrl(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Couldn't read the file"));
    r.readAsDataURL(f);
  });
}

/** File input with preview and size check. `dataUrl()` resolves undefined when nothing is chosen. */
function photoPicker(id, currentSrc) {
  const input = h("input", { id, type: "file", accept: "image/png,image/jpeg,image/webp", class: "field text-sm", "aria-describedby": `${id}-help` });
  const preview = h("img", { alt: "Sample photo", hidden: !currentSrc, src: currentSrc ?? null, class: "max-h-40 self-start rounded-xl border border-orange-100" });
  const msg = h("p", { role: "status", "aria-live": "polite", class: "text-sm text-red-700" });
  let url = null;
  const tooBig = (f) => f && f.size > MAX_UPLOAD_MB * 1024 * 1024;
  input.addEventListener("change", () => {
    if (url) URL.revokeObjectURL(url);
    const f = input.files[0];
    url = f ? URL.createObjectURL(f) : null;
    preview.hidden = !url && !currentSrc;
    preview.src = url ?? currentSrc ?? "";
    msg.textContent = tooBig(f) ? `That picture is too big (max ${MAX_UPLOAD_MB} MB).` : "";
  });
  return {
    input, preview, msg,
    async dataUrl() {
      const f = input.files[0];
      if (!f) return undefined;
      if (tooBig(f)) throw new Error(`That picture is too big (max ${MAX_UPLOAD_MB} MB).`);
      return fileToDataUrl(f);
    },
  };
}

async function renderChannelList(currentId) {
  const list = await api("/api/channels");
  mount($("#sidebar"),
    h("a", { href: "#/channel/new", class: "btn mb-4 w-full justify-center" }, "＋ New channel"),
    h("div", { class: "side-heading flex items-center justify-between" }, h("span", { text: "Your channels" }), h("span", { class: "font-normal normal-case tracking-normal", text: String(list.length) })),
    h("ul", { class: "space-y-1" }, list.length
      ? list.map((k) => h("li", {},
          h("a", { href: `#/channel/${enc(k.id)}`, class: "side-item flex items-center gap-3", "aria-current": k.id === currentId ? "page" : null },
            k.logo ? h("img", { src: channelMediaUrl(k.id, k.logo), alt: "", class: "size-9 shrink-0 rounded-full border border-orange-100 object-cover" })
              : h("span", { "aria-hidden": "true", class: "grid size-9 shrink-0 place-items-center rounded-full bg-stone-100", text: "📺" }),
            h("span", { class: "leading-snug" }, h("span", { class: "line-clamp-2 block text-sm font-semibold", text: k.name }),
              h("span", { class: "block text-xs text-stone-500", text: `${k.videos} video${k.videos === 1 ? "" : "s"}` })))))
      : h("li", { class: "px-2 py-3 text-sm text-stone-500", text: "No channels yet." })),
  );
}

/** Shared fields for the new-kit form and the brief editor. */
function channelBriefFields(prefix, input = {}) {
  const field = (id, label, control, hint) => h("div", {}, h("label", { for: id, class: "label", text: label }), control, hint ? h("p", { class: "mt-1 text-xs text-stone-500", text: hint }) : null);
  const els = {
    brief: h("textarea", { id: `${prefix}-brief`, rows: 3, class: "field", value: input.brief ?? "", placeholder: "e.g. Fun Amharic songs that teach toddlers colours, numbers and good habits, with a cheerful little goat as the mascot" }),
    name: h("input", { id: `${prefix}-name`, class: "field", maxlength: 100, value: input.name ?? "", placeholder: "Leave empty and the AI suggests one" }),
    language: h("select", { id: `${prefix}-language`, class: "field" }, [["en", "English"], ["am", "አማርኛ (Amharic)"], ["both", "Both — አማርኛ + English"]].map(([v, t]) => h("option", { value: v, text: t, selected: v === (input.language ?? "en") }))),
    ageRange: h("input", { id: `${prefix}-age`, class: "field", value: input.ageRange ?? "3-6" }),
    style: h("input", { id: `${prefix}-style`, class: "field", value: input.style ?? "colorful 3D animated kids' movie style, Pixar-like, soft cinematic lighting, expressive characters" }),
    mainCharacter: h("input", { id: `${prefix}-character`, class: "field", maxlength: 300, value: input.mainCharacter ?? "", placeholder: "e.g. Milcah (ሚልካ), a cheerful, curious little Ethiopian girl" }),
    videoMinutes: h("input", { id: `${prefix}-minutes`, type: "number", min: 0.5, max: 10, step: 0.5, class: "field", value: input.videoMinutes ?? "", placeholder: "e.g. 5" }),
    audioMode: h("select", { id: `${prefix}-audio`, class: "field" }, [["", "Not set (song; rhyme over music for Amharic)"], ...AUDIO_MODES].map(([v, t]) => h("option", { value: v, text: t, selected: v === (input.audioMode ?? "") }))),
    singer: h("select", { id: `${prefix}-singer`, class: "field" }, SINGERS.map(([v, t]) => h("option", { value: v, text: t, selected: v === (input.singer ?? "auto") }))),
    voice: h("select", { id: `${prefix}-voice`, class: "field" }, VOICE_OPTIONS.map(([v, t]) => h("option", { value: v, text: t, selected: v === (input.voice ?? "") }))),
  };
  const view = [
    field(`${prefix}-brief`, "What is the channel about? (prompt)", els.brief, "Optional if you add a sample photo. Describe the topic, the mascot, colours or mood you want."),
    h("div", { class: "grid gap-4 sm:grid-cols-3" },
      field(`${prefix}-name`, "Channel name (optional)", els.name),
      field(`${prefix}-language`, "Language", els.language, "For the name, description and keywords."),
      field(`${prefix}-age`, "Age range", els.ageRange)),
    field(`${prefix}-style`, "Art style", els.style),
    h("div", { class: "grid gap-4 sm:grid-cols-[2fr_1fr]" },
      field(`${prefix}-character`, "Main character (in every video, optional)", els.mainCharacter),
      field(`${prefix}-minutes`, "Usual video length (minutes, optional)", els.videoMinutes)),
    h("div", { class: "grid gap-4 sm:grid-cols-3" },
      field(`${prefix}-audio`, "Usual audio", els.audioMode, "Rhyme over music: planned songs use it too."),
      field(`${prefix}-singer`, "Singer / voice", els.singer),
      field(`${prefix}-voice`, "Exact voice (optional)", els.voice)),
    h("p", { class: "text-xs text-stone-500", text: "The language, age range, style, main character and length fill the New video and Ideas & schedule forms for this channel." }),
  ];
  const read = () => ({
    brief: els.brief.value.trim(), name: els.name.value.trim(), language: els.language.value, ageRange: els.ageRange.value.trim() || "3-6", style: els.style.value.trim() || undefined,
    mainCharacter: els.mainCharacter.value.trim(), videoMinutes: els.videoMinutes.value ? Math.round(Number(els.videoMinutes.value) * 2) / 2 : null,
    audioMode: els.audioMode.value || null, singer: els.singer.value === "auto" ? null : els.singer.value, voice: els.voice.value || null,
  });
  return { view, read, els };
}

async function showNewChannel() {
  setNav("channel");
  channelState = null;
  await renderChannelList();
  const photo = photoPicker("c-photo");
  const brief = channelBriefFields("c");
  const provider = h("select", { id: "c-provider", class: "field" }, [["gemini", "Gemini (real AI)"], ["mock", "Mock (offline test)"]].map(([v, t]) => h("option", { value: v, text: t, selected: v === (config.hasApiKey ? "gemini" : "mock") })));
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const submit = h("button", { type: "submit", class: "btn" }, "Create channel ✨");
  const form = h("form", { class: "card space-y-5", novalidate: true },
    h("div", {},
      h("h2", { class: "text-xl font-bold", text: "New channel" }),
      h("p", { class: "mt-1 text-sm text-stone-600", text: "Each channel has its own videos, monthly plans, prompt edits and branding. Here you also make everything YouTube asks for when you set up a channel: profile picture, banner, video watermark, a thumbnail, plus the channel name, handle, description and keywords. Start from a sample photo (e.g. your mascot or character), a prompt, or both." })),
    config.hasApiKey ? null : h("div", { class: "rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm" }, "No GEMINI_API_KEY found. Add it to .env and restart, or choose the Mock provider to try things offline."),
    h("div", { class: "flex flex-col gap-4 rounded-xl border border-dashed border-orange-200 p-4 sm:flex-row" },
      h("div", { class: "flex-1 space-y-2" },
        h("label", { for: "c-photo", class: "label", text: "Sample photo (optional)" }), photo.input,
        h("p", { id: "c-photo-help", class: "text-xs text-stone-500", text: `PNG, JPEG or WebP, up to ${MAX_UPLOAD_MB} MB. The logo, banner and thumbnail keep its main subject.` }),
        photo.msg),
      photo.preview),
    brief.view,
    h("div", {}, h("label", { for: "c-provider", class: "label", text: "Provider" }), provider,
      h("p", { class: "mt-1 text-xs text-stone-500", text: "Prompts are on the Prompts page (YouTube channel …) and models on the Models page (Channel …)." })),
    h("div", { class: "flex flex-wrap items-center gap-3" }, submit, status));
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    submit.disabled = true;
    mount(status, "Creating…");
    try {
      const image = await photo.dataUrl();
      const input = brief.read();
      if (!image && !input.brief && !input.name) throw new Error("Add a sample photo or describe the channel.");
      const kit = await post("/api/channels", { input, provider: provider.value, image });
      autoMakeAll = kit.id;
      await loadChannels();
      selectChannel(kit.id);
      location.hash = `#/channel/${enc(kit.id)}`;
    } catch (err) {
      mount(status, errorBox(err));
      submit.disabled = false;
    }
  });
  mount($("#main"), form);
  brief.els.brief.focus();
}

async function showChannel(id) {
  setNav("channel");
  const kit = await api(`/api/channels/${enc(id)}`);
  if (id !== channel) selectChannel(id);
  channelState = { kit, pending: new Set(), errors: {}, title: channelState?.kit.id === id ? channelState.title : "" };
  await renderChannelList(id);
  const slot = (name) => h("div", { id: `chan-${name}` });
  mount($("#main"), slot("header"), slot("brief"), slot("details"),
    h("div", { class: "grid gap-4 lg:grid-cols-2" }, slot("logo"), slot("watermark")), slot("banner"), slot("thumbnail"), channelDangerCard(kit));
  refreshChannel(["header", "brief", ...Object.keys(CHANNEL_ASSETS)]);
  $("#main").focus();
  if (autoMakeAll === id) {
    autoMakeAll = null;
    makeAllChannel();
  } else if (kit.busy.length) pollChannel(id);
}

/** Re-render only the given parts, so typing in one card isn't lost when another finishes. */
function refreshChannel(parts) {
  const render = { header: channelHeader, brief: channelBriefCard, details: channelDetailsCard };
  for (const p of new Set(["header", ...parts])) {
    const el = $(`#chan-${p}`);
    if (el) mount(el, (render[p] ?? channelPictureCard)(p));
  }
}

const isMaking = (a) => channelState.pending.has(a) || channelState.kit.busy.includes(a);

/** Make one asset. Returns true on success. Re-making the logo also refreshes the watermark made from it. */
async function makeChannelAsset(a, { chain = true } = {}) {
  const st = channelState;
  const id = st.kit.id;
  st.pending.add(a);
  delete st.errors[a];
  refreshChannel([a]);
  let ok = false;
  try {
    const kit = await post(`/api/channels/${enc(id)}/assets/${enc(a)}/generate`, { provider: $("#chan-prov")?.value, title: a === "thumbnail" ? st.title : undefined });
    st.kit = { ...kit, busy: kit.busy.filter((b) => b !== a) };
    ok = true;
  } catch (err) {
    st.errors[a] = err;
  } finally {
    st.pending.delete(a);
    if (channelState === st) {
      refreshChannel([a, ...(a === "logo" ? ["watermark"] : [])]);
      if (a === "logo" || a === "details") loadChannels().then(() => renderChannelList(id)).catch(() => {});
    }
  }
  if (ok && chain && a === "logo" && st.kit.media.watermark) await makeChannelAsset("watermark");
  return ok;
}

async function makeAllChannel() {
  const st = channelState;
  const all = Object.keys(CHANNEL_ASSETS);
  const missing = all.filter((a) => !hasAsset(st.kit, a));
  if (!missing.length && !confirm("Everything is made already. Make it all again? This uses AI credits (1 text + 3 pictures).")) return;
  const todo = new Set(missing.length ? missing : all);
  for (const group of MAKE_ALL_ORDER) {
    const results = await Promise.all(group.filter((a) => todo.has(a) && !isMaking(a)).map((a) => makeChannelAsset(a, { chain: false })));
    if (channelState !== st || results.includes(false)) return; // stop at the first failure; finished assets are kept
  }
}

/** Another tab (or a reload) started something: check back until it's done. */
function pollChannel(id) {
  clearTimeout(channelPoll);
  channelPoll = setTimeout(async () => {
    const st = channelState;
    if (st?.kit.id !== id) return;
    const kit = await api(`/api/channels/${enc(id)}`).catch(() => null);
    if (!kit || channelState !== st) return;
    const finished = st.kit.busy.filter((a) => !kit.busy.includes(a));
    st.kit = kit;
    if (finished.length) refreshChannel(finished);
    if (kit.busy.length) pollChannel(id);
  }, 3000);
}

function channelHeader() {
  const { kit } = channelState;
  const busy = Object.keys(CHANNEL_ASSETS).some(isMaking);
  const made = Object.keys(CHANNEL_ASSETS).filter((a) => hasAsset(kit, a)).length;
  const total = Object.keys(CHANNEL_ASSETS).length;
  return h("section", { class: "card" },
    h("div", { class: "flex flex-wrap items-center gap-3" },
      kit.media.logo ? h("img", { src: channelMediaUrl(kit.id, kit.media.logo), alt: "", class: "size-12 rounded-full border border-orange-100" }) : null,
      h("h2", { class: "text-2xl font-bold", lang: kitLang(kit), text: kitName(kit) }),
      kit.details?.handle ? h("span", { class: "chip", text: `@${kit.details.handle}` }) : null,
      h("span", { class: `chip ${made === total ? "bg-emerald-100 text-emerald-800" : ""}`, text: `${made}/${total} made` })),
    kit.input.brief ? h("p", { class: "mt-2 line-clamp-2 text-sm text-stone-600", text: kit.input.brief }) : null,
    h("div", { class: "mt-4 flex flex-wrap items-center gap-2" },
      h("button", { type: "button", class: "btn", disabled: busy, onclick: () => makeAllChannel() }, busy ? "⏳ Making…" : made < total ? "✨ Make everything missing" : "↻ Make everything again"),
      h("select", { id: "chan-prov", class: "field w-auto py-1.5 text-sm", "aria-label": "Provider" }, config.providers.map((n) => h("option", { value: n, text: n, selected: n === kit.provider }))),
      h("span", { class: "ml-auto text-sm" }, extLink("https://studio.youtube.com", "Open YouTube Studio"))));
}

function channelBriefCard() {
  const { kit } = channelState;
  const id = kit.id;
  const photo = photoPicker("cb-photo", kit.media.photo ? channelMediaUrl(id, kit.media.photo) : null);
  const brief = channelBriefFields("cb", kit.input);
  const remove = kit.media.photo ? h("input", { id: "cb-remove", type: "checkbox", class: "size-4 accent-coral" }) : null;
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const save = h("button", { type: "button", class: "btn", onclick: async () => {
    save.disabled = true;
    mount(status, "Saving…");
    try {
      const image = await photo.dataUrl();
      const kit = await post(`/api/channels/${enc(id)}`, { input: brief.read(), image, removePhoto: Boolean(remove?.checked) && !image, provider: $("#chan-prov")?.value }, "PUT");
      channelState.kit = kit;
      loadChannels().catch(() => {});
      refreshChannel(["brief"]);
      $("#chan-brief details").open = true;
      $("#cb-status").textContent = "Saved ✓ Remake the pieces you want to change.";
    } catch (err) {
      mount(status, errorBox(err));
      save.disabled = false;
    }
  } }, "💾 Save brief");
  return h("details", { class: "card" },
    h("summary", { class: "cursor-pointer font-bold", text: "✏️ The brief: sample photo, prompt, name and style" }),
    h("div", { class: "mt-4 space-y-4" },
      h("div", { class: "flex flex-col gap-4 sm:flex-row" },
        h("div", { class: "flex-1 space-y-2" },
          h("label", { for: "cb-photo", class: "label", text: kit.media.photo ? "Replace the sample photo" : "Add a sample photo" }), photo.input,
          h("p", { id: "cb-photo-help", class: "text-xs text-stone-500", text: `PNG, JPEG or WebP, up to ${MAX_UPLOAD_MB} MB.` }),
          remove ? h("div", { class: "flex items-center gap-2 text-sm" }, remove, h("label", { for: "cb-remove", text: "Remove the sample photo" })) : null,
          photo.msg),
        photo.preview),
      brief.view,
      h("p", { class: "text-xs text-stone-500", text: "Saving keeps what's already made; remake the pieces you want to change." }),
      h("div", { class: "flex flex-wrap items-center gap-3" }, save, h("span", { id: "cb-status", class: "text-sm text-emerald-700" })),
      status));
}

/** Delete the channel; its videos are deleted too, or moved to another channel. */
function channelDangerCard(kit) {
  const name = kitName(kit);
  const others = channels.filter((k) => k.id !== kit.id);
  const info = channels.find((k) => k.id === kit.id);
  const videos = info?.videos ?? 0;
  const choice = h("select", { id: "del-videos", class: "field w-auto" },
    h("option", { value: "", text: videos ? `Delete its ${videos} video${videos === 1 ? "" : "s"} too` : "It has no videos" }),
    others.map((k) => h("option", { value: k.id, text: `Move its videos and plans to ${k.name}` })));
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const del = h("button", { type: "button", class: "btn-danger", onclick: async () => {
    const moveTo = choice.value;
    const what = moveTo ? `Its videos and monthly plans move to "${others.find((k) => k.id === moveTo)?.name}".` : `Its ${videos} video${videos === 1 ? "" : "s"} (with all their files) and its monthly plans are deleted too.`;
    if (!confirm(`Delete the channel "${name}"? Its logo, banner, channel text and its own prompt edits are deleted. ${what} This can't be undone.`)) return;
    if (prompt(`Type the channel name to confirm:\n${name}`)?.trim() !== name) { status.textContent = "Not deleted: the name didn't match."; return; }
    del.disabled = true;
    mount(status, "Deleting…");
    try {
      await post(`/api/channels/${enc(kit.id)}`, { moveVideosTo: moveTo || undefined }, "DELETE");
      await loadChannels();
      if (moveTo) selectChannel(moveTo);
      location.hash = channels.length ? "#/channel" : "#/channel/new";
      if (location.hash === "#/channel") route();
    } catch (err) { mount(status, errorBox(err)); del.disabled = false; }
  } }, "🗑 Delete this channel");
  return h("details", { class: "card border-red-100" },
    h("summary", { class: "cursor-pointer font-bold text-red-700", text: "🗑 Delete this channel" }),
    h("div", { class: "mt-3 space-y-3 text-sm" },
      h("p", { class: "text-stone-600", text: "This deletes the channel in this app only (logo, banner, channel text, monthly plans and this channel's prompt edits). Your channel on YouTube is not touched; delete that in YouTube Studio → Settings → Channel → Advanced settings." }),
      h("div", { class: "flex flex-wrap items-center gap-2" }, h("label", { for: "del-videos", class: "sr-only", text: "What happens to its videos" }), choice, del),
      status));
}

function copyButton(label, getText) {
  const btn = h("button", { type: "button", class: "btn-soft px-3 py-1 text-xs", "aria-label": `Copy ${label}` }, "📋 Copy");
  btn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(getText());
      btn.textContent = "Copied ✓";
    } catch {
      btn.textContent = "Couldn't copy";
    }
    setTimeout(() => (btn.textContent = "📋 Copy"), 1500);
  });
  return btn;
}

/** Card frame shared by every asset: title, size, help, body, buttons, error and the prompt that was sent. */
function channelCard(a, body, buttons) {
  const info = CHANNEL_ASSETS[a];
  const { kit, errors } = channelState;
  const prompt = kit.prompts?.[a];
  const promptKey = a === "details" ? "channel_details" : `channel_${a}`;
  return h("section", { class: "card", "aria-labelledby": `chan-${a}-title` },
    h("div", { class: "mb-1 flex flex-wrap items-center gap-2" },
      h("span", { "aria-hidden": "true", class: "text-xl", text: info.icon }),
      h("h3", { id: `chan-${a}-title`, class: "text-lg font-bold", text: info.title }),
      info.size ? h("span", { class: "chip px-2 py-0 text-xs", text: info.size }) : null,
      isMaking(a) ? h("span", { class: "chip animate-pulse bg-orange-100 px-2 py-0 text-xs text-orange-800", text: "⏳ making…" }) : hasAsset(kit, a) ? h("span", { class: "chip bg-emerald-100 px-2 py-0 text-xs text-emerald-800", text: "✓ done" }) : null),
    h("p", { class: "mb-4 text-sm text-stone-600", text: info.help }),
    body,
    h("div", { class: "mt-4 flex flex-wrap items-center gap-2" }, buttons),
    errors[a] ? h("div", { class: "mt-3" }, errorBox(errors[a])) : null,
    prompt ? h("details", { class: "mt-3 text-sm" },
      h("summary", { class: "cursor-pointer text-stone-500", text: "Prompt sent to the AI" }),
      h("pre", { class: "mt-2 whitespace-pre-wrap rounded-xl bg-stone-50 p-3 font-mono text-xs", text: prompt }),
      h("a", { href: `#/prompts/${enc(promptKey)}`, class: "text-xs underline", text: "Edit this prompt" })) : null);
}

function makeButton(a, extraConfirm) {
  const { kit } = channelState;
  const done = hasAsset(kit, a);
  const info = CHANNEL_ASSETS[a];
  const needsLogo = a === "watermark" && !kit.media.logo;
  return h("button", { type: "button", class: done ? "btn-soft" : "btn", disabled: isMaking(a) || needsLogo, title: needsLogo ? "Make the logo first" : null, onclick: () => {
    if (done && a !== "watermark" && !confirm(`Make a new ${info.title.toLowerCase()}? The current one is replaced.${extraConfirm ?? ""}`)) return;
    makeChannelAsset(a);
  } }, isMaking(a) ? "⏳ Making…" : done ? info.redo : info.make);
}

function channelDetailsCard() {
  const { kit } = channelState;
  const d = kit.details;
  const lang = kitLang(kit);
  if (!d) {
    const body = h("p", { class: "text-stone-500", text: isMaking("details") ? "Writing…" : kit.input.name ? `The AI writes a description and keywords for “${kit.input.name}”.` : "The AI suggests a name, handle, description and keywords." });
    return channelCard("details", body, [makeButton("details")]);
  }
  const counter = (el, max, measure = (v) => v.length) => {
    const out = h("span", { class: "text-xs text-stone-500", "aria-live": "polite" });
    const update = () => {
      const n = measure(el.value);
      out.textContent = `${n} / ${max}`;
      out.className = `text-xs ${n > max ? "font-semibold text-red-700" : "text-stone-500"}`;
    };
    el.addEventListener("input", update);
    update();
    return out;
  };
  const keywordsOf = (v) => v.split(/[,\n]/).map((k) => k.trim()).filter(Boolean);
  const name = h("input", { id: "cd-name", class: "field", lang, value: d.name });
  const handle = h("input", { id: "cd-handle", class: "field font-mono", value: d.handle, "aria-describedby": "cd-handle-help" });
  const tagline = h("input", { id: "cd-tagline", class: "field", lang, value: d.tagline ?? "" });
  const description = h("textarea", { id: "cd-description", class: "field leading-relaxed", lang, rows: 7, value: d.description });
  const keywords = h("textarea", { id: "cd-keywords", class: "field text-sm", lang, rows: 3, value: d.keywords.join(", "), "aria-describedby": "cd-keywords-help" });
  const read = () => ({ name: name.value.trim(), handle: handle.value.trim(), tagline: tagline.value.trim() || undefined, description: description.value.trim(), keywords: keywordsOf(keywords.value) });
  const row = (id, label, control, copyText, count, help) => h("div", {},
    h("div", { class: "mb-1 flex items-center gap-2" }, h("label", { for: id, class: "label mb-0 flex-1", text: label }), count, copyButton(label, copyText)),
    control, help ? h("p", { id: `${id}-help`, class: "mt-1 text-xs text-stone-500", text: help }) : null);
  const status = h("span", { role: "status", "aria-live": "polite", class: "text-sm" });
  const save = h("button", { type: "button", class: "btn", onclick: async () => {
    const next = read();
    if (JSON.stringify(next) === JSON.stringify({ ...d, tagline: d.tagline || undefined })) { status.textContent = "Nothing changed."; return; }
    save.disabled = true;
    status.textContent = "Saving…";
    try {
      channelState.kit = await post(`/api/channels/${enc(kit.id)}/details`, { details: next }, "PUT");
      loadChannels().catch(() => {});
      refreshChannel(["details"]);
      renderChannelList(kit.id).catch(() => {});
      $("#cd-status").textContent = "Saved ✓ Names on the pictures change when you remake them.";
    } catch (err) {
      status.replaceChildren(errorBox(err));
      save.disabled = false;
    }
  } }, "💾 Save changes");
  status.id = "cd-status";
  const body = h("div", { class: "space-y-4" },
    h("div", { class: "grid gap-4 sm:grid-cols-2" },
      row("cd-name", "Channel name", name, () => name.value, counter(name, DETAILS_LIMITS.name)),
      row("cd-handle", "Handle", handle, () => `@${handle.value.replace(/^@/, "")}`, null, "3–30 letters, numbers, dots, dashes or underscores. Check it's free when you claim it in YouTube.")),
    row("cd-tagline", "Tagline", tagline, () => tagline.value),
    row("cd-description", "Description", description, () => description.value, counter(description, DETAILS_LIMITS.description)),
    row("cd-keywords", "Keywords", keywords, () => keywordsOf(keywords.value).join(", "), counter(keywords, DETAILS_LIMITS.keywords, (v) => keywordsOf(v).join(",").length),
      "Separate with commas. YouTube Studio → Settings → Channel → Keywords."));
  return channelCard("details", body, [save, makeButton("details", " Your edits to the text are lost."), status]);
}

function channelPictureCard(a) {
  const { kit } = channelState;
  const m = kit.media[a];
  const url = m ? channelMediaUrl(kit.id, m) : null;
  const ext = m ? m.file.slice(m.file.lastIndexOf(".")) : "";
  const empty = (cls) => h("div", { class: `grid place-items-center rounded-xl bg-stone-100 text-sm text-stone-500 ${cls}`, text: isMaking(a) ? "making…" : a === "watermark" && !kit.media.logo ? "make the logo first" : "not made yet" });
  let body;
  if (a === "logo") {
    body = url
      ? h("div", { class: "flex flex-wrap items-end gap-4" },
          h("img", { src: url, alt: `Logo for ${kitName(kit)}`, class: "w-40 rounded-xl border border-orange-100" }),
          h("figure", { class: "text-center text-xs text-stone-500" }, h("img", { src: url, alt: "", class: "size-20 rounded-full border border-orange-100" }), h("figcaption", { class: "mt-1", text: "on your channel" })),
          h("figure", { class: "text-center text-xs text-stone-500" }, h("img", { src: url, alt: "", class: "size-9 rounded-full" }), h("figcaption", { class: "mt-1", text: "next to videos" })))
      : empty("aspect-square w-40");
  } else if (a === "watermark") {
    body = url
      ? h("div", { class: "flex items-end gap-4" },
          h("img", { src: url, alt: "Video watermark", class: "size-[150px] rounded-lg border border-orange-100" }),
          h("figure", { class: "relative aspect-video w-48 overflow-hidden rounded-lg bg-gradient-to-br from-sky-300 to-emerald-300" },
            h("img", { src: url, alt: "", class: "absolute right-2 bottom-2 size-8 rounded opacity-80" }),
            h("figcaption", { class: "absolute top-1 left-2 text-[10px] text-white", text: "on a video" })))
      : empty("size-[150px]");
  } else if (a === "banner") {
    const overlay = h("div", { "aria-hidden": "true", class: "pointer-events-none absolute inset-0 m-auto h-[29.38%] w-[60.39%] rounded border-2 border-dashed border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" });
    const toggle = h("input", { id: "cbn-safe", type: "checkbox", checked: true, class: "size-4 accent-coral" });
    toggle.addEventListener("change", () => (overlay.hidden = !toggle.checked));
    body = url
      ? h("div", {},
          h("div", { class: "relative overflow-hidden rounded-xl border border-orange-100" }, h("img", { src: url, alt: `Banner for ${kitName(kit)}`, class: "block w-full" }), overlay),
          h("div", { class: "mt-2 flex items-center gap-2 text-sm" }, toggle, h("label", { for: "cbn-safe", text: "Show the safe area (1546 × 423, visible on every device)" })))
      : empty("aspect-video w-full");
  } else {
    body = url ? h("img", { src: url, alt: `Sample thumbnail${channelState.title ? `: ${channelState.title}` : ""}`, class: "w-full rounded-xl border border-orange-100" }) : empty("aspect-video w-full");
    const title = h("input", { id: "ct-title", class: "field", lang: kitLang(kit), maxlength: 100, value: channelState.title, placeholder: "e.g. Wash Your Hands! (leave empty for no text)" });
    title.addEventListener("input", () => (channelState.title = title.value));
    body = h("div", { class: "space-y-3" }, h("div", {}, h("label", { for: "ct-title", class: "label", text: "Title on the thumbnail (optional)" }), title), body);
  }
  const buttons = [makeButton(a)];
  if (m) buttons.push(h("a", { class: "btn-soft", href: url, download: `${kit.id}-${a}${ext}` }, "⬇ Download"), h("span", { class: "text-xs text-stone-500", text: `${Math.max(1, Math.round(m.bytes / 1024))} kB` }));
  return channelCard(a, body, buttons);
}

// ---------- Ideas & schedule (monthly plan) ----------
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const LANG_LABEL = { am: "አማርኛ", en: "English" };

function nextMonth() {
  const d = new Date();
  const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}`;
}
const monthLabel = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const dayLabelOf = (date) => new Date(`${date}T00:00:00Z`).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

async function renderPlanList(currentMonth) {
  const list = await api(planApi());
  mount($("#sidebar"),
    h("a", { href: "#/plan", class: "btn mb-4 w-full justify-center" }, "＋ Plan a month"),
    h("div", { class: "side-heading", text: "Your monthly plans" }),
    h("ul", { class: "space-y-1" }, list.length
      ? list.map((p) => h("li", {},
          h("a", { href: `#/plan/${enc(p.month)}`, class: "side-item", "aria-current": p.month === currentMonth ? "page" : null },
            h("span", { class: "block text-sm font-semibold", text: monthLabel(p.month) }),
            p.theme ? h("span", { class: "mt-0.5 line-clamp-1 block text-xs text-stone-500", text: p.theme }) : null,
            h("span", { class: "mt-1 block text-xs text-stone-500", text: `${p.made} of ${p.videos} videos made` }))))
      : h("li", { class: "px-2 py-3 text-sm text-stone-500", text: "No plans yet." })));
}

async function showPlan(month) {
  setNav("plan");
  await renderPlanList(month);
  const plan = month ? await api(planApi(`/${enc(month)}`)).catch((err) => (/No plan/.test(err.message) ? null : Promise.reject(err))) : null;
  const kit = await api(`/api/channels/${enc(channel)}`);
  const fromChannel = { channelName: kit.details?.name ?? kit.input.name, about: kit.input.brief, language: kit.input.language, ageRange: kit.input.ageRange, mainCharacter: kit.input.mainCharacter, videoMinutes: kit.input.videoMinutes };
  const defaults = plan?.input ?? (await api(planApi("/last-input"))) ?? fromChannel;
  if (!plan) {
    mount($("#main"), await planSettingsForm(month ?? nextMonth(), defaults, false));
    $("#pl-about").focus();
    return;
  }
  const projects = await api(withChannel("/api/projects")).catch(() => []);
  const byId = new Map(projects.map((p) => [p.id, p]));
  const settings = h("details", { class: "card" }, h("summary", { class: "cursor-pointer font-bold", text: "⚙️ Settings and plan again" }), await planSettingsForm(plan.month, plan.input, true));
  const made = plan.ideas.filter((i) => i.projectId).length;
  mount($("#main"),
    h("section", { class: "card" },
      h("div", { class: "flex flex-wrap items-center gap-3" },
        h("h2", { class: "text-2xl font-bold", text: monthLabel(plan.month) }),
        h("span", { class: "chip", text: `${plan.ideas.length} videos` }),
        h("span", { class: `chip ${made === plan.ideas.length ? "bg-emerald-100 text-emerald-800" : ""}`, text: `${made} made` })),
      plan.theme ? h("p", { class: "mt-1 text-stone-600" }, "Theme: ", h("strong", { text: plan.theme })) : null,
      h("p", { class: "mt-1 text-sm text-stone-500", text: `${plan.input.channelName ?? "Your channel"} · ${plan.input.videoMinutes ? `${plan.input.videoMinutes}-minute videos · ` : ""}times in ${plan.input.timezone} · ${plan.input.postDays.map((d) => WEEKDAY_NAMES[d]).join(", ")}` }),
      h("div", { class: "mt-4 flex flex-wrap items-center gap-2" },
        h("a", { class: "btn", href: planApi(`/${enc(plan.month)}/calendar.ics`), download: `posting-plan-${plan.month}.ics` }, "📅 Add to my calendar (.ics)"),
        h("select", { id: "pl-prov", class: "field w-auto py-1.5 text-sm", "aria-label": "Provider for new videos" }, config.providers.map((n) => h("option", { value: n, text: n, selected: n === (config.hasApiKey ? "gemini" : "mock") }))),
        h("span", { class: "text-xs text-stone-500", text: "The calendar reminds you 2 days before each post to make the video." }))),
    settings,
    h("ol", { class: "space-y-3", "aria-label": "Videos this month" }, plan.ideas.map((idea, i) => h("li", {}, ideaCard(plan, idea, i, byId.get(idea.projectId))))));
}

/** One planned video: when to post it, what to give the app, and what to paste into YouTube. */
function ideaCard(plan, idea, i, project) {
  const lang = idea.language;
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const field = (label, value, copy = true) => h("div", {},
    h("div", { class: "flex items-center gap-2" }, h("p", { class: "label mb-0 flex-1", text: label }), copy ? copyButton(label, () => value) : null),
    h("p", { class: "whitespace-pre-line text-sm", lang, text: value }));
  const make = idea.projectId && project
    ? h("a", { class: "btn-soft", href: `#/project/${enc(project.id)}` }, "▶ Open the video ", badge(project.running ? "running" : project.status))
    : h("button", { type: "button", class: "btn", onclick: async (e) => {
        if (!confirm(`Make "${idea.title}" now? The app creates the video project and writes the poem; it stops after each step so you can check it (manual mode).`)) return;
        e.currentTarget.disabled = true;
        mount(status, "Creating the video…");
        try {
          const r = await post(planApi(`/${enc(plan.month)}/ideas/${i + 1}/make`), { provider: $("#pl-prov")?.value });
          location.hash = `#/project/${enc(r.projectId)}`;
        } catch (err) { mount(status, errorBox(err)); e.target.disabled = false; }
      } }, "🎬 Make this video");
  const again = idea.projectId && project ? null : (() => {
    const hint = h("input", { id: `ia-${i}`, class: "field text-sm", lang, maxlength: 500, placeholder: "Optional: what would you like instead? e.g. about animals · keep the topic, funnier title" });
    const go = h("button", { type: "button", class: "btn", onclick: async () => {
      go.disabled = true;
      mount(status, "Thinking of another idea…");
      try {
        await post(planApi(`/${enc(plan.month)}/ideas/${i + 1}/regenerate`), { provider: $("#pl-prov")?.value, hint: hint.value.trim() || undefined });
        await showPlan(plan.month);
        $(`#idea-${i + 1}`)?.scrollIntoView({ block: "center" });
      } catch (err) { mount(status, errorBox(err)); go.disabled = false; }
    } }, "✨ Make it");
    hint.addEventListener("keydown", (e) => { if (e.key === "Enter") go.click(); });
    const box = h("div", { class: "mt-3 flex w-full flex-wrap items-center gap-2 rounded-xl bg-violet-50 p-3", hidden: true },
      h("label", { for: `ia-${i}`, class: "sr-only", text: "What would you like instead?" }), h("div", { class: "min-w-64 flex-1" }, hint), go);
    const toggle = h("button", { type: "button", class: "btn-soft", "aria-expanded": "false", onclick: () => {
      box.hidden = !box.hidden;
      toggle.setAttribute("aria-expanded", String(!box.hidden));
      if (!box.hidden) hint.focus();
    } }, "↻ Another idea");
    return { toggle, box };
  })();
  const card = h("article", { id: `idea-${i + 1}`, class: "card mb-0" },
    h("div", { class: "flex flex-wrap items-center gap-2" },
      h("span", { class: "rounded-xl bg-coral/15 px-3 py-1 text-sm font-bold", text: `${dayLabelOf(idea.date)} · ${idea.time}` }),
      h("span", { class: "chip px-2 py-0 text-xs", text: LANG_LABEL[lang] }),
      h("span", { class: "chip px-2 py-0 text-xs", text: idea.audioMode === "song" ? "🎵 song" : "📖 narration" }),
      h("span", { class: "chip px-2 py-0 text-xs", text: plan.input.videoMinutes ? `⏱ ${plan.input.videoMinutes} min` : `${idea.sceneCount} scenes` })),
    h("h3", { class: "mt-2 text-lg font-bold", lang, text: `${i + 1}. ${idea.title}` }),
    h("p", { class: "text-sm text-stone-500", text: `Teaches: ${idea.lesson}` }),
    h("div", { class: "mt-3 grid gap-3 rounded-xl bg-orange-50/60 p-3 sm:grid-cols-2" },
      h("div", { class: "sm:col-span-2" }, field("Topic for the app (What is the video about?)", idea.topic)),
      field("Thumbnail title", idea.thumbnailTitle)),
    h("details", { class: "mt-3" },
      h("summary", { class: "cursor-pointer text-sm font-semibold", text: "YouTube description and tags" }),
      h("div", { class: "mt-2 space-y-3" }, field("Video description", idea.videoDescription), field("Tags", idea.tags.join(", ")))),
    h("div", { class: "mt-4 flex flex-wrap items-center gap-2" }, make,
      again?.toggle,
      h("button", { type: "button", class: "btn-soft", onclick: () => card.replaceWith(ideaEditor(plan, idea, i, card)) }, "✏️ Edit")),
    again?.box,
    status);
  return card;
}

function ideaEditor(plan, idea, i, view) {
  const lang = idea.language;
  const [y, m] = plan.month.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const id = (k) => `ie-${i}-${k}`;
  const els = {
    date: h("input", { id: id("date"), type: "date", class: "field", min: `${plan.month}-01`, max: `${plan.month}-${last}`, value: idea.date }),
    time: h("input", { id: id("time"), type: "time", class: "field", value: idea.time }),
    language: h("select", { id: id("language"), class: "field" }, Object.entries(LANG_LABEL).map(([v, t]) => h("option", { value: v, text: t, selected: v === idea.language }))),
    audioMode: h("select", { id: id("audioMode"), class: "field" }, [["song", "Song"], ["narration", "Narrated story"]].map(([v, t]) => h("option", { value: v, text: t, selected: v === idea.audioMode }))),
    sceneCount: h("input", { id: id("sceneCount"), type: "number", min: 2, max: 12, class: "field", value: idea.sceneCount }),
    title: h("input", { id: id("title"), class: "field", lang, value: idea.title }),
    topic: h("textarea", { id: id("topic"), class: "field", lang, rows: 2, value: idea.topic }),
    lesson: h("input", { id: id("lesson"), class: "field", value: idea.lesson }),
    thumbnailTitle: h("input", { id: id("thumbnailTitle"), class: "field", lang, value: idea.thumbnailTitle }),
    videoDescription: h("textarea", { id: id("videoDescription"), class: "field text-sm", lang, rows: 4, value: idea.videoDescription }),
    tags: h("textarea", { id: id("tags"), class: "field text-sm", lang, rows: 2, value: idea.tags.join(", ") }),
  };
  const f = (k, label) => h("div", {}, h("label", { for: id(k), class: "label", text: label }), els[k]);
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const save = h("button", { type: "button", class: "btn", onclick: async () => {
    save.disabled = true;
    mount(status, "Saving…");
    try {
      await post(planApi(`/${enc(plan.month)}/ideas/${i + 1}`), { idea: {
        date: els.date.value, time: els.time.value, language: els.language.value, audioMode: els.audioMode.value, sceneCount: Number(els.sceneCount.value),
        title: els.title.value.trim(), topic: els.topic.value.trim(), lesson: els.lesson.value.trim(), thumbnailTitle: els.thumbnailTitle.value.trim(),
        videoDescription: els.videoDescription.value.trim(), tags: els.tags.value.split(/[,\n]/).map((t) => t.trim()).filter(Boolean),
      } }, "PUT");
      await showPlan(plan.month);
    } catch (err) { mount(status, errorBox(err)); save.disabled = false; }
  } }, "💾 Save");
  const editor = h("article", { class: "card mb-0 space-y-3 border-2 border-violet-200" },
    h("h3", { class: "font-bold", text: `Edit video ${i + 1}` }),
    h("div", { class: "grid gap-3 sm:grid-cols-5" }, f("date", "Date"), f("time", "Time"), f("language", "Language"), f("audioMode", "Audio"), f("sceneCount", "Scenes")),
    f("title", "YouTube title"), f("topic", "Topic for the app"), h("div", { class: "grid gap-3 sm:grid-cols-2" }, f("lesson", "Lesson"), f("thumbnailTitle", "Thumbnail title")),
    f("videoDescription", "Video description"), f("tags", "Tags (comma separated)"),
    h("div", { class: "flex flex-wrap items-center gap-2" }, save, h("button", { type: "button", class: "btn-soft", onclick: () => editor.replaceWith(view) }, "Cancel")),
    status);
  return editor;
}

/** Settings for a month: channel, character, language, posting days/times, notes. Generates (or re-plans) the month. */
async function planSettingsForm(month, defaults, existing) {
  const d = defaults ?? {};
  const tz = d.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "Africa/Addis_Ababa";
  const field = (id, label, control, hint) => h("div", {}, h("label", { for: id, class: "label", text: label }), control, hint ? h("p", { class: "mt-1 text-xs text-stone-500", text: hint }) : null);
  const els = {
    month: h("input", { id: "pl-month", type: "month", class: "field", value: month, disabled: existing || null }),
    channelName: h("input", { id: "pl-name", class: "field", maxlength: 100, value: d.channelName ?? "", placeholder: "e.g. ሚልካ ዓለም | Milcah's World" }),
    about: h("textarea", { id: "pl-about", class: "field", rows: 3, value: d.about ?? "", placeholder: "Short animated songs and stories for little kids in Amharic and English, each teaching one good habit or simple lesson…" }),
    mainCharacter: h("input", { id: "pl-character", class: "field", maxlength: 300, value: d.mainCharacter ?? "", placeholder: "e.g. Milcah (ሚልካ), a cheerful, curious little Ethiopian girl" }),
    language: h("select", { id: "pl-language", class: "field" }, [["both", "Both — alternate አማርኛ and English"], ["am", "አማርኛ only"], ["en", "English only"]].map(([v, t]) => h("option", { value: v, text: t, selected: v === (d.language ?? "both") }))),
    ageRange: h("input", { id: "pl-age", class: "field", value: d.ageRange ?? "3-6" }),
    videoMinutes: h("input", { id: "pl-minutes", type: "number", min: 0.5, max: 10, step: 0.5, class: "field", value: d.videoMinutes ?? "", placeholder: "e.g. 5" }),
    weekdayTime: h("input", { id: "pl-wtime", type: "time", class: "field", value: d.weekdayTime ?? "16:00" }),
    weekendTime: h("input", { id: "pl-etime", type: "time", class: "field", value: d.weekendTime ?? "09:00" }),
    timezone: h("input", { id: "pl-tz", class: "field", value: tz }),
    notes: h("textarea", { id: "pl-notes", class: "field", rows: 2, value: d.notes ?? "", placeholder: "Anything special this month: a holiday, a series (e.g. the alphabet ሀ–ለ), back to school…" }),
  };
  const days = new Set(d.postDays ?? [2, 4, 6]);
  const dayBoxes = WEEKDAY_NAMES.map((name, i) => {
    const box = h("input", { id: `pl-day-${i}`, type: "checkbox", class: "size-4 accent-coral", checked: days.has(i) || null });
    return h("label", { for: `pl-day-${i}`, class: "flex items-center gap-1.5 rounded-full border border-orange-100 px-3 py-1 text-sm" }, box, name);
  });
  const read = () => ({
    channelName: els.channelName.value.trim(), about: els.about.value.trim(), mainCharacter: els.mainCharacter.value.trim(), language: els.language.value, ageRange: els.ageRange.value.trim() || "3-6",
    videoMinutes: els.videoMinutes.value ? Math.round(Number(els.videoMinutes.value) * 2) / 2 : undefined,
    postDays: WEEKDAY_NAMES.map((_, i) => i).filter((i) => $(`#pl-day-${i}`, form).checked),
    weekdayTime: els.weekdayTime.value || "16:00", weekendTime: els.weekendTime.value || "09:00", timezone: els.timezone.value.trim(), notes: els.notes.value.trim(),
  });

  // Live preview of the posting dates.
  const slotsView = h("p", { role: "status", "aria-live": "polite", class: "rounded-xl bg-sky-50 p-3 text-sm text-sky-900" });
  let timer = null;
  const updateSlots = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      try {
        const slots = await post(planApi(`/${enc(els.month.value)}/slots`), { input: read() });
        slotsView.textContent = slots.length
          ? `${slots.length} videos: ${slots.map((s) => `${dayLabelOf(s.date)} ${s.time}${els.language.value === "both" ? ` (${LANG_LABEL[s.language]})` : ""}`).join(" · ")}`
          : "No posting days left in this month with these settings.";
      } catch (err) { slotsView.textContent = err.details?.[0] ?? err.message; }
    }, 300);
  };

  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const provider = h("select", { id: "pl-provider", class: "field w-auto", "aria-label": "Provider" }, [["gemini", "Gemini (real AI)"], ["mock", "Mock (offline test)"]].map(([v, t]) => h("option", { value: v, text: t, selected: v === (config.hasApiKey ? "gemini" : "mock") })));
  const submit = h("button", { type: "submit", class: "btn" }, existing ? "↻ Plan this month again" : "✨ Generate the month's ideas");
  const form = h("form", { class: existing ? "mt-4 space-y-4" : "card space-y-4", novalidate: true },
    existing ? null : h("div", {},
      h("h2", { class: "text-xl font-bold", text: "Ideas & posting schedule" }),
      h("p", { class: "mt-1 text-sm text-stone-600", text: "Once a month, plan every video: when to post it and exactly what to give the app (topic, language, song or story, scenes), plus the YouTube title, thumbnail text, description and tags. Your earlier months are remembered so topics don't repeat." })),
    h("div", { class: "flex flex-wrap items-end gap-3" }, field("pl-month", "Month", els.month),
      h("p", { class: "pb-2 text-sm text-stone-500", text: `Plan for ${currentKit()?.name ?? "this channel"}` })),
    h("div", { class: "grid gap-4 sm:grid-cols-2" }, field("pl-name", "Channel name", els.channelName), field("pl-character", "Main character (in every video)", els.mainCharacter)),
    field("pl-about", "What is the channel about?", els.about),
    h("div", { class: "grid gap-4 sm:grid-cols-3" }, field("pl-language", "Language", els.language), field("pl-age", "Age range", els.ageRange),
      field("pl-minutes", "Video length (minutes)", els.videoMinutes, "Every video this month. Empty = 30-second songs.")),
    h("fieldset", {}, h("legend", { class: "label", text: "Posting days" }), h("div", { class: "flex flex-wrap gap-2" }, dayBoxes)),
    h("div", { class: "grid gap-4 sm:grid-cols-3" },
      field("pl-wtime", "Weekday posting time", els.weekdayTime),
      field("pl-etime", "Weekend posting time", els.weekendTime),
      field("pl-tz", "Time zone", els.timezone, "e.g. Africa/Addis_Ababa")),
    h("p", { class: "text-xs text-stone-500", text: "Kids' videos are mostly watched with a parent: after daycare or school on weekdays (about 4–7 PM) and in the morning at weekends (about 8–11 AM). Post an hour or two before that so YouTube has processed the video. 2–3 videos a week on the same days is easier to keep up than daily posts." }),
    slotsView,
    field("pl-notes", "Special requests this month (optional)", els.notes),
    h("div", { class: "flex flex-wrap items-center gap-3" }, submit, provider, status),
    existing ? h("p", { class: "text-xs text-stone-500", text: "Planning again replaces the ideas that haven't been made into videos yet; the ones you already made stay on their dates." }) : null);
  for (const el of [els.month, els.language, els.weekdayTime, els.weekendTime, els.timezone]) el.addEventListener("change", updateSlots);
  form.addEventListener("change", (e) => e.target.id?.startsWith("pl-day-") && updateSlots());
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (existing && !confirm("Plan this month again? Ideas not yet made into videos are replaced.")) return;
    submit.disabled = true;
    mount(status, "Planning the month… (this can take up to a minute)");
    try {
      const plan = await post(planApi(`/${enc(els.month.value)}/generate`), { input: read(), provider: provider.value });
      if (location.hash === `#/plan/${plan.month}`) await showPlan(plan.month);
      else location.hash = `#/plan/${enc(plan.month)}`;
    } catch (err) { mount(status, errorBox(err)); submit.disabled = false; }
  });
  updateSlots();
  return form;
}

// ---------- boot ----------
api("/api/config").then(async (c) => { config = c; await loadChannels(); route(); }, (err) => mount($("#main"), errorBox(err)));
