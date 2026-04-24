import { useEffect, useState } from "react";

import { clearChatHistory, getChatHistory, sendChatMessage } from "../services/chatApi";

const STORAGE_KEY = "garment-chat-conversation-id";

const DEFAULT_SUGGESTIONS = [
  "What is the current humidity in zone1?",
  "Guide me through the dashboard for zone1",
  "How many anomalies happened today?",
  "Explain the current warning level",
  "Show humidity trend for today",
  "What factors influence warning level the most?"
];

function buildAssistantMessage(response) {
  return {
    id: `assistant-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant",
    message: response.answer,
    timestamp: new Date().toISOString(),
    toolCalls: response.toolCalls || [],
    chartData: response.chartData || null,
    chartMeta: response.chartMeta || null,
    tableData: response.tableData || null,
    tableMeta: response.tableMeta || null,
    suggestedQuestions: response.suggestedQuestions || []
  };
}

export function useChat(defaultZone = "zone1") {
  const [conversationId, setConversationId] = useState(() => {
    if (typeof window === "undefined") {
      return "";
    }
    return window.sessionStorage.getItem(STORAGE_KEY) || "";
  });
  const [messages, setMessages] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!conversationId) {
      return;
    }

    let cancelled = false;
    setIsHistoryLoading(true);

    getChatHistory(conversationId)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setMessages((payload.messages || []).map((item, index) => ({
          id: `${item.role}-${index}-${item.timestamp || index}`,
          ...item
        })));
        setError("");
      })
      .catch((historyError) => {
        if (cancelled) {
          return;
        }
        setError(historyError.message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsHistoryLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  async function submitMessage(message, zone = defaultZone) {
    const trimmed = String(message || "").trim();
    if (!trimmed || isLoading) {
      return;
    }

    const optimisticMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      message: trimmed,
      timestamp: new Date().toISOString()
    };

    setMessages((current) => [...current, optimisticMessage]);
    setIsLoading(true);
    setError("");

    try {
      const response = await sendChatMessage({
        message: trimmed,
        conversationId: conversationId || undefined,
        zone
      });

      if (response.conversationId) {
        setConversationId(response.conversationId);
        if (typeof window !== "undefined") {
          window.sessionStorage.setItem(STORAGE_KEY, response.conversationId);
        }
      }

      setMessages((current) => [...current, buildAssistantMessage(response)]);
    } catch (sendError) {
      setError(sendError.message);
      setMessages((current) => [...current, {
        id: `assistant-error-${Date.now()}`,
        role: "assistant",
        message: `I could not answer that request: ${sendError.message}`,
        timestamp: new Date().toISOString(),
        suggestedQuestions: DEFAULT_SUGGESTIONS
      }]);
    } finally {
      setIsLoading(false);
    }
  }

  async function clearConversation() {
    if (conversationId) {
      try {
        await clearChatHistory(conversationId);
      } catch (clearError) {
        setError(clearError.message);
      }
    }

    setMessages([]);
    setConversationId("");
    setError("");
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
  }

  const activeSuggestions = messages[messages.length - 1]?.suggestedQuestions?.length
    ? messages[messages.length - 1].suggestedQuestions
    : DEFAULT_SUGGESTIONS;

  return {
    conversationId,
    messages,
    isLoading,
    isHistoryLoading,
    error,
    suggestions: activeSuggestions,
    submitMessage,
    clearConversation
  };
}
