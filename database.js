require("dotenv").config();
const mongoose = require("mongoose");

let Activity, ActivityLog, LeaveLog, Communication;

async function initialize() {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 5000,
    });

    const activitySchema = new mongoose.Schema({
      guildId: String,
      userId: String,
      lastActivity: { type: Number, default: 0 },
      warningSent: { type: Boolean, default: false },
      warnedAt: { type: Number, default: null }, // timestamp when warning was sent
      leaveBalance: { type: Number, default: 0 },
      leaveStart: Number,
      internSince: { type: Number, default: null }, // timestamp when intern role was assigned
    });
    activitySchema.index({ guildId: 1, userId: 1 }, { unique: true });
    Activity = mongoose.model("Activity", activitySchema);

    const activityLogSchema = new mongoose.Schema({
      guildId: String,
      userId: String,
      activityDate: String,
    });
    activityLogSchema.index(
      { guildId: 1, userId: 1, activityDate: 1 },
      { unique: true },
    );
    ActivityLog = mongoose.model("ActivityLog", activityLogSchema);

    const leaveLogSchema = new mongoose.Schema({
      guildId: String,
      userId: String,
      startDate: String,
      endDate: String,
    });
    LeaveLog = mongoose.model("LeaveLog", leaveLogSchema);

    const communicationSchema = new mongoose.Schema(
      {
        guildId: String,
        channelId: String,
        messageId: String,
        DiscordID: String,
        DiscordName: String,
        time: Date,
        channelName: String,
        status: {
          type: String,
          enum: ["active", "deleted"],
          default: "active",
        },
        deletedAt: { type: Date, default: null },
      },
      { collection: "communication" },
    );
    communicationSchema.index({ guildId: 1, messageId: 1 }, { unique: true });
    Communication = mongoose.model("Communication", communicationSchema);

    console.log("📦 Database initialized.");
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
}

// ─── Record a member's activity ───────────────────────────────────────────────
async function recordActivity(guildId, userId) {
  const now = Date.now();
  const today = getTodayString();

  try {
    await Activity.findOneAndUpdate(
      { guildId, userId },
      { lastActivity: now, warningSent: false },
      { upsert: true, new: true },
    );

    await ActivityLog.findOneAndUpdate(
      { guildId, userId, activityDate: today },
      {},
      { upsert: true },
    );
  } catch (error) {
    console.error("Error recording activity:", error);
  }
}

