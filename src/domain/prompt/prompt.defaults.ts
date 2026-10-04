/**
 * Built-in prompt templates. These seed the `prompts` table on first run; after that the database copy
 * is what the pipeline uses, so edits in the web UI (Prompts page) take effect on the next run without code changes.
 * "Reset to default" restores the text below.
 */

import { NotFoundError } from "../errors.js";

/** Flags available to every prompt. The has_reference / has_channel_name / has_title flags are only set on the Channel page. */
export const PROMPT_FLAGS = ["am", "en", "song", "narration", "music_voice", "character_voice", "veo", "has_character_hint", "has_reference", "has_channel_name", "has_title", "has_audio_request"] as const;

/** Variables available to every prompt. */
export const COMMON_VARS = ["topic", "language_name", "age_range", "style", "scene_count", "character_hint", "safety", "syllables_per_line", "letters_per_line", "video_seconds", "singer", "voice_style", "audio_request"] as const;

export interface PromptDefinition {
  key: string;
  title: string;
  description: string;
  /** Extra variables beyond COMMON_VARS. */
  vars: readonly string[];
  template: string;
  /** Earlier built-in templates; a stored prompt still equal to one of them was never edited and is upgraded on startup. */
  previousTemplates?: readonly string[];
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
    template: `Write a rhythmic {{#if song}}children's song{{else}}rhyming children's poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}.
{{#if song}}Exactly {{scene_count}} stanzas of 2 short lines each (the whole song is sung in about {{song_seconds}} seconds), short enough to sing slowly and clearly. Repeat a simple chorus line every few stanzas.{{/if}}{{#if narration}}Exactly {{scene_count}} stanzas of 4 short lines each (the whole story is read aloud slowly in about {{video_seconds}} seconds). Tell one story from beginning to end, one step per stanza.{{/if}}{{#if music_voice}}Exactly {{scene_count}} stanzas of 4 short lines each, chanted like a nursery rhyme with a steady, bouncy beat over music (about {{video_seconds}} seconds in all). Tell one story from beginning to end, one step per stanza.{{/if}}{{#if character_voice}}Exactly {{scene_count}} stanzas of 2 short lines each. The main character says each stanza herself, looking at the camera, in one 8-second shot, so each stanza is something she says out loud (talking to the children watching), slowly and clearly. Tell one story from beginning to end, one step per stanza.{{/if}}
{{#if en}}Each line has at most {{syllables_per_line}} syllables.{{/if}}{{#if am}}Each line has about {{letters_per_line}} Ge'ez letters (fidel), never more than {{letters_per_line}} + 2.{{/if}}
Simple vocabulary, repetition, and a positive message.
{{#if am}}Write a real Amharic children's ግጥም, natively in Ge'ez script (not transliteration, not a translation from English):
- ቤት (rhyme): the lines of each stanza end on the same sound, the same last syllable (for example ተነሳች / ታጠበች, ሳሙና / ጤና), like traditional Amharic poems and children's songs.
- Every stanza is one complete sentence or thought that makes sense on its own, because each stanza is shown on its own picture. Never let a sentence run on into the next stanza.
- Everyday spoken Amharic a small child understands, with correct grammar: verbs agree with the subject (a girl: ተነሳች, ታጠበች; a boy: ተነሳ, ታጠበ). No old Ge'ez, church or bookish words.
- All lines about the same length, so the rhythm is steady and easy to clap to. A short አዝማች (refrain) that comes back is welcome.{{/if}}
{{safety}}`,
    /** Earlier built-in versions: a prompt still on one of these (never edited) is upgraded automatically. */
    previousTemplates: [`Write a rhythmic {{#if song}}children's song{{else}}rhyming children's poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}.
{{#if song}}Exactly {{scene_count}} stanzas of 2 short lines each (the whole song is sung in about {{song_seconds}} seconds), short enough to sing slowly and clearly. Repeat a simple chorus line every few stanzas.{{/if}}{{#if narration}}Exactly {{scene_count}} stanzas of 4 short lines each (the whole story is read aloud slowly in about {{video_seconds}} seconds). Tell one story from beginning to end, one step per stanza.{{/if}}{{#if music_voice}}Exactly {{scene_count}} stanzas of 4 short lines each, chanted like a nursery rhyme with a steady, bouncy beat over music (about {{video_seconds}} seconds in all). Tell one story from beginning to end, one step per stanza.{{/if}}
{{#if en}}Each line has at most {{syllables_per_line}} syllables.{{/if}}{{#if am}}Each line has about {{letters_per_line}} Ge'ez letters (fidel), never more than {{letters_per_line}} + 2.{{/if}}
Simple vocabulary, repetition, and a positive message.
{{#if am}}Write a real Amharic children's ግጥም, natively in Ge'ez script (not transliteration, not a translation from English):
- ቤት (rhyme): the lines of each stanza end on the same sound, the same last syllable (for example ተነሳች / ታጠበች, ሳሙና / ጤና), like traditional Amharic poems and children's songs.
- Every stanza is one complete sentence or thought that makes sense on its own, because each stanza is shown on its own picture. Never let a sentence run on into the next stanza.
- Everyday spoken Amharic a small child understands, with correct grammar: verbs agree with the subject (a girl: ተነሳች, ታጠበች; a boy: ተነሳ, ታጠበ). No old Ge'ez, church or bookish words.
- All lines about the same length, so the rhythm is steady and easy to clap to. A short አዝማች (refrain) that comes back is welcome.{{/if}}
{{safety}}`, `Write a rhythmic {{#if song}}children's song{{else}}rhyming story poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}.
{{#if song}}Exactly {{scene_count}} stanzas of 2 short lines each (the whole song is sung in about {{song_seconds}} seconds), so each line has at most {{syllables_per_line}} syllables (in Ge'ez script, about one letter per syllable): short enough to sing slowly and clearly. Repeat a simple chorus line every few stanzas.{{else}}Exactly {{scene_count}} stanzas of 4 short lines each (the whole story is read aloud slowly in about {{video_seconds}} seconds), so each line has about {{syllables_per_line}} syllables (in Ge'ez script, about one letter per syllable). Tell one story from beginning to end, one step per stanza.{{/if}} Simple vocabulary, repetition, and a positive message.
{{#if am}}Write natively in Amharic using Ge'ez script (not transliteration, not translation-ese).{{/if}}
{{safety}}`, `Write a short, rhythmic {{#if song}}children's song{{else}}rhyming story poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}.
{{#if song}}Exactly {{scene_count}} stanzas of 2 short lines each (the whole song is sung in about {{song_seconds}} seconds), so each line has at most {{syllables_per_line}} syllables (in Ge'ez script, about one letter per syllable): short enough to sing slowly and clearly. Repeat a simple chorus line.{{else}}Exactly {{scene_count}} stanzas of 2-4 short lines each.{{/if}} Simple vocabulary, repetition, and a positive message.
{{#if am}}Write natively in Amharic using Ge'ez script (not transliteration, not translation-ese).{{/if}}
{{safety}}`, `Write a short, rhythmic {{#if song}}children's song{{else}}rhyming story poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}.
{{#if song}}Exactly {{scene_count}} stanzas of 2 short lines each (the whole song is sung in about {{song_seconds}} seconds).{{else}}Exactly {{scene_count}} stanzas of 2-4 short lines each.{{/if}} Simple vocabulary, repetition, and a positive message.
{{#if am}}Write natively in Amharic using Ge'ez script (not transliteration, not translation-ese).{{/if}}
{{safety}}`],
  },
  {
    key: "poem_stanza",
    title: "Rewrite one stanza",
    description: "Poem and Scenes pages: writes ONE stanza (scene) again, keeping the rest of the poem. {{poem_text}} is the whole poem with numbered stanzas, {{hint}} what the parent wants changed. Must return JSON {lines}.",
    vars: ["title", "poem_text", "stanza_number", "stanza_text", "line_count", "hint"],
    template: `Rewrite ONE stanza of this {{#if song}}children's song{{else}}rhyming children's poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}. Title: "{{title}}".

The whole poem (stanza {{stanza_number}} is the one to rewrite):
{{poem_text}}

Write a new stanza {{stanza_number}} to replace:
{{stanza_text}}

It must fit between the stanzas around it: the same rhythm and tone, and the story keeps going in the same order. Exactly {{line_count}} short lines{{#if en}}, each with at most {{syllables_per_line}} syllables{{/if}}{{#if am}}, each with about {{letters_per_line}} Ge'ez letters (fidel){{/if}}{{#if song}}, easy to sing slowly and clearly{{/if}}. If the poem has a chorus line and this stanza had it, keep it.
What the parent wants changed: {{hint}}
{{#if am}}Write a real Amharic children's ግጥም, natively in Ge'ez script (not transliteration, not a translation from English):
- ቤት (rhyme): the lines of each stanza end on the same sound, the same last syllable (for example ተነሳች / ታጠበች, ሳሙና / ጤና), like traditional Amharic poems and children's songs.
- Every stanza is one complete sentence or thought that makes sense on its own, because each stanza is shown on its own picture. Never let a sentence run on into the next stanza.
- Everyday spoken Amharic a small child understands, with correct grammar: verbs agree with the subject (a girl: ተነሳች, ታጠበች; a boy: ተነሳ, ታጠበ). No old Ge'ez, church or bookish words.
- All lines about the same length, so the rhythm is steady and easy to clap to. A short አዝማች (refrain) that comes back is welcome.{{/if}}
Return only the new stanza's lines; don't repeat the old one.
{{safety}}`,
    previousTemplates: [`Rewrite ONE stanza of this {{#if song}}children's song{{else}}rhyming story poem{{/if}} in {{language_name}} for children aged {{age_range}}.
Topic: {{topic}}. Title: "{{title}}".

The whole poem (stanza {{stanza_number}} is the one to rewrite):
{{poem_text}}

Write a new stanza {{stanza_number}} to replace:
{{stanza_text}}

It must fit between the stanzas around it: the same rhythm, rhyme style and tone, and the story keeps going in the same order. Exactly {{line_count}} short lines, each with at most {{syllables_per_line}} syllables (in Ge'ez script, about one letter per syllable){{#if song}}, easy to sing slowly and clearly{{/if}}. If the poem has a chorus line and this stanza had it, keep it.
What the parent wants changed: {{hint}}
{{#if am}}Write natively in Amharic using Ge'ez script (not transliteration, not translation-ese).{{/if}}
Return only the new stanza's lines; don't repeat the old one.
{{safety}}`],
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
    title: "Song (Lyria)",
    description: "Music prompt for the song. {{timed_lyrics}} holds the verses with [m:ss - m:ss] timestamps so scene cuts land on verse boundaries. Songs longer than the model allows (~3 min, or 30 s for Lyria 3 Clip) are made in parts that are joined; {{part_note}} tells each part how it fits (empty for a one-part song).",
    vars: ["title", "timed_lyrics", "song_seconds", "part_note"],
    template: `Create a cheerful, bouncy children's song for ages {{age_range}} titled "{{title}}", about {{song_seconds}} seconds long.
Bright, simple melody, ~100 BPM, ukulele, xylophone, light hand percussion, clapping; {{singer}} singing slowly and clearly in {{language_name}}, one syllable per note, never rushing the words.
{{#if am}}The singer is a native Amharic-speaking Ethiopian vocalist with natural Ethiopian pronunciation (ejective consonants, gemination); a light Ethiopian kids'-song flavour (krar, kebero) is welcome.
ይህ የልጆች ዘፈን በአማርኛ፣ በግልጽ እና ቀስ ብሎ ይዘመር።{{/if}}
{{part_note}}
{{#if has_audio_request}}Extra wishes from the parent (follow them unless they break the rules above): {{audio_request}}{{/if}}
Sing exactly these lyrics, at these times, and nothing else:

{{timed_lyrics}}`,
    previousTemplates: [`Create a cheerful, bouncy children's song for ages {{age_range}} titled "{{title}}", about {{song_seconds}} seconds long.
Bright, simple melody, ~100 BPM, ukulele, xylophone, light hand percussion, clapping; {{singer}} singing slowly and clearly in {{language_name}}, one syllable per note, never rushing the words.
{{#if am}}The singer is a native Amharic-speaking Ethiopian vocalist with natural Ethiopian pronunciation (ejective consonants, gemination); a light Ethiopian kids'-song flavour (krar, kebero) is welcome.
ይህ የልጆች ዘፈን በአማርኛ፣ በግልጽ እና ቀስ ብሎ ይዘመር።{{/if}}
{{part_note}}
Sing exactly these lyrics, at these times, and nothing else:

{{timed_lyrics}}`, `Create a cheerful, bouncy children's song for ages {{age_range}} titled "{{title}}", about {{song_seconds}} seconds long.
Bright, simple melody, ~100 BPM, ukulele, xylophone, light hand percussion, clapping; one clear, warm, friendly vocalist singing slowly and clearly in {{language_name}}, one syllable per note, never rushing the words.
{{#if am}}The singer is a native Amharic-speaking Ethiopian vocalist with natural Ethiopian pronunciation (ejective consonants, gemination); a light Ethiopian kids'-song flavour (krar, kebero) is welcome.
ይህ የልጆች ዘፈን በአማርኛ፣ በግልጽ እና ቀስ ብሎ ይዘመር።{{/if}}
{{part_note}}
Sing exactly these lyrics, at these times, and nothing else:

{{timed_lyrics}}`, `Create a cheerful, bouncy children's song for ages {{age_range}} titled "{{title}}", about {{song_seconds}} seconds long.
Bright, simple melody, ~100 BPM, ukulele, xylophone, light hand percussion, clapping; one clear, warm, friendly vocalist singing slowly and clearly in {{language_name}}, one syllable per note, never rushing the words.
{{#if am}}The singer is a native Amharic-speaking Ethiopian vocalist with natural Ethiopian pronunciation (ejective consonants, gemination); a light Ethiopian kids'-song flavour (krar, kebero) is welcome.
ይህ የልጆች ዘፈን በአማርኛ፣ በግልጽ እና ቀስ ብሎ ይዘመር።{{/if}}
Sing exactly these lyrics, at these times, and nothing else:

{{timed_lyrics}}`, `Create a cheerful, bouncy children's song for ages {{age_range}} titled "{{title}}", about {{song_seconds}} seconds long.
Bright, simple melody, ~110 BPM, ukulele, xylophone, light hand percussion, clapping; one clear, warm, friendly vocalist singing slowly and clearly in {{language_name}}.
{{#if am}}Sing in Amharic with natural Ethiopian pronunciation; a light Ethiopian kids'-song flavour (e.g. krar, kebero) is welcome.{{/if}}
Sing exactly these lyrics, at these times, and nothing else:

{{timed_lyrics}}`],
  },
  {
    key: "music_bed",
    title: "Music under the voice",
    description: "Voice over music mode: the instrumental music played under the chanted rhyme. No singing, so it works for any language. It is looped to the video length and played quietly under the voice.",
    vars: ["title", "song_seconds"],
    template: `Instrumental background music for a children's nursery-rhyme video titled "{{title}}" (ages {{age_range}}), about {{song_seconds}} seconds long.
Cheerful, warm and bouncy, ~100 BPM, simple and steady so a voice can chant a rhyme over it: ukulele, xylophone, soft hand percussion and light clapping.
{{#if am}}A light Ethiopian kids'-music flavour (krar, kebero, masinko) is welcome.{{/if}}
Instrumental only: no vocals, no singing, no humming, no spoken words. Even volume, no big drops or solos, so it loops well.
{{#if has_audio_request}}Extra wishes from the parent (follow them unless they break the rules above): {{audio_request}}{{/if}}`,
    previousTemplates: [`Instrumental background music for a children's nursery-rhyme video titled "{{title}}" (ages {{age_range}}), about {{song_seconds}} seconds long.
Cheerful, warm and bouncy, ~100 BPM, simple and steady so a voice can chant a rhyme over it: ukulele, xylophone, soft hand percussion and light clapping.
{{#if am}}A light Ethiopian kids'-music flavour (krar, kebero, masinko) is welcome.{{/if}}
Instrumental only: no vocals, no singing, no humming, no spoken words. Even volume, no big drops or solos, so it loops well.`],
  },
  {
    key: "scene_speech",
    title: "Narration / TTS",
    description: "Text-to-speech instruction per scene: narration, voice over music (chanted like a nursery rhyme over the music), or song mode when the provider has no music model. {{voice_style}} is the chosen singer/voice.",
    vars: ["scene_number", "scene_text"],
    template: `{{#if song}}Sing this cheerfully as a simple children's song with a bouncy melody{{/if}}{{#if narration}}Read this aloud warmly and slowly, like a storyteller for small children{{/if}}{{#if music_voice}}Say this as a lively children's nursery rhyme with a steady, bouncy beat (it is played over cheerful music), slowly and very clearly, with a short pause at the end of each line{{/if}}, in {{language_name}}, in the voice of {{voice_style}}{{#if am}}, with natural native Ethiopian Amharic pronunciation{{/if}}{{#if has_audio_request}}, and: {{audio_request}}{{/if}}:

{{scene_text}}`,
    previousTemplates: [`{{#if song}}Sing this cheerfully as a simple children's song with a bouncy melody{{/if}}{{#if narration}}Read this aloud warmly and slowly, like a storyteller for small children{{/if}}{{#if music_voice}}Say this as a lively children's nursery rhyme with a steady, bouncy beat (it is played over cheerful music), slowly and very clearly, with a short pause at the end of each line{{/if}}, in {{language_name}}, in the voice of {{voice_style}}{{#if am}}, with natural native Ethiopian Amharic pronunciation{{/if}}:

{{scene_text}}`, `{{#if song}}Sing this cheerfully as a simple children's song with a bouncy melody{{else}}Read this aloud warmly and slowly, like a storyteller for small children{{/if}}, in {{language_name}}:

{{scene_text}}`],
  },
  {
    key: "scene_video",
    title: "Scene animation (Veo)",
    description: "Video prompt per scene when Visuals = Veo. The character sheet and the scene illustration are attached as reference images so the character looks the same in every clip.",
    vars: ["scene_number", "scene_text", "visual_prompt", "character_name", "character_description"],
    template: `A shot from a high-quality 3D animated kids' movie (Pixar-like), full of life and motion. {{visual_prompt}}
{{character_name}} ({{character_description}}) looks exactly like the character in the reference image in every frame: same face, hair, clothes and colours.
She is clearly animated the whole time: expressive face (smiling, laughing, eyes blinking, looking around), lively hands and body acting out the action, natural movement. The animals move too (walking, nibbling, wagging, hopping). Setting: outdoors in a sunny, lush green countryside (never indoors). Add small living details: bubbles, splashing water, grass and leaves swaying in the breeze, butterflies, light glinting.
{{#if song}}A cheerful children's song is playing and she is singing along to it, singing these words: "{{scene_text}}". Her mouth moves as she sings, she smiles and sways and claps gently to the beat (~100 BPM), and acts out the words.{{/if}}{{#if music_voice}}A cheerful nursery rhyme is playing and she is chanting along to it: "{{scene_text}}". Her mouth moves with the words, she sways and claps gently to the beat and acts out the words.{{/if}}{{#if narration}}A storyteller (not shown) is telling this part of the story: "{{scene_text}}". She acts it out with her face, hands and body, but she does not talk.{{/if}}{{#if character_voice}}She speaks to the camera in {{language_name}}, in the voice of {{voice_style}}, saying exactly these words, slowly and clearly, with her lips in sync: "{{scene_text}}". Only her voice and soft natural sounds of the scene (birds, water, breeze); no music, no other voices.{{/if}}
Cinematic camera: a smooth slow push-in or gentle tracking move, medium or close-up framing; the character stays in frame.
Style: {{style}}. {{#if character_voice}}No captions, no text.{{else}}No speech, no captions, no text.{{/if}} {{safety}}`,
    previousTemplates: [`A shot from a high-quality 3D animated kids' movie (Pixar-like), full of life and motion. {{visual_prompt}}
{{character_name}} ({{character_description}}) looks exactly like the character in the reference image in every frame: same face, hair, clothes and colours.
She is clearly animated the whole time: expressive face (smiling, laughing, eyes blinking, looking around), lively hands and body acting out the action, natural movement. The animals move too (walking, nibbling, wagging, hopping). Setting: outdoors in a sunny, lush green countryside (never indoors). Add small living details: bubbles, splashing water, grass and leaves swaying in the breeze, butterflies, light glinting.
Cinematic camera: a smooth slow push-in or gentle tracking move, medium or close-up framing; the character stays in frame.
Style: {{style}}. No speech, no captions, no text. {{safety}}`],
  },
  {
    key: "video_publish",
    title: "YouTube upload: title, description, tags",
    description: "Final video page: writes the YouTube title, description, tags and thumbnail words for the finished video. {{lyrics}} are the words of the video. Must return JSON {title, description, tags, thumbnailTitle}.",
    vars: ["title", "lyrics", "channel_name", "channel_handle", "video_length"],
    template: `Write the YouTube upload text for a finished kids' video{{#if has_channel_name}} on the channel "{{channel_name}}" (YouTube handle: {{channel_handle}}){{/if}}.
Working title: "{{title}}". Topic: {{topic}}. Audience: children aged {{age_range}} and their parents. Length: {{video_length}}.
The words of the video:
{{lyrics}}

"title" = a catchy YouTube title in {{language_name}}, at most 70 characters, with the main keyword near the start. Honest (no clickbait), no ALL CAPS, at most one emoji.
"description" = in {{language_name}}: a warm first line (a hook with the main keyword); 2-3 short sentences for parents about what the child sees and learns; then the words of the video under a short heading (lyrics or story); then a friendly invitation to subscribe{{#if has_channel_name}} to {{channel_name}}{{/if}}; end with 3 hashtags. Under 1500 characters. No links.
"tags" = 12-20 search tags, most important first, without #.{{#if am}} Mix three kinds: Amharic in Ge'ez script (e.g. "የልጆች መዝሙር"); the same Amharic phrases written in English letters the way Ethiopians type them when searching (e.g. "ye lijoch mezmur", "Ye lijoch song", "konjo zefen"); and a few in English (e.g. "amharic kids songs").{{else}} In {{language_name}}.{{/if}}
"thumbnailTitle" = 2-4 big, simple words for the thumbnail, in {{language_name}}.
{{safety}}`,
    previousTemplates: [`Write the YouTube upload text for a finished kids' video{{#if has_channel_name}} on the channel "{{channel_name}}" (YouTube handle: {{channel_handle}}){{/if}}.
Working title: "{{title}}". Topic: {{topic}}. Audience: children aged {{age_range}} and their parents. Length: {{video_length}}.
The words of the video:
{{lyrics}}

"title" = a catchy YouTube title in {{language_name}}, at most 70 characters, with the main keyword near the start. Honest (no clickbait), no ALL CAPS, at most one emoji.
"description" = in {{language_name}}: a warm first line (a hook with the main keyword); 2-3 short sentences for parents about what the child sees and learns; then the words of the video under a short heading (lyrics or story); then a friendly invitation to subscribe{{#if has_channel_name}} to {{channel_name}}{{/if}}; end with 3 hashtags. Under 1500 characters. No links.
"tags" = 12-20 search tags in {{language_name}}{{#if am}} plus some in English{{/if}}, most important first, without #.
"thumbnailTitle" = 2-4 big, simple words for the thumbnail, in {{language_name}}.
{{safety}}`],
  },
  {
    key: "video_thumbnail",
    title: "YouTube upload: video thumbnail",
    description: "Final video page: image prompt for the 1280×720 thumbnail of the finished video. The character sheet and a scene picture are attached as references.",
    vars: ["thumbnail_title", "character_name", "character_description", "channel_name"],
    template: `Design an eye-catching YouTube video thumbnail (16:9) for a kids' video{{#if has_channel_name}} from the channel "{{channel_name}}"{{/if}} about: {{topic}}.
Feature {{character_name}} ({{character_description}}) looking exactly like the character in the attached reference pictures (same face, hair, clothes and colours), large, close-up and very expressive, in a moment from the video like the attached scene.
{{#if has_title}}Add the title "{{thumbnail_title}}" in big, bold, rounded, high-contrast letters with a thick outline, spelled exactly, on one side.{{else}}Leave clear empty space on one side; no text.{{/if}}
Bright saturated colours, a simple background, easy to read at small size. No YouTube logos, play buttons or watermarks.
Style: {{style}}. {{safety}}`,
  },
  {
    key: "channel_details",
    title: "YouTube channel: name & description",
    description: "Channel page. Writes the channel name, handle, tagline, description and keywords. {{topic}} is the channel brief; the sample photo is attached when there is one. Must return JSON {name, handle, tagline, description, keywords}.",
    vars: ["channel_name"],
    template: `Write the YouTube channel branding text for a kids' channel.
What the channel is about: {{topic}}
Audience: children aged {{age_range}} and their parents.
{{#if has_channel_name}}The channel name is "{{channel_name}}": use it exactly as "name".{{else}}"name" = invent a short, catchy, easy-to-say channel name in {{language_name}}.{{/if}}
{{#if has_reference}}The attached picture is the channel's sample photo (its mascot, main character or look); let it inspire the name and the tone.{{/if}}
"handle" = a matching YouTube handle in Latin letters: 3-30 characters, only letters, numbers, dots, underscores or hyphens, no @ and no spaces.
"tagline" = a short slogan (at most 8 words) in {{language_name}}.
"description" = the channel description in {{language_name}}: 2-3 short, warm paragraphs, under 900 characters in total, saying what children will watch and learn and inviting parents to subscribe. No links, no hashtags.
"keywords" = 10-15 search keywords or short phrases (in {{language_name}}{{#if am}}, plus a few in English{{/if}}).
{{safety}}`,
  },
  {
    key: "channel_logo",
    title: "YouTube channel: logo (profile picture)",
    description: "Channel page. Image prompt for the 800×800 profile picture, which YouTube shows as a small circle. The sample photo is attached when there is one.",
    vars: ["channel_name"],
    template: `Design a YouTube channel profile picture (logo) for a kids' channel{{#if has_channel_name}} called "{{channel_name}}"{{/if}}.
The channel is about: {{topic}}.
{{#if has_reference}}Base it on the attached sample photo: keep its main subject recognisable (same face or character, colours and features) and turn it into a clean, friendly mascot logo.{{else}}Create one lovable mascot character or a simple emblem that fits the channel.{{/if}}
Square image with one bold subject centred and filling the middle, so it still reads well when cropped to a circle and shown tiny (98 pixels): big simple shapes, bright cheerful colours, strong contrast, a plain softly coloured background. No small details, no text, no letters.
Style: {{style}}. {{safety}}`,
  },
  {
    key: "channel_banner",
    title: "YouTube channel: banner",
    description: "Channel page. Image prompt for the 2560×1440 banner. YouTube crops it per device, so the name and mascot must stay in the central safe area. The sample photo and logo are attached when they exist.",
    vars: ["channel_name"],
    template: `Design a wide YouTube channel banner (channel art) for a kids' channel{{#if has_channel_name}} called "{{channel_name}}"{{/if}}.
The channel is about: {{topic}}.
{{#if has_reference}}The attached picture(s) show the channel's mascot / logo: feature the same character or subject, looking exactly as shown.{{/if}}
IMPORTANT layout: YouTube crops this banner differently on TVs, computers and phones. Put everything important (the {{#if has_channel_name}}channel name and the {{/if}}main character) inside a central horizontal strip: the middle 60% of the width and the middle 30% of the height. Outside that strip, only a continuous decorative background (sky, rolling hills, playful shapes) that can be cut away without losing anything.
{{#if has_channel_name}}Write the channel name "{{channel_name}}" once, large, in bold, rounded, playful letters, spelled exactly.{{else}}No text, no letters.{{/if}}
Bright, cheerful, uncluttered. No YouTube logos, buttons or watermarks.
Style: {{style}}. {{safety}}`,
  },
  {
    key: "channel_thumbnail",
    title: "YouTube channel: video thumbnail",
    description: "Channel page. Image prompt for a 1280×720 video thumbnail in the channel's look. {{thumbnail_title}} is the text typed on the Channel page. The sample photo and logo are attached when they exist.",
    vars: ["channel_name", "thumbnail_title"],
    template: `Design an eye-catching YouTube video thumbnail for a kids' channel{{#if has_channel_name}} called "{{channel_name}}"{{/if}} about: {{topic}}.
{{#if has_reference}}Feature the character / mascot from the attached picture(s), looking exactly as shown, large, close-up and very expressive.{{else}}Feature one lovable, very expressive character, large and close-up.{{/if}}
{{#if has_title}}Add the title "{{thumbnail_title}}" in big, bold, rounded, high-contrast letters with a thick outline, spelled exactly, on one side.{{else}}Leave clear empty space on one side for a title; no text.{{/if}}
Bright saturated colours, a simple background, easy to read at small size. No YouTube logos, play buttons or watermarks.
Style: {{style}}. {{safety}}`,
  },
  {
    key: "content_plan",
    title: "Monthly ideas & schedule",
    description: "Ideas & schedule page. Plans one video per posting slot for a month. {{topic}} is what the channel is about, {{schedule}} lists the dates with each video's language. Must return JSON {theme, ideas:[{title, topic, lesson, audioMode, sceneCount, thumbnailTitle, videoDescription, tags}]} with one idea per slot, in order.",
    vars: ["month_name", "channel_name", "schedule", "video_count", "notes", "previous_topics", "video_length"],
    template: `Plan {{month_name}} for a YouTube kids' channel{{#if has_channel_name}} called "{{channel_name}}"{{/if}}.
What the channel is about: {{topic}}
Audience: children aged {{age_range}} and their parents.
{{#if has_character_hint}}Every video stars the same main character: {{character_hint}}.{{/if}}
Each video is an animated song or story made with an app: it writes a poem from the topic, plans scenes, draws the character and makes the song or a narration. Each video is {{video_length}} long, so pick topics with enough to say for that length.

Plan exactly {{video_count}} videos, one per posting slot below, in the same order:
{{schedule}}

For each video:
"title" = a short, catchy YouTube title in the slot's language (at most 60 characters).
"topic" = exactly what to type in the app's "What is the video about?" field, in the slot's language: one or two sentences naming the subject, the one lesson, and where it happens (outdoors), e.g. "Washing hands with soap before eating, by the water jug in the garden".
"lesson" = the one habit, skill or value it teaches, in English (for the planner).
"audioMode" = "song" for catchy sing-along topics (most videos), "narration" for small stories.
"sceneCount" = 3 to 6.
"thumbnailTitle" = 2 to 4 big words for the thumbnail, in the slot's language.
"videoDescription" = the YouTube description in the slot's language: 2 short sentences for parents about what the child learns, then an invitation to subscribe. No links.
"tags" = 8 to 12 search tags in the slot's language{{#if am}}; for Amharic slots, also the key Amharic phrases written in English letters the way Ethiopians search (e.g. "ye lijoch mezmur", "Ye lijoch song"), plus a few in English{{/if}}.

Make the month varied and balanced: good habits, feelings and kindness, numbers and letters, colours and shapes, animals and nature, family and friends. Build a gentle weekly rhythm and repeat favourite formats, but never repeat a topic.
{{#if am}}Where it fits naturally, include Ethiopian holidays and seasons that fall in this month (for example Enkutatash, Meskel, Genna, Timkat, Fasika, the rainy season or harvest), placed in the slots just before the date.{{/if}}
Special requests for this month: {{notes}}
Topics already used in earlier months (do not repeat them): {{previous_topics}}
"theme" = a short name for the month's overall theme.
{{safety}}`,
    previousTemplates: [`Plan {{month_name}} for a YouTube kids' channel{{#if has_channel_name}} called "{{channel_name}}"{{/if}}.
What the channel is about: {{topic}}
Audience: children aged {{age_range}} and their parents.
{{#if has_character_hint}}Every video stars the same main character: {{character_hint}}.{{/if}}
Each video is an animated song or story made with an app: it writes a poem from the topic, plans scenes, draws the character and makes the song or a narration. Each video is {{video_length}} long, so pick topics with enough to say for that length.

Plan exactly {{video_count}} videos, one per posting slot below, in the same order:
{{schedule}}

For each video:
"title" = a short, catchy YouTube title in the slot's language (at most 60 characters).
"topic" = exactly what to type in the app's "What is the video about?" field, in the slot's language: one or two sentences naming the subject, the one lesson, and where it happens (outdoors), e.g. "Washing hands with soap before eating, by the water jug in the garden".
"lesson" = the one habit, skill or value it teaches, in English (for the planner).
"audioMode" = "song" for catchy sing-along topics (most videos), "narration" for small stories.
"sceneCount" = 3 to 6.
"thumbnailTitle" = 2 to 4 big words for the thumbnail, in the slot's language.
"videoDescription" = the YouTube description in the slot's language: 2 short sentences for parents about what the child learns, then an invitation to subscribe. No links.
"tags" = 8 to 12 search tags (in the slot's language{{#if am}}, plus a few in English{{/if}}).

Make the month varied and balanced: good habits, feelings and kindness, numbers and letters, colours and shapes, animals and nature, family and friends. Build a gentle weekly rhythm and repeat favourite formats, but never repeat a topic.
{{#if am}}Where it fits naturally, include Ethiopian holidays and seasons that fall in this month (for example Enkutatash, Meskel, Genna, Timkat, Fasika, the rainy season or harvest), placed in the slots just before the date.{{/if}}
Special requests for this month: {{notes}}
Topics already used in earlier months (do not repeat them): {{previous_topics}}
"theme" = a short name for the month's overall theme.
{{safety}}`, `Plan {{month_name}} for a YouTube kids' channel{{#if has_channel_name}} called "{{channel_name}}"{{/if}}.
What the channel is about: {{topic}}
Audience: children aged {{age_range}} and their parents.
{{#if has_character_hint}}Every video stars the same main character: {{character_hint}}.{{/if}}
Each video is a short animated song or story made with an app: it writes a poem from the topic, plans scenes, draws the character and makes the song (about 30 seconds) or a narration.

Plan exactly {{video_count}} videos, one per posting slot below, in the same order:
{{schedule}}

For each video:
"title" = a short, catchy YouTube title in the slot's language (at most 60 characters).
"topic" = exactly what to type in the app's "What is the video about?" field, in the slot's language: one or two sentences naming the subject, the one lesson, and where it happens (outdoors), e.g. "Washing hands with soap before eating, by the water jug in the garden".
"lesson" = the one habit, skill or value it teaches, in English (for the planner).
"audioMode" = "song" for catchy sing-along topics (most videos), "narration" for small stories.
"sceneCount" = 3 to 6.
"thumbnailTitle" = 2 to 4 big words for the thumbnail, in the slot's language.
"videoDescription" = the YouTube description in the slot's language: 2 short sentences for parents about what the child learns, then an invitation to subscribe. No links.
"tags" = 8 to 12 search tags (in the slot's language{{#if am}}, plus a few in English{{/if}}).

Make the month varied and balanced: good habits, feelings and kindness, numbers and letters, colours and shapes, animals and nature, family and friends. Build a gentle weekly rhythm and repeat favourite formats, but never repeat a topic.
{{#if am}}Where it fits naturally, include Ethiopian holidays and seasons that fall in this month (for example Enkutatash, Meskel, Genna, Timkat, Fasika, the rainy season or harvest), placed in the slots just before the date.{{/if}}
Special requests for this month: {{notes}}
Topics already used in earlier months (do not repeat them): {{previous_topics}}
"theme" = a short name for the month's overall theme.
{{safety}}`],
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
