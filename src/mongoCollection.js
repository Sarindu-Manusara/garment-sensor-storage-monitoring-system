const dns = require("node:dns").promises;

const { MongoClient } = require("mongodb");

function shouldRetryWithCanonicalAtlasUri(uri, error) {
  if (!String(uri || "").startsWith("mongodb+srv://")) {
    return false;
  }

  const message = String(error?.message || "");
  return /tlsv1 alert internal error|SSL alert number 80/i.test(message);
}

async function resolveSrvHosts(hostname) {
  const srvRecords = await dns.resolveSrv(`_mongodb._tcp.${hostname}`);
  return Promise.all(
    srvRecords.map(async (record) => {
      const cnames = await dns.resolveCname(record.name).catch(() => []);
      return {
        host: cnames[0] || record.name,
        port: record.port
      };
    })
  );
}

async function resolveTxtOptions(hostname) {
  const txtRecords = await dns.resolveTxt(hostname).catch(() => []);
  const options = new URLSearchParams();

  for (const record of txtRecords) {
    const joined = record.join("");
    const nested = new URLSearchParams(joined);
    for (const [key, value] of nested.entries()) {
      options.set(key, value);
    }
  }

  return options;
}

async function probeAtlasPrimaryHost(hosts) {
  let fallbackHost = hosts[0] || null;

  for (const { host, port } of hosts) {
    const probeUri = `mongodb://${host}:${port}/?tls=true&directConnection=true`;
    const probeClient = new MongoClient(probeUri, {
      serverSelectionTimeoutMS: 5000
    });

    try {
      await probeClient.connect();
      const hello = await probeClient.db("admin").command({ hello: 1 });
      if (!fallbackHost) {
        fallbackHost = { host, port };
      }

      if (hello.isWritablePrimary) {
        await probeClient.close();
        return {
          host,
          port,
          hello
        };
      }
    } catch {
      // Ignore probe failures and continue scanning the remaining hosts.
    } finally {
      await probeClient.close().catch(() => {});
    }
  }

  if (!fallbackHost) {
    throw new Error("No Atlas shard hosts were discovered from the SRV record.");
  }

  return fallbackHost;
}

function buildCredentialSection(parsed) {
  if (!parsed.username) {
    return "";
  }

  const encodedUser = encodeURIComponent(decodeURIComponent(parsed.username));
  const encodedPassword = encodeURIComponent(decodeURIComponent(parsed.password || ""));
  return `${encodedUser}:${encodedPassword}@`;
}

async function buildCanonicalAtlasUri(uri) {
  const parsed = new URL(uri);
  const hostname = parsed.hostname;
  const hosts = await resolveSrvHosts(hostname);
  const txtOptions = await resolveTxtOptions(hostname);
  const primaryHost = await probeAtlasPrimaryHost(hosts);
  const mergedOptions = new URLSearchParams(parsed.search);

  for (const [key, value] of txtOptions.entries()) {
    if (!mergedOptions.has(key)) {
      mergedOptions.set(key, value);
    }
  }

  if (!mergedOptions.has("tls")) {
    mergedOptions.set("tls", "true");
  }

  mergedOptions.set("directConnection", "true");
  mergedOptions.delete("replicaSet");

  const credentialSection = buildCredentialSection(parsed);
  const hostSection = `${primaryHost.host}:${primaryHost.port || 27017}`;
  const pathname = parsed.pathname && parsed.pathname !== "/" ? parsed.pathname : "/";
  const query = mergedOptions.toString();

  return `mongodb://${credentialSection}${hostSection}${pathname}${query ? `?${query}` : ""}`;
}

async function connectMongoClient(config) {
  const primaryClient = new MongoClient(config.mongodbUri);

  try {
    await primaryClient.connect();
    return primaryClient;
  } catch (error) {
    await primaryClient.close().catch(() => {});

    if (!shouldRetryWithCanonicalAtlasUri(config.mongodbUri, error)) {
      throw error;
    }

    const fallbackUri = await buildCanonicalAtlasUri(config.mongodbUri);
    const fallbackClient = new MongoClient(fallbackUri);
    await fallbackClient.connect();
    console.warn("MongoDB SRV TLS fallback engaged: using canonical Atlas shard hosts.");
    return fallbackClient;
  }
}

async function connectToDatabase(config) {
  const mongoClient = await connectMongoClient(config);

  const db = mongoClient.db(config.mongodbDatabase);
  const sensorCollection = db.collection(config.mongodbCollection);
  const mlCollection = db.collection(config.mongodbMlCollection || "ml_predictions");
  const chatCollection = db.collection(config.mongodbChatCollection || "chat_messages");
  const alertCollection = db.collection(config.mongodbAlertCollection || "alert_notifications");

  return {
    mongoClient,
    db,
    sensorCollection,
    mlCollection,
    chatCollection,
    alertCollection
  };
}

async function connectToCollection(config) {
  const { mongoClient, sensorCollection } = await connectToDatabase(config);

  return {
    mongoClient,
    collection: sensorCollection
  };
}

module.exports = {
  buildCanonicalAtlasUri,
  connectMongoClient,
  connectToDatabase,
  connectToCollection
};
