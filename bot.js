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
function isProtectedRole(roleOrName) {
  const roleId =
    roleOrName && typeof roleOrName === "object" ? roleOrName.id : null;
  const roleName =
    roleOrName && typeof roleOrName === "object"
      ? roleOrName.name
      : roleOrName;

  if (roleId && config.PROTECTED_ROLE_IDS.includes(roleId)) return true;
  if (!roleName) return false;

  const normalized = normalizeRoleName(roleName);
  return config.PROTECTED_ROLES.some(
    (r) => normalizeRoleName(r) === normalized,
  );
}

function getRemovableRoles(member) {
  return member.roles.cache.filter(
    (role) =>
      role.name !== "@everyone" &&
      !isProtectedRole(role) &&
      !isFutureRulesRole(role.name),
  );
}

async function removeRolesSafely(member, roles, reason) {
  const removed = [];
  for (const role of roles.values()) {
    if (isProtectedRole(role)) {
      console.error(
        `🛡️ Blocked protected role "${role.name}" (${role.id}) — will never remove`,
      );
      continue;
    }
    await member.roles.remove(role, reason);
    removed.push(role.name);
  }
  return removed;
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

function isInactivityExempt(member) {
  if (!member) return true;
  if (config.EXEMPT_USER_IDS.includes(member.id)) return true;
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  return false;
}

// ─── Sync member into test.members ────────────────────────────────────────────
async function syncDiscordMember(member, { preserveLeave = true } = {}) {
  if (!member || member.user.bot) return;

  const guildId = member.guild.id;
  const userId = member.id;
  const roles = getMemberRoles(member);
  const existing = await db.getMember(guildId, userId);
  const onLeave = existing?.status === "leave";

  const payload = {
    username: member.user.username,
    globalName: member.user.globalName || null,
    roles,
  };

  if (onLeave && existing?.savedRoles?.length) {
    payload.savedRoles = existing.savedRoles;
  }

  if (!existing) {
    payload.status = computeStatusFromRoles(member);
    payload.warningCount = 0;
    payload.warnedAt = null;
    payload.leaveEndDate = null;
  } else if (!onLeave || !preserveLeave) {
    const activeLeave = await db.getActiveLeave(guildId, userId);
    if (!activeLeave) {
      payload.status = computeStatusFromRoles(member);
    }
  }

  await db.upsertMember(guildId, userId, payload);
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
    `📋 Synced ${count} member(s) to test.members in "${guild.name}".`,
  );
}

