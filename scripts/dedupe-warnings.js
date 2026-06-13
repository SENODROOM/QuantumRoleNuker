/**
 * One-time cleanup: remove duplicate rows in test.warning.
 * Keeps the newest document (latest `time`) per guildId + userId.
 *
 * Dry run (preview only):
 *   node scripts/dedupe-warnings.js
 *
 * Apply deletions (stop quantum-role-nuker in pm2 first):
 *   node scripts/dedupe-warnings.js --apply
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });

const mongoose = require("mongoose");
const { resolveMongoUriAsync } = require("../mongoUri");

const APPLY = process.argv.includes("--apply");
const GUILD_ID = process.env.GUILD_ID?.trim() || null;

function dbUriFor(baseUri, dbName) {
  if (/\/[^/?]+(\?|$)/.test(baseUri)) {
    return baseUri.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
  }
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
  const matchStage = GUILD_ID ? { guildId: GUILD_ID } : {};

  console.log(
    APPLY
      ? "🔧 APPLY mode — deleting duplicate test.warning rows\n"
      : "👀 Dry run — pass --apply to delete duplicates\n",
  );
  if (GUILD_ID) console.log(`Guild filter: ${GUILD_ID}\n`);

  const conn = await mongoose
    .createConnection(testUri, {
      serverSelectionTimeoutMS: 15000,
      family: 4,
    })
    .asPromise();

  const Warning = conn.model(
    "Warning",
    new mongoose.Schema({}, { strict: false, collection: "warning" }),
  );

  const total = await Warning.countDocuments(matchStage);
  console.log(`test.warning — total documents: ${total}`);

  const duplicateGroups = await Warning.aggregate([
    { $match: matchStage },
    { $sort: { time: -1 } },
    {
      $group: {
        _id: { guildId: "$guildId", userId: "$userId" },
        keepId: { $first: "$_id" },
        keepTime: { $first: "$time" },
        allIds: { $push: "$_id" },
        count: { $sum: 1 },
      },
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } },
  ]);

  if (!duplicateGroups.length) {
    console.log("\n✅ No duplicate warnings found. Nothing to do.");
    await conn.close();
    return;
  }

  const idsToDelete = [];
  for (const group of duplicateGroups) {
    for (const id of group.allIds) {
      if (String(id) !== String(group.keepId)) {
        idsToDelete.push(id);
      }
    }
  }

  console.log(`\nUsers with duplicates: ${duplicateGroups.length}`);
  console.log(`Documents to delete: ${idsToDelete.length}`);
  console.log(`Documents to keep: ${duplicateGroups.length}`);
  console.log(`Final count after cleanup: ${total - idsToDelete.length}\n`);

  console.log("Sample (up to 15 users):");
  for (const group of duplicateGroups.slice(0, 15)) {
    const { guildId, userId } = group._id;
    console.log(
      `  userId ${userId} — ${group.count} rows → keep ${group.keepId} (${group.keepTime?.toISOString?.() || group.keepTime})`,
    );
  }
  if (duplicateGroups.length > 15) {
    console.log(`  … and ${duplicateGroups.length - 15} more user(s)`);
  }

  if (!APPLY) {
    console.log("\nNo changes made. Run with --apply to delete duplicates.");
    await conn.close();
    return;
  }

  const result = await Warning.deleteMany({ _id: { $in: idsToDelete } });
  console.log(`\n✅ Deleted ${result.deletedCount} duplicate warning(s).`);

  const remaining = await Warning.countDocuments(matchStage);
  console.log(`test.warning — documents remaining: ${remaining}`);
  console.log("\nDone. Restart quantum-role-nuker when ready:");
  console.log("  pm2 restart quantum-role-nuker");

  await conn.close();
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
