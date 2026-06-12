const dns = require("dns");
const dnsPromises = require("dns").promises;

const PUBLIC_DNS = ["8.8.8.8", "1.1.1.1"];

async function resolveSrvRecords(hostname) {
  try {
    return await dnsPromises.resolveSrv(`_mongodb._tcp.${hostname}`);
  } catch (err) {
    const resolver = new dns.Resolver();
    resolver.setServers(PUBLIC_DNS);
    return new Promise((resolve, reject) => {
      resolver.resolveSrv(`_mongodb._tcp.${hostname}`, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });
  }
}

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

  const records = await resolveSrvRecords(parsed.host);
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
  const primary = process.env[primaryEnv]?.trim() || "";
  const direct = process.env[directEnv]?.trim();
  if (!primary && direct) {
    console.log(`[DB] Using ${directEnv}`);
    return direct;
  }
  if (!primary) return "";

  if (primary.startsWith("mongodb+srv://")) {
    try {
      const converted = await srvUriToDirectViaDns(primary);
      console.log(`[DB] Resolved ${primaryEnv} SRV → direct shard hosts via DNS`);
      return converted;
    } catch (err) {
      console.warn(`[DB] Could not resolve ${primaryEnv} SRV (${err.message}).`);
      if (direct) {
        console.log(`[DB] Falling back to ${directEnv}`);
        return direct;
      }
      return primary;
    }
  }

  if (direct) {
    console.log(`[DB] Using ${directEnv}`);
    return direct;
  }

  return primary;
}

module.exports = {
  resolveMongoUri,
  resolveMongoUriAsync,
  srvUriToDirectViaDns,
};
