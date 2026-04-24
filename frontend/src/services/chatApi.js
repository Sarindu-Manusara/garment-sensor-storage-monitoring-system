import { toApiUrl } from "./apiBase";

async function parseJsonResponse(response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || "Chat request failed.");
  }
  return payload;
}

export async function sendChatMessage({ message, conversationId, zone }) {
  const response = await fetch(toApiUrl("/api/chat/message"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      conversationId,
      zone
    })
  });

  return parseJsonResponse(response);
}

export async function getChatHistory(conversationId) {
  const response = await fetch(toApiUrl(`/api/chat/history?conversationId=${encodeURIComponent(conversationId)}`));
  return parseJsonResponse(response);
}

export async function clearChatHistory(conversationId) {
  const response = await fetch(toApiUrl(`/api/chat/history?conversationId=${encodeURIComponent(conversationId)}`), {
    method: "DELETE"
  });
  return parseJsonResponse(response);
}
