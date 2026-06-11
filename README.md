# QuantumLogics Activity Bot

A Discord bot for the **QuantumLogics** server that tracks intern activity, manages approved leave, syncs status with the main `quantum_logics` employee database, logs server communication, and automatically warns or removes roles from inactive interns.

---

## What the Bot Does

### Automatic activity tracking

| Event | What happens |
| ----- | ------------ |
| **Any member sends a message** | Message is saved to the `communication` collection (author, channel, timestamp, status). |
| **Intern sends a message** | Inactivity timer resets, daily activity streak is recorded, and the matching employee in the main DB is marked `discordActivityStatus: active`. |
| **Any message is deleted** | The matching `communication` record is marked `deleted` with a `deletedAt` timestamp. |
| **Intern joins a voice channel** | Employee is marked `active` in the main DB. **Does not** reset the message-based inactivity timer. |
| **Intern role is assigned** | `internSince` is recorded in the bot DB. Employee is marked `active` in the main DB. The inactivity clock starts from the member's **first message**, not from role assignment. |
| **Intern role is removed** | Employee is marked `inactive` in the main DB. |
| **New member joins** | Logged to the console only (no activity seeding). |
| **Bot starts up** | Connects to both databases, then backfills `discordActivityStatus` for all intern employees by comparing Discord Intern role holders against `employees.discordUrl`. |

### Inactivity enforcement (interns only)

Only members with the **Intern** role are subject to warnings and role removal. Non-interns can still use `/status`, but they are never warned or stripped of roles by the cron job.

The bot runs an **hourly check** (`0 * * * *`) and also supports manual triggers via `/forcecheck`.

| Phase | Threshold | Action |
| ----- | --------- | ------ |
| **Safe** | Fewer than 3 effective inactive days | No action. Employee stays `active` in main DB. |
| **Warning** | 3+ effective inactive days (`WARN_AFTER_DAYS`) | One warning embed is posted in a channel whose name contains `"announcement"`, tagging the member. `warningSent` and `warnedAt` are stored in the DB. |
| **Grace period** | 24 hours after the warning | Member must send a message to reset the timer. Voice activity alone does not count. |
| **Role removal** | Still inactive 24+ hours after the warning | All roles are removed **except** `@everyone`, **Intern**, and protected team roles (`AI/ML`, `Web`, `Compiler`). A removal notice is posted in announcements, the member is DMed, and the employee is marked `inactive` in the main DB. |

**How inactive days are calculated**

- Based on the member's **last message** in any readable text channel (up to 300 messages per channel scanned in parallel).
- If the member has never sent a message, the clock falls back to `internSince` (when the Intern role was assigned, or when the bot first detected them as an intern).
- Approved leave days that overlap the inactivity window are subtracted — leave days do not count toward inactivity.
- Sending a new message resets `lastActivity`, clears the warning flag, and stops the removal process.

**Roles that are never removed**

- `Intern` (kept so tracking continues)
- `AI/ML`
- `Web`
- `Compiler`

Edit `PROTECTED_ROLES` in `config.js` to change the team roles.

### Main database sync (`quantum_logics`)

The bot connects to a **second MongoDB database** (`quantum_logics`) and updates the `employees` collection:

- Matches Discord members to employees by `discordUrl` (supports `@username`, plain username, or legacy `username#1234`).
- Tries both `member.user.username` and `member.user.globalName` for matching.
- Sets `discordActivityStatus` to `active` or `inactive` based on Discord activity and intern role state.
- Reads `joinedAt` from intern employee records for the **Intern Since** field in `/status`.

### Message history scanning

When the bot needs a member's real last message time (for `/status`, `/syncactivity`, `/forcecheck`, or the hourly cron), it scans **all viewable text channels** in parallel — up to 3 pages (300 messages) per channel — and uses the most recent message timestamp found.

---

## Slash Commands

### Member commands

| Command | Description |
| ------- | ----------- |
| `/leave <days>` | Log approved leave (1–60 days). Leave days are excluded from the inactivity count. Also updates `lastActivity` and adds to leave balance. |
| `/status` | Show your activity status embed. |
| `/status @user` | Show another member's status embed. |

**`/status` for non-interns** shows: last active, active-day streak, server join date, account creation date, team role, and full role list.

**`/status` for interns** adds: intern since (from main DB `joinedAt`), time as intern, leave status, inactivity timer with color-coded embed, and whether a warning was already sent.

### Admin commands

All admin commands require the **Administrator** permission.

| Command | Description |
| ------- | ----------- |
| `/resetactivity @user` | Manually set a member's `lastActivity` to now and clear their warning. If the target is an intern, also marks them `active` in the main DB. |
| `/grantleave @user <days>` | Grant approved leave days to a member (same effect as them running `/leave`). |
| `/syncactivity` | Scan Discord message history and backfill `lastActivity` for **all interns** in the server. |
| `/syncactivity @user` | Same scan for a single member. |
| `/forcecheck` | Backfill missing `lastActivity` / `internSince` for interns, then immediately run the full inactivity check. Useful for testing without waiting for the hourly cron. |
| `/debuguser` | Show raw DB fields (`lastActivity`, `internSince`, `warningSent`, `warnedAt`, `leaveBalance`), effective inactive days, warn threshold, and whether an announcements channel was found. |
| `/debuguser @user` | Debug a specific member. |
| `/testwarn @user` | Force-send an inactivity warning embed to announcements for a user (bypasses the day threshold). Records the warning in the DB. |

