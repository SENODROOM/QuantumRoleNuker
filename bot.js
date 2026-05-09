require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  PermissionsBitField,
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
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isInternMember(member) {
  return member.roles.cache.some((r) => r.name.toLowerCase() === "intern");
}

function getTeamRole(member) {
  const found = member.roles.cache.find((r) =>
    config.PROTECTED_ROLES.map((p) => p.toLowerCase()).includes(
      r.name.toLowerCase(),
    ),
  );
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

// ─── On Ready ────────────────────────────────────────────────────────────────
client.once("ready", async () => {
  console.log(`✅ QuantumLogics Bot is online as ${client.user.tag}`);
  await db.initialize();
  await mainDb.initMainDb();
  await backfillMainDbStatuses();
  startInactivityChecker();
});

// ─── Backfill discordActivityStatus in quantum_logics DB on startup ───────────
async function backfillMainDbStatuses() {
  for (const guild of client.guilds.cache.values()) {
    try {
      const members = await guild.members.fetch();
      const activeMembers = [];
      for (const member of members.values()) {
        if (member.user.bot) continue;
        if (isInternMember(member)) {
          // Pass both username and globalName — maindb will try both against discordUrl
          activeMembers.push({
            username: member.user.username,
            globalName: member.user.globalName || null,
          });
        }
      }
      await mainDb.backfillActivityStatuses(activeMembers);
    } catch (err) {
      console.error(`Main DB backfill error in guild ${guild.name}:`, err);
    }
  }
}

// ─── Auto-detect when Intern role is assigned or removed ─────────────────────
client.on("guildMemberUpdate", async (oldMember, newMember) => {
  if (newMember.user.bot) return;

  const hadIntern = isInternMember(oldMember);
  const hasIntern = isInternMember(newMember);

  const username = newMember.user.username;
  const globalName = newMember.user.globalName || null;

  // Intern role just ADDED
  if (!hadIntern && hasIntern) {
    // Only set internSince — do NOT seed lastActivity here.
    // The inactivity clock starts from their first message, not role assignment.
    await db.setInternSince(newMember.guild.id, newMember.id);
    await mainDb.markActive(username, globalName);
    console.log(
      `🎓 Intern role assigned to ${newMember.user.tag} — internSince recorded, marked active.`,
    );
  }

  // Intern role just REMOVED
  if (hadIntern && !hasIntern) {
    await mainDb.markInactive(username, globalName);
    console.log(
      `🔴 Intern role removed from ${newMember.user.tag} — marked inactive.`,
    );
  }
});

// ─── Track Message Activity ───────────────────────────────────────────────────
client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  const member = message.guild.members.cache.get(message.author.id);
  if (member && isInternMember(member)) {
    // Record in bot DB (resets inactivity timer) AND mark active in main DB
    await db.recordActivity(message.guild.id, message.author.id);
    await mainDb.markActive(
      message.author.username,
      message.author.globalName || null,
    );
  }
});

// ─── Track Voice Activity ─────────────────────────────────────────────────────
// Voice joins update mainDb status only — they do NOT reset the message-based
// lastActivity timer. Inactivity is tracked from last message only.
client.on("voiceStateUpdate", async (oldState, newState) => {
  if (!oldState.channelId && newState.channelId) {
    if (newState.member && !newState.member.user.bot) {
      if (isInternMember(newState.member)) {
        await mainDb.markActive(
          newState.member.user.username,
          newState.member.user.globalName || null,
        );
      }
    }
  }
});

// ─── Track Members Joining ───────────────────────────────────────────────────
// We do NOT seed lastActivity on join — the clock only starts from first message.
client.on("guildMemberAdd", async (member) => {
  console.log(`👋 New member joined: ${member.user.tag}.`);
});

