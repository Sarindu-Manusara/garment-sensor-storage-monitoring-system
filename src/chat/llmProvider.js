function createLlmProvider(config, logger = console) {
  async function generateResponse({
    systemPrompt,
    userMessage,
    conversation = [],
    toolCalls = [],
    toolResults = [],
    draftAnswer = ""
  }) {
    const provider = config.chatLlmProvider || "local";
    if (provider === "local" || !config.chatLlmApiKey) {
      return draftAnswer;
    }

    const response = await fetch(`${config.chatLlmBaseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.chatLlmApiKey}`
      },
      body: JSON.stringify({
        model: config.chatLlmModel,
        temperature: 0.1,
        max_tokens: 280,
        messages: [
          {
            role: "system",
            content: systemPrompt
          },
          {
            role: "system",
            content: [
              "Conversation context:",
              JSON.stringify(conversation.slice(-6), null, 2),
              "Tool calls:",
              JSON.stringify(toolCalls, null, 2),
              "Tool results:",
              JSON.stringify(toolResults, null, 2),
              "Answer only from these tool results. If uncertain, say the data is unavailable."
            ].join("\n")
          },
          {
            role: "user",
            content: userMessage
          }
        ]
      }),
      signal: AbortSignal.timeout(config.chatLlmTimeoutMs || 15000)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`LLM provider request failed (${response.status}): ${errorText.slice(0, 240)}`);
    }

    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === "string" && content.trim() ? content.trim() : draftAnswer;
  }

  async function generateWithTools(payload) {
    try {
      const answer = await generateResponse(payload);
      return {
        answer,
        provider: config.chatLlmProvider || "local",
        usedFallback: answer === payload.draftAnswer
      };
    } catch (error) {
      logger.warn?.(`Chat LLM fallback engaged: ${error.message}`);
      return {
        answer: payload.draftAnswer,
        provider: "local-fallback",
        usedFallback: true
      };
    }
  }

  return {
    generateResponse,
    generateWithTools
  };
}

module.exports = {
  createLlmProvider
};
