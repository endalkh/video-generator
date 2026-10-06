import { spawn } from "node:child_process";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { VIDEO_RESOLUTIONS, videoResolution, type AspectRatio, type Scene, type VideoResolution } from "../../domain/project/project.model.js";
import { log } from "../../util/log.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export interface VideoFormat {
  width: number;
  height: number;
  fps: number;
}

/** Final video size: 4k = 3840×2160, 1080p = 1920×1080, 720p = 1280×720 (swapped for 9:16). */
export function formatFor(aspect: AspectRatio, resolution: VideoResolution = videoResolution()): VideoFormat {
  const short = VIDEO_RESOLUTIONS[resolution];
  const long = Math.round((short * 16) / 9);
  return aspect === "9:16" ? { width: short, height: long, fps: 25 } : { width: long, height: short, fps: 25 };
}

function run(bin: string, args: string[]): Promise<string> {
  log.debug(`$ ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      if (stderr.length > 64_000) stderr = stderr.slice(-32_000);
    });
    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      reject(e.code === "ENOENT" ? new Error(`${bin} not found. Install ffmpeg (e.g. \`brew install ffmpeg\`) or set FFMPEG_PATH/FFPROBE_PATH.`) : err);
    });
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(bin)} exited with code ${code}:\n${stderr.split("\n").slice(-15).join("\n")}`));
    });
  });
}

export const runFfmpeg = (args: string[]) => run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args]);

/** Convert any picture ffmpeg can read (PNG, JPEG, WebP…) to a PNG that fits in 1024×1024. Throws on non-images. */
export async function imageToPng(input: string, out: string): Promise<void> {
  await runFfmpeg(["-i", input, "-frames:v", "1", "-vf", "scale=w=1024:h=1024:force_original_aspect_ratio=decrease", "-f", "image2", "-c:v", "png", out]);
}

/** One frame of a video as a PNG (at `atSec`, or the first frame if the video is shorter). */
export async function videoFrame(input: string, out: string, atSec = 1): Promise<void> {
  const seek = Math.max(0, Math.min(atSec, (await probeDuration(input).catch(() => 0)) - 0.1));
  await runFfmpeg(["-ss", String(seek), "-i", input, "-frames:v", "1", "-f", "image2", "-c:v", "png", out]);
}

/**
 * Scale and centre-crop a picture to exactly `width`×`height` (e.g. YouTube's 2560×1440 banner).
 * JPEG output steps the quality down until the file fits `maxBytes`; returns the file size.
 */
export async function fitImage(opts: { input: string; out: string; width: number; height: number; maxBytes?: number }): Promise<number> {
  const { width: w, height: h } = opts;
  const vf = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1`;
  const jpeg = /\.jpe?g$/i.test(opts.out);
  for (const q of jpeg ? [2, 4, 6, 9, 13] : [0]) {
    await runFfmpeg(["-i", opts.input, "-frames:v", "1", "-vf", jpeg ? `${vf},format=yuvj444p` : vf, "-f", "image2", ...(jpeg ? ["-c:v", "mjpeg", "-q:v", String(q)] : ["-c:v", "png"]), opts.out]);
    const size = (await stat(opts.out)).size;
    if (!opts.maxBytes || size <= opts.maxBytes) return size;
    if (!jpeg) break;
  }
  throw new Error(`${path.basename(opts.out)} is larger than ${Math.round(opts.maxBytes! / 1024)} kB`);
}

/**
 * Voice over music: each voice clip starts at its time (seconds), the music loops underneath at a lower volume
 * (fading in and out), and the result is exactly `total` seconds of 48 kHz stereo WAV.
 */
export async function mixVoiceOverMusic(opts: { voices: string[]; starts: number[]; music: string; total: number; out: string; musicVolume?: number }): Promise<void> {
  const n = opts.voices.length;
  const total = opts.total.toFixed(3);
  const fmt = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";
  const voices = opts.voices.map((_, i) => {
    const ms = Math.max(0, Math.round((opts.starts[i] ?? 0) * 1000));
    return `[${i}:a]${fmt},adelay=${ms}|${ms}[v${i}]`;
  });
  const fadeOut = Math.max(0, opts.total - 2.5).toFixed(3);
  const filter = [
    ...voices,
    `${opts.voices.map((_, i) => `[v${i}]`).join("")}amix=inputs=${n}:normalize=0:dropout_transition=0[voice]`,
    `[${n}:a]${fmt},atrim=0:${total},asetpts=N/SR/TB,volume=${opts.musicVolume ?? 0.22},afade=t=in:d=0.8,afade=t=out:st=${fadeOut}:d=2.5[bed]`,
    `[voice][bed]amix=inputs=2:normalize=0:duration=longest,atrim=0:${total},alimiter=limit=0.95[a]`,
  ].join(";");
  await runFfmpeg([...opts.voices.flatMap((f) => ["-i", f]), "-stream_loop", "-1", "-i", opts.music, "-filter_complex", filter, "-map", "[a]", "-t", total, "-c:a", "pcm_s16le", "-f", "wav", opts.out]);
}

