// Commit message rules, run by the lefthook commit-msg hook.
// Conventional Commits through @commitlint/config-conventional, plus two project rules from .rules:
// every diagnostic is an error, and a message carries no Co-Authored-By trailer or tool attribution.
import { RuleConfigSeverity, type SyncRule, type UserConfig } from "@commitlint/types";

const ATTRIBUTION = [/^co-authored-by:/im, /generated with/i];

const noAttribution: SyncRule = (parsed) => {
  const found = ATTRIBUTION.some((pattern) => pattern.test(parsed.raw ?? ""));
  return [!found, "the message must not carry a Co-Authored-By trailer or tool attribution"];
};

const config: UserConfig = {
  extends: ["@commitlint/config-conventional"],
  plugins: [{ rules: { "no-attribution": noAttribution } }],
  rules: {
    // config-conventional ships these two as warnings, and the project has no warning severity.
    "body-leading-blank": [RuleConfigSeverity.Error, "always"],
    "footer-leading-blank": [RuleConfigSeverity.Error, "always"],
    "no-attribution": [RuleConfigSeverity.Error, "always"],
  },
};

export default config;
