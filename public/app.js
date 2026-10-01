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
    err.details?.length ? h("ul", { class: "mt-1 list-disc pl-5 text-sm" }, err.details.map((d) => h("li", { text: d }))) : null);
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
  closeEvents();
  currentProject = null;
  const [, section, arg] = (location.hash || "#/new").split("/").map(decodeURIComponent);
  try {
    if (section === "prompts") await showPrompts(arg);
    else if (section === "models") await showModels();
    else if (section === "project" && arg) await showProject(arg);
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
      "Manual: check and edit the poem before scenes are planned, then the scenes, character, song and clips."),
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

async function showProject(id) {
  setNav("videos");
  currentProject = id;
  await renderProject(id);
  $("#main").focus();
  events = new EventSource(`/api/projects/${enc(id)}/events`);
  events.onmessage = (m) => {
    const e = JSON.parse(m.data);
    const s = $("#run-status");
    if (s) {
      if (e.type === "progress") s.textContent = `${STEP_LABELS[e.step]}: ${e.message} (${e.done}/${e.total})`;
      else if (e.type === "step-start") s.textContent = `${STEP_LABELS[e.step]}…`;
      else if (e.type === "done") s.textContent = "Done! 🎉";
      else if (e.type === "review") s.textContent = `${STEP_LABELS[e.step]} is ready for your review ↓`;
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
  const prevStatus = keepStatus ? $("#run-status")?.textContent : null;
  const lang = p.input.language;
  const oldVideo = $("#final-video");
  const videoKey = `${id}|${p.updatedAt}`;
  const keepVideo = oldVideo && (oldVideo.dataset.key === videoKey || p.running) ? oldVideo : null; // never interrupt playback

  const controls = h("div", { class: "flex flex-wrap items-center gap-2" },
    p.running
      ? h("button", { type: "button", class: "btn-danger", onclick: () => post(`/api/projects/${enc(id)}/cancel`) }, "■ Stop")
      : p.awaitingReview ? null : [
          h("button", { type: "button", class: "btn", onclick: async (e) => {
            e.currentTarget.disabled = true;
            try {
              await post(`/api/projects/${enc(id)}/resume`, { from: $("#from").value || undefined, provider: $("#prov").value });
              await showProject(id);
            } catch (err) { mount($("#run-status"), errorBox(err)); e.target.disabled = false; }
          } }, p.status === "done" ? "↻ Regenerate" : "▶ Resume"),
          h("select", { id: "from", class: "field w-auto", "aria-label": "Where to start" },
            h("option", { value: "", text: "continue where it stopped" }),
            config.steps.map((s) => h("option", { value: s, text: `redo from ${STEP_LABELS[s]}` }))),
          h("select", { id: "prov", class: "field w-auto", "aria-label": "Provider" }, config.providers.map((n) => h("option", { value: n, text: n, selected: n === p.provider }))),
        ],
    h("span", { id: "run-status", role: "status", "aria-live": "polite", class: "text-sm text-stone-600" }),
  );

  // Switch visuals without redoing the poem, song or pictures.
  const veoCount = p.media.scenes.filter((m) => m.video).length;
  const toVeo = p.input.videoMode !== "veo" || veoCount < p.media.scenes.length;
  const sceneCount = p.scenes?.scenes.length ?? p.input.sceneCount;
  const visualsCard = p.running || !p.completed.includes("audio") ? null : h("div", { class: "mt-4 flex flex-wrap items-center gap-3 rounded-xl bg-violet-50 p-3 text-sm" },
    h("span", { class: "flex-1", text: toVeo
      ? (p.input.videoMode === "veo"
          ? `${veoCount} of ${sceneCount} scenes have Veo video. Retry to make the missing ones (the error above says what went wrong). The poem, song and pictures are kept.`
          : `These are animated pictures. Turn each of the ${sceneCount} scenes into a moving AI video clip with Veo? The poem, song and pictures are kept.`)
      : "This video uses Veo clips. Switch back to animated pictures (fast, free)?" }),
    h("button", { type: "button", class: toVeo ? "btn" : "btn-soft", onclick: async (e) => {
      if (toVeo && !confirm(`This makes ${sceneCount} Veo video requests, which is slow (a few minutes) and uses paid credits. Continue?`)) return;
      e.currentTarget.disabled = true;
      try {
        await post(`/api/projects/${enc(id)}/visuals`, { videoMode: toVeo ? "veo" : "still" });
        await showProject(id);
      } catch (err) { $("#run-status").replaceChildren(errorBox(err)); e.target.disabled = false; }
    } }, toVeo ? (p.input.videoMode === "veo" ? "🎞️ Retry Veo" : "🎞️ Animate with Veo") : "🖼️ Use animated pictures"));

  const active = p.running ? p.nextStep : null;
  const sections = [
    h("section", { class: "card" },
      h("div", { class: "flex flex-wrap items-center gap-3" }, h("h2", { class: "text-2xl font-bold", lang, text: p.poem?.title || p.topic }), badge(p.running ? "running" : p.status)),
      h("p", { class: "mt-1 text-sm text-stone-500", text: [p.input.reviewMode === "manual" ? "manual review" : "auto", lang === "am" ? "አማርኛ" : "English", p.input.audioMode, p.input.videoMode === "veo" ? "Veo video" : "animated pictures", p.input.aspectRatio, `provider: ${p.provider}`].join(" · ") }),
      h("ol", { class: "my-4 flex flex-wrap gap-2", "aria-label": "Progress" }, config.steps.map((s) => {
        const done = p.completed.includes(s);
        const cls = s === p.awaitingReview ? "bg-sky-100 font-bold text-sky-800 ring-2 ring-sky-300"
          : done ? "bg-emerald-100 text-emerald-800" : s === active ? "bg-orange-100 font-bold text-orange-800 animate-pulse" : "bg-stone-100 text-stone-500";
        return h("li", { class: `rounded-full px-3 py-1 text-sm ${cls}`, text: `${done ? "✓ " : ""}${STEP_LABELS[s]}` });
      })),
      controls,
      visualsCard,
      p.error && !p.running && p.error !== "cancelled" ? h("div", { class: "mt-3" }, errorBox({ message: p.error })) : null,
    ),
  ];

  if (p.awaitingReview) sections.push(reviewPanel(p));
  else if (!p.running && p.status !== "done") sections.push(modeToggle(p));

  if (p.media.final) {
    const video = keepVideo || h("video", { id: "final-video", "data-key": videoKey, controls: true, preload: "metadata", class: "w-full rounded-xl bg-black", src: mediaUrl(id, p.media.final, p.updatedAt) },
      p.media.subtitles ? h("track", { kind: "subtitles", label: p.input.audioMode === "song" ? "Lyrics" : "Captions", srclang: lang, src: mediaUrl(id, "subtitles.vtt", p.updatedAt), default: true }) : null);
    sections.push(h("section", { class: "card" }, h("h3", { class: "mb-3 text-lg font-bold", text: "Your video" }), video,
      h("div", { class: "mt-3 flex flex-wrap gap-2" },
        h("a", { class: "btn", href: mediaUrl(id, p.media.final, p.updatedAt), download: `${id}.mp4` }, "⬇ Download MP4"),
        p.song ? h("a", { class: "btn-soft", href: mediaUrl(id, p.song.file, p.updatedAt), download: "" }, "♪ Song only") : null)));
  }
  const reviewing = p.awaitingReview;
  if (p.poem && reviewing !== "poem") {
    sections.push(h("section", { class: "card" }, h("h3", { class: "mb-2 text-lg font-bold", text: "Poem" }),
      h("div", { class: "whitespace-pre-line text-lg leading-relaxed", lang, text: p.poem.stanzas.map((s) => s.lines.join("\n")).join("\n\n") })));
  }
  if (p.character && reviewing !== "character") {
    sections.push(h("section", { class: "card flex flex-col gap-4 sm:flex-row" },
      p.media.characterImage ? h("img", { src: mediaUrl(id, p.media.characterImage, p.updatedAt), alt: `Character sheet for ${p.character.name}`, class: "w-40 rounded-xl border border-orange-100" }) : null,
      h("div", {}, h("h3", { class: "text-lg font-bold", lang, text: `Meet ${p.character.name}` }), h("p", { class: "text-stone-600", text: p.character.description }))));
  }
  if (p.scenes && reviewing !== "scenes" && reviewing !== "clips") {
    sections.push(h("section", { class: "card" }, h("h3", { class: "mb-3 text-lg font-bold", text: "Scenes" }),
      h("div", { class: "grid gap-4 sm:grid-cols-2 lg:grid-cols-3" }, p.scenes.scenes.map((s) => {
        const img = p.media.scenes.find((m) => m.index === s.index)?.image;
        return h("figure", { class: "overflow-hidden rounded-xl border border-orange-100 bg-white" },
          img ? h("img", { src: mediaUrl(id, img, p.updatedAt), alt: s.visualPrompt, loading: "lazy", class: "aspect-video w-full object-cover" })
              : h("div", { class: "grid aspect-video place-items-center bg-stone-100 text-sm text-stone-500", text: p.running ? "painting…" : "not yet" }),
          h("figcaption", { class: "whitespace-pre-line p-3 text-sm", lang, text: `${s.index + 1}. ${s.text}` }));
      }))));
  }
  const log = h("details", { class: "card", id: "gen-log" }, h("summary", { class: "cursor-pointer font-bold", text: "Prompts sent to the AI" }), h("div", { class: "mt-3 space-y-3", text: "Loading…" }));
  log.addEventListener("toggle", async () => {
    if (!log.open) return;
    const list = await api(`/api/projects/${enc(id)}/generations`);
    mount($("div", log), ...(list.length ? list.map((g) => h("div", { class: "rounded-xl bg-stone-50 p-3" },
      h("p", { class: "mb-1 text-xs text-stone-500" },
        `${STEP_LABELS[g.step] ?? g.step}${g.sceneIndex != null ? ` · scene ${g.sceneIndex + 1}` : ""} · `,
        h("a", { href: `#/prompts/${enc(g.promptKey)}`, class: "underline", text: `${g.promptKey} v${g.promptVersion}` }),
        g.model ? ` · ${g.model}` : "",
        ` · ${new Date(g.createdAt).toLocaleString()}`),
      h("pre", { class: "whitespace-pre-wrap font-mono text-xs", text: g.prompt }))) : [h("p", { class: "text-sm text-stone-500", text: "Nothing yet." })]));
  });
  sections.push(log);

  const wasOpen = $("#gen-log")?.open;
  mount($("#main"), ...sections);
  if (wasOpen) log.open = true;
  if (prevStatus) $("#run-status").textContent = prevStatus;
  await renderProjectList();
}

// ---------- Manual review ----------
const SKIP = Symbol("skip");
const REVIEW_HELP = {
  poem: "Read the poem. Edit any line, then approve to plan the scenes from it.",
  scenes: "Check what each scene shows. Edit the lyrics or the picture description, then approve.",
  character: "Check the main character. Change the name or look and redraw, or approve.",
  audio: "Listen to the song. Make a new one if you don't like it, or approve to make the clips.",
  clips: "Watch each scene. Remake any scene you don't like, then approve to build the final video.",
};

function modeToggle(p) {
  const manual = p.input.reviewMode === "manual";
  return h("div", { class: "card flex flex-wrap items-center gap-3 text-sm" },
    h("span", { class: "flex-1", text: manual ? "Manual mode: the video stops after each step for your review." : "Auto mode: the video runs through without stopping." }),
    h("button", { type: "button", class: "btn-soft", onclick: async () => {
      await post(`/api/projects/${enc(p.id)}/review-mode`, { mode: manual ? "auto" : "manual" }, "PUT");
      await renderProject(p.id);
    } }, manual ? "Switch to auto" : "Switch to manual review"));
}

function reviewPanel(p) {
  const id = p.id, step = p.awaitingReview, lang = p.input.language;
  const status = h("div", { role: "status", "aria-live": "polite", class: "text-sm" });
  const act = (fn) => async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    mount(status, "Working…");
    try {
      if ((await fn()) === SKIP) { mount(status); btn.disabled = false; return; }
      await showProject(id);
    } catch (err) { mount(status, errorBox(err)); btn.disabled = false; }
  };
  const approve = h("button", { type: "button", class: "btn", onclick: act(() => post(`/api/projects/${enc(id)}/approve`, { step })) },
    step === "clips" ? "✓ Approve & build final video" : `✓ Approve & continue to ${STEP_LABELS[config.steps[config.steps.indexOf(step) + 1]]}`);
  const regenerate = (label) => h("button", { type: "button", class: "btn-soft", onclick: act(async () => {
    if (!confirm(`Throw this ${STEP_LABELS[step].toLowerCase()} away and make a new one?`)) return SKIP;
    await post(`/api/projects/${enc(id)}/regenerate`, { step });
  }) }, label);
  let body, buttons;

  if (step === "poem") {
    const title = h("input", { class: "field text-lg font-semibold", lang, value: p.poem.title, "aria-label": "Title" });
    const stanzas = p.poem.stanzas.map((st, i) => h("textarea", { class: "field text-lg leading-relaxed", lang, rows: Math.max(2, st.lines.length), "aria-label": `Stanza ${i + 1}`, value: st.lines.join("\n") }));
    const read = () => ({ title: title.value.trim(), moral: p.poem.moral, stanzas: stanzas.map((t) => ({ lines: t.value.split("\n").map((l) => l.trim()).filter(Boolean) })) });
    const changed = () => JSON.stringify(read()) !== JSON.stringify({ title: p.poem.title, moral: p.poem.moral, stanzas: p.poem.stanzas });
    body = h("div", { class: "space-y-3" }, title, stanzas.map((t, i) => h("div", {}, h("p", { class: "label", text: `Stanza ${i + 1} (scene ${i + 1})` }), t)));
    approve.onclick = null;
    approve.addEventListener("click", act(async () => {
      if (changed()) await post(`/api/projects/${enc(id)}/poem`, { poem: read() }, "PUT");
      await post(`/api/projects/${enc(id)}/approve`, { step });
    }));
    approve.textContent = "✓ Save & continue to Scenes";
    buttons = [approve, regenerate("↻ Write a new poem")];
  } else if (step === "scenes") {
    const rows = p.scenes.scenes.map((sc) => ({
      sc,
      text: h("textarea", { class: "field", lang, rows: 2, "aria-label": `Scene ${sc.index + 1} lyrics`, value: sc.text }),
      visual: h("textarea", { class: "field text-sm", rows: 3, "aria-label": `Scene ${sc.index + 1} picture description`, value: sc.visualPrompt }),
    }));
    const read = () => ({ scenes: rows.map((r) => ({ ...r.sc, text: r.text.value.trim(), visualPrompt: r.visual.value.trim() })) });
    body = h("div", { class: "space-y-4" }, rows.map((r) => h("div", { class: "rounded-xl border border-orange-100 p-3" },
      h("p", { class: "mb-2 font-semibold", text: `Scene ${r.sc.index + 1}` }),
      h("p", { class: "label", text: "Sung / spoken" }), r.text,
      h("p", { class: "label mt-2", text: "What the picture shows (English)" }), r.visual)));
    approve.onclick = null;
    approve.addEventListener("click", act(async () => {
      if (JSON.stringify(read()) !== JSON.stringify({ scenes: p.scenes.scenes })) await post(`/api/projects/${enc(id)}/scenes`, { scenes: read() }, "PUT");
      await post(`/api/projects/${enc(id)}/approve`, { step });
    }));
    approve.textContent = "✓ Save & continue to Character";
    buttons = [approve, regenerate("↻ Plan the scenes again")];
  } else if (step === "character") {
    const name = h("input", { class: "field", lang, value: p.character.name, "aria-label": "Name" });
    const desc = h("textarea", { class: "field", rows: 4, value: p.character.description, "aria-label": "Look (English)" });
    body = h("div", { class: "flex flex-col gap-4 sm:flex-row" },
      p.media.characterImage ? h("img", { src: mediaUrl(id, p.media.characterImage, p.updatedAt), alt: `Character sheet for ${p.character.name}`, class: "w-56 self-start rounded-xl border border-orange-100" }) : null,
      h("div", { class: "flex-1 space-y-2" }, h("p", { class: "label", text: "Name" }), name, h("p", { class: "label", text: "Look (English, used for every picture)" }), desc));
    const redraw = h("button", { type: "button", class: "btn-soft", onclick: act(() => post(`/api/projects/${enc(id)}/character`, { character: { name: name.value.trim(), description: desc.value.trim() } }, "PUT")) }, "🎨 Save & redraw picture");
    buttons = [approve, redraw, regenerate("↻ Design a new character")];
  } else if (step === "audio") {
    body = p.song
      ? h("audio", { controls: true, class: "w-full", src: mediaUrl(id, p.song.file, p.updatedAt) })
      : h("p", { class: "text-stone-600", text: "Narration was recorded for each scene; it plays in the clips." });
    buttons = [approve, regenerate(p.song ? "↻ Make a new song" : "↻ Record again")];
  } else {
    body = h("div", { class: "grid gap-4 sm:grid-cols-2" }, p.scenes.scenes.map((sc) => {
      const m = p.media.scenes.find((x) => x.index === sc.index);
      return h("figure", { class: "overflow-hidden rounded-xl border border-orange-100" },
        m?.clip ? h("video", { controls: true, preload: "metadata", class: "aspect-video w-full bg-black", src: mediaUrl(id, m.clip, p.updatedAt) }) : h("div", { class: "grid aspect-video place-items-center bg-stone-100 text-sm", text: "missing" }),
        h("figcaption", { class: "flex items-start gap-2 p-3 text-sm" },
          h("span", { class: "flex-1 whitespace-pre-line", lang, text: `${sc.index + 1}. ${sc.text}` }),
          h("button", { type: "button", class: "btn-soft shrink-0 px-3 py-1 text-xs", onclick: act(async () => {
            const cost = p.input.videoMode === "veo" ? " This makes 1 new Veo clip (paid)." : "";
            if (!confirm(`Remake scene ${sc.index + 1} (new picture and clip)?${cost}`)) return SKIP;
            await post(`/api/projects/${enc(id)}/scenes/${sc.index + 1}/redo`);
          }) }, "↻ Remake")));
    }));
    buttons = [approve];
  }

  return h("section", { class: "card border-2 border-sky-200 bg-sky-50/40" },
    h("div", { class: "mb-1 flex items-center gap-2" }, h("span", { "aria-hidden": "true", text: "👀" }), h("h3", { class: "text-lg font-bold", text: `Review: ${STEP_LABELS[step]}` })),
    h("p", { class: "mb-4 text-sm text-stone-600", text: REVIEW_HELP[step] }),
    body,
    h("div", { class: "mt-4 flex flex-wrap items-center gap-2" }, buttons),
    status);
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
    available.warning ? h("div", { class: "mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm", text: available.warning + " — you can still type a model id." }) : null,
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