/** Any audio ffmpeg can read (MP3, M4A, WAV, OGG, WebM…) → 48 kHz stereo WAV. Throws on files without audio. */
export async function audioToWav(input: string, out: string): Promise<void> {
  await runFfmpeg(["-i", input, "-vn", "-ac", "2", "-ar", "48000", "-c:a", "pcm_s16le", "-f", "wav", out]);
}

/**
 * One scene's own audio as an MP3 (for audio-driven video models like Kling Avatar, or to download):
 * either a cut [start, end) of the whole song, or a scene's voice plus `padSec` of silence (its clip's length).
 */
export async function audioPiece(opts: { input: string; out: string; start?: number; end?: number; padSec?: number }): Promise<void> {
  const cut = opts.start !== undefined && opts.end !== undefined ? ["-ss", opts.start.toFixed(3), "-to", opts.end.toFixed(3)] : [];
  const pad = opts.padSec ? ["-af", `apad=pad_dur=${opts.padSec.toFixed(3)}`] : [];
  await runFfmpeg([...cut, "-i", opts.input, "-vn", ...pad, "-ac", "2", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", "-f", "mp3", opts.out]);
}

let drawtextOk: Promise<boolean> | undefined;
/** Whether this ffmpeg can draw text (needs libfreetype; the Docker image has it, some local builds don't). */
export function canDrawText(): Promise<boolean> {
  return (drawtextOk ??= run(FFMPEG, ["-hide_banner", "-filters"]).then((out) => /\bdrawtext\b/.test(out), () => false));
}

/** A bold font for the end card: FONT_FILE, else a common one on Linux/macOS, else fontconfig's default. */
async function boldFont(): Promise<string | undefined> {
  const candidates = [process.env.FONT_FILE, "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "/Library/Fonts/Arial Bold.ttf"];
  for (const f of candidates) if (f && (await stat(f).then(() => true, () => false))) return f;
  return undefined;
}

/** drawtext needs : , ' \ % escaped inside text values. */
const dtEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/%/g, "\\%").replace(/,/g, "\\,");

/**
 * End card for Shorts: for the last `seconds`, a dark rounded box near the bottom with a call to action and the
 * channel's YouTube address (e.g. "youtube.com/@MilcahsWorld"). Sound and length stay the same.
 */
export async function addEndCard(opts: { input: string; out: string; lines: [string, string]; seconds: number; fmt: VideoFormat }): Promise<void> {
  const dur = await probeDuration(opts.input);
  const from = Math.max(0, dur - opts.seconds).toFixed(3);
  const font = await boldFont();
  // Shrink long lines (e.g. a 30-letter handle) so they stay inside the picture (bold glyphs ≈ 0.62 em wide).
  const fit = (size: number, text: string) => Math.round(Math.min(size, (opts.fmt.width * 0.9) / (0.62 * [...text].length)));
  const big = fit(opts.fmt.width * 0.075, opts.lines[0]);
  const small = fit(opts.fmt.width * 0.055, opts.lines[1]);
  const pad = Math.round(opts.fmt.width * 0.03);
  const common = `${font ? `fontfile='${font}':` : ""}fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=${pad}:x=(w-text_w)/2:enable='gte(t,${from})'`;
  const filter = [
    `drawtext=${common}:fontsize=${big}:y=h*0.70:text='${dtEscape(opts.lines[0])}'`,
    `drawtext=${common}:fontsize=${small}:y=h*0.70+${big + pad * 3}:text='${dtEscape(opts.lines[1])}'`,
  ].join(",");
  await runFfmpeg(["-i", opts.input, "-vf", filter, "-map", "0", "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "copy", "-c:s", "copy", "-movflags", "+faststart", opts.out]);
}

/** Join audio files (any format/rate) into one WAV, in order. */
export async function concatAudio(inputs: string[], out: string): Promise<void> {
  const norm = inputs.map((_, i) => `[${i}:a]aresample=48000,aformat=sample_fmts=s16:channel_layouts=stereo[a${i}]`).join(";");
  const join = `${inputs.map((_, i) => `[a${i}]`).join("")}concat=n=${inputs.length}:v=0:a=1[a]`;
  await runFfmpeg([...inputs.flatMap((f) => ["-i", f]), "-filter_complex", `${norm};${join}`, "-map", "[a]", "-c:a", "pcm_s16le", "-f", "wav", out]);
}

export async function assertFfmpegAvailable(): Promise<void> {
  await run(FFMPEG, ["-version"]);
  await run(FFPROBE, ["-version"]);
}

/** Stream types in a media file, e.g. ["video", "audio", "subtitle"]. */
export async function probeStreams(file: string): Promise<string[]> {
  const out = await run(FFPROBE, ["-v", "error", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]);
  return out.split("\n").map((l) => l.trim()).filter(Boolean);
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number.parseFloat(out.trim());
  if (!Number.isFinite(d)) throw new Error(`Could not read duration of ${file}`);
  return d;
}

/** Pause after each scene's audio so lines don't run into each other. */
export const SCENE_TAIL_SEC = 0.5;

const ENCODE_ARGS = ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];

/** Ken Burns style zoompan expressions for a clip of N frames. */
export function zoompanFilter(motion: Scene["motion"], frames: number, fmt: VideoFormat): string {
  const N = Math.max(1, frames - 1);
  const center = "x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
  const exprs: Record<Scene["motion"], string> = {
    "zoom-in": `z='1+0.15*on/${N}':${center}`,
    "zoom-out": `z='1.15-0.15*on/${N}':${center}`,
    "pan-left": `z='1.15':x='(iw-iw/zoom)*(1-on/${N})':y='ih/2-(ih/zoom/2)'`,
    "pan-right": `z='1.15':x='(iw-iw/zoom)*on/${N}':y='ih/2-(ih/zoom/2)'`,
    static: `z='1':${center}`,
  };
  // Upscale first so the zoom stays smooth (zoompan rounds to integer pixels); at 4K the pixels are already small enough.
  const k = fmt.width * fmt.height > 1920 * 1080 ? 1 : 2;
  const up = `scale=${fmt.width * k}:${fmt.height * k}:force_original_aspect_ratio=increase:flags=lanczos,crop=${fmt.width * k}:${fmt.height * k}`;
  return `${up},zoompan=${exprs[motion]}:d=${frames}:s=${fmt.width}x${fmt.height}:fps=${fmt.fps},setsar=1,format=yuv420p`;
}

export interface ClipTiming {
  /** Scene audio; clip lasts audio length + SCENE_TAIL_SEC. */
  audio?: string;
  /** Fixed clip length with a silent track (used when one song spans all scenes). */
  duration?: number;
}

async function timingArgs(t: ClipTiming): Promise<{ dur: number; audioInput: string[]; audioFilter: string }> {
  if (t.audio) {
    const dur = (await probeDuration(t.audio)) + SCENE_TAIL_SEC;
    return { dur, audioInput: ["-i", t.audio], audioFilter: "[1:a]apad[a]" };
  }
  if (!t.duration || t.duration <= 0) throw new Error("clip needs either audio or a positive duration");
  return { dur: t.duration, audioInput: ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"], audioFilter: "[1:a]anull[a]" };
}

/** Render a still image into an MP4 clip with gentle camera motion. */
export async function stillToClip(opts: ClipTiming & { image: string; out: string; motion: Scene["motion"]; fmt: VideoFormat }): Promise<number> {
  const { dur, audioInput, audioFilter } = await timingArgs(opts);
  const frames = Math.ceil(dur * opts.fmt.fps);
  await runFfmpeg([
    "-i", opts.image,
    ...audioInput,
    "-filter_complex", `[0:v]${zoompanFilter(opts.motion, frames, opts.fmt)}[v];${audioFilter}`,
    "-map", "[v]", "-map", "[a]",
    "-frames:v", String(frames),
    "-t", dur.toFixed(3),
    ...ENCODE_ARGS,
    "-movflags", "+faststart",
    opts.out,
  ]);
  return dur;
}

/** Fit a generated video (e.g. Veo) to the target format and scene length, looping if it's too short. */
export async function videoToClip(opts: ClipTiming & { video: string; out: string; fmt: VideoFormat; /** Keep the video's own sound (a speaking character) at its natural length. */ keepAudio?: boolean }): Promise<number> {
  const { width: w, height: h, fps } = opts.fmt;
  const fit = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},fps=${fps},setsar=1,format=yuv420p`;
  if (opts.keepAudio) {
    const dur = await probeDuration(opts.video);
    const hasAudio = (await probeStreams(opts.video)).includes("audio");
    await runFfmpeg([
      "-i", opts.video,
      ...(hasAudio ? [] : ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo"]),
      "-filter_complex", `[0:v]${fit}[v];[${hasAudio ? 0 : 1}:a]aresample=48000,apad[a]`,
      "-map", "[v]", "-map", "[a]", "-t", dur.toFixed(3), ...ENCODE_ARGS, "-movflags", "+faststart", opts.out,
    ]);
    return dur;
  }
  const { dur, audioInput, audioFilter } = await timingArgs(opts);
  // A scene a little longer than the animation: play it slightly slower (smooth) rather than visibly restarting it.
  const src = await probeDuration(opts.video).catch(() => 0);
  const stretch = src > 0 && dur > src && dur <= src * 1.35 ? dur / src : 1;
  await runFfmpeg([
    ...(stretch === 1 ? ["-stream_loop", "-1"] : []), "-i", opts.video,
    ...audioInput,
    "-filter_complex", `[0:v]${stretch === 1 ? "" : `setpts=${stretch.toFixed(4)}*PTS,`}${fit}[v];${audioFilter}`,
    "-map", "[v]", "-map", "[a]",
    "-t", dur.toFixed(3),
    ...ENCODE_ARGS,
    "-movflags", "+faststart",
    opts.out,
  ]);
  return dur;
}

function srtTime(sec: number): string {
  const ms = Math.round(sec * 1000);
  const pad = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function buildSrt(entries: { text: string; duration: number }[]): string {
  let t = 0;
  return entries
    .map((e, i) => {
      const start = t;
      t += e.duration;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(Math.max(start, t - SCENE_TAIL_SEC / 2))}\n${e.text.trim()}\n`;
    })
    .join("\n");
}

/** Concatenate uniform clips into the final MP4, optionally embedding soft subtitles (mov_text). */
export async function concatClips(opts: { clips: string[]; out: string; workDir: string; srt?: string; language?: string; audio?: string; /** Music mixed softly under the clips' own sound. */ bed?: string }): Promise<void> {
  if (opts.bed && !opts.audio) {
    // Join first, then lay the looped music under the clips' own sound (keeping video and subtitles as they are).
    const joined = path.join(opts.workDir, "joined.part.mp4");
    await concatClips({ ...opts, bed: undefined, out: joined });
    const total = (await probeDuration(joined)).toFixed(3);
    const fadeOut = Math.max(0, Number(total) - 2.5).toFixed(3);
    await runFfmpeg([
      "-i", joined, "-stream_loop", "-1", "-i", opts.bed,
      "-filter_complex", `[1:a]aresample=48000,atrim=0:${total},asetpts=N/SR/TB,volume=0.15,afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=2.5[b];[0:a][b]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.95[a]`,
      "-map", "0:v", "-map", "[a]", "-map", "0:s?", "-c:v", "copy", "-c:s", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", opts.out,
    ]);
    await rm(joined, { force: true });
    return;
  }
  const list = path.join(opts.workDir, "concat.txt");
  // Paths in concat lists are relative to the list file; quote-escape per ffmpeg rules.
  const body = opts.clips.map((c) => `file '${path.resolve(c).replace(/'/g, "'\\''")}'`).join("\n") + "\n";
  await writeFile(list, body);
  const args = ["-f", "concat", "-safe", "0", "-i", list];
  // Optional continuous soundtrack (e.g. one song across all scenes) replaces per-clip audio, avoiding seams.
  if (opts.audio) args.push("-i", opts.audio);
  if (opts.srt) args.push("-i", opts.srt);
  args.push("-map", "0:v", "-map", opts.audio ? "1:a" : "0:a");
  if (opts.srt) {
    args.push("-map", `${opts.audio ? 2 : 1}:s`, "-c:s", "mov_text");
    // ffmpeg expects ISO 639-2 codes for the language tag.
    if (opts.language) args.push("-metadata:s:s:0", `language=${opts.language === "am" ? "amh" : "eng"}`);
  }
  args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2");
  if (opts.audio) args.push("-shortest");
  args.push("-movflags", "+faststart", opts.out);
  await runFfmpeg(args);
}