---

## Configuration

### Environment variables (`.env`)

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_TOKEN=your_discord_bot_token_here
CLIENT_ID=your_discord_application_client_id
GUILD_ID=your_discord_guild_id

# Bot activity database (database.js)
MONGODB_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/activity_bot_db

# Main app database (maindb.js)
MONGO_URI=mongodb+srv://<user>:<password>@cluster.mongodb.net/quantum_logics
```

### `config.js`

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `WARN_AFTER_DAYS` | `3` | Effective inactive days before a warning is posted. |
| `REMOVE_ROLES_AFTER_DAYS` | `4` | Used in `/status` display for "days remaining" messaging. Actual removal happens **24 hours after the warning**, not strictly on day 4. |
| `PROTECTED_ROLES` | `AI/ML`, `Web`, `Compiler` | Team roles never stripped during inactivity removal. |

---

## Setup Guide

### 1. Create the bot on Discord

1. Go to https://discord.com/developers/applications → **New Application**
2. Open **Bot** → **Add Bot**
3. Under **Privileged Gateway Intents**, enable:
   - **Server Members Intent**
   - **Message Content Intent**
4. Copy the bot token into `.env` as `DISCORD_TOKEN`
5. Copy the **Application ID** from **General Information** into `.env` as `CLIENT_ID`

### 2. Invite the bot

In **OAuth2 → URL Generator**, select:

- Scopes: `bot`, `applications.commands`
- Permissions: **Manage Roles**, **Send Messages**, **Read Message History**, **View Channels**, **Embed Links**

Add the bot to your server. Copy the server ID (Developer Mode → right-click server → Copy Server ID) into `.env` as `GUILD_ID`.

> The bot's role must be **above** every role it needs to remove in **Server Settings → Roles**.

### 3. Set up MongoDB

The bot uses **two** MongoDB databases:

| Variable | Database | Collections used |
| -------- | -------- | ---------------- |
| `MONGODB_URI` | Activity bot DB | `activities`, `activitylogs`, `leavelogs`, `communication` |
| `MONGO_URI` | `quantum_logics` | `employees` |

Use local MongoDB or [MongoDB Atlas](https://www.mongodb.com/cloud/atlas). Whitelist your IP if using Atlas.

### 4. Create an announcements channel

Warnings and role-removal notices are posted in the first text channel whose name contains `"announcement"` (case-insensitive). Create something like `#announcements` so warnings are delivered.

### 5. Install and run

```bash
npm install
npm run deploy    # Register slash commands (run after command changes)
npm start         # Start the bot
```

---

## Data Storage

### Activity bot database (`MONGODB_URI`)

| Collection | Purpose |
| ---------- | ------- |
| `activities` | Per-member state: `lastActivity`, `internSince`, `warningSent`, `warnedAt`, `leaveBalance`, `leaveStart` |
| `activitylogs` | One record per active day (used for consecutive-day streaks) |
| `leavelogs` | Approved leave periods (`startDate`, `endDate`) |
| `communication` | Every tracked message: author, channel, timestamp, active/deleted status |

### Main database (`MONGO_URI`)

| Collection | Fields used by bot |
| ---------- | ------------------ |
| `employees` | `discordUrl`, `jobTitle`, `joinedAt`, `discordActivityStatus` (`active` / `inactive`) |

---

## File Structure

```
├── bot.js              # Main bot: events, slash commands, inactivity cron
├── database.js         # Activity bot MongoDB layer
├── maindb.js           # quantum_logics employee DB sync
├── config.js           # Thresholds and protected roles
├── deploy-commands.js  # Register guild slash commands
├── .env.example        # Environment variable template
└── package.json
```

---

## Keeping It Running

Use `pm2` for 24/7 uptime:

```bash
npm install -g pm2
pm2 start bot.js --name quantumlogics-bot
pm2 save
pm2 startup
```

---

## Troubleshooting

**Bot won't start (MongoDB error)**

- Confirm MongoDB is running or Atlas is reachable
- Check `MONGODB_URI` and `MONGO_URI` in `.env`
- For Atlas, verify IP whitelist and credentials

**Commands not appearing**

- Run `npm run deploy`
- Confirm `CLIENT_ID` and `GUILD_ID` in `.env` are correct

**Warnings not posting**

- Ensure a channel with `"announcement"` in its name exists
- Confirm the bot can view and send messages in that channel
- Use `/debuguser` to verify the announcements channel is detected

**Roles not being removed**

- Bot role must be higher than the roles it removes
- Bot needs **Manage Roles** permission
- Removal only applies to members with the **Intern** role who exceeded the warning + 24h grace period

**Employee not syncing to main DB**

- `discordUrl` in `employees` must match the member's Discord username or display name (case-insensitive, `@` optional)
- Use `/debuguser` and check console logs for `markActive: no match` messages

**Inactivity seems wrong**

- Run `/syncactivity @user` to backfill last message time from Discord history
- Run `/forcecheck` to backfill and trigger an immediate check
- Remember: voice joins do **not** reset the inactivity timer — only messages do