// ─── Slash Commands ───────────────────────────────────────────────────────────
client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // ── /leave ──────────────────────────────────────────────────────────────────
  if (commandName === "leave") {
    const days = interaction.options.getInteger("days");
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    await db.setLeave(guildId, userId, days);

    await interaction.reply({
      content: `✅ Leave recorded! You have **${days} day(s)** of approved leave. These won't count toward your inactivity timer.`,
    });
    console.log(`🏖️ ${interaction.user.tag} took ${days} day(s) of leave.`);
  }

  // ── /status ─────────────────────────────────────────────────────────────────
  if (commandName === "status") {
    const targetUser = interaction.options.getUser("user") || interaction.user;
    const userId = targetUser.id;
    const guildId = interaction.guild.id;

    await interaction.deferReply();

    const data = await db.getMemberData(guildId, userId);
    const member =
      interaction.guild.members.cache.get(userId) ||
      (await interaction.guild.members.fetch(userId).catch(() => null));

    if (!data || !member) {
      return interaction.editReply({
        content: "❓ No activity data found for this user.",
      });
    }

    const activeDays = await db.getConsecutiveActiveDays(guildId, userId);
    // Scan Discord directly — do not use DB lastActivity at all
    const lastMsgTs = await scanLastMessage(interaction.guild, userId);
    const lastSeen = lastMsgTs
      ? `<t:${Math.floor(lastMsgTs / 1000)}:R>`
      : "No messages sent yet";
    const serverJoined = member.joinedTimestamp
      ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:D>`
      : "Unknown";
    const accountCreated = `<t:${Math.floor(targetUser.createdTimestamp / 1000)}:D>`;

    const isIntern = isInternMember(member);
    const teamRole = getTeamRole(member);
    const teamValue = teamRole ? `**${teamRole}**` : "Not assigned";

    if (!isIntern) {
      // ── Non-intern view ──────────────────────────────────────────────────
      const roleList =
        member.roles.cache
          .filter((r) => r.name !== "@everyone")
          .map((r) => `<@&${r.id}>`)
          .join(", ") || "None";

      const embed = new EmbedBuilder()
        .setColor(0x5865f2)
        .setTitle("📊 Member Status")
        .setDescription(`<@${userId}>`)
        .setThumbnail(targetUser.displayAvatarURL())
        .addFields(
          { name: "🕐 Last Active", value: lastSeen, inline: true },
          {
            name: "📅 Active Days (streak)",
            value: `${activeDays} day(s)`,
            inline: true,
          },
          { name: "📆 Joined Server", value: serverJoined, inline: true },
          { name: "🗓️ Account Created", value: accountCreated, inline: true },
          { name: "🛠️ Team", value: teamValue, inline: true },
          { name: "🎭 Roles", value: roleList, inline: false },
        )
        .setFooter({ text: "QuantumLogics Activity Tracker" })
        .setTimestamp();

      return interaction.editReply({ embeds: [embed] });
    }

    // ── Intern view ──────────────────────────────────────────────────────────
    const leaveLeft = data.leaveBalance || 0;
    const activeLeave = await db.getActiveLeave(guildId, userId);
    // Use the real last message time (already scanned above) for inactivity
    const effectiveInactiveDays =
      await db.getEffectiveInactiveDaysFromTimestamp(
        guildId,
        userId,
        lastMsgTs || data.internSince || null,
      );

    // Fetch intern start date from quantum_logics employees.joinedAt
    const joinedAt = await mainDb.getInternJoinedAt(
      targetUser.username,
      targetUser.globalName || null,
    );
    let internSinceStr = "Not found in employee records";
    let internDurationStr = "—";
    if (joinedAt) {
      internSinceStr = `<t:${Math.floor(joinedAt.getTime() / 1000)}:D>`;
      internDurationStr = humanDuration(Date.now() - joinedAt.getTime());
    }

    // Leave status
    let leaveStatus;
    if (activeLeave) {
      leaveStatus = `✅ On approved leave until **${activeLeave.endDate}**`;
    } else if (leaveLeft > 0) {
      leaveStatus = `🏖️ ${leaveLeft} day(s) balance (not currently active)`;
    } else {
      leaveStatus = "❌ Not on leave";
    }

    // Inactivity timer
    const daysLeft = config.REMOVE_ROLES_AFTER_DAYS - effectiveInactiveDays;
    let inactivityStatus;
    if (activeLeave) {
      inactivityStatus = "⏸️ Paused (on leave)";
    } else if (effectiveInactiveDays >= config.REMOVE_ROLES_AFTER_DAYS) {
      inactivityStatus = `🔴 ${effectiveInactiveDays} day(s) inactive — roles at risk!`;
    } else if (effectiveInactiveDays >= config.WARN_AFTER_DAYS) {
      inactivityStatus = `⚠️ ${effectiveInactiveDays} day(s) inactive — warning issued (${daysLeft} day(s) until removal)`;
    } else {
      inactivityStatus = `✅ ${effectiveInactiveDays} day(s) inactive — all good (${daysLeft} day(s) remaining)`;
    }

    const embedColor = activeLeave
      ? 0x00b0f4
      : effectiveInactiveDays >= config.REMOVE_ROLES_AFTER_DAYS
        ? 0xff0000
        : effectiveInactiveDays >= config.WARN_AFTER_DAYS
          ? 0xffa500
          : 0x57f287;

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle("🎓 Intern Status")
      .setDescription(`<@${userId}>`)
      .setThumbnail(targetUser.displayAvatarURL())
      .addFields(
        { name: "🕐 Last Active", value: lastSeen, inline: true },
        {
          name: "📅 Active Days (streak)",
          value: `${activeDays} day(s)`,
          inline: true,
        },
        { name: "📆 Joined Server", value: serverJoined, inline: true },
        { name: "🗓️ Account Created", value: accountCreated, inline: true },
        { name: "🛠️ Team", value: teamValue, inline: true },
        { name: "🎓 Intern Since", value: internSinceStr, inline: true },
        { name: "⏳ Time as Intern", value: internDurationStr, inline: true },
        { name: "🏖️ Leave Status", value: leaveStatus, inline: false },
        { name: "⏱️ Inactivity Timer", value: inactivityStatus, inline: false },
        {
          name: "⚠️ Warning Sent",
          value: data.warningSent ? "Yes" : "No",
          inline: true,
        },
      )
      .setFooter({ text: "QuantumLogics Activity Tracker" })
      .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
  }

  // ── /resetactivity ───────────────────────────────────────────────────────────
  if (commandName === "resetactivity") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({
        content: "❌ Only admins can reset activity.",
      });
    }
    const user = interaction.options.getUser("user");

    // Reset in bot DB (inactivity timer) AND mark active in main DB
    await db.recordActivity(interaction.guild.id, user.id);

    const targetMember =
      interaction.guild.members.cache.get(user.id) ||
      (await interaction.guild.members.fetch(user.id).catch(() => null));
    if (targetMember && isInternMember(targetMember)) {
      await mainDb.markActive(
        targetMember.user.username,
        targetMember.user.globalName || null,
      );
    }

    await interaction.reply({
      content: `✅ Activity reset for <@${user.id}>.`,
    });
  }

  // ── /grantleave ──────────────────────────────────────────────────────────────
  if (commandName === "grantleave") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({
        content: "❌ Only admins can grant leave.",
      });
    }
    const user = interaction.options.getUser("user");
    const days = interaction.options.getInteger("days");
    await db.setLeave(interaction.guild.id, user.id, days);
    await interaction.reply({
      content: `✅ Granted **${days}** day(s) of leave to <@${user.id}>.`,
    });
  }

  // ── /syncactivity ────────────────────────────────────────────────────────────
  if (commandName === "syncactivity") {
    if (
      !interaction.member.permissions.has(
        PermissionsBitField.Flags.Administrator,
      )
    ) {
      return interaction.reply({
        content: "❌ Only admins can sync activity.",
      });
    }

    await interaction.deferReply();

    const targetUser = interaction.options.getUser("user");
    const guild = interaction.guild;
    await guild.members.fetch();

    let membersToSync = [];
    if (targetUser) {
      const m = guild.members.cache.get(targetUser.id);
      if (m) membersToSync = [m];
    } else {
      // No user specified — sync all interns
      membersToSync = [...guild.members.cache.values()].filter(
        (m) => !m.user.bot && isInternMember(m),
      );
    }

    if (membersToSync.length === 0) {
      return interaction.editReply({
        content: "❌ No matching members found.",
      });
    }

    await interaction.editReply({
      content: `🔍 Scanning message history for **${membersToSync.length}** member(s)… this may take a moment.`,
    });

    const results = [];
    for (const member of membersToSync) {
      const lastMsgTimestamp = await scanLastMessage(guild, member.id);
      if (lastMsgTimestamp) {
        const existing = await db.getMemberData(guild.id, member.id);
        if (
          !existing ||
          !existing.lastActivity ||
          lastMsgTimestamp > existing.lastActivity
        ) {
          await db.forceSetLastActivity(guild.id, member.id, lastMsgTimestamp);
          results.push(
            `✅ <@${member.id}> — last message <t:${Math.floor(lastMsgTimestamp / 1000)}:R>`,
          );
        } else {
          results.push(`⏭️ <@${member.id}> — DB already up to date`);
        }
      } else {
        // No messages found anywhere — lastActivity stays unset.
        // Inactivity will be counted from internSince by getEffectiveInactiveDays.
        results.push(
          `⚠️ <@${member.id}> — no messages found; inactivity counted from intern start date`,
        );
      }
    }

    // Send results, splitting into chunks to avoid Discord 2000-char limit
    const lines = results.join("\n");
    const chunks = lines.match(/[\s\S]{1,1900}/g) || [lines];
    await interaction.editReply({
      content: `**Sync complete:**\n${chunks[0]}`,
    });
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i] });
    }
  }

  // ── /forcecheck ──────────────────────────────────────────────────────────────
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
    const guild = interaction.guild;
    await guild.members.fetch();

    // Step 1: backfill lastActivity from Discord for interns with 0/missing data
    const allData = await db.getAllMembers(guild.id);
    let synced = 0;
    for (const memberData of allData) {
      try {
        const member = guild.members.cache.get(memberData.userId);
        if (!member || member.user.bot || !isInternMember(member)) continue;
        if (memberData.lastActivity && memberData.lastActivity > 0) continue;

        const lastMsgTs = await scanLastMessage(guild, memberData.userId);
        if (lastMsgTs) {
          await db.forceSetLastActivity(guild.id, memberData.userId, lastMsgTs);
          console.log(
            `🔄 Backfilled lastActivity for ${member.user.tag}: ${new Date(lastMsgTs).toISOString()}`,
          );
          synced++;
        } else if (!memberData.internSince) {
          await db.setInternSince(guild.id, memberData.userId);
          console.log(
            `🔄 Set internSince for ${member.user.tag} (no messages found)`,
          );
          synced++;
        }
      } catch (e) {
        console.error(`Backfill error for ${memberData.userId}:`, e);
      }
    }

    await interaction.editReply({
      content: `🔄 Backfilled **${synced}** member(s).
🔍 Running inactivity check...`,
    });

    // Step 2: run the check
    await checkInactivity();

    await interaction.editReply({
      content: `✅ Done. Backfilled **${synced}** member(s), then ran inactivity check.
Check **#announcements** for warnings that were just sent.`,
    });
  }

  // ── /debuguser ───────────────────────────────────────────────────────────────
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

    const data = await db.getMemberData(interaction.guild.id, targetUser.id);

    if (!data) {
      return interaction.editReply({
        content: `❌ No DB record found for <@${targetUser.id}>. They have never been tracked.`,
      });
    }

    const referenceTs = data.lastActivity || data.internSince || null;
    const effectiveDays = referenceTs
      ? await db.getEffectiveInactiveDaysFromTimestamp(
          interaction.guild.id,
          targetUser.id,
          referenceTs,
        )
      : 0;

    const fmt = (ts) =>
      ts ? `<t:${Math.floor(ts / 1000)}:F> (raw: ${ts})` : `null / 0`;

    // Also fix the stale referenceTs bug right here too
    const referenceTs2 =
      data.lastActivity > 0
        ? data.lastActivity
        : data.internSince > 0
          ? data.internSince
          : null;
    const effectiveDays2 = referenceTs2
      ? await db.getEffectiveInactiveDaysFromTimestamp(
          interaction.guild.id,
          targetUser.id,
          referenceTs2,
        )
      : 0;

    const channelFound = interaction.guild.channels.cache.find(
      (c) =>
        c.name.toLowerCase().includes("announcement") &&
        c.isTextBased() &&
        c.viewable,
    );

    await interaction.editReply({
      content:
        `**🔬 DB Debug for <@${targetUser.id}>**
` +
        `\`lastActivity\` : ${fmt(data.lastActivity)}
` +
        `\`internSince\`  : ${fmt(data.internSince)}
` +
        `\`warningSent\`  : ${data.warningSent}
` +
        `\`warnedAt\`     : ${fmt(data.warnedAt)}
` +
        `\`leaveBalance\` : ${data.leaveBalance}
` +
        `**Effective inactive days (> 0 check):** ${effectiveDays2}
` +
        `**WARN threshold:** ${config.WARN_AFTER_DAYS} days
` +
        `**Would warn now?** ${effectiveDays2 >= config.WARN_AFTER_DAYS && !data.warningSent ? "✅ YES" : "❌ NO"}
` +
        `**Announcements channel:** ${channelFound ? `#${channelFound.name} ✅` : "❌ NOT FOUND"}`,
    });
  }

  // ── /testwarn ─────────────────────────────────────────────────────────────────
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

    const guild = interaction.guild;
    const member =
      guild.members.cache.get(targetUser.id) ||
      (await guild.members.fetch(targetUser.id).catch(() => null));

    if (!member) {
      return interaction.editReply({ content: "❌ Member not found." });
    }

    // Find announcements channel — show exactly what we find
    const channel = guild.channels.cache.find(
      (c) =>
        c.name.toLowerCase().includes("announcement") &&
        c.isTextBased() &&
        c.viewable,
    );

    if (!channel) {
      const allTextChannels = guild.channels.cache
        .filter((c) => c.isTextBased() && c.viewable)
        .map((c) => `#${c.name}`)
        .join(", ");
      return interaction.editReply({
        content: `❌ No announcements channel found!
Available text channels: ${allTextChannels}`,
      });
    }

    // Force-send the warning embed directly
    const embed = new EmbedBuilder()
      .setColor(0xffa500)
      .setTitle("⚠️ Inactivity Warning")
      .setDescription(
        `Hey ${member} — you haven't sent a message in **${config.WARN_AFTER_DAYS}+ days**!

` +
          `Please send a message in the server within **24 hours** to keep your roles.
` +
          `If you don't respond in time, your roles will be automatically removed.

` +
          `📋 On planned leave? Use \`/leave <days>\` to pause your timer and protect your roles. ✅`,
      )
      .setFooter({ text: "QuantumLogics Activity System" })
      .setTimestamp();

    try {
      await channel.send({ embeds: [embed] });
      await db.setWarningSent(guild.id, member.id, true);
      await interaction.editReply({
        content: `✅ Warning sent to ${member} in <#${channel.id}> and recorded in DB.`,
      });
    } catch (err) {
      await interaction.editReply({
        content: `❌ Failed to send to <#${channel.id}>: ${err.message}`,
      });
    }
  }
});

