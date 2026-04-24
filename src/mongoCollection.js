const { MongoClient } = require("mongodb");

async function connectToDatabase(config) {
  const mongoClient = new MongoClient(config.mongodbUri);
  await mongoClient.connect();

  const db = mongoClient.db(config.mongodbDatabase);
  const sensorCollection = db.collection(config.mongodbCollection);
  const mlCollection = db.collection(config.mongodbMlCollection || "ml_predictions");
  const chatCollection = db.collection(config.mongodbChatCollection || "chat_messages");

  return {
    mongoClient,
    db,
    sensorCollection,
    mlCollection,
    chatCollection
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
  connectToDatabase,
  connectToCollection
};
