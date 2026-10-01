import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";

export async function ensureDir(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    const s = await stat(file);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/** Write atomically (tmp file + rename) so an interrupted run never leaves a half-written checkpoint. */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

export async function readJson<T extends z.ZodType>(file: string, schema: T): Promise<z.infer<T>> {
  const raw = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in ${file}: ${(err as Error).message}`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`Schema validation failed for ${file}: ${result.error.message}`);
  }
  return result.data;
}

/** ASCII slug; falls back to a hash-like suffix for non-Latin topics (e.g. Amharic). */
export function slugify(text: string, maxLen = 40): string {
  const ascii = text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Cut at a word boundary so ids don't end in half a word.
  const cut = ascii.length <= maxLen ? ascii : ascii.slice(0, maxLen + 1).replace(/-[^-]*$/, "") || ascii.slice(0, maxLen);
  if (cut.length >= 3) return cut;
  let h = 0;
  for (const ch of text) h = (Math.imul(h, 31) + ch.codePointAt(0)!) >>> 0;
  return `project-${h.toString(36)}`;
}