// ─── Scan all text channels for a user's most recent message ─────────────────
// Runs all channels in parallel for speed. Each channel scans up to 3 pages
// (300 messages). Returns the most recent message timestamp, or null.
async function scanLastMessage(guild, userId) {
  const textChannels = [...guild.channels.cache.values()].filter(
    (c) => c.isTextBased() && c.viewable,
  );

  // Scan one channel — returns timestamp of user's latest message or null
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
      /* no read permission — skip */
    }
    return null;
  }

  // Run all channels in parallel, collect all timestamps, return the latest
  const timestamps = await Promise.all(textChannels.map(scanChannel));
  const valid = timestamps.filter(Boolean);
  return valid.length ? Math.max(...valid) : null;
}

// ─── Inactivity Checker (runs every hour) ────────────────────────────────────
function startInactivityChecker() {
  cron.schedule("0 * * * *", async () => {
    console.log("⏰ Running inactivity check...");
    await checkInactivity();
  });
}

async function checkInactivity() {
  for (const guild of client.guilds.cache.values()) {
    try {
      await guild.members.fetch();
      const allData = await db.getAllMembers(guild.id);
      console.log(
        `⏰ Inactivity check — ${allData.length} DB record(s) in guild "${guild.name}"`,
      );

      for (const memberData of allData) {
        try {
          const member = guild.members.cache.get(memberData.userId);
          if (!member || member.user.bot) continue;
          if (!isInternMember(member)) continue;

          const username = member.user.username;
          const globalName = member.user.globalName || null;

          // --- CRITICAL: 0 is falsy in JS. Explicitly check > 0. ---
          // If DB has no real lastActivity, scan Discord to get the real timestamp
          // and write it back so future cron ticks don't need to scan again.
          let referenceTs =
            memberData.lastActivity > 0
              ? memberData.lastActivity
              : memberData.internSince > 0
                ? memberData.internSince
                : null;

          if (!referenceTs) {
            console.log(
              `🔎 ${member.user.tag} — DB has no timestamps, scanning Discord...`,
            );
            const scanned = await scanLastMessage(guild, memberData.userId);
            if (scanned) {
              await db.forceSetLastActivity(guild.id, member.id, scanned);
              referenceTs = scanned;
              console.log(
                `📝 ${member.user.tag} — lastActivity backfilled: ${new Date(scanned).toISOString()}`,
              );
            } else {
              // No messages ever — set internSince to now so the clock starts
              await db.setInternSince(guild.id, member.id);
              const refreshed = await db.getMemberData(guild.id, member.id);
              referenceTs =
                refreshed?.internSince > 0 ? refreshed.internSince : null;
              console.log(
                `📝 ${member.user.tag} — no messages found, internSince set to now`,
              );
            }
          }

          const effectiveInactiveDays = referenceTs
            ? await db.getEffectiveInactiveDaysFromTimestamp(
                guild.id,
                memberData.userId,
                referenceTs,
              )
            : 0;

          console.log(
            `🔍 ${member.user.tag} — inactive: ${effectiveInactiveDays}d | warningSent: ${memberData.warningSent} | ref: ${referenceTs ? new Date(referenceTs).toISOString() : "null"}`,
          );

          // Safe — below warn threshold
          if (effectiveInactiveDays < config.WARN_AFTER_DAYS) {
            await mainDb.markActive(username, globalName);
            continue;
          }

          // Reached warn threshold — send warning once
          if (!memberData.warningSent) {
            console.log(
              `📣 Sending inactivity warning to ${member.user.tag}...`,
            );
            await sendWarning(guild, member);
            await db.setWarningSent(guild.id, member.id, true);
            memberData.warningSent = true;
            memberData.warnedAt = Date.now();
            console.log(`✅ Warning recorded for ${member.user.tag}`);
          }

          // Warning sent — check if 24h grace period elapsed
          if (memberData.warningSent) {
            const hoursSinceWarn =
              memberData.warnedAt > 0
                ? (Date.now() - memberData.warnedAt) / (1000 * 60 * 60)
                : 25; // warnedAt missing → treat as already expired

            console.log(
              `⏱️  ${member.user.tag} — hours since warning: ${hoursSinceWarn.toFixed(1)}`,
            );

            if (hoursSinceWarn >= 24) {
              const protectedRoleNames = [
                ...config.PROTECTED_ROLES.map((r) => r.toLowerCase()),
                "intern",
              ];
              const removableRoles = member.roles.cache.filter(
                (role) =>
                  role.name !== "@everyone" &&
                  !protectedRoleNames.includes(role.name.toLowerCase()),
              );
              if (removableRoles.size > 0) {
                console.log(
                  `🔴 Removing roles from ${member.user.tag} after 24h no-response...`,
                );
                await removeRoles(guild, member);
                await mainDb.markInactive(username, globalName);
              }
              await db.resetWarning(guild.id, member.id);
            }
          }
        } catch (memberErr) {
          console.error(
            `Error processing member ${memberData.userId}:`,
            memberErr,
          );
        }
      }
    } catch (err) {
      console.error(`Error checking guild ${guild.name}:`, err);
    }
  }
}

