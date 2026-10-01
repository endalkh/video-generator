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

/** Google answers unpaid/overdue billing or empty Prepay credit with 402/403 errors; point to where it's fixed. */
function billingHelp(message) {
  if (!/dunning|billing|prepay|credit balance|payment required|\b402\b|RESOURCE_EXHAUSTED.*(spend|cap)/i.test(String(message ?? ""))) return null;
  return h("div", { class: "mt-2 rounded-lg bg-white/70 p-2 text-sm text-ink" },
    h("p", { text: "This looks like a Google billing problem (unpaid or overdue bill, declined card, or no Prepay credits). Nothing in the app needs changing; fix it here, then try again in a few minutes:" }),
    h("p", { class: "mt-1 flex flex-wrap gap-x-4 gap-y-1" },
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

// ---------- router ----------
async function route() {
  const [, section, arg, sub] = (location.hash || "#/new").split("/").map(decodeURIComponent);
  // Switching between a project's step pages keeps its live event stream open.
  if (!(section === "project" && arg && arg === currentProject)) {
    closeEvents();
    currentProject = null;
  }
  try {
    if (section === "prompts") await showPrompts(arg);
    else if (section === "models") await showModels();
    else if (section === "project" && arg) await showProject(arg, sub);
    else await showNewVideo();
  } catch (err) {
    mount($("#main"), errorBox(err), h("a", { href: "#/new", class: "btn mt-4", text: "← Back to videos" }));
    if (section !== "prompts" && section !== "models") await renderProjectList().catch(() => {});
  }
}
window.addEventListener("hashchange", route);

// ---------- Videos ----------
let projectFilter = "";

async function renderProjectList() {
  const list = await api("/api/projects");
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

async function showNewVideo() {
  setNav("videos");
  await renderProjectList();
  const field = (id, label, control, hint) => h("div", {}, h("label", { for: id, class: "label", text: label }), control, hint ? h("p", { class: "mt-1 text-xs text-stone-500", text: hint }) : null);
  const select = (id, name, options, value) => h("select", { id, name, class: "field" }, options.map(([v, t]) => h("option", { value: v, text: t, selected: v === value })));
  const status = h("p", { role: "status", class: "text-sm" });
  const form = h("form", { class: "card space-y-5", novalidate: true },
    h("h2", { class: "text-xl font-bold", text: "Make a new video" }),
    config.hasApiKey ? null : h("div", { class: "rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm" },
      "No GEMINI_API_KEY found. Add it to .env and restart, or choose the Mock provider to try things offline."),
    field("f-topic", "What is the video about?", h("textarea", { id: "f-topic", name: "topic", required: true, minlength: 3, rows: 2, class: "field", placeholder: "e.g. Washing hands before eating / እጅ መታጠብ" })),
    h("div", { class: "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" },
      field("f-language", "Language", select("f-language", "language", [["en", "English"], ["am", "አማርኛ (Amharic)"]])),
      field("f-audio", "Audio", select("f-audio", "audioMode", [["song", "Song — Lyria 3 Clip (30s)"], ["narration", "Narrated story (TTS)"]])),
      field("f-video", "Visuals", select("f-video", "videoMode", [["still", "Animated pictures — still images with camera motion (fast)"], ["veo", "Moving video clips — Veo (slow, uses more credits)"]])),
      field("f-scenes", "Scenes", h("input", { id: "f-scenes", name: "sceneCount", type: "number", min: 2, max: 12, value: 4, class: "field" })),
      field("f-song", "Song length", select("f-song", "songSeconds", [["15", "15 seconds"], ["30", "30 seconds"], ["60", "1 minute"], ["90", "1½ minutes"]], "30"),
        "Song mode. Lyria 3 Clip is always 30s; pick Lyria 3.5 on the Models page for other lengths."),
      field("f-age", "Age range", h("input", { id: "f-age", name: "ageRange", value: "3-6", class: "field" })),
      field("f-aspect", "Shape", select("f-aspect", "aspectRatio", [["16:9", "Landscape 16:9 (YouTube)"], ["9:16", "Portrait 9:16 (Shorts)"]])),
    ),
    h("div", { class: "grid gap-4 sm:grid-cols-2" },
      field("f-character", "Main character (optional)", h("input", { id: "f-character", name: "characterHint", class: "field", placeholder: "a curious little goat named Abeba" })),
      field("f-style", "Art style", h("input", { id: "f-style", name: "style", class: "field", value: "colorful 3D animated kids' movie style, Pixar-like, soft cinematic lighting, expressive characters" })),
    ),
    field("f-mode", "Mode", select("f-mode", "reviewMode", [["auto", "Auto — make the whole video in one go"], ["manual", "Manual — stop after each step so I can review and edit"]], "auto"),
      "Every step also has its own page (Poem, Scenes, Character, Audio, Clips, Final video) where you can make, edit or redo it on its own."),
    field("f-provider", "Provider", select("f-provider", "provider", [["gemini", "Gemini (real AI)"], ["mock", "Mock (offline test)"]], config.hasApiKey ? "gemini" : "mock"),
      "Prompts come from the Prompts page and models from the Models page."),
    h("div", { class: "flex items-center gap-3" }, h("button", { type: "submit", class: "btn" }, "Create video ✨"), status),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const input = Object.fromEntries([...fd.entries()].filter(([k, v]) => k !== "provider" && String(v).trim() !== ""));
    input.sceneCount = Number(input.sceneCount);
    if (input.songSeconds) input.songSeconds = Number(input.songSeconds);
    const btn = $("button[type=submit]", form);
    btn.disabled = true;
    mount(status, "Starting…");
    try {
      const p = await post("/api/projects", { input, provider: fd.get("provider") });
      location.hash = `#/project/${enc(p.id)}`;
    } catch (err) {
      mount(status, errorBox(err));
      btn.disabled = false;
    }
  });
  mount($("#main"), form);
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
  final: "All clips joined with the audio and subtitles into one MP4.",
};
const MAKE_LABEL = { poem: "✨ Write the poem", scenes: "✨ Plan the scenes", character: "✨ Design the character", audio: "✨ Make the audio", clips: "✨ Make the clips", final: "🎬 Build the final video" };
const REDO_LABEL = { poem: "↻ Write a new poem", scenes: "↻ Plan the scenes again", character: "↻ Design a new character", audio: "↻ Make new audio", clips: "↻ Remake all clips", final: "↻ Build again" };
const SKIP = Symbol("skip");

let currentStep = null;
const stepUrl = (id, step) => `#/project/${enc(id)}/${step}`;
const prevStep = (s) => config.steps[config.steps.indexOf(s) - 1];
const nextStepOf = (s) => config.steps[config.steps.indexOf(s) + 1];

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
    h("p", { class: "mt-1 text-sm text-stone-500", text: [manual ? "manual review" : "auto", lang === "am" ? "አማርኛ" : "English", p.input.audioMode, p.input.videoMode === "veo" ? "Veo video" : "animated pictures", p.input.aspectRatio, `provider: ${p.provider}`].join(" · ") }),
    controls,
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
  mount($("#main"), header, tabs, stepPage(p, step, keepVideo, videoKey), generationLog(id, step));
  if (wasOpen) $("#gen-log").open = true;
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
  const generate = (label = MAKE_LABEL[step], cls = "btn") => h("button", { type: "button", class: cls, onclick: act(async () => {
    if (done && !confirm(`Throw this ${STEP_LABELS[step].toLowerCase()} away and make a new one?${laterNote}`)) return SKIP;
    if (step === "clips" && p.input.videoMode === "veo" && !confirm(`This makes ${p.scenes.scenes.length} Veo video requests (slow, uses paid credits). Continue?`)) return SKIP;
    await post(`/api/projects/${enc(id)}/steps/${step}/generate`, { provider: provider() });
  }) }, label);

  // Each step fills in: body (what was made), save (persist edits; null when unchanged), extra buttons.
  let body = null, save = () => null, extra = [], after = null;
  const editable = idle && done;

  if (step === "poem" && p.poem) {
    if (editable) {
      const title = h("input", { class: "field text-lg font-semibold", lang, value: p.poem.title, "aria-label": "Title" });
      const stanzas = p.poem.stanzas.map((st, i) => h("textarea", { class: "field text-lg leading-relaxed", lang, rows: Math.max(2, st.lines.length), "aria-label": `Stanza ${i + 1}`, value: st.lines.join("\n") }));
      const read = () => ({ title: title.value.trim(), moral: p.poem.moral, stanzas: stanzas.map((t) => ({ lines: t.value.split("\n").map((l) => l.trim()).filter(Boolean) })) });
      const changed = () => JSON.stringify(read()) !== JSON.stringify({ title: p.poem.title, moral: p.poem.moral, stanzas: p.poem.stanzas });
      save = () => changed() ? post(`/api/projects/${enc(id)}/poem`, { poem: read() }, "PUT") : null;
      body = h("div", { class: "space-y-3" }, h("label", { class: "label", text: "Title" }), title,
        stanzas.map((t, i) => h("div", {}, h("p", { class: "label", text: `Stanza ${i + 1} (scene ${i + 1})` }), t)));
    } else {
      body = h("div", { class: "whitespace-pre-line text-lg leading-relaxed", lang, text: p.poem.stanzas.map((s) => s.lines.join("\n")).join("\n\n") });
    }
  } else if (step === "scenes" && p.scenes) {
    if (editable) {
      const rows = p.scenes.scenes.map((sc) => ({
        sc,
        text: h("textarea", { class: "field", lang, rows: 2, "aria-label": `Scene ${sc.index + 1} words`, value: sc.text }),
        visual: h("textarea", { class: "field text-sm", rows: 3, "aria-label": `Scene ${sc.index + 1} picture description`, value: sc.visualPrompt }),
      }));
      const read = () => ({ scenes: rows.map((r) => ({ ...r.sc, text: r.text.value.trim(), visualPrompt: r.visual.value.trim() })) });
      save = () => JSON.stringify(read()) !== JSON.stringify({ scenes: p.scenes.scenes }) ? post(`/api/projects/${enc(id)}/scenes`, { scenes: read() }, "PUT") : null;
      body = h("div", { class: "space-y-4" }, rows.map((r) => h("div", { class: "rounded-xl border border-orange-100 p-3" },
        h("p", { class: "mb-2 font-semibold", text: `Scene ${r.sc.index + 1}` }),
        h("p", { class: "label", text: "Sung / spoken" }), r.text,
        h("p", { class: "label mt-2", text: "What the picture shows (English)" }), r.visual)));
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
          h("p", { class: "text-sm text-stone-500", text: `Song · ${p.song.duration.toFixed(1)} seconds` }),
          h("a", { class: "btn-soft", href: mediaUrl(id, p.song.file, p.updatedAt), download: "" }, "⬇ Download song"))
      : h("ol", { class: "space-y-3" }, (p.scenes?.scenes ?? []).map((sc) => {
          const a = p.media.scenes.find((m) => m.index === sc.index)?.audio;
          return h("li", { class: "rounded-xl border border-orange-100 p-3" },
            h("p", { class: "mb-2 whitespace-pre-line text-sm", lang, text: `${sc.index + 1}. ${sc.text}` }),
            a ? h("audio", { controls: true, preload: "none", class: "w-full", src: mediaUrl(id, a, p.updatedAt), "aria-label": `Scene ${sc.index + 1} narration` }) : h("p", { class: "text-sm text-stone-500", text: "missing" }));
        }));
  } else if (step === "clips" && p.scenes && (done || making || p.media.scenes.some((m) => m.image || m.clip))) {
    body = h("div", { class: "grid gap-4 sm:grid-cols-2" }, p.scenes.scenes.map((sc) => {
      const m = p.media.scenes.find((x) => x.index === sc.index);
      const media = m?.clip ? h("video", { controls: true, preload: "metadata", class: "aspect-video w-full bg-black", src: mediaUrl(id, m.clip, p.updatedAt), "aria-label": `Scene ${sc.index + 1} clip` })
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
      p.media.subtitles ? h("track", { kind: "subtitles", label: p.input.audioMode === "song" ? "Lyrics" : "Captions", srclang: lang, src: mediaUrl(id, "subtitles.vtt", p.updatedAt), default: true }) : null);
    body = h("div", {}, video, h("div", { class: "mt-3 flex flex-wrap gap-2" },
      h("a", { class: "btn", href: mediaUrl(id, p.media.final, p.updatedAt), download: `${id}.mp4` }, "⬇ Download MP4"),
      p.song ? h("a", { class: "btn-soft", href: mediaUrl(id, p.song.file, p.updatedAt), download: "" }, "♪ Song only") : null));
  }

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
    buttons = [generate()];
  } else {
    const saveBtn = step === "poem" || step === "scenes" ? h("button", { type: "button", class: "btn", onclick: act(async () => {
      const saving = save();
      if (!saving) { mount(status, "Nothing changed."); return SKIP; }
      if (laterDone.length && !confirm(`Save your changes?${laterNote}`)) return SKIP;
      await saving;
    }, false) }, "💾 Save changes") : null;
    const approve = reviewing ? h("button", { type: "button", class: "btn", onclick: act(async () => {
      await save();
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
    buttons.length || nextLink ? h("div", { class: "mt-5 flex flex-wrap items-center gap-2" }, buttons, nextLink) : null,
    status,
    after);
}

const MAX_UPLOAD_MB = 8;

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
  const prompts = await api("/api/prompts");
  const selected = prompts.find((p) => p.key === key) ?? prompts[0];
  mount($("#sidebar"), 
    h("div", { class: "side-heading", text: "Prompt library" }),
    h("p", { class: "mb-3 px-2 text-xs text-stone-500", text: "Saved in Postgres. Changes apply to the next run." }),
    h("ul", { class: "space-y-1" }, prompts.map((p) => h("li", {},
      h("a", { href: `#/prompts/${enc(p.key)}`, "aria-current": p.key === selected?.key ? "page" : null, class: "side-item" },
        h("span", { class: "block text-sm font-semibold", text: p.title }),
        h("span", { class: "mt-1 flex items-center gap-1.5 text-xs text-stone-500" }, h("span", { text: `v${p.version}` }),
          p.isDefault ? null : h("span", { class: "rounded-full bg-violet-100 px-1.5 text-violet-800", text: "edited" })))))),
  );
  if (selected) renderPromptEditor(selected);
}

function renderPromptEditor(p) {
  const textarea = h("textarea", { id: "tpl", class: "field min-h-72 font-mono text-sm leading-relaxed", spellcheck: "false", "aria-describedby": "tpl-help", value: p.template });
  const note = h("input", { id: "note", class: "field", placeholder: "What did you change? (optional)" });
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const preview = h("pre", { class: "min-h-24 whitespace-pre-wrap rounded-xl bg-stone-50 p-3 font-mono text-xs", text: "Click Preview to see the final prompt with sample values." });
  const lang = h("select", { class: "field w-auto", "aria-label": "Preview language" }, h("option", { value: "en", text: "English" }), h("option", { value: "am", text: "Amharic" }));
  const mode = h("select", { class: "field w-auto", "aria-label": "Preview audio mode" }, h("option", { value: "song", text: "song" }), h("option", { value: "narration", text: "narration" }));
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
    const saved = await post(`/api/prompts/${enc(p.key)}`, { template: textarea.value, note: note.value || undefined, expectedVersion: p.version }, "PUT");
    await showPrompts(saved.key);
    $("#prompt-status").textContent = `Saved as v${saved.version} ✓`;
  }));

  const history = h("details", { class: "card" }, h("summary", { class: "cursor-pointer font-bold", text: "Version history" }), h("ol", { class: "mt-3 space-y-2" }));
  history.addEventListener("toggle", async () => {
    if (!history.open) return;
    const versions = await api(`/api/prompts/${enc(p.key)}/history`);
    mount($("ol", history), ...versions.map((v) => h("li", { class: "rounded-xl bg-stone-50 p-3" },
      h("div", { class: "mb-1 flex flex-wrap items-center gap-2 text-sm" },
        h("strong", { text: `v${v.version}` }), h("span", { class: "text-stone-500", text: new Date(v.createdAt).toLocaleString() }),
        v.note ? h("span", { class: "chip", text: v.note }) : null,
        v.version === p.version ? h("span", { class: "chip bg-emerald-100 text-emerald-800", text: "current" })
          : h("button", { type: "button", class: "btn-soft ml-auto px-3 py-1 text-sm", onclick: run(async () => { await post(`/api/prompts/${enc(p.key)}/restore`, { version: v.version }); await showPrompts(p.key); }) }, "Restore")),
      h("pre", { class: "max-h-40 overflow-auto whitespace-pre-wrap font-mono text-xs text-stone-600", text: v.template }))));
  });

  mount($("#main"), 
    h("section", { class: "card space-y-4" },
      h("div", { class: "flex flex-wrap items-center gap-3" },
        h("h2", { class: "text-xl font-bold", text: p.title }),
        h("span", { class: "chip", text: `v${p.version}` }),
        p.isDefault ? h("span", { class: "chip", text: "default" }) : h("span", { class: "chip bg-violet-100 text-violet-800", text: "edited" })),
      h("p", { class: "text-stone-600", text: p.description }),
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
        p.isDefault ? null : h("button", { type: "button", class: "btn-soft", onclick: run(async () => {
          if (!confirm("Reset this prompt to the built-in default? (It's saved as a new version, so you can restore your edit later.)")) return;
          await post(`/api/prompts/${enc(p.key)}/reset`);
          await showPrompts(p.key);
        }) }, "↺ Reset to default")),
      h("div", { id: "prompt-status" }), status,
    ),
    h("section", { class: "card space-y-3" },
      h("div", { class: "flex flex-wrap items-center gap-2" },
        h("h3", { class: "mr-auto text-lg font-bold", text: "Preview" }), lang, mode,
        h("button", { type: "button", class: "btn-soft", onclick: run(async () => {
          const r = await post(`/api/prompts/${enc(p.key)}/preview`, { template: textarea.value, input: { language: lang.value, audioMode: mode.value } });
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

// ---------- boot ----------
api("/api/config").then((c) => { config = c; route(); }, (err) => mount($("#main"), errorBox(err)));