// ─── Leave: strip roles, assign FutureRules ───────────────────────────────────
async function applyLeaveToMember(guild, member, endDate, { startDate, source } = {}) {
  const guildId = guild.id;
  const userId = member.id;
  const freshMember = await guild.members.fetch(userId);
  const testRecord = await db.getMember(guildId, userId);

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
  const savedRoles = [...merged.values()];

  await db.upsertMember(guildId, userId, {
    username: freshMember.user.username,
    globalName: freshMember.user.globalName || null,
    savedRoles,
  });

  await db.upsertMember(guildId, userId, {
    status: "leave",
    leaveEndDate: endDate,
    warningCount: 0,
    warnedAt: null,
  });
  await db.clearWarning(guildId, userId);

  const rolesToRemove = getRemovableRoles(freshMember);

  if (rolesToRemove.size > 0) {
    try {
      await removeRolesSafely(
        freshMember,
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
  await db.upsertMember(guildId, userId, {
    roles: getMemberRoles(finalMember),
    savedRoles,
  });

  console.log(
    `🏖️ ${freshMember.user.tag} on leave until ${endDate}. Saved ${savedRoles.length} role(s): ${savedRoles.map((r) => r.name).join(", ") || "none"}`,
  );

  await db.recordOnLeave({
    guildId,
    userId,
    username: freshMember.user.username,
    globalName: freshMember.user.globalName || null,
    startDate: startDate || db.getTodayString(),
    endDate,
    savedRoles,
    source: source || "bot",
  });
}

function memberNeedsLeaveApplied(guild, member, record, leaveLog) {
  if (!leaveLog) return false;

  if (!record || record.status !== "leave") return true;
  if (record.leaveEndDate !== leaveLog.endDate) return true;

  const futureRole = resolveFutureRulesRole(guild);
  const hasRemovableRoles = member.roles.cache.some(
    (r) =>
      r.name !== "@everyone" &&
      !isProtectedRole(r.name) &&
      !isFutureRulesRole(r.name),
  );

  if (hasRemovableRoles) return true;
  if (futureRole && !member.roles.cache.has(futureRole.id)) return true;

  return false;
}

async function syncLeaveLogsFromDb(guild) {
  await guild.roles.fetch();

  const activeLeaves = await db.getAllActiveLeaves(guild.id);
  if (!activeLeaves.length) return 0;

  const latestLeaveByUser = new Map();
  for (const log of activeLeaves) {
    const existing = latestLeaveByUser.get(log.userId);
    if (!existing || log.endDate > existing.endDate) {
      latestLeaveByUser.set(log.userId, log);
    }
  }

  let applied = 0;

  for (const leaveLog of latestLeaveByUser.values()) {
    try {
      const member = await guild.members.fetch(leaveLog.userId).catch(() => null);
      if (!member) {
        console.warn(
          `⚠️ LeaveLog for user ${leaveLog.userId} — member not in guild.`,
        );
        continue;
      }

      const record = await db.getMember(guild.id, leaveLog.userId);

      if (memberNeedsLeaveApplied(guild, member, record, leaveLog)) {
        console.log(
          `🏖️ LeaveLog sync — applying leave for ${member.user.tag} until ${leaveLog.endDate} (source: website/DB).`,
        );
        await applyLeaveToMember(guild, member, leaveLog.endDate, {
          startDate: leaveLog.startDate,
          source: "website",
        });
        applied++;
      }
    } catch (err) {
      console.error(
        `LeaveLog sync error for user ${leaveLog.userId}:`,
        err.message,
      );
    }
  }

  if (applied > 0) {
    console.log(
      `✅ LeaveLog sync in "${guild.name}" — applied leave actions for ${applied} member(s).`,
    );
  }

  return applied;
}

async function syncAllLeaveLogs() {
  if (!db.isReady()) {
    console.warn("🏖️ Skipping LeaveLog sync — database is not ready.");
    return;
  }

  for (const guild of client.guilds.cache.values()) {
    try {
      await syncLeaveLogsFromDb(guild);
    } catch (err) {
      console.error(`LeaveLog sync failed for guild ${guild.name}:`, err);
    }
  }
}

// ─── On Ready ────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ QuantumLogics Bot is online as ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    await syncAllServerMembers(guild);
    await syncLeaveLogsFromDb(guild);
  }

  startInactivityChecker();
  startLeaveLogSync();
});

// ─── Keep test.members roles in sync when Discord roles change ───────────────
client.on("guildMemberUpdate", async (_oldMember, newMember) => {
  if (newMember.user.bot) return;

  const memberRecord = await db.getMember(newMember.guild.id, newMember.id);
  if (memberRecord?.status === "leave") return;

  await syncDiscordMember(newMember, { preserveLeave: false });
});

client.on("guildMemberAdd", async (member) => {
  if (member.user.bot) return;
  console.log(
    `👋 New member joined: ${member.user.tag} — recording in test.members.`,
  );
  await syncDiscordMember(member, { preserveLeave: false });
});

