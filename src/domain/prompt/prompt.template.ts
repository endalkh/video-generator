/**
 * Tiny template language for DB-stored prompts (kept deliberately simple so non-developers can edit them):
 *   {{name}}                         variable
 *   {{#if flag}} ... {{else}} ... {{/if}}   conditional block (not nestable)
 * Unknown variables/flags are errors, so a typo in an edited prompt fails loudly instead of sending "{{tpoic}}" to the model.
 */
export type PromptVars = Record<string, string | number | undefined>;
export type PromptFlags = Record<string, boolean>;

const IF_RE = /\{\{#if\s+(\w+)\s*\}\}([\s\S]*?)(?:\{\{else\}\}([\s\S]*?))?\{\{\/if\}\}/g;
const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

export class PromptTemplateError extends Error {}

export function renderTemplate(template: string, vars: PromptVars, flags: PromptFlags = {}): string {
  const withBlocks = template.replace(IF_RE, (_m, flag: string, yes: string, no?: string) => {
    if (!(flag in flags)) throw new PromptTemplateError(`unknown flag "${flag}" (available: ${Object.keys(flags).join(", ") || "none"})`);
    return flags[flag] ? yes : (no ?? "");
  });
  if (/\{\{[#/]|\{\{else\}\}/.test(withBlocks)) throw new PromptTemplateError("unbalanced {{#if}} / {{/if}} (nesting is not supported)");
  const out = withBlocks.replace(VAR_RE, (_m, name: string) => {
    if (!(name in vars)) throw new PromptTemplateError(`unknown variable "{{${name}}}" (available: ${Object.keys(vars).join(", ")})`);
    return String(vars[name] ?? "");
  });
  // Tidy blank lines left behind by empty blocks/variables.
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Validate a template against the variables/flags a prompt key supports (used before saving edits). */
export function validateTemplate(template: string, vars: readonly string[], flags: readonly string[]): string[] {
  const errors: string[] = [];
  const v = Object.fromEntries(vars.map((k) => [k, "x"]));
  for (const combo of [true, false]) {
    try {
      renderTemplate(template, v, Object.fromEntries(flags.map((f) => [f, combo])));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  if (!template.trim()) errors.push("template is empty");
  return [...new Set(errors)];
}
