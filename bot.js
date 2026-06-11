require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
  Partials,
} = require("discord.js");
const cron = require("node-cron");
const db = require("./database");
const mainDb = require("./maindb");
const config = require("./config");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ─── Role helpers ─────────────────────────────────────────────────────────────
function isProtectedRole(roleName) {
  return config.PROTECTED_ROLES.map((r) => r.toLowerCase()).includes(
    roleName.toLowerCase(),
  );
}

function normalizeRoleName(name) {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

function isFutureRulesRole(roleName) {
  return normalizeRoleName(roleName) === normalizeRoleName(config.FUTURE_RULES_ROLE);
}

function getMemberRoles(member) {
  return member.roles.cache
    .filter((r) => r.name !== "@everyone")
    .map((r) => ({ id: r.id, name: r.name }));
}

function hasNonProtectedRoles(member) {
  return member.roles.cache.some(
    (r) =>
      r.name !== "@everyone" &&
      !isProtectedRole(r.name) &&
      !isFutureRulesRole(r.name),
  );
}

function getTeamRole(member) {
  const found = member.roles.cache.find((r) => isProtectedRole(r.name));
  return found ? found.name : null;
}

function humanDuration(ms) {
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0 && hours > 0) return `${days}d ${hours}h`;
  if (days > 0) return `${days} day(s)`;
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours} hour(s)`;
  return `${minutes} minute(s)`;
}

function resolveFutureRulesRole(guild) {
  if (config.FUTURE_RULES_ROLE_ID) {
    const byId = guild.roles.cache.get(config.FUTURE_RULES_ROLE_ID);
    if (byId) return byId;
  }

  return (
    guild.roles.cache.find((r) => isFutureRulesRole(r.name)) ||
    guild.roles.cache.find((r) => normalizeRoleName(r.name) === "futurerules") ||
    null
  );
}

function computeStatusFromRoles(member) {
  return hasNonProtectedRoles(member) ? "active" : "inactive";
}

// ─── Sync member into test.members + team.members ─────────────────────────────
async function syncDiscordMember(member, { preserveLeave = true } = {}) {
  if (!member || member.user.bot) return;

  const guildId = member.guild.id;
  const userId = member.id;
  const roles = getMemberRoles(member);
  const existingTeam = await db.getTeamMember(guildId, userId);
  const existingTest = await db.getTestMember(guildId, userId);
  const onLeave = existingTeam?.status === "leave";

  const testPayload = {
    username: member.user.username,
    globalName: member.user.globalName || null,
    roles,
  };
  if (onLeave && existingTest?.savedRoles?.length) {
    testPayload.savedRoles = existingTest.savedRoles;
  }

  await db.upsertTestMember(guildId, userId, testPayload);

  if (preserveLeave && onLeave) return;

  const activeLeave = await db.getActiveLeave(guildId, userId);
  if (preserveLeave && activeLeave) return;

  const status = computeStatusFromRoles(member);
  await db.upsertTeamMember(guildId, userId, { status });
}

async function syncAllServerMembers(guild) {
  await guild.members.fetch();
  let count = 0;

  for (const member of guild.members.cache.values()) {
    if (member.user.bot) continue;
    await syncDiscordMember(member, { preserveLeave: true });
    count++;
  }

  console.log(
    `📋 Synced ${count} member(s) to test.members + team.members in "${guild.name}".`,
  );
}

// ─── Leave: strip roles, assign FutureRules, restore on end ─────────────────
async function applyLeaveToMember(guild, member, endDate) {
  const guildId = guild.id;
  const userId = member.id;
  const freshMember = await guild.members.fetch(userId);
  const testRecord = await db.getTestMember(guildId, userId);

  const currentRemovable = getMemberRoles(freshMember).filter(
    (r) => !isProtectedRole(r.name) && !isFutureRulesRole(r.name),
  );

  const merged = new Map();
  for (const source of [
    ...(testRecord?.savedRoles || []),
    ...(testRecord?.roles || []),
    ...currentRemovable,
  ]) {
    if (
      source?.id &&
      source?.name &&
      !isProtectedRole(source.name) &&
      !isFutureRulesRole(source.name)
    ) {
      merged.set(source.id, { id: source.id, name: source.name });
    }
  }
  savedRoles = [...merged.values()];

  await db.upsertTestMember(guildId, userId, {
    username: freshMember.user.username,
    globalName: freshMember.user.globalName || null,
    savedRoles,
  });

  await db.upsertTeamMember(guildId, userId, {
    status: "leave",
    leaveEndDate: endDate,
    warningCount: 0,
    warnedAt: null,
  });
  await db.clearWarning(guildId, userId);

  const rolesToRemove = freshMember.roles.cache.filter(
    (r) =>
      r.name !== "@everyone" &&
      !isProtectedRole(r.name) &&
      !isFutureRulesRole(r.name),
  );

  if (rolesToRemove.size > 0) {
    try {
      await freshMember.roles.remove(
        rolesToRemove,
        "Approved leave — roles stored by QuantumLogics bot",
      );
    } catch (err) {
      console.error(
        `❌ Leave role removal failed for ${freshMember.user.tag}: ${err.message}`,
      );
    }
  }

  await guild.roles.fetch();
  const futureRole = resolveFutureRulesRole(guild);
  if (!futureRole) {
    console.warn(
      `⚠️ ${config.FUTURE_RULES_ROLE} role not found in "${guild.name}". Create the role or set FUTURE_RULES_ROLE_ID in .env.`,
    );
  } else {
    const updated = await guild.members.fetch(userId);
    if (!updated.roles.cache.has(futureRole.id)) {
      try {
        await updated.roles.add(
          futureRole,
          "Approved leave — FutureRules assigned by QuantumLogics bot",
        );
      } catch (err) {
        console.error(
          `❌ Failed to assign ${config.FUTURE_RULES_ROLE} to ${updated.user.tag}: ${err.message}`,
        );
      }
    }
  }

  const finalMember = await guild.members.fetch(userId);
  await db.upsertTestMember(guildId, userId, {
    roles: getMemberRoles(finalMember),
    savedRoles,
  });

  console.log(
    `🏖️ ${freshMember.user.tag} on leave until ${endDate}. Saved ${savedRoles.length} role(s): ${savedRoles.map((r) => r.name).join(", ") || "none"}`,
  );
}

async function reconcileAllLeaveStates(guild) {
  await guild.members.fetch();
  await guild.roles.fetch();

  const [teamOnLeave, activeLeaveLogs] = await Promise.all([
    db.getMembersOnLeave(guild.id),
    db.getAllActiveLeaves(guild.id),
  ]);

  const leaveByUser = new Map();
  for (const record of teamOnLeave) {
    if (record.leaveEndDate) leaveByUser.set(record.userId, record.leaveEndDate);
  }
  for (const log of activeLeaveLogs) {
    if (!leaveByUser.has(log.userId)) {
      leaveByUser.set(log.userId, log.endDate);
    }
  }

  if (leaveByUser.size === 0) return;

  console.log(
    `🏖️ Reconciling leave for ${leaveByUser.size} member(s) in "${guild.name}"...`,
  );

  for (const [userId, endDate] of leaveByUser) {
    const member = await guild.members.fetch(userId).catch(() => null);
    if (!member) continue;
    await applyLeaveToMember(guild, member, endDate);
  }
}

async function restoreLeaveForMember(guild, member) {
  const guildId = guild.id;
  const userId = member.id;
  const testRecord = await db.getTestMember(guildId, userId);

  const futureRole = resolveFutureRulesRole(guild);
  if (futureRole && member.roles.cache.has(futureRole.id)) {
    await member.roles.remove(futureRole, "Leave ended — restoring roles");
  }

  const savedRoles = testRecord?.savedRoles || [];
  const restorable = savedRoles.filter((r) => {
    const role = guild.roles.cache.get(r.id);
    return role && !member.roles.cache.has(r.id);
  });

  if (restorable.length > 0) {
    await member.roles.add(
      restorable.map((r) => r.id),
      "Leave ended — roles restored by QuantumLogics bot",
    );
  }

  const refreshed = await guild.members.fetch(userId);
  const status = computeStatusFromRoles(refreshed);

  await db.upsertTestMember(guildId, userId, {
    roles: getMemberRoles(refreshed),
    savedRoles: [],
  });

  await db.upsertTeamMember(guildId, userId, {
    status,
    leaveEndDate: null,
  });

  console.log(
    `✅ Leave ended for ${member.user.tag}. Restored ${restorable.length} role(s). Status: ${status}.`,
  );
}

async function processExpiredLeaves() {
  const today = db.getTodayString();

  for (const guild of client.guilds.cache.values()) {
    try {
      const onLeave = await db.getMembersOnLeave(guild.id);

      for (const record of onLeave) {
        if (!record.leaveEndDate || record.leaveEndDate >= today) continue;

        const member =
          guild.members.cache.get(record.userId) ||
          (await guild.members.fetch(record.userId).catch(() => null));

        if (!member) continue;
        await restoreLeaveForMember(guild, member);
      }
    } catch (err) {
      console.error(`Leave expiry error in guild ${guild.name}:`, err);
    }
  }
}

// ─── On Ready ────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ QuantumLogics Bot is online as ${client.user.tag}`);
  await db.initialize();
  await mainDb.initMainDb();

  for (const guild of client.guilds.cache.values()) {
    await syncAllServerMembers(guild);
    await reconcileAllLeaveStates(guild);
  }

  await processExpiredLeaves();
  startInactivityChecker();

  console.log("⏰ Running startup inactivity check...");
  await checkInactivity();
});

