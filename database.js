require("dotenv").config();
const mongoose = require("mongoose");
const { resolveMongoUriAsync } = require("./mongoUri");

let Activity,
  ActivityLog,
  LeaveLog,
  Communication,
  Member,
  Warning,
  InactiveMember,
  OnLeave,
  memberConn;
let dbReady = false;

async function primaryMongoUri() {
  return resolveMongoUriAsync("MONGODB_URI", "MONGODB_URI_DIRECT");
}

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

async function migrateFromTeamDb(baseUri) {
  let teamConn;
  try {
    teamConn = mongoose.createConnection(dbUriFor(baseUri, "team"), {
      maxPoolSize: 1,
      serverSelectionTimeoutMS: 5000,
    });

    const LegacyTeamMember = teamConn.model(
      "LegacyTeamMember",
      new mongoose.Schema(
        {
          guildId: String,
          userId: String,
          status: String,
          warningCount: Number,
          warnedAt: Number,
          leaveEndDate: String,
        },
        { collection: "members" },
      ),
    );

    const legacyRecords = await LegacyTeamMember.find({});
    if (!legacyRecords.length) return 0;

    let merged = 0;
    for (const record of legacyRecords) {
      const result = await Member.findOneAndUpdate(
        { guildId: record.guildId, userId: record.userId },
        {
          $set: {
            status: record.status || "inactive",
            warningCount: record.warningCount || 0,
            warnedAt: record.warnedAt ?? null,
            leaveEndDate: record.leaveEndDate ?? null,
          },
          $setOnInsert: {
            guildId: record.guildId,
            userId: record.userId,
            roles: [],
            savedRoles: [],
          },
        },
        { upsert: true, new: true },
      );
      if (result) merged++;
    }

    return merged;
  } catch (error) {
    console.error("Legacy team.members migration skipped:", error.message);
    return 0;
  } finally {
    if (teamConn) await teamConn.close().catch(() => {});
  }
}

