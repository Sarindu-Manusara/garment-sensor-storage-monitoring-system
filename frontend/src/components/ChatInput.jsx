import { useState } from "react";

export function ChatInput({ onSend, disabled }) {
  const [value, setValue] = useState("");

  function submit() {
    const trimmed = value.trim();
    if (!trimmed || disabled) {
      return;
    }

    onSend(trimmed);
    setValue("");
  }

  return (
    <div style={styles.wrap}>
      <textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder="Ask about current data, trends, anomalies, warnings, or TinyML predictions..."
        aria-label="Chat message input"
        style={styles.input}
        rows={3}
        disabled={disabled}
      />
      <button
        type="button"
        onClick={submit}
        disabled={disabled || !value.trim()}
        aria-label={disabled ? "Sending chat message" : "Send chat message"}
        style={styles.button}
      >
        {disabled ? "Sending..." : "Send"}
      </button>
    </div>
  );
}

const styles = {
  wrap: {
    display: "grid",
    gap: 10
  },
  input: {
    width: "100%",
    resize: "none",
    borderRadius: 18,
    border: "1px solid rgba(15, 23, 42, 0.14)",
    padding: "12px 14px",
    fontSize: 14,
    fontFamily: "inherit",
    color: "#0f172a",
    background: "rgba(255, 255, 255, 0.92)",
    outline: "none"
  },
  button: {
    justifySelf: "end",
    border: "none",
    borderRadius: 14,
    padding: "10px 16px",
    background: "linear-gradient(135deg, #ff7a59, #f97316)",
    color: "#fff",
    fontWeight: 700,
    cursor: "pointer"
  }
};
