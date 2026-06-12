function atlasSrvToDirect(uri) {
  const match = uri.match(
    /^mongodb\+srv:\/\/([^/]+)@([^./]+)\.([a-z0-9-]+)\.mongodb\.net\/?([^?]*)?(\?.*)?$/i,
  );
  if (!match) return uri;

  const [, creds, clusterName, clusterId, dbName = "", query = ""] = match;
  const hosts = [0, 1, 2]
    .map((n) => `${clusterName}-shard-00-0${n}.${clusterId}.mongodb.net:27017`)
    .join(",");
  const params =
    query && query.length > 0
      ? query.startsWith("?")
        ? query
        : `?${query}`
      : "?ssl=true&authSource=admin&retryWrites=true&w=majority";

  return `mongodb://${creds}@${hosts}/${dbName}${params}`;
}

function resolveMongoUri(primaryEnv, directEnv) {
  const direct = process.env[directEnv]?.trim();
  if (direct) {
    console.log(`[DB] Using ${directEnv}`);
    return direct;
  }

  const primary = process.env[primaryEnv]?.trim() || "";
  if (!primary) return "";

  if (primary.startsWith("mongodb+srv://")) {
    const converted = atlasSrvToDirect(primary);
    console.log(
      `[DB] Auto-converted ${primaryEnv} from mongodb+srv to direct shard hosts`,
    );
    return converted;
  }

  return primary;
}

module.exports = { atlasSrvToDirect, resolveMongoUri };
