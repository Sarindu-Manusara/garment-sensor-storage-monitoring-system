import { ChatChartRenderer } from "./ChatChartRenderer";
import { ChatSuggestions } from "./ChatSuggestions";

function renderCell(value) {
  if (Array.isArray(value)) {
    return value.join(", ");
  }
  if (value === null || value === undefined || value === "") {
    return "--";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  return String(value);
}

function ChatTable({ tableData, tableMeta }) {
  if (!tableData?.length) {
    return null;
  }

  const columns = tableMeta?.columns || Object.keys(tableData[0] || {});
  return (
    <div style={styles.tableWrap}>
      <table style={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} style={styles.tableHead}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tableData.map((row, index) => (
            <tr key={`${index}-${columns[0]}`}>
              {columns.map((column) => (
                <td key={column} style={styles.tableCell}>{renderCell(row[column])}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChatMessageList({ messages, onSuggestion }) {
  if (!messages.length) {
    return (
      <div style={styles.empty}>
        <div style={styles.emptyTitle}>Ask the monitoring assistant</div>
        <div style={styles.emptyText}>
          It can answer live sensor questions, guide you through the dashboard, explain anomaly and warning outputs, and estimate which factors are tracking a target metric most strongly.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.list}>
      {messages.map((message) => (
        <div
          key={message.id}
          style={{
            ...styles.message,
            ...(message.role === "assistant" ? styles.assistant : styles.user)
          }}
        >
          <div style={styles.meta}>
            <span style={styles.role}>{message.role === "assistant" ? "Assistant" : "You"}</span>
            <span>{message.timestamp ? new Date(message.timestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : ""}</span>
          </div>
          <div style={styles.body}>{message.message}</div>
          {message.chartData?.length ? (
            <ChatChartRenderer chartData={message.chartData} chartMeta={message.chartMeta} />
          ) : null}
          {message.tableData?.length ? (
            <ChatTable tableData={message.tableData} tableMeta={message.tableMeta} />
          ) : null}
          {message.role === "assistant" && message.suggestedQuestions?.length ? (
            <div style={{ marginTop: 12 }}>
              <ChatSuggestions suggestions={message.suggestedQuestions} onSelect={onSuggestion} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const styles = {
  list: {
    display: "grid",
    gap: 12
  },
  empty: {
    padding: "24px 18px",
    borderRadius: 22,
    background: "rgba(255,255,255,0.72)",
    border: "1px dashed rgba(15, 23, 42, 0.14)",
    color: "#475569"
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: 700,
    color: "#0f172a",
    marginBottom: 6
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 1.6
  },
  message: {
    padding: 14,
    borderRadius: 22,
    border: "1px solid rgba(15, 23, 42, 0.08)"
  },
  assistant: {
    background: "rgba(255, 255, 255, 0.9)"
  },
  user: {
    background: "rgba(255, 122, 89, 0.12)"
  },
  meta: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 12,
    color: "#64748b",
    marginBottom: 8
  },
  role: {
    fontWeight: 700
  },
  body: {
    whiteSpace: "pre-wrap",
    lineHeight: 1.6,
    color: "#0f172a",
    fontSize: 14
  },
  tableWrap: {
    overflowX: "auto",
    marginTop: 10
  },
  table: {
    width: "100%",
    borderCollapse: "collapse",
    fontSize: 12
  },
  tableHead: {
    textAlign: "left",
    padding: "8px 6px",
    color: "#475569",
    borderBottom: "1px solid rgba(15, 23, 42, 0.1)"
  },
  tableCell: {
    padding: "8px 6px",
    borderBottom: "1px solid rgba(15, 23, 42, 0.06)",
    color: "#0f172a"
  }
};
