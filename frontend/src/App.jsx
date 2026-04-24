import { startTransition, useEffect, useEffectEvent, useRef, useState } from "react";

import { ChatWidget } from "./components/ChatWidget";
import filtersIcon from "../../src/images/filters.png";
import healthIcon from "../../src/images/health.png";
import investigateIcon from "../../src/images/investigate.png";
import logoImage from "../../src/images/logo.png";
import mlIcon from "../../src/images/ml.png";
import timelineIcon from "../../src/images/timeline.png";
import zoneIcon from "../../src/images/zone.png";
import { toApiUrl } from "./services/apiBase";

const POLL_INTERVAL_MS = 5000;
const DEFAULT_ZONE = "zone1";
const RANGE_WINDOWS = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

const NAV = [
  { id: "zones", label: "Zones", icon: zoneIcon },
  { id: "health", label: "Health", icon: healthIcon },
  { id: "focus", label: "Filters", icon: filtersIcon },
  { id: "analytics", label: "ML Views", icon: mlIcon },
  { id: "history", label: "Timeline", icon: timelineIcon },
  { id: "investigation", label: "Investigate", icon: investigateIcon }
];

const STATUS_THEME = {
  safe: {
    background: "#dcfce7",
    color: "#15803d",
    border: "#86efac",
    label: "SAFE"
  },
  warning: {
    background: "#fef3c7",
    color: "#a16207",
    border: "#fcd34d",
    label: "WARNING"
  },
  danger: {
    background: "#fee2e2",
    color: "#b91c1c",
    border: "#fca5a5",
    label: "DANGER"
  },
  waiting: {
    background: "#e2e8f0",
    color: "#475569",
    border: "#cbd5e1",
    label: "WAITING"
  }
};

const METRICS = [
  {
    key: "temperature",
    label: "Temperature",
    unit: "C",
    icon: "TMP",
    decimals: 1,
    color: "#f97316"
  },
  {
    key: "humidity",
    label: "Humidity",
    unit: "%",
    icon: "HUM",
    decimals: 1,
    color: "#0f766e"
  },
  {
    key: "lightLux",
    label: "Light",
    unit: "lx",
    icon: "LUX",
    decimals: 0,
    color: "#ca8a04"
  },
  {
    key: "dustMgPerM3",
    label: "Dust Proxy",
    unit: "mg/m^3",
    icon: "DST",
    decimals: 3,
    color: "#7c3aed"
  },
  {
    key: "mq135AirQualityDeviation",
    label: "Gas Proxy",
    unit: "%",
    icon: "GAS",
    decimals: 2,
    color: "#dc2626"
  }
];

const DETAIL_FILTERS = [
  { key: "all", label: "All points" },
  { key: "alerting", label: "Alerting only" },
  { key: "predicted", label: "Prediction points" }
];

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short"
});

function formatValue(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "--";
  }

  return Number(value).toFixed(decimals);
}

function formatSignedValue(value, decimals = 1) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "--";
  }

  const number = Number(value);
  const prefix = number > 0 ? "+" : "";
  return `${prefix}${number.toFixed(decimals)}`;
}

function formatTimestamp(timestamp) {
  if (!timestamp) {
    return "No timestamp";
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return "No timestamp";
  }

  return timeFormatter.format(parsed);
}

function normalizeStatus(level) {
  const normalized = String(level || "").trim().toLowerCase();
  if (normalized === "low" || normalized === "safe") {
    return "safe";
  }
  if (normalized === "medium" || normalized === "warning") {
    return "warning";
  }
  if (normalized === "high" || normalized === "danger") {
    return "danger";
  }
  return "waiting";
}

function warningToNumeric(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "high") {
    return 2;
  }
  if (normalized === "medium") {
    return 1;
  }
  return 0;
}

function deriveHealthStatus(actual, inference) {
  const warningStatus = normalizeStatus(inference?.warningLevel);
  if (warningStatus !== "waiting") {
    return warningStatus;
  }

  if (inference?.anomalyFlag) {
    return inference.anomalyScore >= 0.75 ? "danger" : "warning";
  }

  if (!actual) {
    return "waiting";
  }

  if ((actual.humidity ?? 0) >= 75 || (actual.mq135AirQualityDeviation ?? 0) >= 1.5) {
    return "danger";
  }
  if ((actual.humidity ?? 0) >= 65 || (actual.dustMgPerM3 ?? 0) >= 0.08) {
    return "warning";
  }
  return "safe";
}

function healthScoreFromStatus(status) {
  if (status === "danger") {
    return 38;
  }
  if (status === "warning") {
    return 67;
  }
  if (status === "safe") {
    return 93;
  }
  return 80;
}

function buildRangeQuery(activeRange, zone) {
  const to = new Date();
  const from = new Date(to.getTime() - RANGE_WINDOWS[activeRange]);
  return new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    zone: zone || DEFAULT_ZONE
  }).toString();
}

async function fetchJson(url) {
  const response = await fetch(toApiUrl(url));
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.message || `Request failed for ${url}`);
  }
  return response.json();
}

