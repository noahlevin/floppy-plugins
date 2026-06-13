/**
 * SP-147 — shared per-tenant style-profile loader for the `floppy:*` skill
 * suite.
 *
 * Thin wrapper over the Atlas client's `getSkillStyleProfile(skillId)`. Each
 * skill declares a stable `SKILL_ID` and loads its profile identically. The
 * tenant is derived from the bearer server-side, so the same skill bytes serve
 * any tenant. Degrades to an empty profile on 404/503/error (today's base
 * behavior) instead of crashing the run.
 */

/**
 * @typedef {object} StyleProfile
 * @property {string} skillId
 * @property {Array<{ id: string, text: string, source: string, created_at: string }>} rules
 * @property {string} compiled
 * @property {string | null} updatedAt
 */

/**
 * Load this skill's per-tenant style profile. Never throws — the underlying
 * client already degrades to an empty profile on failure.
 * @param {{ getSkillStyleProfile: (skillId: string) => Promise<StyleProfile> }} atlas
 * @param {string} skillId
 * @param {(message: string, meta?: object) => void} [log]
 * @returns {Promise<StyleProfile>}
 */
export const loadStyleProfile = async (atlas, skillId, log = () => {}) => {
  const profile = await atlas.getSkillStyleProfile(skillId);
  if (profile.rules.length > 0) {
    log("style_profile_loaded", {
      skillId,
      ruleCount: profile.rules.length,
    });
  }
  return profile;
};

/**
 * Render the tenant style rules as a system-prompt block. Empty profile →
 * empty string, so prompt assembly falls back to today's unchanged behavior.
 * @param {StyleProfile} profile
 * @returns {string}
 */
export const renderStyleRules = (profile) => {
  if (!profile || profile.rules.length === 0) return "";
  const lines = ["Tenant style rules (apply when writing prose):"];
  for (const rule of profile.rules) {
    if (rule && typeof rule.text === "string" && rule.text.length > 0) {
      lines.push(`- ${rule.text}`);
    }
  }
  return lines.join("\n");
};