// ─── Track every server message in communication collection ──────────────────
async function recordCommunication(message) {
  if (!Communication || !message.guild || !message.author) return;

  try {
    await Communication.findOneAndUpdate(
      { guildId: message.guild.id, messageId: message.id },
      {
        guildId: message.guild.id,
        channelId: message.channel.id,
        messageId: message.id,
        DiscordID: message.author.id,
        DiscordName: message.author.username,
        time: message.createdAt || new Date(),
        channelName: message.channel.name || null,
        status: "active",
        deletedAt: null,
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    console.error("Error recording communication:", error);
  }
}

// ─── Mark a tracked message as deleted ───────────────────────────────────────
async function markCommunicationDeleted(message) {
  if (!Communication || !message.guild) return;

  try {
    await Communication.findOneAndUpdate(
      { guildId: message.guild.id, messageId: message.id },
      {
        $set: {
          guildId: message.guild.id,
          channelId: message.channel?.id || null,
          messageId: message.id,
          channelName: message.channel?.name || null,
          status: "deleted",
          deletedAt: new Date(),
        },
        $setOnInsert: {
          DiscordID: message.author?.id || null,
          DiscordName: message.author?.username || null,
          time: message.createdAt || new Date(),
        },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    console.error("Error marking communication deleted:", error);
  }
}

// ─── Get all members for a guild ─────────────────────────────────────────────
async function getAllMembers(guildId) {
  try {
    return await Activity.find({ guildId });
  } catch (error) {
    console.error("Error getting all members:", error);
    return [];
  }
}

// ─── Get single member data ───────────────────────────────────────────────────
async function getMemberData(guildId, userId) {
  try {
    return await Activity.findOne({ guildId, userId });
  } catch (error) {
    console.error("Error getting member data:", error);
    return null;
  }
}

// ─── Set leave for a member ───────────────────────────────────────────────────
async function setLeave(guildId, userId, days) {
  const today = getTodayString();
  const endDate = getDateStringOffset(days);

  try {
    await Activity.findOneAndUpdate(
      { guildId, userId },
      { lastActivity: Date.now() },
      { upsert: true },
    );

    await LeaveLog.create({ guildId, userId, startDate: today, endDate });

    await Activity.findOneAndUpdate(
      { guildId, userId },
      { $inc: { leaveBalance: days }, leaveStart: Date.now() },
    );
  } catch (error) {
    console.error("Error setting leave:", error);
  }
}

// ─── Mark warning as sent ─────────────────────────────────────────────────────
async function setWarningSent(guildId, userId, value) {
  try {
    const update = { warningSent: value };
    if (value)
      update.warnedAt = Date.now(); // record exactly when warning fired
    else update.warnedAt = null; // clear on reset
    await Activity.findOneAndUpdate({ guildId, userId }, update, {
      upsert: true,
    });
  } catch (error) {
    console.error("Error setting warning sent:", error);
  }
}

// ─── Reset warning flag after action taken ───────────────────────────────────
async function resetWarning(guildId, userId) {
  try {
    await Activity.findOneAndUpdate(
      { guildId, userId },
      { warningSent: false },
    );
  } catch (error) {
    console.error("Error resetting warning:", error);
  }
}

// ─── Get effective inactive days (accounting for approved leave) ──────────────
// Logic:
//   - Find how many calendar days have passed since last activity
//   - Subtract any approved leave days that overlap that window
//   - The remaining is "real" inactive days
async function getEffectiveInactiveDays(guildId, userId) {
  try {
    const member = await getMemberData(guildId, userId);
    if (!member) return 0;

    // Use lastActivity if the member has ever sent a message.
    // If lastActivity is 0/missing (never messaged), fall back to internSince
    // so they are counted as inactive from the day they became an intern.
    // If neither is set we cannot determine inactivity — return 0.
    const activityTimestamp = member.lastActivity || member.internSince || 0;
    if (!activityTimestamp) return 0;

    // lastActivity = 0 means "never messaged" — we're measuring from internSince.
    // In that case we still want to count every day since then as inactive.
    const lastActivity = new Date(activityTimestamp);
    const now = new Date();

    // Total elapsed days since last activity
    const totalDays = Math.floor((now - lastActivity) / (1000 * 60 * 60 * 24));
    if (totalDays <= 0) return 0;

    // Get approved leave days that fall within the inactivity window
    const lastActivityStr = toDateString(lastActivity);
    const todayStr = getTodayString();

    const leaveDays = await LeaveLog.find({
      guildId,
      userId,
      endDate: { $gte: lastActivityStr },
      startDate: { $lte: todayStr },
    });

    let coveredDays = 0;
    for (const leave of leaveDays) {
      const leaveStart = new Date(
        Math.max(new Date(leave.startDate), lastActivity),
      );
      const leaveEnd = new Date(Math.min(new Date(leave.endDate), now));
      if (leaveEnd > leaveStart) {
        coveredDays += Math.floor(
          (leaveEnd - leaveStart) / (1000 * 60 * 60 * 24),
        );
      }
    }

    return Math.max(0, totalDays - coveredDays);
  } catch (error) {
    console.error("Error getting effective inactive days:", error);
    return 0;
  }
}

// ─── Get effective inactive days from a given timestamp ──────────────────────
// Same logic as getEffectiveInactiveDays but accepts the reference timestamp
// directly — so callers can pass the real last-message time from Discord
// without going through lastActivity in the DB at all.
async function getEffectiveInactiveDaysFromTimestamp(
  guildId,
  userId,
  referenceTimestamp,
) {
  if (!referenceTimestamp) return 0;
  try {
    const lastActivity = new Date(referenceTimestamp);
    const now = new Date();

    const totalDays = Math.floor((now - lastActivity) / (1000 * 60 * 60 * 24));
    if (totalDays <= 0) return 0;

    const lastActivityStr = toDateString(lastActivity);
    const todayStr = getTodayString();

    const leaveDays = await LeaveLog.find({
      guildId,
      userId,
      endDate: { $gte: lastActivityStr },
      startDate: { $lte: todayStr },
    });

    let coveredDays = 0;
    for (const leave of leaveDays) {
      const leaveStart = new Date(
        Math.max(new Date(leave.startDate), lastActivity),
      );
      const leaveEnd = new Date(Math.min(new Date(leave.endDate), now));
      if (leaveEnd > leaveStart) {
        coveredDays += Math.floor(
          (leaveEnd - leaveStart) / (1000 * 60 * 60 * 24),
        );
      }
    }

    return Math.max(0, totalDays - coveredDays);
  } catch (error) {
    console.error(
      "Error getting effective inactive days from timestamp:",
      error,
    );
    return 0;
  }
}

// ─── Get consecutive active days ─────────────────────────────────────────────
// Counts backwards from today how many consecutive days they were active
async function getConsecutiveActiveDays(guildId, userId) {
  try {
    const rows = await ActivityLog.find({ guildId, userId }).sort({
      activityDate: -1,
    });

    if (!rows.length) return 0;

    let streak = 0;
    let check = new Date();

    for (const row of rows) {
      const rowDate = toDateString(new Date(row.activityDate));
      const checkDate = toDateString(check);

      if (rowDate === checkDate) {
        streak++;
        check.setDate(check.getDate() - 1);
      } else {
        break;
      }
    }

    return streak;
  } catch (error) {
    console.error("Error getting consecutive active days:", error);
    return 0;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getTodayString() {
  return toDateString(new Date());
}

function toDateString(date) {
  return date.toISOString().split("T")[0]; // "YYYY-MM-DD"
}

function getDateStringOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

// ─── Set intern start date (only sets once, never overwrites) ────────────────
// FIXED: check internSince > 0 explicitly — 0 is stored as falsy default
async function setInternSince(guildId, userId) {
  try {
    const member = await getMemberData(guildId, userId);
    if (member && member.internSince > 0) return; // already set, don't overwrite
    await Activity.findOneAndUpdate(
      { guildId, userId },
      { internSince: Date.now() },
      { upsert: true },
    );
  } catch (error) {
    console.error("Error setting internSince:", error);
  }
}

// ─── Get active leave (if member is currently on approved leave) ──────────────
async function getActiveLeave(guildId, userId) {
  try {
    const todayStr = getTodayString();
    const leave = await LeaveLog.findOne({
      guildId,
      userId,
      startDate: { $lte: todayStr },
      endDate: { $gte: todayStr },
    }).sort({ endDate: -1 });
    return leave || null;
  } catch (error) {
    console.error("Error getting active leave:", error);
    return null;
  }
}

// ─── Force-set lastActivity to a specific timestamp (used by /syncactivity) ──
async function forceSetLastActivity(guildId, userId, timestamp) {
  try {
    await Activity.findOneAndUpdate(
      { guildId, userId },
      { lastActivity: timestamp, warningSent: false },
      { upsert: true },
    );
  } catch (error) {
    console.error("Error force-setting lastActivity:", error);
  }
}

// ─── Force-set intern start date (admin override, always overwrites) ─────────
async function forceSetInternSince(guildId, userId, timestamp) {
  try {
    await Activity.findOneAndUpdate(
      { guildId, userId },
      { internSince: timestamp },
      { upsert: true },
    );
  } catch (error) {
    console.error("Error force-setting internSince:", error);
  }
}

module.exports = {
  initialize,
  recordActivity,
  recordCommunication,
  markCommunicationDeleted,
  getAllMembers,
  getMemberData,
  setLeave,
  setWarningSent,
  resetWarning,
  getEffectiveInactiveDays,
  getConsecutiveActiveDays,
  setInternSince,
  forceSetInternSince,
  forceSetLastActivity,
  getEffectiveInactiveDaysFromTimestamp,
  getActiveLeave,
};
