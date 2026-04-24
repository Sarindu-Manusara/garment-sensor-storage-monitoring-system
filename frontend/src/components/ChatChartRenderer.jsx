const SERIES_COLORS = ["#f97316", "#14b8a6", "#ef4444", "#64748b"];

function buildLinePoints(data, key, width, height, padding, min, max) {
  const range = max - min || 1;
  return data
    .map((item, index) => {
      const rawValue = Number(item[key]);
      const value = Number.isFinite(rawValue) ? rawValue : min;
      const x = padding + (index / Math.max(data.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((value - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");
}

function formatLabel(value) {
  if (!value) {
    return "";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

function LineChart({ chartData, chartMeta }) {
  const width = 260;
  const height = 120;
  const padding = 14;
  const yKeys = chartMeta?.yKeys || [];
  const values = yKeys.flatMap((key) => chartData.map((item) => Number(item[key])).filter(Number.isFinite));

  if (!values.length) {
    return null;
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  return (
    <div style={styles.chartCard}>
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.svg}>
        <rect x="0" y="0" width={width} height={height} rx="18" fill="rgba(255,255,255,0.7)" />
        {yKeys.map((key, index) => (
          <polyline
            key={key}
            fill="none"
            stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={buildLinePoints(chartData, key, width, height, padding, min, max)}
          />
        ))}
      </svg>
      <div style={styles.legend}>
        {yKeys.map((key, index) => (
          <span key={key} style={styles.legendItem}>
            <span style={{ ...styles.dot, background: SERIES_COLORS[index % SERIES_COLORS.length] }} />
            {key}
          </span>
        ))}
      </div>
      <div style={styles.caption}>
        {formatLabel(chartData[0]?.[chartMeta?.xKey || "timestamp"])} to {formatLabel(chartData[chartData.length - 1]?.[chartMeta?.xKey || "timestamp"])}
      </div>
    </div>
  );
}

function BarChart({ chartData, chartMeta }) {
  const width = 260;
  const height = 120;
  const padding = 16;
  const yKey = chartMeta?.yKeys?.[0];
  const values = chartData.map((item) => Number(item[yKey])).filter(Number.isFinite);
  const max = Math.max(...values, 1);

  return (
    <div style={styles.chartCard}>
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.svg}>
        <rect x="0" y="0" width={width} height={height} rx="18" fill="rgba(255,255,255,0.7)" />
        {chartData.map((item, index) => {
          const value = Number(item[yKey]) || 0;
          const barWidth = 70;
          const gap = 30;
          const x = padding + index * (barWidth + gap);
          const barHeight = ((height - padding * 2) * value) / max;
          return (
            <g key={`${item[chartMeta?.xKey]}-${index}`}>
              <rect
                x={x}
                y={height - padding - barHeight}
                width={barWidth}
                height={barHeight}
                rx="14"
                fill={SERIES_COLORS[index % SERIES_COLORS.length]}
                opacity="0.85"
              />
              <text x={x + barWidth / 2} y={height - 4} textAnchor="middle" style={styles.svgLabel}>
                {item[chartMeta?.xKey]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function ChatChartRenderer({ chartData, chartMeta }) {
  if (!chartData?.length || !chartMeta?.type) {
    return null;
  }

  if (chartMeta.type === "bar") {
    return <BarChart chartData={chartData} chartMeta={chartMeta} />;
  }

  return <LineChart chartData={chartData} chartMeta={chartMeta} />;
}

const styles = {
  chartCard: {
    marginTop: 10,
    padding: 10,
    borderRadius: 18,
    border: "1px solid rgba(15, 23, 42, 0.08)",
    background: "rgba(248, 250, 252, 0.8)"
  },
  svg: {
    width: "100%",
    display: "block"
  },
  legend: {
    display: "flex",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 8
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#475569"
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999
  },
  caption: {
    marginTop: 8,
    fontSize: 12,
    color: "#64748b"
  },
  svgLabel: {
    fill: "#475569",
    fontSize: 11,
    fontFamily: "Space Grotesk, sans-serif"
  }
};
