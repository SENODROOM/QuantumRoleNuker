require("dotenv").config();
const mongoose = require("mongoose");

let Activity,
  ActivityLog,
  LeaveLog,
  Communication,
  TestMember,
  TeamMember;

function dbUriFor(dbName) {
  const uri = process.env.MONGODB_URI || "";
  if (/\/[^/?]+(\?|$)/.test(uri)) {
    return uri.replace(/\/([^/?]+)(\?|$)/, `/${dbName}$2`);
  }
  return uri.endsWith("/") ? `${uri}${dbName}` : `${uri}/${dbName}`;
}

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
    communicationSchema.index({ guildId: 1, DiscordID: 1, time: -1 });
    Communication = mongoose.model("Communication", communicationSchema);

    const testConn = mongoose.createConnection(dbUriFor("test"), {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 5000,
    });

    const testMemberSchema = new mongoose.Schema(
      {
        guildId: String,
        userId: String,
        username: String,
        globalName: String,
        roles: [{ id: String, name: String }],
        savedRoles: [{ id: String, name: String }],
        syncedAt: { type: Date, default: Date.now },
      },
      { collection: "members", timestamps: true },
    );
    testMemberSchema.index({ guildId: 1, userId: 1 }, { unique: true });
    TestMember = testConn.model("TestMember", testMemberSchema);

    const teamConn = mongoose.createConnection(dbUriFor("team"), {
      maxPoolSize: 3,
      serverSelectionTimeoutMS: 5000,
    });

    const teamMemberSchema = new mongoose.Schema(
      {
        guildId: String,
        userId: String,
        status: {
          type: String,
          enum: ["active", "inactive", "leave"],
          default: "inactive",
        },
        warningCount: { type: Number, default: 0 },
        warnedAt: { type: Number, default: null },
        leaveEndDate: { type: String, default: null },
      },
      { collection: "members", timestamps: true },
    );
    teamMemberSchema.index({ guildId: 1, userId: 1 }, { unique: true });
    TeamMember = teamConn.model("TeamMember", teamMemberSchema);

    console.log("📦 Database initialized (test.members + team.members).");
  } catch (error) {
    console.error("Database initialization failed:", error);
  }
}

async function upsertTestMember(guildId, userId, data) {
  if (!TestMember) return null;
  try {
    return await TestMember.findOneAndUpdate(
      { guildId, userId },
      { guildId, userId, ...data, syncedAt: new Date() },
      { upsert: true, new: true },
    );
  } catch (error) {
    console.error("Error upserting test member:", error);
    return null;
  }
}

async function upsertTeamMember(guildId, userId, data) {
  if (!TeamMember) return null;
  try {
    return await TeamMember.findOneAndUpdate(
      { guildId, userId },
      { guildId, userId, ...data },
      { upsert: true, new: true },
    );
  } catch (error) {
    console.error("Error upserting team member:", error);
    return null;
  }
}

async function getTestMember(guildId, userId) {
  if (!TestMember) return null;
  try {
    return await TestMember.findOne({ guildId, userId });
  } catch (error) {
    console.error("Error getting test member:", error);
    return null;
  }
}

async function getTeamMember(guildId, userId) {
  if (!TeamMember) return null;
  try {
    return await TeamMember.findOne({ guildId, userId });
  } catch (error) {
    console.error("Error getting team member:", error);
    return null;
  }
}

async function getAllTeamMembers(guildId) {
  if (!TeamMember) return [];
  try {
    return await TeamMember.find({ guildId });
  } catch (error) {
    console.error("Error getting all team members:", error);
    return [];
  }
}

async function getMembersOnLeave(guildId) {
  if (!TeamMember) return [];
  try {
    return await TeamMember.find({ guildId, status: "leave" });
  } catch (error) {
    console.error("Error getting members on leave:", error);
    return [];
  }
}

async function setWarning(guildId, userId, warningCount, warnedAt) {
  return upsertTeamMember(guildId, userId, { warningCount, warnedAt });
}

async function clearWarning(guildId, userId) {
  return upsertTeamMember(guildId, userId, {
    warningCount: 0,
    warnedAt: null,
  });
}

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

async function getLastCommunicationTime(guildId, userId) {
  if (!Communication) return null;
  try {
    const latest = await Communication.findOne({
      guildId: String(guildId),
      DiscordID: String(userId),
    })
      .sort({ time: -1 })
      .lean();

    return latest?.time ? new Date(latest.time).getTime() : null;
  } catch (error) {
    console.error("Error getting last communication time:", error);
    return null;
  }
}

async function getLastActivityReference(guildId, userId, fallbackTimestamp) {
  const fromCommunication = await getLastCommunicationTime(guildId, userId);
  if (fromCommunication) return { timestamp: fromCommunication, source: "communication" };

  const activity = await getMemberData(guildId, userId);
  if (activity?.lastActivity > 0) {
    return { timestamp: activity.lastActivity, source: "activity" };
  }
  if (activity?.internSince > 0) {
    return { timestamp: activity.internSince, source: "internSince" };
  }
  if (fallbackTimestamp) {
    return { timestamp: fallbackTimestamp, source: "fallback" };
  }
  return null;
}

async function getDaysSinceLastMessage(guildId, userId, fallbackTimestamp) {
  const ref = await getLastActivityReference(guildId, userId, fallbackTimestamp);
  if (!ref) return null;

  return Math.floor((Date.now() - ref.timestamp) / (1000 * 60 * 60 * 24));
}

async function getAllMembers(guildId) {
  try {
    return await Activity.find({ guildId });
  } catch (error) {
    console.error("Error getting all members:", error);
    return [];
  }
}

async function getMemberData(guildId, userId) {
  try {
    return await Activity.findOne({ guildId, userId });
  } catch (error) {
    console.error("Error getting member data:", error);
    return null;
  }
}

async function setLeave(guildId, userId, days) {
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

module.exports = {
  initialize,
  upsertTestMember,
  upsertTeamMember,
  getTestMember,
  getTeamMember,
  getAllTeamMembers,
  getMembersOnLeave,
  setWarning,
  clearWarning,
  recordCommunication,
  markCommunicationDeleted,
  getLastCommunicationTime,
  getLastActivityReference,
  getDaysSinceLastMessage,
  getAllMembers,
  getMemberData,
  setLeave,
  getActiveLeave,
  getAllActiveLeaves,
  getConsecutiveActiveDays,
  setInternSince,
  getTodayString,
};
