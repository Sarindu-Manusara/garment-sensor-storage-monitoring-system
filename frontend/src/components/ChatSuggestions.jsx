export function ChatSuggestions({ suggestions, onSelect }) {
  if (!suggestions?.length) {
    return null;
  }

  return (
    <div style={styles.wrap}>
      {suggestions.map((suggestion) => (
        <button
          key={suggestion}
          type="button"
          onClick={() => onSelect(suggestion)}
          style={styles.button}
        >
          {suggestion}
        </button>
      ))}
    </div>
  );
}

const styles = {
  wrap: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8
  },
  button: {
    border: "1px solid rgba(15, 23, 42, 0.12)",
    background: "rgba(255, 255, 255, 0.88)",
    color: "#0f172a",
    borderRadius: 999,
    padding: "8px 12px",
    fontSize: 12,
    cursor: "pointer"
  }
};
