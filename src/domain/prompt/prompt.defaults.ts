/**
 * Built-in prompt templates. These seed the `prompts` table on first run; after that the database copy
 * is what the pipeline uses, so edits in the web UI (Prompts page) take effect on the next run without code changes.
 * "Reset to default" restores the text below.
 */

import { NotFoundError } from "../errors.js";

/** Flags available to every prompt. */
export const PROMPT_FLAGS = ["am", "en", "song", "narration", "veo", "has_character_hint"] as const;

/** Variables available to every prompt. */
export const COMMON_VARS = ["topic", "language_name", "age_range", "style", "scene_count", "character_hint", "safety"] as const;

export interface PromptDefinition {
  key: string;
  title: string;
  description: string;
  /** Extra variables beyond COMMON_VARS. */
  vars: readonly string[];
  template: string;
}

export const DEFAULT_PROMPTS: readonly PromptDefinition[] = [
  {
    key: "safety",
    title: "Safety rules",
    description: "Shared child-safety text, inserted into other prompts as {{safety}}.",
    vars: [],
    template: "The audience is young children: keep everything gentle, kind, safe, non-scary and age-appropriate.",
  },
  {
    key: "poem",
    title: "Poem / lyrics",
    description: "Writes the poem (song lyrics or story verses). Must return JSON {title, stanzas:[{lines}], moral}.",
    vars: ["song_seconds"],
    template: `Write a short, rhythmic {{#if song}}children's song{{else}}rhyming story poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}.
{{#if song}}Exactly {{scene_count}} stanzas of 2 short lines each (the whole song is sung in about {{song_seconds}} seconds).{{else}}Exactly {{scene_count}} stanzas of 2-4 short lines each.{{/if}} Simple vocabulary, repetition, and a positive message.
{{#if am}}Write natively in Amharic using Ge'ez script (not transliteration, not translation-ese).{{/if}}
{{safety}}`,
  },
  {
    key: "scenes",
    title: "Scene plan",
    description: "Splits the poem into scenes with English visual descriptions. Must return JSON {scenes:[{index,text,visualPrompt,motion}]}.",
    vars: ["poem_json", "stanza_count"],
    template: `Turn this children's song into {{stanza_count}} animated film shots, one per stanza, in order, like a modern 3D kids' animated movie.
For each shot: "index" (0-based), "text" = the stanza lines verbatim (joined with newlines, keep the original language),
Every shot takes place OUTDOORS in a sunny, lush green countryside (soft grass, leafy trees, flowers, blue sky) — never indoors. Adapt the action to the outdoors (e.g. washing hands at an outdoor basin or water jug, not a kitchen sink).
"visualPrompt" = a vivid ENGLISH shot description: where exactly we are in that setting, ONE clear, lively action the main character is doing with her hands and body (e.g. scrubbing soapy hands as bubbles float up, running up the hill, hugging a baby goat), her facial expression, and what the animals do. Prefer medium and close-up shots where the character fills much of the frame; vary the shots. Do not describe the main character's appearance (it is added separately); no text in the image.
"motion" = one of zoom-in, zoom-out, pan-left, pan-right, static.
Art style: {{style}}.
{{safety}}

{{poem_json}}`,
  },
  {
    key: "character",
    title: "Character design",
    description: "Designs the main character. Must return JSON {name, description}.",
    vars: ["title"],
    template: `Design one lovable main character for a kids' cartoon titled "{{title}}" about: {{topic}}.
{{#if has_character_hint}}The user wants: {{character_hint}}.{{/if}}
{{#if am}}Give them a short Ethiopian/Amharic name (in Ge'ez script) and make the setting feel Ethiopian where natural.{{/if}}
"description" must be a precise ENGLISH visual description (species/body, colors, clothing, distinctive features) so an illustrator can redraw them identically every time.
Style: {{style}}.
{{safety}}`,
  },
  {
    key: "character_from_image",
    title: "Character from an uploaded picture",
    description: "Describes an uploaded character picture so every scene can redraw it. The picture is attached. Must return JSON {name, description}.",
    vars: ["character_name"],
    template: `The attached picture shows the main character of a kids' cartoon about: {{topic}}.
Name: {{character_name}}
If a name is given above, use it exactly. Otherwise give them a short, friendly name{{#if am}} in Amharic (Ge'ez script){{/if}}.
"description" must be a precise ENGLISH visual description of the character in the picture (species/body, age, skin, hair, eyes, colors, clothing, accessories, distinctive features) so an illustrator can redraw them identically every time. Describe only the character, not the art style or the background.
{{safety}}`,
  },
  {
    key: "character_image",
    title: "Character reference image",
    description: "Image prompt for the character sheet that keeps every scene consistent.",
    vars: ["character_name", "character_description"],
    template: `Character model sheet for a 3D animated kids' movie: {{character_name}}, {{character_description}}.
Full body, front view, friendly expressive pose, big expressive eyes, soft studio lighting, plain light background.
Style: {{style}}. No text. {{safety}}`,
  },
  {
    key: "scene_image",
    title: "Scene illustration",
    description: "Image prompt for each scene. The character sheet is attached as a reference image.",
    vars: ["scene_number", "scene_text", "visual_prompt", "character_name", "character_description"],
    template: `Still frame from a high-quality 3D animated kids' movie. {{visual_prompt}}
The main character is the one in the reference image ({{character_name}}: {{character_description}}); keep her look exactly the same. Medium or close-up shot, she is large in frame, caught in the middle of the action, with a clear, happy facial expression.
Setting: outdoors in a sunny, lush green countryside with soft grass, leafy trees, flowers and blue sky (never indoors).
Cinematic lighting, warm sunlight, shallow depth of field, rich detailed background.
Style: {{style}}. No text, letters or watermarks. {{safety}}`,
  },
  {
    key: "song",
    title: "Song (Lyria 3 Clip)",
    description: "Music prompt for the whole song. {{timed_lyrics}} holds the verses with [m:ss - m:ss] timestamps so scene cuts land on verse boundaries.",
    vars: ["title", "timed_lyrics", "song_seconds"],
    template: `Create a cheerful, bouncy children's song for ages {{age_range}} titled "{{title}}", about {{song_seconds}} seconds long.
Bright, simple melody, ~110 BPM, ukulele, xylophone, light hand percussion, clapping; one clear, warm, friendly vocalist singing slowly and clearly in {{language_name}}.
{{#if am}}Sing in Amharic with natural Ethiopian pronunciation; a light Ethiopian kids'-song flavour (e.g. krar, kebero) is welcome.{{/if}}
Sing exactly these lyrics, at these times, and nothing else:

{{timed_lyrics}}`,
  },
  {
    key: "scene_speech",
    title: "Narration / TTS",
    description: "Text-to-speech instruction per scene (narration mode, or song mode when the provider has no music model).",
    vars: ["scene_number", "scene_text"],
    template: `{{#if song}}Sing this cheerfully as a simple children's song with a bouncy melody{{else}}Read this aloud warmly and slowly, like a storyteller for small children{{/if}}, in {{language_name}}:

{{scene_text}}`,
  },
  {
    key: "scene_video",
    title: "Scene animation (Veo)",
    description: "Video prompt per scene when Visuals = Veo. The character sheet and the scene illustration are attached as reference images so the character looks the same in every clip.",
    vars: ["scene_number", "scene_text", "visual_prompt", "character_name", "character_description"],
    template: `A shot from a high-quality 3D animated kids' movie (Pixar-like), full of life and motion. {{visual_prompt}}
{{character_name}} ({{character_description}}) looks exactly like the character in the reference image in every frame: same face, hair, clothes and colours.
She is clearly animated the whole time: expressive face (smiling, laughing, eyes blinking, looking around), lively hands and body acting out the action, natural movement. The animals move too (walking, nibbling, wagging, hopping). Setting: outdoors in a sunny, lush green countryside (never indoors). Add small living details: bubbles, splashing water, grass and leaves swaying in the breeze, butterflies, light glinting.
Cinematic camera: a smooth slow push-in or gentle tracking move, medium or close-up framing; the character stays in frame.
Style: {{style}}. No speech, no captions, no text. {{safety}}`,
  },
];

export const PROMPT_KEYS = DEFAULT_PROMPTS.map((p) => p.key);

export function findPromptDefinition(key: string): PromptDefinition | undefined {
  return DEFAULT_PROMPTS.find((p) => p.key === key);
}

export function promptDefinition(key: string): PromptDefinition {
  const def = findPromptDefinition(key);
  if (!def) throw new NotFoundError(`Unknown prompt "${key}". Known: ${PROMPT_KEYS.join(", ")}`);
  return def;
}

export function allowedVars(key: string): string[] {
  return [...COMMON_VARS, ...promptDefinition(key).vars];
}
