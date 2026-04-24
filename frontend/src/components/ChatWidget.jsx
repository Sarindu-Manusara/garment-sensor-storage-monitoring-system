import { Suspense, lazy, useState } from "react";

import { useChat } from "../hooks/useChat";
import { ChatInput } from "./ChatInput";
import { ChatMessageList } from "./ChatMessageList";
import { ChatSuggestions } from "./ChatSuggestions";

const ChatbotLottieIcon = lazy(() => import("./ChatbotLottieIcon"));

export function ChatWidget({ zone = "zone1" }) {
  const [isOpen, setIsOpen] = useState(false);
  const {
    messages,
    isLoading,
    isHistoryLoading,
    error,
    suggestions,
    submitMessage,
    clearConversation
  } = useChat(zone);

  return (
    <div style={styles.root}>
      {isOpen ? (
        <section
          id="chat-widget-panel"
          role="dialog"
          aria-modal="false"
          aria-labelledby="chat-widget-title"
          style={styles.panel}
        >
          <header style={styles.header}>
            <div>
              <div style={styles.eyebrow}>DATA-AWARE CHAT</div>
              <div id="chat-widget-title" style={styles.title}>Monitoring Assistant</div>
              <div style={styles.subtitle}>Uses backend tools against live sensor, history, ML outputs, and dashboard context</div>
            </div>
            <div style={styles.headerButtons}>
              <button type="button" onClick={clearConversation} aria-label="Clear chat history" style={styles.secondaryButton}>
                Clear
              </button>
              <button type="button" onClick={() => setIsOpen(false)} aria-label="Close monitoring assistant" style={styles.secondaryButton}>
                Close
              </button>
            </div>
          </header>

          <div style={styles.zonePill}>Active zone: {zone}</div>

          {error ? <div role="alert" style={styles.error}>{error}</div> : null}
          {isHistoryLoading ? <div aria-live="polite" style={styles.loading}>Loading chat history...</div> : null}

          <div style={styles.scrollArea}>
            <ChatMessageList messages={messages} onSuggestion={(value) => submitMessage(value, zone)} />
          </div>

          <div style={styles.suggestionBlock}>
            <ChatSuggestions suggestions={suggestions} onSelect={(value) => submitMessage(value, zone)} />
          </div>

          <ChatInput onSend={(value) => submitMessage(value, zone)} disabled={isLoading} />
        </section>
      ) : (
        <button
          id="chat-widget-toggle"
          type="button"
          onClick={() => setIsOpen(true)}
          aria-expanded="false"
          aria-controls="chat-widget-panel"
          aria-label="Open monitoring assistant"
          style={styles.fab}
        >
          <Suspense fallback={<div aria-hidden="true" style={styles.fabIconFallback} />}>
            <ChatbotLottieIcon size={124} />
          </Suspense>
        </button>
      )}
    </div>
  );
}

const styles = {
  root: {
    position: "fixed",
    right: 22,
    bottom: 22,
    zIndex: 40
  },
  panel: {
    width: "min(420px, calc(100vw - 20px))",
    maxHeight: "min(720px, calc(100vh - 40px))",
    display: "grid",
    gridTemplateRows: "auto auto auto 1fr auto auto",
    gap: 12,
    padding: 16,
    borderRadius: 28,
    border: "1px solid rgba(255,255,255,0.45)",
    background: "linear-gradient(180deg, rgba(255,255,255,0.96), rgba(244,247,250,0.92))",
    boxShadow: "0 24px 60px rgba(15, 23, 42, 0.18)",
    backdropFilter: "blur(14px)"
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12
  },
  headerButtons: {
    display: "flex",
    gap: 8,
    alignItems: "flex-start"
  },
  eyebrow: {
    fontSize: 11,
    letterSpacing: "0.14em",
    color: "#64748b",
    fontWeight: 700
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    color: "#0f172a"
  },
  subtitle: {
    fontSize: 13,
    color: "#475569",
    marginTop: 4
  },
  zonePill: {
    display: "inline-flex",
    width: "fit-content",
    borderRadius: 999,
    background: "rgba(20, 184, 166, 0.12)",
    color: "#0f766e",
    fontSize: 12,
    fontWeight: 700,
    padding: "8px 12px"
  },
  scrollArea: {
    overflowY: "auto",
    paddingRight: 4,
    minHeight: 220,
    maxHeight: 360
  },
  suggestionBlock: {
    paddingTop: 4
  },
  fab: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    width: 136,
    height: 136,
    borderRadius: "50%",
    padding: 0,
    background: "transparent",
    color: "#fff",
    boxShadow: "none",
    cursor: "pointer"
  },
  fabIconFallback: {
    width: 124,
    height: 124,
    borderRadius: "50%",
    background: "transparent"
  },
  secondaryButton: {
    border: "1px solid rgba(15, 23, 42, 0.12)",
    borderRadius: 12,
    background: "rgba(255,255,255,0.82)",
    color: "#0f172a",
    padding: "8px 12px",
    cursor: "pointer"
  },
  error: {
    padding: "10px 12px",
    borderRadius: 14,
    background: "rgba(239, 68, 68, 0.12)",
    color: "#991b1b",
    fontSize: 13
  },
  loading: {
    fontSize: 13,
    color: "#64748b"
  }
};