// ─── Keep test.members roles in sync when Discord roles change ───────────────
client.on("guildMemberUpdate", async (_oldMember, newMember) => {
  if (newMember.user.bot) return;

  const team = await db.getTeamMember(newMember.guild.id, newMember.id);
  if (team?.status === "leave") return;

  await syncDiscordMember(newMember, { preserveLeave: false });
});

client.on("guildMemberAdd", async (member) => {
  if (member.user.bot) return;
  console.log(`👋 New member joined: ${member.user.tag}.`);
  await syncDiscordMember(member);
});

// ─── Track messages in communication collection only ─────────────────────────
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;

  await db.recordCommunication(message);

  const team = await db.getTeamMember(message.guild.id, message.author.id);
  if (team?.warningCount > 0) {
    await db.clearWarning(message.guild.id, message.author.id);
    console.log(
      `💬 ${message.author.tag} responded — warning cleared.`,
    );
  }
});

client.on("messageDelete", async (message) => {
  if (!message.guild) return;
  await db.markCommunicationDeleted(message);
});

// ─── Slash Commands ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === "leave") {
    const days = interaction.options.getInteger("days");
    const member =
      interaction.guild.members.cache.get(interaction.user.id) ||
      (await interaction.guild.members.fetch(interaction.user.id));

    const leaveInfo = await db.setLeave(
      interaction.guild.id,
      interaction.user.id,
      days,
    );

    if (!leaveInfo) {
      return interaction.reply({
        content: "❌ Failed to record leave. Please try again.",
        ephemeral: true,
      });
    }

    await applyLeaveToMember(interaction.guild, member, leaveInfo.endDate);

    await interaction.reply({
      content:
        `✅ Leave approved for **${days} day(s)** (until **${leaveInfo.endDate}**).\n` +
        `Your roles have been saved and **${config.FUTURE_RULES_ROLE}** has been assigned. ` +
        `Roles will be restored automatically when leave ends.`,
    });
  }

  if (commandName === "status") {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    await interaction.deferReply();

    const member =
      interaction.guild.members.cache.get(targetUser.id) ||
      (await interaction.guild.members.fetch(targetUser.id).catch(() => null));

    const testRecord = await db.getTestMember(
      interaction.guild.id,
      targetUser.id,
    );
    const teamRecord = await db.getTeamMember(
      interaction.guild.id,
      targetUser.id,
    );

    if (!member || !teamRecord) {
      return interaction.editReply({
        content: "❓ No member data found. The bot may still be syncing.",
      });
    }

    const lastMsgTs = await db.getLastCommunicationTime(
      interaction.guild.id,
      targetUser.id,
    );
    const lastSeen = lastMsgTs
      ? `<t:${Math.floor(lastMsgTs / 1000)}:R>`
      : "No messages recorded";
    const inactiveDays = await db.getDaysSinceLastMessage(
      interaction.guild.id,
      targetUser.id,
      member.joinedTimestamp,
    );

    const roleList =
      (testRecord?.roles || [])
        .map((r) => `<@&${r.id}>`)
        .join(", ") || "None";

    const teamRole = getTeamRole(member);
    const statusEmoji =
      teamRecord.status === "leave"
        ? "🏖️"
        : teamRecord.status === "active"
          ? "✅"
          : "🔴";

    let inactivityLine;
    if (teamRecord.status === "leave") {
      inactivityLine = `⏸️ On leave until **${teamRecord.leaveEndDate}**`;
    } else if (inactiveDays === null) {
      inactivityLine = "—";
    } else if (inactiveDays >= config.WARN_AFTER_DAYS) {
      inactivityLine = `⚠️ ${inactiveDays} day(s) since last message`;
    } else {
      inactivityLine = `✅ ${inactiveDays} day(s) since last message`;
    }

    const embed = new EmbedBuilder()
      .setColor(
        teamRecord.status === "leave"
          ? 0x00b0f4
          : inactiveDays >= config.WARN_AFTER_DAYS
            ? 0xffa500
            : 0x57f287,
      )
      .setTitle("📊 Member Status")
      .setDescription(`<@${targetUser.id}>`)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        {
          name: `${statusEmoji} Status`,
          value: teamRecord.status,
          inline: true,
        },
        { name: "🕐 Last Message", value: lastSeen, inline: true },
        { name: "⏱️ Inactivity", value: inactivityLine, inline: true },
        {
          name: "🛠️ Team",
          value: teamRole ? `**${teamRole}**` : "Not assigned",
          inline: true,
        },
        {
          name: "⚠️ Warnings",
          value: `${teamRecord.warningCount || 0}`,
          inline: true,
        },
        { name: "🎭 Roles", value: roleList, inline: false },
      )
      .setFooter({ text: "QuantumLogics Activity Tracker" })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  if (commandName === "resetactivity") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({ content: "❌ Only admins can reset activity." });
    }

    const user = interaction.options.getUser("user");
    await db.clearWarning(interaction.guild.id, user.id);

    await interaction.reply({
      content: `✅ Warning cleared for <@${user.id}>.`,
    });
  }

  if (commandName === "grantleave") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({ content: "❌ Only admins can grant leave." });
    }

    const user = interaction.options.getUser("user");
    const days = interaction.options.getInteger("days");
    const member =
      interaction.guild.members.cache.get(user.id) ||
      (await interaction.guild.members.fetch(user.id).catch(() => null));

    if (!member) {
      return interaction.reply({ content: "❌ Member not found." });
    }

    const leaveInfo = await db.setLeave(interaction.guild.id, user.id, days);
    await applyLeaveToMember(interaction.guild, member, leaveInfo.endDate);

    await interaction.reply({
      content: `✅ Granted **${days}** day(s) of leave to <@${user.id}> until **${leaveInfo.endDate}**.`,
    });
  }

  if (commandName === "forcecheck") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({
        content: "❌ Only admins can run a force check.",
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });
    await processExpiredLeaves();
    await checkInactivity();

    await interaction.editReply({
      content: `✅ Done. Processed expired leave and ran inactivity check.\nCheck <#${config.WARNINGS_CHANNEL_ID}> for warnings.`,
    });
  }

  if (commandName === "debuguser") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({
        content: "❌ Only admins can debug users.",
        ephemeral: true,
      });
    }

    const targetUser = interaction.options.getUser("user") || interaction.user;
    await interaction.deferReply({ ephemeral: true });

    const testRecord = await db.getTestMember(
      interaction.guild.id,
      targetUser.id,
    );
    const teamRecord = await db.getTeamMember(
      interaction.guild.id,
      targetUser.id,
    );

    if (!teamRecord) {
      return interaction.editReply({
        content: `❌ No team.members record for <@${targetUser.id}>.`,
      });
    }

    const member =
      interaction.guild.members.cache.get(targetUser.id) ||
      (await interaction.guild.members.fetch(targetUser.id).catch(() => null));

    const lastMsgTs = await db.getLastCommunicationTime(
      interaction.guild.id,
      targetUser.id,
    );
    const inactiveDays = await db.getDaysSinceLastMessage(
      interaction.guild.id,
      targetUser.id,
      null,
    );

    const fmt = (ts) =>
      ts ? `<t:${Math.floor(ts / 1000)}:F> (raw: ${ts})` : `null`;

    await interaction.editReply({
      content:
        `**🔬 Debug for <@${targetUser.id}>**\n` +
        `**team.members status:** ${teamRecord.status}\n` +
        `**warningCount:** ${teamRecord.warningCount}\n` +
        `**warnedAt:** ${fmt(teamRecord.warnedAt)}\n` +
        `**leaveEndDate:** ${teamRecord.leaveEndDate || "none"}\n` +
        `**last communication:** ${lastMsgTs ? fmt(lastMsgTs) : "none"}\n` +
        `**days since last message:** ${inactiveDays ?? "unknown"}\n` +
        `**saved roles:** ${testRecord?.savedRoles?.length || 0}\n` +
        `**current roles in test.members:** ${testRecord?.roles?.length || 0}\n` +
        `**WARN threshold:** ${config.WARN_AFTER_DAYS} days\n` +
        `**Would warn?** ${
          member &&
          hasNonProtectedRoles(member) &&
          teamRecord.status !== "leave" &&
          (teamRecord.warningCount || 0) === 0 &&
          inactiveDays !== null &&
          inactiveDays >= config.WARN_AFTER_DAYS
            ? "✅ YES"
            : "❌ NO"
        }`,
    });
  }

  if (commandName === "testwarn") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({ content: "❌ Admins only.", ephemeral: true });
    }

    const targetUser = interaction.options.getUser("user");
    await interaction.deferReply({ ephemeral: true });

    const member =
      interaction.guild.members.cache.get(targetUser.id) ||
      (await interaction.guild.members.fetch(targetUser.id).catch(() => null));

    if (!member) {
      return interaction.editReply({ content: "❌ Member not found." });
    }

    const channel = await resolveWarningsChannel(interaction.guild);
    if (!channel) {
      return interaction.editReply({
        content: `❌ Cannot access warnings channel (<#${config.WARNINGS_CHANNEL_ID}>). Ensure the bot role can **View Channel**, **Send Messages**, and **Embed Links** there.`,
      });
    }

    try {
      await sendInactivityWarning(interaction.guild, member, {
        inactiveDays: config.WARN_AFTER_DAYS,
      });
      await db.setWarning(interaction.guild.id, member.id, 1, Date.now());
      await interaction.editReply({
        content: `✅ Test warning sent to ${member} (DM + <#${channel.id}>).`,
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Failed to send warning: ${err.message}`,
      });
    }
  }
});

// ─── Warning embeds ───────────────────────────────────────────────────────────
function buildWarningDmEmbed(member) {
  return new EmbedBuilder()
    .setColor(0xfaa61a)
    .setAuthor({
      name: "QuantumLogics — Activity Notice",
      iconURL: client.user.displayAvatarURL(),
    })
    .setTitle("We haven't heard from you lately")
    .setDescription(
      `Hi ${member.displayName || member.user.username},\n\n` +
        "We noticed you haven't sent a message in the server recently.",
    )
    .addFields(
      {
        name: "🤝 Facing an issue?",
        value:
          "If something is blocking you, please let us know — we're here to help.",
        inline: false,
      },
      {
        name: "🌴 Need a break?",
        value:
          `You can take approved leave anytime with \`/leave\` — mention ${client.user} if you need guidance.`,
        inline: false,
      },
      {
        name: "⏰ Action required",
        value:
          "Please respond in your **team channel within 24 hours**, or your internship roles (team, captain, project roles, etc.) **may be removed**.",
        inline: false,
      },
    )
    .setFooter({ text: "QuantumLogics Activity System" })
    .setTimestamp();
}