async function sendWarning(guild, member) {
  // Look for a channel named "announcements" (case-insensitive)
  const channel = guild.channels.cache.find(
    (c) =>
      c.name.toLowerCase().includes("announcement") &&
      c.isTextBased() &&
      c.viewable,
  );

  const embed = new EmbedBuilder()
    .setColor(0xffa500)
    .setTitle("⚠️ Inactivity Warning")
    .setDescription(
      `Hey ${member} — you haven't sent a message in **${config.WARN_AFTER_DAYS}+ days**!\n\n` +
        `Please send a message in the server within **24 hours** to keep your roles.\n` +
        `If you don't respond in time, your roles will be automatically removed.\n\n` +
        `📋 On planned leave? Use \`/leave <days>\` to pause your timer and protect your roles. ✅`,
    )
    .setFooter({ text: "QuantumLogics Activity System" })
    .setTimestamp();

  if (channel) {
    await channel.send({ embeds: [embed] });
    console.log(`⚠️ Warning sent for ${member.user.tag} in #${channel.name}`);
  } else {
    console.warn(
      `⚠️ WARNING: Could not find an announcements channel in guild "${guild.name}". ` +
        `Please create a channel with "announcement" in its name so warnings can be posted. ` +
        `Warning for ${member.user.tag} was NOT sent.`,
    );
  }
}

