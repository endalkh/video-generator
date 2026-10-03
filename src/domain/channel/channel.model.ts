import { z } from "zod";

const tidy = (v: string) => v.replace(/\s+/g, " ").trim();
const optionalText = (max: number) =>
  z
    .string()
    .transform(tidy)
    .pipe(z.string().max(max))
    .optional()
    .transform((v) => v || undefined);

/** Channel text language; "both" = bilingual (Amharic and English side by side). */
export const ChannelLanguageSchema = z.enum(["en", "am", "both"]);
export type ChannelLanguage = z.infer<typeof ChannelLanguageSchema>;

/** What the user asks for on the Channel page: a sample photo, a prompt, or both. */
export const ChannelInputSchema = z.object({
  /** Channel name; when empty the AI suggests one. */
  name: optionalText(100),
  /** What the channel is about / how it should look (the prompt). Optional when a sample photo is given. */
  brief: optionalText(2000),
  language: ChannelLanguageSchema.default("en"),
  ageRange: z.string().transform(tidy).default("3-6"),
  style: z.string().transform(tidy).default("colorful 3D animated kids' movie style, Pixar-like, soft cinematic lighting, expressive characters"),
  /** Channel default for new videos and plans: the recurring main character. */
  mainCharacter: optionalText(300),
  /** Channel default for new videos and plans: video length in minutes (½–10). */
  videoMinutes: z.number().min(0.5).max(10).multipleOf(0.5).optional(),
});
export type ChannelInput = z.infer<typeof ChannelInputSchema>;

/** The text YouTube asks for in Customisation → Branding / Basic info. */
export const ChannelDetailsSchema = z.object({
  name: z.string().min(1),
  /** YouTube handle without the leading @. */
  handle: z.string(),
  tagline: z.string().optional(),
  description: z.string().min(1),
  keywords: z.array(z.string()),
});
export type ChannelDetails = z.infer<typeof ChannelDetailsSchema>;

/** YouTube limits: channel name 100, handle 3-30, description 1000, keywords 500 characters in total. */
export const CHANNEL_LIMITS = { name: 100, handle: 30, description: 1000, keywords: 500 } as const;

/** Clamp model output (or user edits) to what YouTube accepts. */
export function normalizeChannelDetails(d: ChannelDetails): ChannelDetails {
  const name = tidy(d.name).slice(0, CHANNEL_LIMITS.name);
  const handleBase = (d.handle || name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/^@+/, "")
    .replace(/[^A-Za-z0-9._-]+/g, "")
    .slice(0, CHANNEL_LIMITS.handle);
  const handle = handleBase.length >= 3 ? handleBase : `${handleBase}kids`.slice(0, CHANNEL_LIMITS.handle).padEnd(3, "0");
  const keywords: string[] = [];
  let total = 0;
  for (const k of d.keywords.map(tidy).filter(Boolean)) {
    if (keywords.some((x) => x.toLowerCase() === k.toLowerCase())) continue;
    if (total + k.length + 1 > CHANNEL_LIMITS.keywords) break;
    keywords.push(k);
    total += k.length + 1;
  }
  const tagline = d.tagline ? tidy(d.tagline) : undefined;
  return { name, handle, ...(tagline ? { tagline } : {}), description: d.description.trim().slice(0, CHANNEL_LIMITS.description), keywords };
}

export const CHANNEL_IMAGE_ASSETS = ["logo", "banner", "watermark", "thumbnail"] as const;
export type ChannelImageAsset = (typeof CHANNEL_IMAGE_ASSETS)[number];
export const CHANNEL_ASSETS = ["details", ...CHANNEL_IMAGE_ASSETS] as const;
export type ChannelAsset = (typeof CHANNEL_ASSETS)[number];

export interface ChannelImageSpec {
  file: string;
  width: number;
  height: number;
  /** Aspect ratio requested from the image model (null = derived from another asset, no AI call). */
  aspectRatio: "1:1" | "16:9" | null;
  /** YouTube's upload size limit for this asset. */
  maxBytes: number;
}

/** Sizes and limits from YouTube's channel branding guidelines. */
export const CHANNEL_IMAGE_SPECS: Record<ChannelImageAsset, ChannelImageSpec> = {
  /** Profile picture: 800×800, shown as a circle (down to 98×98). Max 4 MB. */
  logo: { file: "logo.png", width: 800, height: 800, aspectRatio: "1:1", maxBytes: 4 * 1024 * 1024 },
  /** Banner: 2560×1440, text/logo safe area 1546×423 in the middle. Max 6 MB. */
  banner: { file: "banner.jpg", width: 2560, height: 1440, aspectRatio: "16:9", maxBytes: 6 * 1024 * 1024 },
  /** Video watermark: 150×150, max 1 MB. Made from the logo. */
  watermark: { file: "watermark.png", width: 150, height: 150, aspectRatio: null, maxBytes: 1024 * 1024 },
  /** Video thumbnail: 1280×720, max 2 MB. */
  thumbnail: { file: "thumbnail.jpg", width: 1280, height: 720, aspectRatio: "16:9", maxBytes: 2 * 1024 * 1024 },
};

/** The banner's safe area (visible on every device). */
export const BANNER_SAFE_AREA = { width: 1546, height: 423 } as const;