function buildWarningChannelEmbed(member, inactiveDays) {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setAuthor({
      name: "Qubit Warnings",
      iconURL: member.user.displayAvatarURL(),
    })
    .setTitle("⚠️ Inactivity Warning Issued")
    .setDescription(`${member} has been inactive for **${inactiveDays}+ day(s)**.`)
    .addFields(
      {
        name: "📬 DM Sent",
        value: "Member has been notified privately.",
        inline: true,
      },
      {
        name: "⏳ Grace Period",
        value: "**24 hours** to respond in their team channel",
        inline: true,
      },
      {
        name: "🔢 Warning Count",
        value: "**1**",
        inline: true,
      },
      {
        name: "📋 Reminder",
        value:
          `Planned absence? Use \`/leave\` or contact ${client.user} for help.`,
        inline: false,
      },
    )
    .setFooter({ text: "QuantumLogics • Automatic Activity Monitor" })
    .setTimestamp();
}

async function sendInactivityWarning(guild, member, { inactiveDays }) {
  const dmEmbed = buildWarningDmEmbed(member);
  let dmSent = false;
  try {
    await member.send({ embeds: [dmEmbed] });
    dmSent = true;
  } catch {
    console.log(`📵 Could not DM ${member.user.tag} (DMs may be closed).`);
  }

  const channel = await resolveWarningsChannel(guild);
  if (!channel) {
    throw new Error(
      `Warnings channel ${config.WARNINGS_CHANNEL_ID} not found, not text-based, or bot lacks View/Send access.`,
    );
  }

  const channelEmbed = buildWarningChannelEmbed(member, inactiveDays);
  await channel.send({ embeds: [channelEmbed] });
  console.log(
    `⚠️ Warning sent for ${member.user.tag} (DM: ${dmSent ? "yes" : "no"}) in #${channel.name}`,
  );
}

