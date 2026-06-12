const dns = require("dns").promises;

function buildDirectUri(creds, hosts, dbName, query) {
  const params =
    query && query.length > 0
      ? query.startsWith("?")
        ? query
        : `?${query}`
      : "?ssl=true&authSource=admin&retryWrites=true&w=majority";
  return `mongodb://${creds}@${hosts}/${dbName}${params}`;
}

function parseSrvUri(uri) {
  const match = uri.match(
    /^mongodb\+srv:\/\/([^/]+)@([^/]+)\/?([^?]*)?(\?.*)?$/i,
  );
  if (!match) return null;
  const [, creds, host, dbName = "", query = ""] = match;
  return { creds, host, dbName, query };
}

async function srvUriToDirectViaDns(uri) {
  const parsed = parseSrvUri(uri);
  if (!parsed) return uri;

  const records = await dns.resolveSrv(`_mongodb._tcp.${parsed.host}`);
  const hosts = records.map((r) => `${r.name}:${r.port}`).join(",");
  return buildDirectUri(parsed.creds, hosts, parsed.dbName, parsed.query);
}

function resolveMongoUri(primaryEnv, directEnv) {
  const direct = process.env[directEnv]?.trim();
  if (direct) {
    console.log(`[DB] Using ${directEnv}`);
    return direct;
  }

  const primary = process.env[primaryEnv]?.trim() || "";
  if (!primary) return "";
  if (!primary.startsWith("mongodb+srv://")) return primary;

  console.warn(
    `[DB] ${primaryEnv} is mongodb+srv — use a direct URI in ${directEnv} or MONGODB_URI if SRV DNS fails on this network.`,
  );
  return primary;
}

async function resolveMongoUriAsync(primaryEnv, directEnv) {
  const direct = process.env[directEnv]?.trim();
  if (direct) {
    console.log(`[DB] Using ${directEnv}`);
    return direct;
  }

  const primary = process.env[primaryEnv]?.trim() || "";
  if (!primary) return "";
  if (!primary.startsWith("mongodb+srv://")) return primary;

  try {
    const converted = await srvUriToDirectViaDns(primary);
    console.log(`[DB] Resolved ${primaryEnv} SRV → direct shard hosts via DNS`);
    return converted;
  } catch (err) {
    console.warn(
      `[DB] Could not resolve ${primaryEnv} SRV (${err.message}). Set ${directEnv} in .env with hosts from Atlas → Connect.`,
    );
    return primary;
  }
}

module.exports = {
  resolveMongoUri,
  resolveMongoUriAsync,
  srvUriToDirectViaDns,
};
