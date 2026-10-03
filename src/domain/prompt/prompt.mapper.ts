import type { Prompt as PromptRow, PromptVersion as PromptVersionRow } from "../../generated/prisma/client.js";
import { PROMPT_FLAGS } from "./prompt.defaults.js";
import { Prompt, type PromptRevision } from "./prompt.entity.js";

export interface PromptDto {
  key: string;
  /** "shared", or "channel" when the channel has its own copy. */
  scope: "shared" | "channel";
  channelId: string | null;
  title: string;
  description: string;
  template: string;
  version: number;
  updatedAt: string;
  isDefault: boolean;
  defaultTemplate: string;
  vars: string[];
  flags: string[];
}

export interface PromptRevisionDto {
  version: number;
  template: string;
  note: string | null;
  createdAt: string;
}

export const PromptMapper = {
  toDomain(row: PromptRow): Prompt {
    return Prompt.restore({ channelId: row.channelId, key: row.key, template: row.template, version: row.version, updatedAt: row.updatedAt });
  },

  toPersistence(prompt: Prompt) {
    const p = prompt.toProps();
    return { channelId: p.channelId, key: p.key, template: p.template, version: p.version };
  },

  revisionToDomain(row: PromptVersionRow): PromptRevision {
    return { channelId: row.channelId, key: row.key, version: row.version, template: row.template, note: row.note, createdAt: row.createdAt };
  },

  toDto(prompt: Prompt): PromptDto {
    const def = prompt.definition;
    return {
      key: prompt.key,
      scope: prompt.channelId ? "channel" : "shared",
      channelId: prompt.channelId || null,
      title: def.title,
      description: def.description,
      template: prompt.template,
      version: prompt.version,
      updatedAt: prompt.updatedAt.toISOString(),
      isDefault: prompt.isDefault,
      defaultTemplate: def.template,
      vars: prompt.allowedVars,
      flags: [...PROMPT_FLAGS],
    };
  },

  revisionToDto(r: PromptRevision): PromptRevisionDto {
    return { version: r.version, template: r.template, note: r.note, createdAt: r.createdAt.toISOString() };
  },
};