async function resolveWarningsChannel(guild) {
  const channelId = config.WARNINGS_CHANNEL_ID;
  let channel = guild.channels.cache.get(channelId);

  if (!channel) {
    channel = await guild.channels.fetch(channelId).catch(() => null);
  }

  if (!channel?.isTextBased()) return null;

  const perms = channel.permissionsFor(guild.members.me);
  if (!perms?.has(["ViewChannel", "SendMessages", "EmbedLinks"])) {
    console.warn(
      `⚠️ Missing permissions for warnings channel ${channelId} (#${channel.name}).`,
    );
    return null;
  }

  return channel;
}

// ─── Scan Discord history when communication DB has no record ────────────────
async function scanLastMessage(guild, userId) {
  const textChannels = [...guild.channels.cache.values()].filter(
    (c) => c.isTextBased() && c.viewable,
  );

  async function scanChannel(channel) {
    try {
      let lastId = null;
      for (let page = 0; page < 3; page++) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;
        const messages = await channel.messages.fetch(options);
        if (messages.size === 0) break;
        const userMsg = messages.find((m) => m.author.id === userId);
        if (userMsg) return userMsg.createdTimestamp;
        lastId = messages.last().id;
      }
    } catch {
      /* skip channels without read access */
    }
    return null;
  }

  const timestamps = await Promise.all(textChannels.map(scanChannel));
  const valid = timestamps.filter(Boolean);
  return valid.length ? Math.max(...valid) : null;
}