async function removeRoles(guild, member) {
  const protectedRoleNames = [
    ...config.PROTECTED_ROLES.map((r) => r.toLowerCase()),
    "intern", // Never strip the Intern role — it's used for tracking
  ];

  const rolesToRemove = member.roles.cache.filter(
    (role) =>
      role.name !== "@everyone" &&
      !protectedRoleNames.includes(role.name.toLowerCase()),
  );

  if (rolesToRemove.size === 0) return;

  const removedRoleNames = rolesToRemove.map((r) => r.name).join(", ");

  try {
    await member.roles.remove(
      rolesToRemove,
      "Inactivity — roles removed by QuantumLogics bot",
    );
    console.log(
      `🔴 Removed roles from ${member.user.tag}: ${removedRoleNames}`,
    );

    // ── Post removal notice to announcements channel ──────────────────────────
    const announcementChannel = guild.channels.cache.find(
      (c) =>
        c.name.toLowerCase().includes("announcement") &&
        c.isTextBased() &&
        c.viewable,
    );
    if (announcementChannel) {
      const removalEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("🔴 Roles Removed — Inactivity")
        .setDescription(
          `${member} did not respond within **24 hours** of their inactivity warning.\n\n` +
            `**Roles removed:** ${removedRoleNames}\n\n` +
            `To get your roles back, please contact an admin.`,
        )
        .setFooter({ text: "QuantumLogics Activity System" })
        .setTimestamp();
      await announcementChannel.send({ embeds: [removalEmbed] });
    }

    const dmEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("🔴 Your Roles Have Been Removed — QuantumLogics")
      .setDescription(
        `Hi **${member.user.username}**,\n\nDue to extended inactivity in the **QuantumLogics** Discord server, your roles have been removed.\n\n**Roles removed:** ${removedRoleNames}\n\n**Protected roles kept:** ${config.PROTECTED_ROLES.join(", ")}\n\nIf you'd like your roles reinstated, please reach out to an admin or return to the server and get active again!\n\nFor future absences, use \`/leave <days>\` to log planned leave — your roles will be protected. 🛡️`,
      )
      .setFooter({ text: "QuantumLogics Activity System" })
      .setTimestamp();

    await member.send({ embeds: [dmEmbed] }).catch(() => {
      console.log(`📵 Could not DM ${member.user.tag} (DMs may be closed).`);
    });
  } catch (err) {
    console.error(
      `Failed to remove roles from ${member.user.tag}:`,
      err.message,
    );
  }
}

client.login(config.TOKEN);