async function initialize() {
  dbReady = false;
  const mongoUri = await primaryMongoUri();
  if (!mongoUri) {
    throw new Error("MONGODB_URI is not set.");
  }

  try {
    await mongoose.connect(mongoUri, {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 15000,
      family: 4,
    });

    const activitySchema = new mongoose.Schema({
      guildId: String,
      userId: String,
      lastActivity: { type: Number, default: 0 },
      warningSent: { type: Boolean, default: false },
      warnedAt: { type: Number, default: null },
      leaveBalance: { type: Number, default: 0 },
      leaveStart: Number,
      internSince: { type: Number, default: null },
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

    memberConn = mongoose.createConnection(dbUriFor(mongoUri, "test"), {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 15000,
      family: 4,
    });
    await memberConn.asPromise();

    const communicationSchema = new mongoose.Schema(
      {
        guildId: String,
        channelId: String,
        messageId: String,
        DiscordID: String,
        time: Date,
        channelName: String,
        status: {
          type: String,
          enum: ["active", "deleted"],
          default: "active",
        },
        deletedAt: { type: Date, default: null },
      },
      { collection: "communication", versionKey: "__v" },
    );
    communicationSchema.index({ guildId: 1, messageId: 1 }, { unique: true });
    communicationSchema.index({ guildId: 1, DiscordID: 1, time: -1 });
    Communication = memberConn.model("Communication", communicationSchema);

    const memberSchema = new mongoose.Schema(
      {
        guildId: String,
        userId: String,
        username: String,
        globalName: String,
        roles: [{ id: String, name: String }],
        savedRoles: [{ id: String, name: String }],
        status: {
          type: String,
          enum: ["active", "inactive", "leave"],
          default: "inactive",
        },
        warningCount: { type: Number, default: 0 },
        totalWarnings: { type: Number, default: 0 },
        warnedAt: { type: Number, default: null },
        leaveEndDate: { type: String, default: null },
        lastMessageAt: { type: Number, default: null },
        syncedAt: { type: Date, default: Date.now },
      },
      { collection: "members", timestamps: true, versionKey: "__v" },
    );
    memberSchema.index({ guildId: 1, userId: 1 }, { unique: true });
    Member = memberConn.model("Member", memberSchema);

    const warningSchema = new mongoose.Schema(
      {
        guildId: String,
        userId: String,
        username: String,
        globalName: String,
        inactiveDays: Number,
        dmSent: { type: Boolean, default: false },
        channelId: String,
        channelMessageId: String,
        type: { type: String, default: "inactivity" },
        status: {
          type: String,
          enum: ["active", "cleared"],
          default: "active",
        },
        clearedAt: { type: Date, default: null },
        time: { type: Date, default: Date.now },
      },
      { collection: "warning", versionKey: "__v" },
    );
    warningSchema.index({ guildId: 1, userId: 1, time: -1 });
    warningSchema.index({ guildId: 1, userId: 1, status: 1 });
    Warning = memberConn.model("Warning", warningSchema);

    const inactiveMemberSchema = new mongoose.Schema(
      {
        guildId: String,
        userId: String,
        username: String,
        globalName: String,
        rolesRemoved: [{ id: String, name: String }],
        rolesKept: [{ id: String, name: String }],
        inactiveDays: Number,
        reason: { type: String, default: "inactivity" },
        time: { type: Date, default: Date.now },
      },
      { collection: "inactivemembers", versionKey: "__v" },
    );
    inactiveMemberSchema.index({ guildId: 1, userId: 1, time: -1 });
    InactiveMember = memberConn.model("InactiveMember", inactiveMemberSchema);

    const onLeaveSchema = new mongoose.Schema(
      {
        guildId: String,
        userId: String,
        username: String,
        globalName: String,
        startDate: String,
        endDate: String,
        savedRoles: [{ id: String, name: String }],
        source: String,
        time: { type: Date, default: Date.now },
      },
      { collection: "onLeave", versionKey: "__v" },
    );
    onLeaveSchema.index({ guildId: 1, userId: 1, endDate: -1 });
    OnLeave = memberConn.model("OnLeave", onLeaveSchema);

    const migrated = await migrateFromTeamDb(mongoUri);
    if (migrated > 0) {
      console.log(
        `📦 Migrated ${migrated} record(s) from legacy team.members → test.members.`,
      );
    }

    dbReady = true;
    console.log(
      "📦 Database initialized (test.members, test.communication, warning, inactivemembers, onLeave).",
    );
    return true;
  } catch (error) {
    dbReady = false;
    console.error("Database initialization failed:", error.message);
    throw error;
  }
}

function isReady() {
  return dbReady;
}

async function setLastMessageAt(guildId, userId, timestamp) {
  if (!Member || !timestamp) return null;
  return upsertMember(guildId, userId, { lastMessageAt: timestamp });
}

async function upsertMember(guildId, userId, data) {
  if (!Member) return null;
  try {
    return await Member.findOneAndUpdate(
      { guildId, userId },
      { guildId, userId, ...data, syncedAt: new Date() },
      { upsert: true, new: true },
    );
  } catch (error) {
    console.error("Error upserting member:", error);
    return null;
  }
}

async function getMember(guildId, userId) {
  if (!Member) return null;
  try {
    return await Member.findOne({ guildId, userId });
  } catch (error) {
    console.error("Error getting member:", error);
    return null;
  }
}

async function getAllGuildMembers(guildId) {
  if (!Member) return [];
  try {
    return await Member.find({ guildId });
  } catch (error) {
    console.error("Error getting all guild members:", error);
    return [];
  }
}

async function getMembersOnLeave(guildId) {
  if (!Member) return [];
  try {
    return await Member.find({ guildId, status: "leave" });
  } catch (error) {
    console.error("Error getting members on leave:", error);
    return [];
  }
}

async function setWarning(guildId, userId, warningCount, warnedAt) {
  if (!Member) return null;
  try {
    const update = {
      guildId,
      userId,
      warningCount,
      warnedAt,
      syncedAt: new Date(),
    };
    if (warningCount > 0) {
      return await Member.findOneAndUpdate(
        { guildId, userId },
        { $set: update, $inc: { totalWarnings: 1 } },
        { upsert: true, new: true },
      );
    }
    return await Member.findOneAndUpdate(
      { guildId, userId },
      { $set: update },
      { upsert: true, new: true },
    );
  } catch (error) {
    console.error("Error setting warning:", error);
    return null;
  }
}

async function hasRecentWarning(guildId, userId, hours = 24) {
  const active = await getActiveWarning(guildId, userId);
  if (!active) return false;
  const since = Date.now() - hours * 60 * 60 * 1000;
  return new Date(active.time).getTime() >= since;
}

async function getActiveWarning(guildId, userId) {
  if (!Warning) return null;
  try {
    return await Warning.findOne({
      guildId: String(guildId),
      userId: String(userId),
      status: "active",
    })
      .sort({ time: -1 })
      .lean();
  } catch (error) {
    console.error("Error getting active warning:", error.message);
    return null;
  }
}

async function hasActiveWarning(guildId, userId) {
  return !!(await getActiveWarning(guildId, userId));
}

async function clearActiveWarning(guildId, userId) {
  if (!Warning) return false;
  try {
    await Warning.updateMany(
      { guildId: String(guildId), userId: String(userId), status: "active" },
      { $set: { status: "cleared", clearedAt: new Date() } },
    );
    await clearWarning(guildId, userId);
    return true;
  } catch (error) {
    console.error("Error clearing active warning:", error.message);
    return false;
  }
}

async function clearActiveWarningIfResponded(guildId, userId) {
  const active = await getActiveWarning(guildId, userId);
  if (!active) return false;

  const lastMsg = await getLastCommunicationTime(guildId, userId);
  if (!lastMsg) return false;

  const warningTime = new Date(active.time).getTime();
  const daysSinceMsg = Math.floor((Date.now() - lastMsg) / (1000 * 60 * 60 * 24));
  const respondedAfterWarning = lastMsg >= warningTime;
  const recentActivity = daysSinceMsg < 3;

  if (respondedAfterWarning || recentActivity) {
    await clearActiveWarning(guildId, userId);
    return true;
  }

  return false;
}

async function repairWarningState(guildId, userId) {
  const active = await getActiveWarning(guildId, userId);
  if (!active?.time || !Member) return false;

  const warnedAt = new Date(active.time).getTime();
  await Member.findOneAndUpdate(
    { guildId, userId },
    { $set: { warningCount: 1, warnedAt, syncedAt: new Date() } },
  );
  return true;
}

async function tryIssueWarning(guildId, userId, warnedAt = Date.now()) {
  if (!Member) return { issued: false, reason: "db_not_ready" };

  try {
    if (await hasActiveWarning(guildId, userId)) {
      return { issued: false, reason: "active_warning" };
    }

    const existing = await Member.findOne({ guildId, userId });
    if ((existing?.warningCount || 0) >= 1) {
      return { issued: false, reason: "already_pending", record: existing };
    }

    const record = await Member.findOneAndUpdate(
      { guildId, userId, warningCount: { $lt: 1 } },
      {
        $set: {
          guildId,
          userId,
          warningCount: 1,
          warnedAt,
          syncedAt: new Date(),
        },
        $inc: { totalWarnings: 1 },
      },
      { upsert: true, new: true },
    );

    if (!record) {
      return { issued: false, reason: "race_lost" };
    }

    return { issued: true, record };
  } catch (error) {
    console.error("Error issuing warning:", error.message);
    return { issued: false, reason: "error" };
  }
}

async function clearWarning(guildId, userId) {
  return upsertMember(guildId, userId, {
    warningCount: 0,
    warnedAt: null,
  });
}

function resolveChannelName(channel) {
  if (!channel) return null;
  if (channel.name) return channel.name;
  if (typeof channel.fetch === "function") {
    return channel.parent?.name || null;
  }
  return null;
}

async function recordCommunication(message) {
  if (!Communication || !message.guild || !message.author) {
    if (!Communication) {
      console.error("Error recording communication: test.communication model not ready");
    }
    return false;
  }

  try {
    const channel =
      message.channel?.partial && typeof message.channel.fetch === "function"
        ? await message.channel.fetch()
        : message.channel;

    await Communication.findOneAndUpdate(
      { guildId: message.guild.id, messageId: message.id },
      {
        $set: {
          guildId: message.guild.id,
          channelId: channel?.id || message.channelId,
          messageId: message.id,
          DiscordID: message.author.id,
          time: message.createdAt || new Date(),
          channelName: resolveChannelName(channel),
          status: "active",
          deletedAt: null,
        },
      },
      { upsert: true, new: true },
    );
    return true;
  } catch (error) {
    console.error("Error recording communication:", error.message);
    return false;
  }
}

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
          time: message.createdAt || new Date(),
        },
      },
      { upsert: true, new: true },
    );
  } catch (error) {
    console.error("Error marking communication deleted:", error);
  }
}

