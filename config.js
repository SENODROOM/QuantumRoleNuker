require("dotenv").config();
module.exports = {
  TOKEN: process.env.DISCORD_TOKEN,

  // ── Inactivity Thresholds ──────────────────────────────────────────────────
  WARN_AFTER_DAYS: 3,
  WARNING_GRACE_HOURS: 24,

  // ── Protected Roles (never removed) ────────────────────────────────────────
  PROTECTED_ROLES: ["AI/ML", "Web", "Compiler"],

  // ── Leave role applied while member is on approved leave ───────────────────
  FUTURE_RULES_ROLE: "FutureRules",
  // Optional: set in .env if the role name differs
  FUTURE_RULES_ROLE_ID: process.env.FUTURE_RULES_ROLE_ID || null,

  // ── #qubit-warnings channel ────────────────────────────────────────────────
  WARNINGS_CHANNEL_ID: "1514355734236626944",

  // Discord user IDs never checked for inactivity (comma-separated in .env)
  EXEMPT_USER_IDS: (process.env.EXEMPT_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean),

  // How many message pages to scan per channel when backfilling activity
  MESSAGE_SCAN_PAGES: 10,
};
