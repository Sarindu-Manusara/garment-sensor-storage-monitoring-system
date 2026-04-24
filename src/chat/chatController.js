const {
  parseChatMessagePayload,
  parseConversationQuery
} = require("../requestValidation");

function registerChatRoutes(app, chatService, asyncRoute) {
  app.post("/api/chat/message", asyncRoute(async (request, response) => {
    const payload = parseChatMessagePayload(request.body);
    const result = await chatService.sendMessage(payload);
    response.json(result);
  }));

  app.get("/api/chat/history", asyncRoute(async (request, response) => {
    const { conversationId } = parseConversationQuery(request.query);
    const messages = await chatService.getHistory(conversationId);
    response.json({
      conversationId,
      messages
    });
  }));

  app.delete("/api/chat/history", asyncRoute(async (request, response) => {
    const { conversationId } = parseConversationQuery(request.query);
    const result = await chatService.clearHistory(conversationId);
    response.json({
      conversationId,
      cleared: true,
      deletedCount: result.deletedCount
    });
  }));
}

module.exports = {
  registerChatRoutes
};