function buildPolyline(points, min, max, width = 320, height = 88, padding = 8) {
  if (!points.length) {
    return "";
  }

  const range = max - min || 1;
  return points
    .map((point, index) => {
      const x = padding + (index / Math.max(points.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((point.value - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");
}

function getMetricConfig(metricKey) {
  return METRICS.find((metric) => metric.key === metricKey) || METRICS[1];
}

function getMetricValue(point, metricKey) {
  if (metricKey === "warningLevel") {
    return warningToNumeric(point.warningLevel);
  }
  return point?.[metricKey] ?? null;
}

function formatMetricValue(metricKey, value) {
  const metric = getMetricConfig(metricKey);
  if (metricKey === "warningLevel") {
    return String(value || "low").toUpperCase();
  }
  return `${formatValue(value, metric.decimals)} ${metric.unit}`.trim();
}

function buildLinkedHistory(series = {}) {
  const linked = new Map();

  const ensurePoint = (timestamp) => {
    const key = new Date(timestamp).toISOString();
    if (!linked.has(key)) {
      linked.set(key, {
        timestamp: key,
        actualHumidity: null,
        predictedHumidity: null,
        anomalyScore: null,
        anomalyFlag: false,
        warningLevel: null,
        warningConfidence: null
      });
    }
    return linked.get(key);
  };

  for (const point of series.actualHumidity || []) {
    const entry = ensurePoint(point.timestamp);
    entry.actualHumidity = point.value ?? null;
  }

  for (const point of series.predictedHumidity || []) {
    const entry = ensurePoint(point.timestamp);
    entry.predictedHumidity = point.value ?? null;
  }

  for (const point of series.anomalyScore || []) {
    const entry = ensurePoint(point.timestamp);
    entry.anomalyScore = point.value ?? null;
    entry.anomalyFlag = Boolean(point.flag);
  }

  for (const point of series.warningLevel || []) {
    const entry = ensurePoint(point.timestamp);
    entry.warningLevel = point.value ?? null;
    entry.warningConfidence = point.confidence ?? null;
  }

  return Array.from(linked.values()).sort((left, right) => new Date(left.timestamp) - new Date(right.timestamp));
}

function derivePointStatus(point) {
  if (!point) {
    return "waiting";
  }
  if (point.warningLevel) {
    return normalizeStatus(point.warningLevel);
  }
  if (point.anomalyFlag) {
    return point.anomalyScore >= 0.75 ? "danger" : "warning";
  }
  if ((point.actualHumidity ?? 0) >= 75) {
    return "danger";
  }
  if ((point.actualHumidity ?? 0) >= 65) {
    return "warning";
  }
  return "safe";
}

function clampBrushWindow(totalPoints, startPercent, endPercent) {
  if (totalPoints <= 1) {
    return { startIndex: 0, endIndex: Math.max(totalPoints - 1, 0) };
  }

  const rawStart = Math.floor((Math.max(0, Math.min(startPercent, 99)) / 100) * (totalPoints - 1));
  const rawEnd = Math.ceil((Math.max(1, Math.min(endPercent, 100)) / 100) * (totalPoints - 1));
  const startIndex = Math.min(rawStart, Math.max(rawEnd - 1, 0));
  const endIndex = Math.max(startIndex + 1, rawEnd);

  return {
    startIndex,
    endIndex: Math.min(endIndex, totalPoints - 1)
  };
}

function filterDetailPoints(points, detailFilter) {
  if (detailFilter === "alerting") {
    return points.filter((point) => derivePointStatus(point) !== "safe");
  }
  if (detailFilter === "predicted") {
    return points.filter((point) => point.predictedHumidity !== null && point.predictedHumidity !== undefined);
  }
  return points;
}

function summarizeFocusedMetric(points, metricKey) {
  const values = points
    .map((point) => getMetricValue(point, metricKey))
    .filter((value) => value !== null && value !== undefined && !Number.isNaN(value));

  if (!values.length) {
    return {
      count: 0,
      min: null,
      max: null,
      average: null,
      latest: null
    };
  }

  const total = values.reduce((sum, value) => sum + Number(value), 0);
  return {
    count: values.length,
    min: Math.min(...values),
    max: Math.max(...values),
    average: total / values.length,
    latest: values[values.length - 1]
  };
}

function findNearestReading(readings, selectedTimestamp) {
  if (!selectedTimestamp || !readings.length) {
    return null;
  }

  const target = new Date(selectedTimestamp).getTime();
  let closest = null;
  let smallestDelta = Number.POSITIVE_INFINITY;

  for (const reading of readings) {
    const delta = Math.abs(new Date(reading.timestamp).getTime() - target);
    if (delta < smallestDelta) {
      smallestDelta = delta;
      closest = reading;
    }
  }

  return closest;
}

function LineChart({ title, series, footer }) {
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  if (!values.length) {
    return (
      <div style={styles.chartCard}>
        <div style={styles.chartHeader}>{title}</div>
        <div style={styles.emptyChart}>No data yet.</div>
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);

  return (
    <div style={styles.chartCard} role="img" aria-label={`${title}. ${footer}`}>
      <div style={styles.chartHeader}>{title}</div>
      <svg viewBox="0 0 320 88" style={styles.chartSvg}>
        <rect x="0" y="0" width="320" height="88" fill="rgba(255,255,255,0.48)" rx="18" />
        {series.map((item) => (
          <polyline
            key={item.key}
            fill="none"
            stroke={item.color}
            strokeWidth="3"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={buildPolyline(item.points, min, max)}
          />
        ))}
      </svg>
      <div style={styles.chartLegend}>
        {series.map((item) => (
          <span key={item.key} style={styles.legendItem}>
            <span style={{ ...styles.legendDot, background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <div style={styles.chartFooter}>{footer}</div>
    </div>
  );
}

function WarningChart({ points }) {
  if (!points.length) {
    return (
      <div style={styles.chartCard}>
        <div style={styles.chartHeader}>Warning Timeline</div>
        <div style={styles.emptyChart}>No data yet.</div>
      </div>
    );
  }

  const polyline = buildPolyline(
    points.map((point) => ({
      ...point,
      value: warningToNumeric(point.value)
    })),
    0,
    2
  );

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeader}>Warning Timeline</div>
      <svg viewBox="0 0 320 88" style={styles.chartSvg}>
        <rect x="0" y="0" width="320" height="88" fill="rgba(255,255,255,0.48)" rx="18" />
        <polyline
          fill="none"
          stroke="#8b5cf6"
          strokeWidth="3"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={polyline}
        />
      </svg>
      <div style={styles.chartLegend}>
        <span style={styles.legendItem}>
          <span style={{ ...styles.legendDot, background: "#8b5cf6" }} />
          Low / Medium / High
        </span>
      </div>
      <div style={styles.chartFooter}>{points[points.length - 1]?.value?.toUpperCase() || "LOW"} current state</div>
    </div>
  );
}

function buildInteractiveCoordinates(points, min, max, width = 320, height = 112, padding = 14) {
  const validPoints = points.filter((point) => point.value !== null && point.value !== undefined && !Number.isNaN(point.value));
  if (!validPoints.length) {
    return [];
  }

  const range = max - min || 1;
  const total = Math.max(points.length - 1, 1);

  return validPoints.map((point) => ({
    ...point,
    x: padding + (point.index / total) * (width - padding * 2),
    y: height - padding - ((point.value - min) / range) * (height - padding * 2)
  }));
}

function CoordinatedLineChart({
  title,
  series,
  footer,
  selectedTimestamp,
  onSelectTimestamp,
  thresholdLines = []
}) {
  const width = 320;
  const height = 112;
  const padding = 14;
  const allValues = [
    ...series.flatMap((item) => item.points.map((point) => point.value).filter((value) => value !== null && value !== undefined && !Number.isNaN(value))),
    ...thresholdLines.map((item) => item.value).filter((value) => value !== null && value !== undefined && !Number.isNaN(value))
  ];

  if (!allValues.length) {
    return (
      <div style={styles.chartCard}>
        <div style={styles.chartHeader}>{title}</div>
        <div style={styles.emptyChart}>No data yet.</div>
      </div>
    );
  }

  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const reference = series[0]?.points || [];
  const selectedIndex = reference.findIndex((point) => point.timestamp === selectedTimestamp);
  const selectedX = selectedIndex >= 0
    ? padding + (selectedIndex / Math.max(reference.length - 1, 1)) * (width - padding * 2)
    : null;

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeader}>{title}</div>
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg}>
        <rect x="0" y="0" width={width} height={height} fill="rgba(255,255,255,0.55)" rx="18" />

        {thresholdLines.map((line) => {
          const y = height - padding - ((line.value - min) / (max - min || 1)) * (height - padding * 2);
          return (
            <g key={`${title}-${line.label}`}>
              <line
                x1={padding}
                x2={width - padding}
                y1={y}
                y2={y}
                stroke={line.color}
                strokeWidth="1.5"
                strokeDasharray="4 5"
                opacity="0.85"
              />
              <text x={width - padding} y={y - 4} textAnchor="end" style={styles.chartAnnotation}>
                {line.label}
              </text>
            </g>
          );
        })}

        {selectedX !== null ? (
          <line
            x1={selectedX}
            x2={selectedX}
            y1={padding}
            y2={height - padding}
            stroke="#0f172a"
            strokeWidth="1.5"
            strokeDasharray="3 4"
            opacity="0.7"
          />
        ) : null}

        {series.map((item) => {
          const coordinates = buildInteractiveCoordinates(item.points, min, max, width, height, padding);
          return (
            <g key={item.key}>
              <polyline
                fill="none"
                stroke={item.color}
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                points={coordinates.map((point) => `${point.x},${point.y}`).join(" ")}
              />
              {coordinates.map((point) => (
                <circle
                  key={`${item.key}-${point.timestamp}`}
                  cx={point.x}
                  cy={point.y}
                  r={point.timestamp === selectedTimestamp ? 4.8 : 3.2}
                  fill={point.timestamp === selectedTimestamp ? "#ffffff" : item.color}
                  stroke={item.color}
                  strokeWidth={point.timestamp === selectedTimestamp ? 2.4 : 1.2}
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelectTimestamp?.(point.timestamp)}
                />
              ))}
            </g>
          );
        })}
      </svg>
      <div style={styles.chartLegend}>
        {series.map((item) => (
          <span key={item.key} style={styles.legendItem}>
            <span style={{ ...styles.legendDot, background: item.color }} />
            {item.label}
          </span>
        ))}
      </div>
      <div style={styles.chartFooter}>{footer}</div>
    </div>
  );
}

function TimelineBrush({
  points,
  brushStartPercent,
  brushEndPercent,
  onBrushStartChange,
  onBrushEndChange,
  selectedTimestamp,
  onSelectTimestamp
}) {
  const width = 320;
  const height = 76;
  const padding = 10;
  const values = points.map((point) => point.actualHumidity).filter((value) => value !== null && value !== undefined && !Number.isNaN(value));

  if (!values.length) {
    return (
      <div style={styles.timelineCard}>
        <div style={styles.timelineHeader}>Timeline Brush</div>
        <div style={styles.emptyChart}>No history yet.</div>
      </div>
    );
  }

  const min = Math.min(...values);
  const max = Math.max(...values);
  const coordinates = buildInteractiveCoordinates(
    points.map((point, index) => ({
      timestamp: point.timestamp,
      value: point.actualHumidity,
      index
    })),
    min,
    max,
    width,
    height,
    padding
  );
  const startX = padding + (Math.max(0, Math.min(brushStartPercent, 99)) / 100) * (width - padding * 2);
  const endX = padding + (Math.max(1, Math.min(brushEndPercent, 100)) / 100) * (width - padding * 2);
  const selectedIndex = points.findIndex((point) => point.timestamp === selectedTimestamp);
  const selectedX = selectedIndex >= 0
    ? padding + (selectedIndex / Math.max(points.length - 1, 1)) * (width - padding * 2)
    : null;

  return (
    <div style={styles.timelineCard} role="group" aria-label="Brushable timeline selector">
      <div style={styles.timelineHeader}>Timeline Brush</div>
      <svg viewBox={`0 0 ${width} ${height}`} style={styles.chartSvg}>
        <rect x="0" y="0" width={width} height={height} fill="rgba(255,255,255,0.55)" rx="18" />
        <rect
          x={Math.min(startX, endX)}
          y={0}
          width={Math.max(Math.abs(endX - startX), 8)}
          height={height}
          fill="rgba(20, 184, 166, 0.12)"
        />
        <polyline
          fill="none"
          stroke="#0f766e"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={coordinates.map((point) => `${point.x},${point.y}`).join(" ")}
        />
        {selectedX !== null ? (
          <line
            x1={selectedX}
            x2={selectedX}
            y1={padding}
            y2={height - padding}
            stroke="#0f172a"
            strokeWidth="1.2"
            strokeDasharray="3 4"
          />
        ) : null}
        {coordinates.map((point) => (
          <circle
            key={`brush-${point.timestamp}`}
            cx={point.x}
            cy={point.y}
            r={point.timestamp === selectedTimestamp ? 4 : 2.2}
            fill={point.timestamp === selectedTimestamp ? "#f97316" : "#0f766e"}
            style={{ cursor: "pointer" }}
            onClick={() => onSelectTimestamp?.(point.timestamp)}
          />
        ))}
      </svg>

      <div style={styles.brushControls}>
        <label style={styles.brushLabel}>
          Start
          <input
            type="range"
            min="0"
            max="99"
            value={Math.min(brushStartPercent, brushEndPercent - 1)}
            onChange={(event) => onBrushStartChange(Number(event.target.value))}
            aria-label="Timeline brush start"
            style={styles.brushSlider}
          />
        </label>
        <label style={styles.brushLabel}>
          End
          <input
            type="range"
            min="1"
            max="100"
            value={Math.max(brushEndPercent, brushStartPercent + 1)}
            onChange={(event) => onBrushEndChange(Number(event.target.value))}
            aria-label="Timeline brush end"
            style={styles.brushSlider}
          />
        </label>
      </div>
    </div>
  );
}

function ZoneComparisonStrip({ zones, activeZone, onSelectZone }) {
  if (!zones.length) {
    return null;
  }

  return (
    <div style={styles.zoneStrip}>
      {zones.map((zone) => {
        const status = zone.status || deriveHealthStatus(zone.actual, zone.inference);
        const theme = STATUS_THEME[normalizeStatus(status)] || STATUS_THEME.waiting;

        return (
          <button
            key={zone.zone}
            type="button"
            onClick={() => onSelectZone(zone.zone)}
            aria-pressed={zone.zone === activeZone}
            aria-label={`Switch to ${zone.zone}. Current humidity ${formatValue(zone.actual?.humidity, 1)} percent. Warning ${String(zone.inference?.warningLevel || "unknown")}.`}
            style={{
              ...styles.zoneCard,
              borderColor: theme.border,
              ...(zone.zone === activeZone ? styles.zoneCardActive : {})
            }}
          >
            <div style={styles.zoneCardHead}>
              <span style={styles.zoneName}>{zone.zone.toUpperCase()}</span>
              <StatusBadge level={status} />
            </div>
            <div style={styles.zoneMetrics}>
              <span>Humidity {formatValue(zone.actual?.humidity, 1)}%</span>
              <span>Warning {String(zone.inference?.warningLevel || "unknown").toUpperCase()}</span>
            </div>
            <div style={styles.zoneMeta}>
              {formatTimestamp(zone.actual?.timestamp || zone.timestamp)}
            </div>
          </button>
        );
      })}
    </div>
  );
}

function StoryFlowStrip({ zone, healthStatus, focusMetric, visiblePoints, selectedPoint, activeRange, detailFilter }) {
  const summary = summarizeFocusedMetric(visiblePoints, focusMetric);
  const selectedStatus = derivePointStatus(selectedPoint);

  return (
    <div className="story-grid" style={styles.storyGrid}>
      <div style={styles.storyCard}>
        <div style={styles.storyStep}>1. Current condition</div>
        <div style={styles.storyTitle}>{zone.toUpperCase()} is {STATUS_THEME[healthStatus]?.label || "WAITING"}</div>
        <div style={styles.storyText}>
          This frame gives the current operational state before you inspect the timeline.
        </div>
      </div>
      <div style={styles.storyCard}>
        <div style={styles.storyStep}>2. Focus metric</div>
        <div style={styles.storyTitle}>{getMetricConfig(focusMetric).label}</div>
        <div style={styles.storyText}>
          {summary.count > 0
            ? `Within the brushed ${activeRange} window and ${detailFilter} filter, the metric averaged ${formatMetricValue(focusMetric, summary.average)} and peaked at ${formatMetricValue(focusMetric, summary.max)}.`
            : "No focused metric points are available in the current view."}
        </div>
      </div>
      <div style={styles.storyCard}>
        <div style={styles.storyStep}>3. Selected event</div>
        <div style={styles.storyTitle}>{selectedPoint ? formatTimestamp(selectedPoint.timestamp) : "No event selected"}</div>
        <div style={styles.storyText}>
          {selectedPoint
            ? `The linked charts and detail panel are pinned to this moment, currently marked as ${STATUS_THEME[selectedStatus]?.label || "WAITING"}.`
            : "Select a point from the timeline to inspect it across all views."}
        </div>
      </div>
    </div>
  );
}

function EventTable({ points, selectedTimestamp, onSelectTimestamp }) {
  if (!points.length) {
    return (
      <div style={styles.card}>
        <div style={styles.emptyChart}>No linked events for the current filters.</div>
      </div>
    );
  }

  return (
    <div style={styles.historyWrap}>
      <div className="history-header" style={styles.tableHead}>
        <span>Timestamp</span>
        <span>Actual / Predicted</span>
        <span>Anomaly Score</span>
        <span>Warning</span>
        <span>Status</span>
      </div>
      {points.slice().reverse().map((point) => {
        const status = derivePointStatus(point);
        const isSelected = point.timestamp === selectedTimestamp;
        return (
          <button
            key={point.timestamp}
            type="button"
            onClick={() => onSelectTimestamp(point.timestamp)}
            className="history-row"
            style={{
              ...styles.eventRow,
              ...(isSelected ? styles.eventRowSelected : {})
            }}
          >
            <span style={{ color: "#64748b", fontSize: 13, textAlign: "left" }}>{formatTimestamp(point.timestamp)}</span>
            <span style={{ fontWeight: 600, textAlign: "left" }}>
              {formatValue(point.actualHumidity, 1)}% / {formatValue(point.predictedHumidity, 1)}%
            </span>
            <span style={{ textAlign: "left" }}>{formatValue(point.anomalyScore, 2)}</span>
            <span style={{ textAlign: "left" }}>{String(point.warningLevel || "low").toUpperCase()}</span>
            <StatusBadge level={status} />
          </button>
        );
      })}
    </div>
  );
}

function resolveDrilldownMetricValue(detail, point, focusMetric) {
  if (detail?.actualReading && detail.actualReading[focusMetric] !== undefined) {
    return detail.actualReading[focusMetric];
  }
  if (focusMetric === "predictedHumidity") {
    return detail?.tinyml?.predictedHumidity ?? point?.predictedHumidity ?? null;
  }
  if (focusMetric === "anomalyScore") {
    return detail?.inference?.anomalyScore ?? point?.anomalyScore ?? null;
  }
  return point ? getMetricValue(point, focusMetric) : null;
}

function DrilldownPanel({ point, detail, isLoading, error, focusMetric, actual, activeZone }) {
  const fallbackStatus = derivePointStatus(point);
  const detailStatus = detail?.inference?.warningLevel
    ? normalizeStatus(detail.inference.warningLevel)
    : detail?.inference?.anomalyFlag
      ? detail.inference.anomalyScore >= 0.75 ? "danger" : "warning"
      : fallbackStatus;
  const predictionDelta = detail?.predictionDelta ?? (point && point.actualHumidity !== null && point.predictedHumidity !== null
    ? point.predictedHumidity - point.actualHumidity
    : null);
  const displayTimestamp = detail?.matchedTimestamp || point?.timestamp || null;
  const focusedMetricValue = resolveDrilldownMetricValue(detail, point, focusMetric);
  const anomalyReasons = detail?.inference?.anomalyReasons || [];
  const liveSnapshot = detail?.actualReading || actual;

  return (
    <div style={styles.drilldownCard}>
      <div style={styles.drilldownHeader}>
        <div>
          <div style={styles.insightEyebrow}>Selected event</div>
          <div style={styles.drilldownTitle}>{displayTimestamp ? formatTimestamp(displayTimestamp) : "Select a timeline point"}</div>
        </div>
        <StatusBadge level={detailStatus} />
      </div>

      <div style={styles.drilldownGrid}>
        <div style={styles.drilldownMetric}>
          <span style={styles.drilldownLabel}>Focused metric</span>
          <strong>{displayTimestamp ? formatMetricValue(focusMetric, focusedMetricValue) : "--"}</strong>
        </div>
        <div style={styles.drilldownMetric}>
          <span style={styles.drilldownLabel}>Prediction delta</span>
          <strong>{formatSignedValue(predictionDelta, 1)}%</strong>
        </div>
        <div style={styles.drilldownMetric}>
          <span style={styles.drilldownLabel}>Anomaly score</span>
          <strong>{formatValue(detail?.inference?.anomalyScore ?? point?.anomalyScore, 2)}</strong>
        </div>
        <div style={styles.drilldownMetric}>
          <span style={styles.drilldownLabel}>Warning level</span>
          <strong>{String(detail?.inference?.warningLevel || point?.warningLevel || "low").toUpperCase()}</strong>
        </div>
      </div>

      <div style={styles.drilldownNarrative}>
        {isLoading
          ? `Loading the matched server event for ${activeZone}.`
          : error
            ? `The selected point is highlighted, but the full server event detail could not be loaded: ${error}`
            : detail
              ? `${activeZone} is being inspected using the ${detail.source === "stored-ml" ? "stored ML event" : "live-inferred event"} matched to this timestamp. Compare actual humidity, TinyML prediction, anomaly score, and warning level at the same moment.`
              : point
                ? `${activeZone} is being inspected at the selected timestamp. Use the linked charts above to compare how actual humidity, TinyML prediction, anomaly score, and warning level line up at the same moment.`
                : `Select a point from the brushed timeline to inspect the coordinated state for ${activeZone}.`}
      </div>

      {detail ? (
        <div style={styles.drilldownMeta}>
          <span>Matched {formatTimestamp(detail.matchedTimestamp)}</span>
          <span>Source {detail.source}</span>
          <span>Reasons {anomalyReasons.length ? anomalyReasons.join(", ") : "none"}</span>
        </div>
      ) : null}

      <div style={styles.drilldownLiveNote}>
        Latest live humidity {formatValue(liveSnapshot?.humidity, 1)}% | Gas {formatValue(liveSnapshot?.mq135AirQualityDeviation, 2)}% | Dust {formatValue(liveSnapshot?.dustMgPerM3, 3)} mg/m^3
      </div>
    </div>
  );
}

function StatusBadge({ level }) {
  const status = normalizeStatus(level);
  const theme = STATUS_THEME[status] || STATUS_THEME.waiting;

  return (
    <span
      style={{
        ...styles.badge,
        background: theme.background,
        color: theme.color,
        border: `1px solid ${theme.border}`
      }}
    >
      {theme.label}
    </span>
  );
}

function Sidebar({ active, onNav }) {
  return (
    <aside className="sidebar" style={styles.sidebar}>
      <div style={styles.sidebarBrand}>
          <img src={logoImage} alt="MAOCHI logo" style={styles.brandLogoImage} />

      </div>

      <nav style={styles.nav}>
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onNav(item.id)}
            aria-current={active === item.id ? "page" : undefined}
            aria-label={`Jump to ${item.label}`}
            style={{
              ...styles.navItem,
              ...(active === item.id ? styles.navItemActive : {})
            }}
          >
            <span style={styles.navIcon}>
              <img
                src={item.icon}
                alt=""
                aria-hidden="true"
                style={styles.navIconImage}
              />
            </span>
            <span style={styles.navLabel}>{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function HealthRing({ score, status }) {
  const theme = STATUS_THEME[status] || STATUS_THEME.waiting;
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  const filled = (score / 100) * circumference;

  return (
    <svg width="148" height="148" viewBox="0 0 148 148">
      <circle cx="74" cy="74" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="10" />
      <circle
        cx="74"
        cy="74"
        r={radius}
        fill="none"
        stroke={theme.color}
        strokeWidth="10"
        strokeDasharray={`${filled} ${circumference - filled}`}
        strokeDashoffset={circumference / 4}
        strokeLinecap="round"
      />
      <text
        x="74"
        y="79"
        textAnchor="middle"
        fontSize="32"
        fontWeight="700"
        fill={theme.color}
        fontFamily="'IBM Plex Mono', monospace"
      >
        {score}
      </text>
    </svg>
  );
}

function MetricCard({ metric, value, trend, active, onSelect }) {
  const status = metric.key === "mq135AirQualityDeviation"
    ? (value ?? 0) >= 1.5
      ? "danger"
      : (value ?? 0) >= 0.75
        ? "warning"
        : "safe"
    : metric.key === "humidity"
      ? (value ?? 0) >= 75
        ? "danger"
        : (value ?? 0) >= 65
          ? "warning"
          : "safe"
      : "safe";
  const theme = STATUS_THEME[status];

  return (
    <button
      type="button"
      onClick={() => onSelect?.(metric.key)}
      aria-pressed={active}
      aria-label={`Focus ${metric.label} metric. Current value ${formatValue(value, metric.decimals)} ${metric.unit}`}
      style={{
        ...styles.metricCard,
        borderColor: theme.border,
        ...(active ? styles.metricCardActive : {})
      }}
    >
      <div style={styles.metricHead}>
        <div style={styles.metricIconWrap}>
          <span style={{ ...styles.metricIcon, color: theme.color, background: theme.background }}>{metric.icon}</span>
          <span style={styles.metricLabel}>{metric.label}</span>
        </div>
        <span style={{ color: theme.color, fontSize: 12, fontWeight: 700 }}>{trend > 0 ? "UP" : trend < 0 ? "DOWN" : "FLAT"}</span>
      </div>
      <div style={styles.metricValue}>
        <span style={{ ...styles.metricNum, color: theme.color }}>{formatValue(value, metric.decimals)}</span>
        <span style={styles.metricUnit}>{metric.unit}</span>
      </div>
      <StatusBadge level={status} />
    </button>
  );
}

function InsightCard({ eyebrow, title, value, subvalue, detail, status, footnote }) {
  const theme = STATUS_THEME[normalizeStatus(status)] || STATUS_THEME.waiting;

  return (
    <div style={{ ...styles.insightCard, borderColor: theme.border }}>
      <div style={styles.insightEyebrow}>{eyebrow}</div>
      <div style={styles.insightTitle}>{title}</div>
      <div style={styles.insightValueWrap}>
        <span style={{ ...styles.insightValue, color: theme.color }}>{value}</span>
        {subvalue ? <span style={styles.insightSubvalue}>{subvalue}</span> : null}
      </div>
      <div style={styles.insightDetail}>{detail}</div>
      <div style={styles.insightFooter}>
        <StatusBadge level={status} />
        <span style={styles.insightFootnote}>{footnote}</span>
      </div>
    </div>
  );
}

function HistoryTable({ recent, highlightedReading, onSelectReading }) {
  return (
    <div style={styles.historyWrap}>
      <div className="history-header" style={styles.tableHead}>
        <span>Timestamp</span>
        <span>Zone</span>
        <span>Temp / Humidity</span>
        <span>Light / Dust / Gas</span>
        <span>Status</span>
      </div>

      {recent.length === 0 ? (
        <p style={{ padding: "16px", color: "#94a3b8" }}>No readings received yet.</p>
      ) : (
        recent.map((reading) => {
          const status = deriveHealthStatus(reading, null);
          const isHighlighted = highlightedReading?.id
            ? highlightedReading.id === reading.id
            : highlightedReading?.timestamp === reading.timestamp;
          return (
            <button
              key={reading.id}
              type="button"
              className="history-row"
              onClick={() => onSelectReading?.(reading.timestamp)}
              style={{
                ...styles.tableRow,
                ...(isHighlighted ? styles.eventRowSelected : {})
              }}
            >
              <span style={{ color: "#64748b", fontSize: 13 }}>{formatTimestamp(reading.timestamp)}</span>
              <span style={{ fontWeight: 600 }}>{reading.zone}</span>
              <span>
                {formatValue(reading.temperature, 1)} C / {formatValue(reading.humidity, 1)}%
              </span>
              <span>
                {formatValue(reading.lightLux, 0)} lx / {formatValue(reading.dustMgPerM3, 3)} / {formatValue(reading.mq135AirQualityDeviation, 2)}%
              </span>
              <StatusBadge level={status} />
            </button>
          );
        })
      )}
    </div>
  );
}

export default function App() {
  const [activeNav, setActiveNav] = useState("zones");
  const [activeZone, setActiveZone] = useState(DEFAULT_ZONE);
  const [activeRange, setActiveRange] = useState("24h");
  const [focusMetric, setFocusMetric] = useState("humidity");
  const [detailFilter, setDetailFilter] = useState("all");
  const [brushStartPercent, setBrushStartPercent] = useState(0);
  const [brushEndPercent, setBrushEndPercent] = useState(100);
  const [selectedHistoryTimestamp, setSelectedHistoryTimestamp] = useState(null);
  const [latestReading, setLatestReading] = useState(null);
  const [recentReadings, setRecentReadings] = useState([]);
  const [zoneSummaries, setZoneSummaries] = useState([]);
  const [mlLatest, setMlLatest] = useState(null);
  const [mlHistory, setMlHistory] = useState(null);
  const [eventDetail, setEventDetail] = useState(null);
  const [isEventDetailLoading, setIsEventDetailLoading] = useState(false);
  const [eventDetailError, setEventDetailError] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");
  const sectionRefs = useRef({});

  const registerSection = (id) => (node) => {
    if (node) {
      sectionRefs.current[id] = node;
    }
  };

  const handleSidebarNav = useEffectEvent((id) => {
    setActiveNav(id);
    const target = sectionRefs.current[id];
    if (target) {
      target.scrollIntoView({
        behavior: "smooth",
        block: "start"
      });
    }
  });

  const loadDashboard = useEffectEvent(async (initialLoad = false) => {
    if (!initialLoad) {
      setIsRefreshing(true);
    }

    try {
      const historyQuery = buildRangeQuery(activeRange, activeZone);
      const [zonesResponse, latestResponse, recentResponse, mlLatestResponse, mlHistoryResponse] = await Promise.all([
        fetchJson("/api/readings/zones?limit=200"),
        fetchJson(`/api/readings/latest?zone=${encodeURIComponent(activeZone)}`),
        fetchJson(`/api/readings/recent?limit=18&zone=${encodeURIComponent(activeZone)}`),
        fetchJson(`/api/ml/latest?zone=${encodeURIComponent(activeZone)}`),
        fetchJson(`/api/ml/history?${historyQuery}`)
      ]);
      const zones = zonesResponse.zones ?? [];
      const zoneStatusRows = await Promise.all(
        zones.map(async (zoneRow) => {
          try {
            const zoneMl = await fetchJson(`/api/ml/latest?zone=${encodeURIComponent(zoneRow.zone)}`);
            return {
              zone: zoneRow.zone,
              actual: zoneMl.actual || zoneRow,
              inference: zoneMl.inference || null,
              timestamp: zoneRow.timestamp,
              status: deriveHealthStatus(zoneMl.actual || zoneRow, zoneMl.inference)
            };
          } catch {
            return {
              zone: zoneRow.zone,
              actual: zoneRow,
              inference: null,
              timestamp: zoneRow.timestamp,
              status: deriveHealthStatus(zoneRow, null)
            };
          }
        })
      );

      startTransition(() => {
        setLatestReading(latestResponse.reading ?? null);
        setRecentReadings(recentResponse.readings ?? []);
        setZoneSummaries(zoneStatusRows);
        setMlLatest(mlLatestResponse ?? null);
        setMlHistory(mlHistoryResponse ?? null);
        setError("");
        setIsLoading(false);
        setIsRefreshing(false);
      });
    } catch (requestError) {
      startTransition(() => {
        setError(requestError.message);
        setIsLoading(false);
        setIsRefreshing(false);
      });
    }
  });

  useEffect(() => {
    let active = true;

    const run = async (initialLoad) => {
      if (!active) {
        return;
      }
      await loadDashboard(initialLoad);
    };

    void run(true);
    const intervalId = window.setInterval(() => {
      void run(false);
    }, POLL_INTERVAL_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [activeRange, activeZone, loadDashboard]);

  useEffect(() => {
    setBrushStartPercent(0);
    setBrushEndPercent(100);
  }, [activeRange, activeZone]);

  const actual = mlLatest?.actual || latestReading;
  const inference = mlLatest?.inference;
  const tinyml = mlLatest?.tinyml;
  const healthStatus = deriveHealthStatus(actual, inference);
  const healthScore = healthScoreFromStatus(healthStatus);
  const predictionDelta = tinyml && actual?.humidity !== null && actual?.humidity !== undefined
    ? (tinyml.predictedHumidity ?? 0) - (actual?.humidity ?? 0)
    : null;

  const historySeries = mlHistory?.series || {
    actualHumidity: [],
    predictedHumidity: [],
    anomalyScore: [],
    warningLevel: []
  };
  const linkedHistory = buildLinkedHistory(historySeries);
  const brushWindow = clampBrushWindow(linkedHistory.length, brushStartPercent, brushEndPercent);
  const brushedHistory = linkedHistory.slice(brushWindow.startIndex, brushWindow.endIndex + 1);
  const visibleHistoryPoints = filterDetailPoints(brushedHistory, detailFilter);
  const selectedPoint = visibleHistoryPoints.find((point) => point.timestamp === selectedHistoryTimestamp) || null;
  const selectedRecentReading = eventDetail?.actualReading || findNearestReading(recentReadings, selectedHistoryTimestamp);

  useEffect(() => {
    const nextTimestamp = visibleHistoryPoints[visibleHistoryPoints.length - 1]?.timestamp
      || brushedHistory[brushedHistory.length - 1]?.timestamp
      || null;
    const stillVisible = visibleHistoryPoints.some((point) => point.timestamp === selectedHistoryTimestamp);

    if (!nextTimestamp && selectedHistoryTimestamp !== null) {
      setSelectedHistoryTimestamp(null);
      return;
    }

    if (nextTimestamp && !stillVisible) {
      setSelectedHistoryTimestamp(nextTimestamp);
    }
  }, [activeZone, activeRange, detailFilter, selectedHistoryTimestamp, brushedHistory, visibleHistoryPoints]);

  useEffect(() => {
    if (!selectedHistoryTimestamp) {
      setEventDetail(null);
      setEventDetailError("");
      setIsEventDetailLoading(false);
      return;
    }

    let cancelled = false;
    setEventDetail(null);
    setIsEventDetailLoading(true);
    setEventDetailError("");

    fetchJson(`/api/ml/event-detail?zone=${encodeURIComponent(activeZone)}&timestamp=${encodeURIComponent(selectedHistoryTimestamp)}`)
      .then((payload) => {
        if (cancelled) {
          return;
        }
        setEventDetail(payload);
      })
      .catch((requestError) => {
        if (cancelled) {
          return;
        }
        setEventDetail(null);
        setEventDetailError(requestError.message);
      })
      .finally(() => {
        if (!cancelled) {
          setIsEventDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeZone, selectedHistoryTimestamp]);

  return (
    <>
      <style>{`
        button, input { font-family: inherit; }
        .skip-link {
          position: absolute;
          left: 16px;
          top: -52px;
          z-index: 80;
          padding: 10px 14px;
          border-radius: 999px;
          background: #172033;
          color: #ffffff;
          text-decoration: none;
          font-size: 13px;
          font-weight: 700;
          transition: top 0.2s ease;
        }
        .skip-link:focus {
          top: 14px;
        }
        @media (max-width: 1120px) {
          .shell { flex-direction: column; }
          .sidebar { width: 100% !important; min-height: auto !important; height: auto !important; position: static !important; top: auto !important; overflow: visible !important; border-right: none !important; border-bottom: 1px solid #dbe3ef; }
          .health-card { grid-template-columns: 1fr !important; }
          .metrics-grid, .insight-grid, .charts-grid, .story-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .control-panel, .drilldown-layout { grid-template-columns: 1fr !important; }
        }
        @media (max-width: 760px) {
          .top-bar { flex-direction: column; align-items: stretch !important; }
          .top-right { flex-direction: column; align-items: stretch !important; }
          .metrics-grid, .insight-grid, .charts-grid, .story-grid { grid-template-columns: 1fr !important; }
          .history-header, .history-row { grid-template-columns: 1fr !important; }
          .content-area { padding: 18px !important; }
        }
      `}</style>

      <a href="#dashboard-main" className="skip-link">Skip to dashboard content</a>

      <div className="shell" style={styles.shell}>
        <Sidebar active={activeNav} onNav={handleSidebarNav} />

        <main id="dashboard-main" style={styles.main}>
          <header className="top-bar" style={styles.topBar}>
            <div>
              <div style={styles.topTitle}>MAOCHI Sensor + ML Console</div>
              <div style={styles.topSub}>Live storage monitoring</div>
            </div>

            <div className="top-right" style={styles.topRight}>
              <div style={styles.rangeGroup}>
                {Object.keys(RANGE_WINDOWS).map((range) => (
                  <button
                    key={range}
                    onClick={() => setActiveRange(range)}
                    aria-pressed={activeRange === range}
                    aria-label={`Set time range to ${range}`}
                    style={{
                      ...styles.rangeBtn,
                      ...(activeRange === range ? styles.rangeBtnActive : {})
                    }}
                  >
                    {range}
                  </button>
                ))}
              </div>

              <div style={styles.searchBox}>
                <span style={{ color: "#94a3b8", marginRight: 6 }}>ZONE</span>
                <input value={activeZone} readOnly aria-label="Active zone" style={styles.searchInput} />
              </div>

              <div style={styles.bellWrap} role="status" aria-live="polite">
                {isRefreshing ? "REFRESHING" : "LIVE"}
                <span style={styles.bellBadge}>{POLL_INTERVAL_MS / 1000}s</span>
              </div>
            </div>
          </header>

          <div className="content-area" style={styles.content}>
            <section ref={registerSection("zones")}>
              <div style={styles.sectionTitle}>1. ZONE COMPARISON</div>
              <ZoneComparisonStrip zones={zoneSummaries} activeZone={activeZone} onSelectZone={setActiveZone} />
            </section>

            <section ref={registerSection("health")}>
              <div style={styles.sectionTitle}>2. SYSTEM HEALTH OVERVIEW</div>
              <div className="health-card" style={styles.healthCard}>
                <HealthRing score={healthScore} status={healthStatus} />

                <div style={styles.healthInfo}>
                  <div style={styles.healthScoreLabel}>
                    Storage Health <span style={{ color: "#94a3b8", fontWeight: 400 }}>/ 100</span>
                  </div>
                  <div style={styles.healthNarrative}>
                    {error
                      ? `Feed unavailable: ${error}`
                      : isLoading
                        ? "Loading live sensor and ML data..."
                        : "Actual sensor readings, device-side TinyML forecasts, and backend anomaly-warning inference are now shown from live API data."}
                  </div>
                </div>

                <div style={styles.pulseBox}>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Overall state</span>
                    <StatusBadge level={healthStatus} />
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Last actual reading</span>
                    <span style={styles.pulseVal}>{formatTimestamp(actual?.timestamp)}</span>
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>TinyML source</span>
                    <span style={styles.pulseVal}>{tinyml ? "ESP32 TinyML" : "Waiting for upload"}</span>
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Backend model</span>
                    <span style={styles.pulseVal}>{inference?.modelVersion || "fallback"}</span>
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Active range</span>
                    <span style={styles.pulseVal}>{activeRange}</span>
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Focused metric</span>
                    <span style={styles.pulseVal}>{getMetricConfig(focusMetric).label}</span>
                  </div>
                </div>
              </div>
            </section>

            <section ref={registerSection("focus")}>
              <div style={styles.sectionTitle}>3. FILTERS AND FOCUS</div>
              <div className="control-panel" style={styles.controlPanel}>
                <div style={styles.controlGroup}>
                  <div style={styles.controlLabel}>Metric focus</div>
                  <div style={styles.chipRow}>
                    {METRICS.map((metric) => (
                      <button
                        key={metric.key}
                        type="button"
                        onClick={() => setFocusMetric(metric.key)}
                        aria-pressed={focusMetric === metric.key}
                        aria-label={`Focus ${metric.label} across charts and tables`}
                        style={{
                          ...styles.filterChip,
                          ...(focusMetric === metric.key ? styles.filterChipActive : {})
                        }}
                      >
                        {metric.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div style={styles.controlGroup}>
                  <div style={styles.controlLabel}>Detail filter</div>
                  <div style={styles.chipRow}>
                    {DETAIL_FILTERS.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => setDetailFilter(item.key)}
                        aria-pressed={detailFilter === item.key}
                        aria-label={`Filter detailed view to ${item.label}`}
                        style={{
                          ...styles.filterChip,
                          ...(detailFilter === item.key ? styles.filterChipActive : {})
                        }}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </section>

            <section>
              <div style={styles.sectionTitle}>4. LIVE SENSOR METRICS</div>
              <div className="metrics-grid" style={styles.metricsGrid}>
                {METRICS.map((metric) => {
                  const value = actual?.[metric.key];
                  const series = recentReadings.map((reading) => reading[metric.key]).filter((point) => point !== null && point !== undefined);
                  const trend = series.length > 1 ? series[series.length - 1] - series[0] : 0;
                  return (
                    <MetricCard
                      key={metric.key}
                      metric={metric}
                      value={value}
                      trend={trend}
                      active={focusMetric === metric.key}
                      onSelect={setFocusMetric}
                    />
                  );
                })}
              </div>
            </section>

            <section>
              <div style={styles.sectionTitle}>5. ANALYTICAL STORYLINE</div>
              <StoryFlowStrip
                zone={activeZone}
                healthStatus={healthStatus}
                focusMetric={focusMetric}
                visiblePoints={visibleHistoryPoints}
                selectedPoint={selectedPoint}
                activeRange={activeRange}
                detailFilter={detailFilter}
              />
            </section>

            <section ref={registerSection("analytics")}>
              <div style={styles.sectionTitle}>6. ML INSIGHTS</div>
              <div className="insight-grid" style={styles.insightGrid}>
                <InsightCard
                  eyebrow="TinyML Forecast"
                  title="Humidity Prediction"
                  value={formatValue(tinyml?.predictedHumidity, 1)}
                  subvalue="% RH"
                  detail={`Actual ${formatValue(actual?.humidity, 1)}% RH | Delta ${formatSignedValue(predictionDelta, 1)}%`}
                  status={tinyml ? healthStatus : "waiting"}
                  footnote={tinyml ? `${tinyml.source} | ${tinyml.inferenceLatencyMs} ms` : "Awaiting ESP32 upload"}
                />

                <InsightCard
                  eyebrow="Backend Anomaly"
                  title="Anomaly Score"
                  value={formatValue(inference?.anomalyScore, 2)}
                  detail={(inference?.anomalyReasons || []).length > 0
                    ? (inference.anomalyReasons || []).join(", ")
                    : "No anomaly reasons reported"}
                  status={inference?.anomalyFlag ? "danger" : "safe"}
                  footnote={inference?.anomalyFlag ? "Detected by hybrid backend pipeline" : "No active anomaly detected"}
                />

                <InsightCard
                  eyebrow="Warning Classifier"
                  title="Warning Level"
                  value={String(inference?.warningLevel || "--").toUpperCase()}
                  detail={`Confidence ${formatValue((inference?.warningConfidence ?? 0) * 100, 0)}%`}
                  status={normalizeStatus(inference?.warningLevel)}
                  footnote={inference?.warningLevel ? "RandomForest backend classification" : "Waiting for inference"}
                />

                <InsightCard
                  eyebrow="Summary"
                  title="Today"
                  value={String(mlLatest?.summary?.anomalyCountToday ?? 0)}
                  subvalue="anomalies"
                  detail={`Avg humidity error ${formatValue(mlLatest?.summary?.avgHumidityPredictionError, 2)} | Current ${String(mlLatest?.summary?.currentWarningState || "unknown").toUpperCase()}`}
                  status={normalizeStatus(mlLatest?.summary?.currentWarningState)}
                  footnote="Derived from stored ml_predictions"
                />
              </div>
            </section>

            <section ref={registerSection("history")}>
              <div style={styles.sectionTitle}>7. BRUSHED TIMELINE ANALYSIS</div>
              <TimelineBrush
                points={linkedHistory}
                brushStartPercent={brushStartPercent}
                brushEndPercent={brushEndPercent}
                onBrushStartChange={setBrushStartPercent}
                onBrushEndChange={setBrushEndPercent}
                selectedTimestamp={selectedHistoryTimestamp}
                onSelectTimestamp={setSelectedHistoryTimestamp}
              />
              <div className="charts-grid" style={styles.chartsGrid}>
                <CoordinatedLineChart
                  title="Humidity: Actual vs TinyML"
                  series={[
                    {
                      key: "actual",
                      label: "Actual",
                      color: "#f97316",
                      points: visibleHistoryPoints.map((point, index) => ({
                        timestamp: point.timestamp,
                        value: point.actualHumidity,
                        index
                      }))
                    },
                    {
                      key: "predicted",
                      label: "Predicted",
                      color: "#14b8a6",
                      points: visibleHistoryPoints.map((point, index) => ({
                        timestamp: point.timestamp,
                        value: point.predictedHumidity,
                        index
                      }))
                    }
                  ]}
                  thresholdLines={[
                    { label: "warning", value: 65, color: "#f59e0b" },
                    { label: "critical", value: 75, color: "#ef4444" }
                  ]}
                  selectedTimestamp={selectedHistoryTimestamp}
                  onSelectTimestamp={setSelectedHistoryTimestamp}
                  footer={`${visibleHistoryPoints.length} linked points in the brushed window`}
                />

                <CoordinatedLineChart
                  title="Anomaly Score Over Time"
                  series={[
                    {
                      key: "anomaly",
                      label: "Anomaly score",
                      color: "#ef4444",
                      points: visibleHistoryPoints.map((point, index) => ({
                        timestamp: point.timestamp,
                        value: point.anomalyScore,
                        index
                      }))
                    }
                  ]}
                  thresholdLines={[
                    { label: "flag focus", value: 0.75, color: "#ef4444" }
                  ]}
                  selectedTimestamp={selectedHistoryTimestamp}
                  onSelectTimestamp={setSelectedHistoryTimestamp}
                  footer={`${visibleHistoryPoints.filter((point) => point.anomalyFlag).length} alerting points in view`}
                />

                <CoordinatedLineChart
                  title="Warning Timeline"
                  series={[
                    {
                      key: "warning",
                      label: "Warning state",
                      color: "#d97706",
                      points: visibleHistoryPoints.map((point, index) => ({
                        timestamp: point.timestamp,
                        value: point.warningLevel ? warningToNumeric(point.warningLevel) : 0,
                        index
                      }))
                    }
                  ]}
                  selectedTimestamp={selectedHistoryTimestamp}
                  onSelectTimestamp={setSelectedHistoryTimestamp}
                  footer={`${visibleHistoryPoints[visibleHistoryPoints.length - 1]?.warningLevel?.toUpperCase() || "LOW"} is the latest state in the brushed view`}
                />
              </div>
            </section>

            <section ref={registerSection("investigation")}>
              <div style={styles.sectionTitle}>8. LINKED EVENT DRILL-DOWN</div>
              <div className="drilldown-layout" style={styles.drilldownLayout}>
                <DrilldownPanel
                  point={selectedPoint}
                  detail={eventDetail}
                  isLoading={isEventDetailLoading}
                  error={eventDetailError}
                  focusMetric={focusMetric}
                  actual={actual}
                  activeZone={activeZone}
                />
                <div style={styles.card}>
                  <EventTable
                    points={visibleHistoryPoints}
                    selectedTimestamp={selectedHistoryTimestamp}
                    onSelectTimestamp={setSelectedHistoryTimestamp}
                  />
                </div>
              </div>
            </section>

            <section>
              <div style={{ ...styles.sectionTitle, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>9. RECENT SENSOR CAPTURES</span>
                <span style={{ fontSize: 13, color: "#64748b", fontWeight: 500 }}>{recentReadings.length} records</span>
              </div>
              <div style={styles.card}>
                <HistoryTable
                  recent={recentReadings}
                  highlightedReading={selectedRecentReading}
                  onSelectReading={setSelectedHistoryTimestamp}
                />
              </div>
            </section>
          </div>
        </main>

        <ChatWidget zone={actual?.zone || "zone1"} />
      </div>
    </>
  );
}

const styles = {
  shell: {
    display: "flex",
    minHeight: "100vh",
    background: "transparent"
  },
  sidebar: {
    width: 260,
    minHeight: "100vh",
    height: "100vh",
    background: "rgba(255, 255, 255, 0.84)",
    backdropFilter: "blur(18px)",
    borderRight: "1px solid #dbe3ef",
    display: "flex",
    flexDirection: "column",
    padding: "24px 16px",
    flexShrink: 0,
    position: "sticky",
    top: 0,
    alignSelf: "flex-start",
    overflowY: "auto",
    gap: 20
  },
  sidebarBrand: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 8,
    padding: "0 8px"
  },
  brandLogoWrap: {
    width: 52,
    height: 52,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0
  },
  brandLogoImage: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    display: "block"
  },
  brandName: {
    fontWeight: 700,
    fontSize: 16,
    color: "#172033"
  },
  brandSub: {
    fontSize: 12,
    color: "#64748b"
  },
  nav: {
    display: "flex",
    flexDirection: "column",
    gap: 10,
    flex: "0 0 auto"
  },
  navItem: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "10px 12px",
    borderRadius: 12,
    color: "#64748b",
    fontSize: 14,
    fontWeight: 600,
    width: "100%",
    textAlign: "left",
    border: "1px solid transparent",
    background: "transparent"
  },
  navItemActive: {
    background: "#172033",
    color: "#ffffff"
  },
  navIcon: {
    width: 28,
    height: 28,
    borderRadius: 8,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0
  },
  navIconImage: {
    width: 22,
    height: 22,
    objectFit: "contain",
    display: "block"
  },
  navLabel: {
    flex: 1
  },
  main: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    minWidth: 0
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "20px 32px",
    background: "rgba(255, 255, 255, 0.78)",
    backdropFilter: "blur(12px)",
    borderBottom: "1px solid #dbe3ef",
    position: "sticky",
    top: 0,
    zIndex: 10,
    gap: 20
  },
  topTitle: {
    fontWeight: 700,
    fontSize: 22,
    color: "#172033"
  },
  topSub: {
    fontSize: 13,
    color: "#64748b",
    maxWidth: 620
  },
  topRight: {
    display: "flex",
    alignItems: "center",
    gap: 16
  },
  rangeGroup: {
    display: "flex",
    background: "#e2e8f0",
    borderRadius: 999,
    padding: 4,
    gap: 4
  },
  rangeBtn: {
    padding: "6px 14px",
    borderRadius: 999,
    fontSize: 13,
    fontWeight: 600,
    color: "#475569",
    border: "none",
    background: "transparent"
  },
  rangeBtnActive: {
    background: "#ffffff",
    color: "#172033",
    boxShadow: "0 4px 12px rgba(15, 23, 42, 0.08)"
  },
  searchBox: {
    display: "flex",
    alignItems: "center",
    background: "#ffffff",
    borderRadius: 999,
    padding: "8px 12px",
    width: 180,
    border: "1px solid #dbe3ef"
  },
  searchInput: {
    border: "none",
    background: "transparent",
    outline: "none",
    fontSize: 13,
    color: "#172033",
    width: "100%"
  },
  bellWrap: {
    position: "relative",
    fontSize: 13,
    cursor: "default",
    fontWeight: 700,
    color: "#172033",
    padding: "10px 14px",
    borderRadius: 999,
    background: "#ffffff",
    border: "1px solid #dbe3ef"
  },
  bellBadge: {
    position: "absolute",
    top: -6,
    right: -6,
    background: "#ef4444",
    color: "#ffffff",
    borderRadius: "50%",
    width: 24,
    height: 24,
    fontSize: 11,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  content: {
    padding: "28px 32px",
    display: "flex",
    flexDirection: "column",
    gap: 28
  },
  sectionTitle: {
    fontSize: 12,
    fontWeight: 700,
    color: "#64748b",
    letterSpacing: "0.08em",
    marginBottom: 16
  },
  healthCard: {
    display: "grid",
    gridTemplateColumns: "160px 1fr 320px",
    gap: 24,
    alignItems: "center",
    padding: 28,
    borderRadius: 24,
    background: "linear-gradient(145deg, rgba(255,255,255,0.96), rgba(255,247,237,0.9))",
    border: "1px solid #dbe3ef",
    boxShadow: "0 24px 50px rgba(15, 23, 42, 0.08)"
  },
  healthInfo: {
    display: "grid",
    gap: 10
  },
  healthScoreLabel: {
    fontWeight: 700,
    fontSize: 22,
    color: "#172033"
  },
  healthNarrative: {
    fontSize: 14,
    color: "#64748b",
    lineHeight: 1.7,
    maxWidth: 520
  },
  pulseBox: {
    background: "rgba(248, 250, 252, 0.92)",
    borderRadius: 18,
    padding: "18px 20px",
    display: "flex",
    flexDirection: "column",
    gap: 12,
    border: "1px solid #dbe3ef"
  },
  pulseRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
    fontSize: 13
  },
  pulseLabel: {
    color: "#94a3b8",
    flex: 1
  },
  pulseVal: {
    fontWeight: 700,
    color: "#172033"
  },
  metricsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
    gap: 16
  },
  zoneStrip: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
    gap: 14
  },
  zoneCard: {
    background: "rgba(255,255,255,0.94)",
    border: "1px solid #dbe3ef",
    borderRadius: 20,
    padding: 16,
    display: "grid",
    gap: 10,
    textAlign: "left",
    cursor: "pointer",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)"
  },
  zoneCardActive: {
    transform: "translateY(-2px)",
    boxShadow: "0 20px 40px rgba(15, 23, 42, 0.1)",
    outline: "2px solid rgba(15, 118, 110, 0.18)"
  },
  zoneCardHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10
  },
  zoneName: {
    fontSize: 15,
    fontWeight: 700,
    color: "#172033"
  },
  zoneMetrics: {
    display: "grid",
    gap: 6,
    fontSize: 13,
    color: "#475569"
  },
  zoneMeta: {
    fontSize: 12,
    color: "#94a3b8"
  },
  controlPanel: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 16,
    padding: 18,
    borderRadius: 22,
    background: "rgba(255,255,255,0.9)",
    border: "1px solid #dbe3ef",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)"
  },
  controlGroup: {
    display: "grid",
    gap: 10
  },
  controlLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "#64748b",
    letterSpacing: "0.06em",
    textTransform: "uppercase"
  },
  chipRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: 8
  },
  filterChip: {
    padding: "8px 12px",
    borderRadius: 999,
    border: "1px solid #dbe3ef",
    background: "#ffffff",
    color: "#475569",
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer"
  },
  filterChipActive: {
    background: "#172033",
    color: "#ffffff",
    borderColor: "#172033"
  },
  metricCard: {
    background: "rgba(255, 255, 255, 0.94)",
    borderRadius: 20,
    border: "2px solid #e2e8f0",
    padding: "18px",
    display: "flex",
    flexDirection: "column",
    gap: 14,
    textAlign: "left",
    cursor: "pointer",
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.05)"
  },
  metricCardActive: {
    transform: "translateY(-2px)",
    boxShadow: "0 18px 34px rgba(15, 23, 42, 0.12)",
    outline: "2px solid rgba(15, 118, 110, 0.18)"
  },
  metricHead: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8
  },
  metricIconWrap: {
    display: "flex",
    alignItems: "center",
    gap: 10
  },
  metricIcon: {
    width: 40,
    height: 40,
    borderRadius: 12,
    fontSize: 11,
    fontWeight: 700,
    display: "flex",
    alignItems: "center",
    justifyContent: "center"
  },
  metricLabel: {
    fontSize: 12,
    fontWeight: 700,
    color: "#64748b",
    letterSpacing: "0.05em"
  },
  metricValue: {
    display: "flex",
    alignItems: "baseline",
    gap: 6
  },
  metricNum: {
    fontSize: 30,
    fontWeight: 700,
    lineHeight: 1
  },
  metricUnit: {
    fontSize: 14,
    color: "#64748b"
  },
  insightGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 16
  },
  storyGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 16
  },
  storyCard: {
    background: "linear-gradient(180deg, rgba(255,255,255,0.97), rgba(248,250,252,0.92))",
    borderRadius: 22,
    border: "1px solid #dbe3ef",
    padding: 18,
    display: "grid",
    gap: 10,
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)"
  },
  storyStep: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: "uppercase",
    letterSpacing: "0.08em",
    color: "#0f766e"
  },
  storyTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#172033"
  },
  storyText: {
    fontSize: 13,
    color: "#64748b",
    lineHeight: 1.7
  },
  insightCard: {
    background: "rgba(255,255,255,0.95)",
    borderRadius: 22,
    border: "1px solid #dbe3ef",
    padding: 20,
    display: "grid",
    gap: 10,
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)"
  },
  insightEyebrow: {
    fontSize: 11,
    letterSpacing: "0.08em",
    textTransform: "uppercase",
    color: "#64748b",
    fontWeight: 700
  },
  insightTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#172033"
  },
  insightValueWrap: {
    display: "flex",
    alignItems: "baseline",
    gap: 8
  },
  insightValue: {
    fontSize: 32,
    fontWeight: 700,
    lineHeight: 1
  },
  insightSubvalue: {
    fontSize: 14,
    color: "#64748b"
  },
  insightDetail: {
    minHeight: 40,
    fontSize: 13,
    color: "#64748b",
    lineHeight: 1.6
  },
  insightFooter: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  insightFootnote: {
    fontSize: 12,
    color: "#64748b"
  },
  chartsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
    gap: 16
  },
  chartCard: {
    background: "rgba(255,255,255,0.95)",
    borderRadius: 22,
    padding: 18,
    border: "1px solid #dbe3ef",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)",
    display: "grid",
    gap: 12
  },
  chartHeader: {
    fontSize: 15,
    fontWeight: 700,
    color: "#172033"
  },
  chartSvg: {
    width: "100%",
    height: "auto"
  },
  chartAnnotation: {
    fill: "#64748b",
    fontSize: 10,
    fontWeight: 700,
    fontFamily: "'IBM Plex Mono', monospace"
  },
  chartLegend: {
    display: "flex",
    gap: 12,
    flexWrap: "wrap"
  },
  legendItem: {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    fontSize: 12,
    color: "#64748b"
  },
  legendDot: {
    width: 10,
    height: 10,
    borderRadius: "50%"
  },
  chartFooter: {
    fontSize: 12,
    color: "#64748b"
  },
  emptyChart: {
    minHeight: 120,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#94a3b8",
    fontSize: 14
  },
  timelineCard: {
    background: "rgba(255,255,255,0.95)",
    borderRadius: 22,
    padding: 18,
    border: "1px solid #dbe3ef",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)",
    display: "grid",
    gap: 12,
    marginBottom: 16
  },
  timelineHeader: {
    fontSize: 15,
    fontWeight: 700,
    color: "#172033"
  },
  brushControls: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 12
  },
  brushLabel: {
    display: "grid",
    gap: 6,
    fontSize: 12,
    color: "#64748b",
    fontWeight: 600
  },
  brushSlider: {
    width: "100%"
  },
  card: {
    background: "rgba(255, 255, 255, 0.94)",
    borderRadius: 20,
    border: "1px solid #dbe3ef",
    overflow: "hidden",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)"
  },
  drilldownLayout: {
    display: "grid",
    gridTemplateColumns: "360px 1fr",
    gap: 16
  },
  drilldownCard: {
    background: "linear-gradient(180deg, rgba(255,255,255,0.97), rgba(255,247,237,0.92))",
    borderRadius: 22,
    border: "1px solid #dbe3ef",
    padding: 20,
    display: "grid",
    gap: 14,
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)"
  },
  drilldownHeader: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "flex-start"
  },
  drilldownTitle: {
    fontSize: 18,
    fontWeight: 700,
    color: "#172033"
  },
  drilldownGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 12
  },
  drilldownMetric: {
    padding: 12,
    borderRadius: 16,
    border: "1px solid #e2e8f0",
    background: "rgba(255,255,255,0.72)",
    display: "grid",
    gap: 6
  },
  drilldownLabel: {
    fontSize: 12,
    color: "#64748b",
    fontWeight: 600
  },
  drilldownNarrative: {
    fontSize: 13,
    color: "#64748b",
    lineHeight: 1.7
  },
  drilldownMeta: {
    display: "grid",
    gap: 6,
    fontSize: 12,
    color: "#475569"
  },
  drilldownLiveNote: {
    fontSize: 12,
    color: "#0f766e",
    fontWeight: 700
  },
  badge: {
    display: "inline-flex",
    alignItems: "center",
    gap: 4,
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 700,
    width: "fit-content"
  },
  historyWrap: {},
  tableHead: {
    display: "grid",
    gridTemplateColumns: "1.3fr 0.7fr 1.1fr 1.5fr 0.8fr",
    padding: "12px 20px",
    background: "#f8fafc",
    borderBottom: "1px solid #e2e8f0",
    fontSize: 12,
    fontWeight: 700,
    color: "#94a3b8",
    letterSpacing: "0.04em",
    gap: 12
  },
  tableRow: {
    display: "grid",
    gridTemplateColumns: "1.3fr 0.7fr 1.1fr 1.5fr 0.8fr",
    padding: "12px 20px",
    borderBottom: "1px solid #f1f5f9",
    fontSize: 13,
    color: "#172033",
    alignItems: "center",
    gap: 12,
    width: "100%",
    background: "transparent",
    borderLeft: "none",
    borderRight: "none",
    borderTop: "none",
    textAlign: "left",
    cursor: "pointer"
  },
  eventRow: {
    display: "grid",
    gridTemplateColumns: "1.2fr 1fr 0.8fr 0.8fr 0.8fr",
    padding: "12px 20px",
    borderBottom: "1px solid #f1f5f9",
    fontSize: 13,
    color: "#172033",
    alignItems: "center",
    gap: 12,
    width: "100%",
    background: "transparent",
    borderLeft: "none",
    borderRight: "none",
    borderTop: "none",
    textAlign: "left",
    cursor: "pointer"
  },
  eventRowSelected: {
    background: "rgba(20, 184, 166, 0.1)"
  }
};