async function getLastCommunicationTime(guildId, userId) {
  if (!Communication) return null;
  try {
    const latest = await Communication.findOne({
      guildId: String(guildId),
      DiscordID: String(userId),
      status: "active",
    })
      .sort({ time: -1 })
      .lean();

    return latest?.time ? new Date(latest.time).getTime() : null;
  } catch (error) {
    console.error("Error getting last communication time:", error);
    return null;
  }
}

async function getDaysSinceLastMessage(guildId, userId) {
  const lastActive = await getLastCommunicationTime(guildId, userId);
  if (!lastActive) return null;

  return Math.floor((Date.now() - lastActive) / (1000 * 60 * 60 * 24));
}

async function getAllMembers(guildId) {
  if (!Activity) return [];
  try {
    return await Activity.find({ guildId });
  } catch (error) {
    console.error("Error getting all members:", error);
    return [];
  }
}

async function getMemberData(guildId, userId) {
  if (!Activity) return null;
  try {
    return await Activity.findOne({ guildId, userId });
  } catch (error) {
    console.error("Error getting member data:", error);
    return null;
  }
}

async function setLeave(guildId, userId, days) {
  if (!LeaveLog || !Activity) return null;

  const today = getTodayString();
  const endDate = getDateStringOffset(days);

  try {
    await LeaveLog.create({ guildId, userId, startDate: today, endDate });

    await Activity.findOneAndUpdate(
      { guildId, userId },
      { $inc: { leaveBalance: days }, leaveStart: Date.now() },
      { upsert: true },
    );

    return { startDate: today, endDate };
  } catch (error) {
    console.error("Error setting leave:", error);
    return null;
  }
}

