import { ValidationError } from "../errors.js";
import { allowedVars, PROMPT_FLAGS, promptDefinition, type PromptDefinition } from "./prompt.defaults.js";
import { renderTemplate, validateTemplate, type PromptFlags, type PromptVars } from "./prompt.template.js";

/** "" = the shared prompt every channel uses unless it has its own copy. */
export const SHARED = "";

export interface PromptProps {
  /** SHARED, or the channel that has its own copy. */
  channelId: string;
  key: string;
  template: string;
  version: number;
  updatedAt: Date;
}

export interface PromptRevision {
  channelId: string;
  key: string;
  version: number;
  template: string;
  note: string | null;
  createdAt: Date;
}

/** An editable, versioned prompt template. Every change produces a new revision. */
export class Prompt {
  private constructor(private props: PromptProps) {}

  static fromDefault(def: PromptDefinition, now = new Date()): Prompt {
    return new Prompt({ channelId: SHARED, key: def.key, template: def.template, version: 1, updatedAt: now });
  }

  /** A channel's own copy of a (shared) prompt, starting at version 1 with the same text. */
  static copyFor(channelId: string, from: Prompt, now = new Date()): Prompt {
    return new Prompt({ channelId, key: from.key, template: from.template, version: 1, updatedAt: now });
  }

  static restore(props: PromptProps): Prompt {
    promptDefinition(props.key); // unknown keys are not part of the domain
    return new Prompt({ ...props });
  }

  get channelId() { return this.props.channelId; }
  get key() { return this.props.key; }
  get template() { return this.props.template; }
  get version() { return this.props.version; }
  get updatedAt() { return this.props.updatedAt; }
  get definition(): PromptDefinition { return promptDefinition(this.props.key); }
  get allowedVars(): string[] { return allowedVars(this.props.key); }
  get isDefault(): boolean { return this.props.template === this.definition.template; }

  /** Validate and apply a new template. Returns the revision to persist, or null if nothing changed. */
  revise(template: string, note: string | null = null): PromptRevision | null {
    const normalized = template.replace(/\r\n/g, "\n");
    const errors = validateTemplate(normalized, this.allowedVars, PROMPT_FLAGS);
    if (errors.length) throw new ValidationError(`Prompt "${this.key}" is invalid`, errors);
    if (normalized === this.props.template) return null;
    this.props.template = normalized;
    this.props.version += 1;
    this.props.updatedAt = new Date();
    return { channelId: this.channelId, key: this.key, version: this.version, template: normalized, note, createdAt: this.props.updatedAt };
  }

  resetToDefault(): PromptRevision | null {
    return this.revise(this.definition.template, "reset to default");
  }

  initialRevision(note = "default"): PromptRevision {
    return { channelId: this.channelId, key: this.key, version: this.version, template: this.template, note, createdAt: this.updatedAt };
  }

  render(vars: PromptVars, flags: PromptFlags): string {
    const allowed = new Set(this.allowedVars);
    const scoped = Object.fromEntries(Object.entries(vars).filter(([k]) => allowed.has(k)));
    try {
      return renderTemplate(this.props.template, scoped, flags);
    } catch (err) {
      throw new ValidationError(`Prompt "${this.key}" v${this.version} failed to render: ${(err as Error).message}`);
    }
  }

  toProps(): PromptProps {
    return { ...this.props };
  }
}

export interface RenderedPrompt {
  key: string;
  version: number;
  text: string;
}

/**
 * Snapshot of all prompts for one pipeline run, bound to that project's shared variables and flags,
 * so edits made mid-run don't produce a half-old/half-new video.
 */
export class PromptSet {
  private readonly common: PromptVars;

  constructor(
    private readonly prompts: ReadonlyMap<string, Prompt>,
    common: Omit<PromptVars, "safety">,
    private readonly flags: PromptFlags,
  ) {
    const safety = this.get("safety").render({ ...common, safety: "" }, flags);
    this.common = { ...common, safety };
  }

  render(key: string, vars: PromptVars = {}): RenderedPrompt {
    const prompt = this.get(key);
    return { key, version: prompt.version, text: prompt.render({ ...this.common, ...vars }, this.flags) };
  }

  private get(key: string): Prompt {
    const p = this.prompts.get(key);
    if (!p) throw new ValidationError(`Prompt "${key}" is missing`);
    return p;
  }
}
