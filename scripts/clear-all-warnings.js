/**
 * One-time reset: clears all inactivity warnings from the database.
 *
 * Usage (stop quantum-role-nuker in pm2 first):
 *   node scripts/clear-all-warnings.js --apply
 *
 * Dry run (preview only):
 *   node scripts/clear-all-warnings.js
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { resolveMongoUriAsync } = require("../mongoUri");

const APPLY = process.argv.includes("--apply");
const GUILD_ID = process.env.GUILD_ID?.trim() || null;

function dbUriFor(baseUri, dbName) {
  const qIndex = baseUri.indexOf("?");
  const base = qIndex >= 0 ? baseUri.slice(0, qIndex) : baseUri;
  const query = qIndex >= 0 ? baseUri.slice(qIndex) : "";
  const normalized = base.replace(/\/$/, "");
  return `${normalized}/${dbName}${query}`;
}

async function main() {
  const mongoUri = await resolveMongoUriAsync("MONGODB_URI", "MONGODB_URI_DIRECT");
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not set in .env");
  }

  const testUri = dbUriFor(mongoUri, "test");
  const guildFilter = GUILD_ID ? { guildId: GUILD_ID } : {};

  console.log(APPLY ? "🔧 APPLY mode — writing changes\n" : "👀 Dry run — pass --apply to reset\n");
  if (GUILD_ID) console.log(`Guild filter: ${GUILD_ID}\n`);

  const memberConn = await mongoose
    .createConnection(testUri, {
      serverSelectionTimeoutMS: 15000,
      family: 4,
    })
    .asPromise();

  const Member = memberConn.model(
    "Member",
    new mongoose.Schema({}, { strict: false, collection: "members" }),
  );

  const membersWithWarnings = await Member.countDocuments({
    ...guildFilter,
    $or: [{ warningCount: { $gt: 0 } }, { warnedAt: { $ne: null } }],
  });

  console.log(`test.members — records with warnings: ${membersWithWarnings}`);

  if (APPLY && membersWithWarnings > 0) {
    const result = await Member.updateMany(
      {
        ...guildFilter,
        $or: [{ warningCount: { $gt: 0 } }, { warnedAt: { $ne: null } }],
      },
      { $set: { warningCount: 0, warnedAt: null } },
    );
    console.log(`✅ test.members — reset ${result.modifiedCount} record(s)`);
  }

  await memberConn.close();

  const activityConn = await mongoose
    .createConnection(mongoUri, {
      serverSelectionTimeoutMS: 15000,
      family: 4,
    })
    .asPromise();

  const Activity = activityConn.model(
    "Activity",
    new mongoose.Schema({}, { strict: false, collection: "activities" }),
  );

  let legacyWithWarnings = 0;
  let legacyReset = 0;

  try {
    legacyWithWarnings = await Activity.countDocuments({
      ...guildFilter,
      $or: [{ warningSent: true }, { warnedAt: { $ne: null } }],
    });
    console.log(`activities (legacy) — records with warnings: ${legacyWithWarnings}`);

    if (APPLY && legacyWithWarnings > 0) {
      const result = await Activity.updateMany(
        {
          ...guildFilter,
          $or: [{ warningSent: true }, { warnedAt: { $ne: null } }],
        },
        { $set: { warningSent: false, warnedAt: null } },
      );
      legacyReset = result.modifiedCount;
      console.log(`✅ activities (legacy) — reset ${legacyReset} record(s)`);
    }
  } catch (err) {
    console.log(`ℹ️  Legacy activities collection skipped: ${err.message}`);
  }

  await activityConn.close();

  if (!APPLY) {
    console.log("\nNo changes made. Run with --apply to reset all warnings.");
  } else {
    console.log("\nDone. Restart quantum-role-nuker when ready:");
    console.log("  pm2 restart quantum-role-nuker");
  }
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