async function getInactiveDays(guild, member) {
  let inactiveDays = await db.getDaysSinceLastMessage(
    guild.id,
    member.id,
    member.joinedTimestamp,
  );

  if (inactiveDays === null) {
    const scanned = await scanLastMessage(guild, member.id);
    if (scanned) {
      inactiveDays = Math.floor((Date.now() - scanned) / (1000 * 60 * 60 * 24));
    }
  }

  return inactiveDays;
}

// ─── Inactivity checker ───────────────────────────────────────────────────────
function startInactivityChecker() {
  cron.schedule("0 * * * *", async () => {
    console.log("⏰ Running scheduled checks...");
    await processExpiredLeaves();
    await checkInactivity();
  });
}

async function checkInactivity() {
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch();

      let eligible = 0;
      let warned = 0;
      let removed = 0;
      let skipped = 0;
      let errors = 0;

      for (const member of guild.members.cache.values()) {
        try {
          if (member.user.bot) continue;
          if (!hasNonProtectedRoles(member)) continue;

          const teamRecord = await db.getTeamMember(guild.id, member.id);
          if (teamRecord?.status === "leave") continue;

          const activeLeave = await db.getActiveLeave(guild.id, member.id);
          if (activeLeave) continue;

          eligible++;

          const inactiveDays = await getInactiveDays(guild, member);

          if (inactiveDays === null || inactiveDays < config.WARN_AFTER_DAYS) {
            skipped++;
            continue;
          }

          const warningCount = teamRecord?.warningCount || 0;

          console.log(
            `🔍 ${member.user.tag} — ${inactiveDays}d inactive | warnings: ${warningCount}`,
          );

          if (warningCount === 0) {
            try {
              await sendInactivityWarning(guild, member, { inactiveDays });
              await db.setWarning(guild.id, member.id, 1, Date.now());
              warned++;
            } catch (warnErr) {
              errors++;
              console.error(
                `❌ Failed to warn ${member.user.tag}:`,
                warnErr.message,
              );
            }
            continue;
          }

          const hoursSinceWarn = teamRecord.warnedAt
            ? (Date.now() - teamRecord.warnedAt) / (1000 * 60 * 60)
            : config.WARNING_GRACE_HOURS + 1;

          if (hoursSinceWarn >= config.WARNING_GRACE_HOURS) {
            const stillInactive = await getInactiveDays(guild, member);

            if (
              stillInactive !== null &&
              stillInactive >= config.WARN_AFTER_DAYS
            ) {
              await removeInternshipRoles(guild, member);
              removed++;
            }

            await db.clearWarning(guild.id, member.id);
          }
        } catch (memberErr) {
          errors++;
          console.error(
            `Error processing member ${member.id}:`,
            memberErr.message,
          );
        }
      }

      console.log(
        `⏰ Inactivity check done for "${guild.name}" — eligible: ${eligible}, warned: ${warned}, roles removed: ${removed}, below threshold: ${skipped}, errors: ${errors}`,
      );
    } catch (err) {
      console.error(`Error checking guild ${guild.name}:`, err);
    }
  }
}