// ─── Track messages in test.communication ────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (!message.guild || message.author.bot) return;
  if (!db.isReady()) {
    console.warn("⚠️ Message ignored — database is not ready yet.");
    return;
  }

  const saved = await db.recordCommunication(message);
  if (!saved) {
    console.error(
      `❌ Failed to save message ${message.id} from ${message.author.tag} to test.communication`,
    );
    return;
  }

  await db.removeWarningDocument(message.guild.id, message.author.id);
  console.log(
    `💬 ${message.author.tag} — saved to test.communication, cleared test.warning if present.`,
  );
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

    await applyLeaveToMember(interaction.guild, member, leaveInfo.endDate, {
      startDate: leaveInfo.startDate,
      source: "leave_command",
    });

    await interaction.reply({
      content:
        `✅ Leave approved for **${days} day(s)** (until **${leaveInfo.endDate}**).\n` +
        `Your roles have been saved and **${config.FUTURE_RULES_ROLE}** has been assigned. Contact an admin when you return to get your roles back.`,
    });
  }

  if (commandName === "status") {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    await interaction.deferReply();

    const member =
      interaction.guild.members.cache.get(targetUser.id) ||
      (await interaction.guild.members.fetch(targetUser.id).catch(() => null));

    const record = await db.getMember(interaction.guild.id, targetUser.id);

    if (!member || !record) {
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
    const inactiveDays = await getInactiveDays(interaction.guild, member);
    const pendingWarning = await db.hasWarningDocument(
      interaction.guild.id,
      targetUser.id,
    );
    const totalWarnings = record.totalWarnings || 0;
    const latestWarning = await db.getLatestWarning(
      interaction.guild.id,
      targetUser.id,
    );
    const lastWarned = latestWarning?.time
      ? `<t:${Math.floor(new Date(latestWarning.time).getTime() / 1000)}:R>`
      : "Never";

    const roleList =
      (record.roles || []).map((r) => `<@&${r.id}>`).join(", ") || "None";

    const teamRole = getTeamRole(member);
    const statusEmoji =
      record.status === "leave"
        ? "🏖️"
        : record.status === "active"
          ? "✅"
          : "🔴";

    let inactivityLine;
    if (record.status === "leave") {
      inactivityLine = `⏸️ On leave until **${record.leaveEndDate}**`;
    } else if (inactiveDays === null) {
      inactivityLine = "—";
    } else if (inactiveDays >= config.WARN_AFTER_DAYS) {
      inactivityLine = `⚠️ ${inactiveDays} day(s) since last message`;
    } else {
      inactivityLine = `✅ ${inactiveDays} day(s) since last message`;
    }

    const embed = new EmbedBuilder()
      .setColor(
        record.status === "leave"
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
          value: record.status,
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
          value:
            `**${totalWarnings}** total` +
            (pendingWarning ? " · ⏳ pending response" : "") +
            `\nLast warned: ${lastWarned}`,
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
    await db.removeWarningDocument(interaction.guild.id, user.id);

    await interaction.reply({
      content: `✅ Warning removed from test.warning for <@${user.id}>.`,
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
    await applyLeaveToMember(interaction.guild, member, leaveInfo.endDate, {
      startDate: leaveInfo.startDate,
      source: "grantleave_command",
    });

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
    await syncAllLeaveLogs();
    await checkInactivity();

    await interaction.editReply({
      content: `✅ Done. Synced LeaveLog entries and ran inactivity check.\nCheck <#${config.WARNINGS_CHANNEL_ID}> for warnings.`,
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

    const record = await db.getMember(interaction.guild.id, targetUser.id);

    if (!record) {
      return interaction.editReply({
        content: `❌ No members record for <@${targetUser.id}>.`,
      });
    }

    const member =
      interaction.guild.members.cache.get(targetUser.id) ||
      (await interaction.guild.members.fetch(targetUser.id).catch(() => null));

    const lastMsgTs = await db.getLastCommunicationTime(
      interaction.guild.id,
      targetUser.id,
    );
    const inactiveDays = member
      ? await getInactiveDays(interaction.guild, member)
      : null;
    const warningDoc = await db.getWarningDocument(
      interaction.guild.id,
      targetUser.id,
    );
    const latestWarning = await db.getLatestWarning(
      interaction.guild.id,
      targetUser.id,
    );

    const fmt = (ts) =>
      ts ? `<t:${Math.floor(ts / 1000)}:F> (raw: ${ts})` : `null`;

    await interaction.editReply({
      content:
        `**🔬 Debug for <@${targetUser.id}>**\n` +
        `**status:** ${record.status}\n` +
        `**active warning (test.warning):** ${warningDoc ? "yes" : "no"}\n` +
        `**warningCount (members):** ${record.warningCount}\n` +
        `**totalWarnings (lifetime):** ${record.totalWarnings || 0}\n` +
        `**warning document (test.warning):** ${warningDoc ? "yes" : "no"}\n` +
        `**last warning in DB:** ${latestWarning?.time ? fmt(new Date(latestWarning.time).getTime()) : "none"}\n` +
        `**warnedAt:** ${fmt(record.warnedAt)}\n` +
        `**leaveEndDate:** ${record.leaveEndDate || "none"}\n` +
        `**last communication:** ${lastMsgTs ? fmt(lastMsgTs) : "none"}\n` +
        `**days since last message:** ${inactiveDays ?? "unknown"}\n` +
        `**saved roles:** ${record.savedRoles?.length || 0}\n` +
        `**current roles:** ${record.roles?.length || 0}\n` +
        `**WARN threshold:** ${config.WARN_AFTER_DAYS} days\n` +
        `**Would warn?** ${
          member &&
          hasNonProtectedRoles(member) &&
          record.status !== "leave" &&
          (record.warningCount || 0) === 0 &&
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

    if (await db.hasWarningDocument(interaction.guild.id, member.id)) {
      return interaction.editReply({
        content: `❌ <@${member.id}> already has a warning in **test.warning**.`,
      });
    }

    try {
      const saved = await db.setWarning(
        interaction.guild.id,
        member.id,
        1,
        Date.now(),
      );

      const warningRecord = await db.recordWarning({
        guildId: interaction.guild.id,
        userId: member.id,
        username: member.user.username,
        globalName: member.user.globalName || null,
        inactiveDays: config.WARN_AFTER_DAYS,
        dmSent: false,
        channelId: null,
        channelMessageId: null,
        type: "test_inactivity",
      });

      if (!warningRecord) {
        await db.clearWarning(interaction.guild.id, member.id);
        return interaction.editReply({
          content: "❌ Could not create test.warning document.",
        });
      }

      const warningResult = await sendInactivityWarning(interaction.guild, member, {
        inactiveDays: config.WARN_AFTER_DAYS,
        totalWarnings: saved?.totalWarnings || 1,
      });

      await db.updateWarningDetails(interaction.guild.id, member.id, {
        dmSent: warningResult.dmSent,
        channelId: warningResult.channelId,
        channelMessageId: warningResult.channelMessageId,
        inactiveDays: config.WARN_AFTER_DAYS,
      });

      await interaction.editReply({
        content: `✅ Test warning sent to ${member} (DM + <#${channel.id}>).`,
      });
    } catch (err) {
      await db.removeWarningDocument(interaction.guild.id, member.id);
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

function buildWarningChannelEmbed(member, inactiveDays, totalWarnings) {
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
        value: `${totalWarnings}`,
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

async function sendInactivityWarning(guild, member, { inactiveDays, totalWarnings }) {
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

  const channelEmbed = buildWarningChannelEmbed(
    member,
    inactiveDays,
    totalWarnings,
  );
  const channelMessage = await channel.send({ embeds: [channelEmbed] });
  console.log(
    `⚠️ Warning sent for ${member.user.tag} (DM: ${dmSent ? "yes" : "no"}) in #${channel.name}`,
  );

  return {
    dmSent,
    channelId: channel.id,
    channelMessageId: channelMessage.id,
  };
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

async function getInactiveDays(guild, member) {
  return db.getDaysSinceLastMessage(guild.id, member.id);
}

// ─── Inactivity checker ───────────────────────────────────────────────────────
function startLeaveLogSync() {
  cron.schedule("*/5 * * * *", async () => {
    console.log("🏖️ Checking LeaveLog for new website leave entries...");
    await syncAllLeaveLogs();
  });
}

function startInactivityChecker() {
  cron.schedule("0 * * * *", async () => {
    console.log("⏰ Running scheduled inactivity check...");
    await checkInactivity();
  });
}

let inactivityCheckRunning = false;

async function checkInactivity() {
  if (!db.isReady()) {
    console.warn("⏰ Skipping inactivity check — database is not ready.");
    return;
  }

  if (inactivityCheckRunning) {
    console.warn("⏰ Skipping inactivity check — already running.");
    return;
  }

  inactivityCheckRunning = true;

  try {
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
          if (isInactivityExempt(member)) continue;
          if (!hasNonProtectedRoles(member)) continue;

          const memberRecord = await db.getMember(guild.id, member.id);
          if (memberRecord?.status === "leave") continue;
          if (memberRecord?.status === "inactive") continue;

          const activeLeave = await db.getActiveLeave(guild.id, member.id);
          if (activeLeave) continue;

          eligible++;

          const inactiveDays = await getInactiveDays(guild, member);

          if (inactiveDays === null || inactiveDays < config.WARN_AFTER_DAYS) {
            skipped++;
            continue;
          }

          const warningDoc = await db.getWarningDocument(guild.id, member.id);
          if (warningDoc) {
            if (await db.clearWarningIfResponded(guild.id, member.id)) {
              console.log(
                `💬 ${member.user.tag} responded recently — removed test.warning document.`,
              );
              skipped++;
              continue;
            }

            const hoursSinceWarn =
              (Date.now() - new Date(warningDoc.time).getTime()) /
              (1000 * 60 * 60);

            console.log(
              `🔍 ${member.user.tag} — ${inactiveDays}d inactive | warning on file | grace: ${hoursSinceWarn.toFixed(1)}h`,
            );

            if (hoursSinceWarn < config.WARNING_GRACE_HOURS) {
              skipped++;
              continue;
            }

            const stillInactive = await getInactiveDays(guild, member);
            if (
              stillInactive !== null &&
              stillInactive >= config.WARN_AFTER_DAYS
            ) {
              await removeInternshipRoles(guild, member, {
                inactiveDays: stillInactive,
              });
              removed++;
            }
            continue;
          }

          console.log(
            `🔍 ${member.user.tag} — ${inactiveDays}d inactive | no warning document`,
          );

          if (await db.hasWarningDocument(guild.id, member.id)) {
            skipped++;
            continue;
          }

          const issue = await db.tryIssueWarning(guild.id, member.id);
          if (!issue.issued) {
            skipped++;
            continue;
          }

          try {
            const totalWarnings = issue.record?.totalWarnings || 1;
            const saved = await db.recordWarning({
              guildId: guild.id,
              userId: member.id,
              username: member.user.username,
              globalName: member.user.globalName || null,
              inactiveDays,
              dmSent: false,
              channelId: null,
              channelMessageId: null,
              type: "inactivity",
            });
            if (!saved) {
              await db.clearWarning(guild.id, member.id);
              skipped++;
              continue;
            }

            const warningResult = await sendInactivityWarning(guild, member, {
              inactiveDays,
              totalWarnings,
            });

            await db.updateWarningDetails(guild.id, member.id, {
              dmSent: warningResult.dmSent,
              channelId: warningResult.channelId,
              channelMessageId: warningResult.channelMessageId,
              inactiveDays,
            });

            warned++;
          } catch (warnErr) {
            await db.removeWarningDocument(guild.id, member.id);
            errors++;
            console.error(
              `❌ Failed to warn ${member.user.tag}:`,
              warnErr.message,
            );
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
  } finally {
    inactivityCheckRunning = false;
  }
}

async function removeInternshipRoles(guild, member, { inactiveDays = null } = {}) {
  const rolesToRemove = getRemovableRoles(member);
  const rolesKept = member.roles.cache
    .filter((role) => isProtectedRole(role))
    .map((role) => ({ id: role.id, name: role.name }));

  try {
    const removedRoleNames =
      rolesToRemove.size > 0
        ? await removeRolesSafely(
            member,
            rolesToRemove,
            "Inactivity — roles removed by QuantumLogics bot",
          )
        : [];

    const removedRoles = rolesToRemove
      .filter((role) => removedRoleNames.includes(role.name))
      .map((role) => ({ id: role.id, name: role.name }));

    const updatedMember = await guild.members.fetch(member.id);
    await db.upsertMember(guild.id, member.id, {
      roles: getMemberRoles(updatedMember),
      status: "inactive",
      warningCount: 0,
      warnedAt: null,
    });

    await db.removeWarningDocument(guild.id, member.id);

    await mainDb.markInactive(
      member.user.username,
      member.user.globalName || null,
    );

    await db.recordInactiveMember({
      guildId: guild.id,
      userId: member.id,
      username: member.user.username,
      globalName: member.user.globalName || null,
      rolesRemoved: removedRoles,
      rolesKept,
      inactiveDays,
      reason: "inactivity",
    });

    console.log(
      `🔴 Silently removed roles from ${member.user.tag}: ${removedRoleNames.join(", ") || "none"} — status set to inactive (protected: ${config.PROTECTED_ROLES.join(", ")})`,
    );
  } catch (err) {
    console.error(
      `Failed to remove roles from ${member.user.tag}:`,
      err.message,
    );
  }
}

async function start() {
  try {
    await db.initialize();
    await mainDb.initMainDb();
  } catch (err) {
    console.error("❌ Startup failed — database not ready:", err.message);
    process.exit(1);
  }

  await client.login(config.TOKEN);
}

start();
