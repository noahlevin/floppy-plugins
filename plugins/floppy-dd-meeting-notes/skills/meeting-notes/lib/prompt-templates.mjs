/**
 * SP-147 — meeting-notes prompt templates.
 *
 * The SYSTEM prompt for each draft type lives here so the per-tenant
 * style-profile can be injected at runtime WITHOUT mutating SKILL.md. The base
 * instructions are the durable, shared playbook; the tenant style rules are
 * appended as a clearly-fenced block only when the profile has rules. An empty
 * or absent profile leaves the base prompt byte-for-byte unchanged, so the
 * skill degrades to today's behavior.
 */

export const TENANT_STYLE_RULES_HEADING = "## Tenant style rules (follow these)";

const RECAP_EMAIL_SYSTEM_BASE = [
  "You write a client recap email from a meeting transcript and Floppy/Atlas memory.",
  "Ground every claim in the brief's cited assertions; never invent facts.",
  "Keep it concise, warm, and skimmable. Lead with outcomes, then open commitments.",
  "The email is review-required: it lands as a draft for a human to approve. Do not address it as sent.",
].join("\n");

const CLICKUP_TASK_SYSTEM_BASE = [
  "You turn a meeting's open commitments into a ClickUp task list.",
  "Ground every task in the brief's cited assertions; never invent work.",
  "Each task: a clear imperative title, an owner when known, and a due date when known.",
  "Tasks are review-required and only ever written to the demo list. Do not auto-execute.",
].join("\n");

/**
 * Build the tenant-style-rules block to append to a SYSTEM prompt. Returns an
 * empty string when there are no rules so the base prompt is unchanged.
 *
 * Accepts either a compiled string (newline-joined rule text) or the raw
 * style-profile envelope `{ rules, compiled }`. Either way, an empty profile
 * yields "".
 * @param {string | { compiled?: string, rules?: Array<{ text?: string }> } | null | undefined} styleProfile
 * @returns {string}
 */
export const buildTenantStyleRulesBlock = (styleProfile) => {
  const compiled = compiledRuleText(styleProfile);
  if (compiled.length === 0) return "";
  return `${TENANT_STYLE_RULES_HEADING}\n${compiled}`;
};

/**
 * Append the tenant-style-rules block to a base SYSTEM prompt. No rules → the
 * base prompt is returned unchanged (no trailing whitespace, no empty heading).
 * @param {string} base
 * @param {string | { compiled?: string, rules?: Array<{ text?: string }> } | null | undefined} styleProfile
 * @returns {string}
 */
const withTenantStyleRules = (base, styleProfile) => {
  const block = buildTenantStyleRulesBlock(styleProfile);
  return block.length === 0 ? base : `${base}\n\n${block}`;
};

/**
 * Build the SYSTEM prompt for the recap email, injecting tenant style rules
 * when the profile has any.
 * @param {{ styleProfile?: string | { compiled?: string, rules?: Array<{ text?: string }> } | null }} [options]
 * @returns {string}
 */
export const buildRecapEmailPrompt = (options = {}) =>
  withTenantStyleRules(RECAP_EMAIL_SYSTEM_BASE, options.styleProfile);

/**
 * Build the SYSTEM prompt for the ClickUp task list, injecting tenant style
 * rules when the profile has any.
 * @param {{ styleProfile?: string | { compiled?: string, rules?: Array<{ text?: string }> } | null }} [options]
 * @returns {string}
 */
export const buildClickupTaskPrompt = (options = {}) =>
  withTenantStyleRules(CLICKUP_TASK_SYSTEM_BASE, options.styleProfile);

/**
 * Normalize a style profile (string OR envelope) into compiled rule text.
 * @param {string | { compiled?: string, rules?: Array<{ text?: string }> } | null | undefined} styleProfile
 * @returns {string}
 */
const compiledRuleText = (styleProfile) => {
  if (typeof styleProfile === "string") return styleProfile.trim();
  if (!styleProfile || typeof styleProfile !== "object") return "";
  if (typeof styleProfile.compiled === "string" && styleProfile.compiled.length > 0) {
    return styleProfile.compiled.trim();
  }
  if (Array.isArray(styleProfile.rules)) {
    return styleProfile.rules
      .map((rule) => (typeof rule?.text === "string" ? rule.text.trim() : ""))
      .filter((text) => text.length > 0)
      .join("\n");
  }
  return "";
};