async function getActiveLeave(guildId, userId) {
  if (!LeaveLog) return null;
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

async function getAllActiveLeaves(guildId) {
  if (!LeaveLog) return [];
  try {
    const todayStr = getTodayString();
    return await LeaveLog.find({
      guildId,
      startDate: { $lte: todayStr },
      endDate: { $gte: todayStr },
    });
  } catch (error) {
    console.error("Error getting all active leaves:", error);
    return [];
  }
}

async function getConsecutiveActiveDays(guildId, userId) {
  if (!ActivityLog) return 0;
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

function getTodayString() {
  return toDateString(new Date());
}

function toDateString(date) {
  return date.toISOString().split("T")[0];
}

function getDateStringOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toDateString(d);
}

async function setInternSince(guildId, userId) {
  try {
    const member = await getMemberData(guildId, userId);
    if (member && member.internSince > 0) return;
    await Activity.findOneAndUpdate(
      { guildId, userId },
      { internSince: Date.now() },
      { upsert: true },
    );
  } catch (error) {
    console.error("Error setting internSince:", error);
  }
}

async function recordWarning(data) {
  if (!Warning) return null;
  try {
    return await Warning.create({
      guildId: data.guildId,
      userId: data.userId,
      username: data.username || null,
      globalName: data.globalName || null,
      inactiveDays: data.inactiveDays ?? null,
      dmSent: data.dmSent ?? false,
      channelId: data.channelId || null,
      channelMessageId: data.channelMessageId || null,
      type: data.type || "inactivity",
      status: "active",
      clearedAt: null,
      time: data.time || new Date(),
    });
  } catch (error) {
    console.error("Error recording warning:", error.message);
    return null;
  }
}

async function countWarnings(guildId, userId) {
  if (!Warning) return 0;
  try {
    const count = await Warning.countDocuments({
      guildId: String(guildId),
      userId: String(userId),
    });
    if (Member && count > 0) {
      await Member.updateOne(
        { guildId, userId },
        { $max: { totalWarnings: count } },
      );
    }
    return count;
  } catch (error) {
    console.error("Error counting warnings:", error.message);
    return 0;
  }
}

async function getLatestWarning(guildId, userId) {
  if (!Warning) return null;
  try {
    return await Warning.findOne({
      guildId: String(guildId),
      userId: String(userId),
    })
      .sort({ time: -1 })
      .lean();
  } catch (error) {
    console.error("Error getting latest warning:", error.message);
    return null;
  }
}

async function recordInactiveMember(data) {
  if (!InactiveMember) return null;
  try {
    return await InactiveMember.create({
      guildId: data.guildId,
      userId: data.userId,
      username: data.username || null,
      globalName: data.globalName || null,
      rolesRemoved: data.rolesRemoved || [],
      rolesKept: data.rolesKept || [],
      inactiveDays: data.inactiveDays ?? null,
      reason: data.reason || "inactivity",
      time: data.time || new Date(),
    });
  } catch (error) {
    console.error("Error recording inactive member:", error.message);
    return null;
  }
}

async function recordOnLeave(data) {
  if (!OnLeave) return null;
  try {
    return await OnLeave.create({
      guildId: data.guildId,
      userId: data.userId,
      username: data.username || null,
      globalName: data.globalName || null,
      startDate: data.startDate,
      endDate: data.endDate,
      savedRoles: data.savedRoles || [],
      source: data.source || "bot",
      time: data.time || new Date(),
    });
  } catch (error) {
    console.error("Error recording onLeave:", error.message);
    return null;
  }
}

module.exports = {
  initialize,
  isReady,
  upsertMember,
  setLastMessageAt,
  getMember,
  getAllGuildMembers,
  getMembersOnLeave,
  setWarning,
  clearWarning,
  tryIssueWarning,
  hasRecentWarning,
  hasActiveWarning,
  getActiveWarning,
  clearActiveWarning,
  clearActiveWarningIfResponded,
  repairWarningState,
  recordCommunication,
  markCommunicationDeleted,
  getLastCommunicationTime,
  getDaysSinceLastMessage,
  getAllMembers,
  getMemberData,
  setLeave,
  getActiveLeave,
  getAllActiveLeaves,
  getConsecutiveActiveDays,
  setInternSince,
  getTodayString,
  recordWarning,
  recordInactiveMember,
  recordOnLeave,
  countWarnings,
  getLatestWarning,
};