async function removeInternshipRoles(guild, member) {
  const rolesToRemove = member.roles.cache.filter(
    (role) => role.name !== "@everyone" && !isProtectedRole(role.name),
  );

  if (rolesToRemove.size === 0) {
    await db.upsertTeamMember(guild.id, member.id, { status: "inactive" });
    await mainDb.markInactive(
      member.user.username,
      member.user.globalName || null,
    );
    return;
  }

  const removedRoleNames = rolesToRemove.map((r) => r.name).join(", ");

  try {
    await member.roles.remove(
      rolesToRemove,
      "Inactivity — roles removed by QuantumLogics bot",
    );

    await db.upsertTestMember(guild.id, member.id, {
      roles: getMemberRoles(await guild.members.fetch(member.id)),
    });

    await db.upsertTeamMember(guild.id, member.id, {
      status: "inactive",
      warningCount: 0,
      warnedAt: null,
    });

    await mainDb.markInactive(
      member.user.username,
      member.user.globalName || null,
    );

    console.log(
      `🔴 Removed roles from ${member.user.tag}: ${removedRoleNames}`,
    );

    const channel = await resolveWarningsChannel(guild);
    if (channel) {
      const removalEmbed = new EmbedBuilder()
        .setColor(0x992d22)
        .setTitle("🔴 Roles Removed — Inactivity")
        .setDescription(
          `${member} did not respond within **24 hours** of their inactivity warning.`,
        )
        .addFields(
          {
            name: "Roles Removed",
            value: removedRoleNames || "None",
            inline: false,
          },
          {
            name: "Protected Roles Kept",
            value: config.PROTECTED_ROLES.join(", "),
            inline: false,
          },
          {
            name: "Status",
            value: "Marked **inactive** in team.members",
            inline: false,
          },
        )
        .setFooter({ text: "QuantumLogics Activity System" })
        .setTimestamp();

      await channel.send({ embeds: [removalEmbed] });
    }

    const dmEmbed = new EmbedBuilder()
      .setColor(0x992d22)
      .setTitle("🔴 Your Roles Have Been Removed")
      .setDescription(
        `Hi **${member.user.username}**,\n\n` +
          "You did not respond within 24 hours of your inactivity warning.\n\n" +
          `**Roles removed:** ${removedRoleNames}\n\n` +
          `**Protected roles kept:** ${config.PROTECTED_ROLES.join(", ")}\n\n` +
          "Contact an admin to get your roles back, or use `/leave` before future absences.",
      )
      .setFooter({ text: "QuantumLogics Activity System" })
      .setTimestamp();

    await member.send({ embeds: [dmEmbed] }).catch(() => {
      console.log(`📵 Could not DM ${member.user.tag}.`);
    });
  } catch (err) {
    console.error(
      `Failed to remove roles from ${member.user.tag}:`,
      err.message,
    );
  }
}

client.login(config.TOKEN);
