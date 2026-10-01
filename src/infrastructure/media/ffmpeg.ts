import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AspectRatio, Scene } from "../../domain/project/project.model.js";
import { log } from "../../util/log.js";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

export interface VideoFormat {
  width: number;
  height: number;
  fps: number;
}

export function formatFor(aspect: AspectRatio): VideoFormat {
  return aspect === "9:16" ? { width: 720, height: 1280, fps: 25 } : { width: 1280, height: 720, fps: 25 };
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

export async function assertFfmpegAvailable(): Promise<void> {
  await run(FFMPEG, ["-version"]);
  await run(FFPROBE, ["-version"]);
}

export async function probeDuration(file: string): Promise<number> {
  const out = await run(FFPROBE, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
  const d = Number.parseFloat(out.trim());
  if (!Number.isFinite(d)) throw new Error(`Could not read duration of ${file}`);
  return d;
}

/** Pause after each scene's audio so lines don't run into each other. */
export const SCENE_TAIL_SEC = 0.5;

const ENCODE_ARGS = ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2"];

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
  // Upscale first so the zoom stays smooth (zoompan rounds to integer pixels).
  const up = `scale=${fmt.width * 2}:${fmt.height * 2}:force_original_aspect_ratio=increase,crop=${fmt.width * 2}:${fmt.height * 2}`;
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
export async function videoToClip(opts: ClipTiming & { video: string; out: string; fmt: VideoFormat }): Promise<number> {
  const { dur, audioInput, audioFilter } = await timingArgs(opts);
  const { width: w, height: h, fps } = opts.fmt;
  await runFfmpeg([
    "-stream_loop", "-1", "-i", opts.video,
    ...audioInput,
    "-filter_complex", `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},setsar=1,format=yuv420p[v];${audioFilter}`,
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
export async function concatClips(opts: { clips: string[]; out: string; workDir: string; srt?: string; language?: string; audio?: string }): Promise<void> {
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
