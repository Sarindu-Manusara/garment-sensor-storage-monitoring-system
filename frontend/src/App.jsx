import { startTransition, useEffect, useMemo, useState } from "react";

import { ChatWidget } from "./components/ChatWidget";
import filtersIcon from "../../src/images/filters.png";
import healthIcon from "../../src/images/health.png";
import investigateIcon from "../../src/images/investigate.png";
import logoImage from "../../src/images/logo.png";
import mlIcon from "../../src/images/ml.png";
import timelineIcon from "../../src/images/timeline.png";
import zoneIcon from "../../src/images/zone.png";
import { getApiBaseUrl, toApiUrl } from "./services/apiBase";

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
    color: "#f97316",
    thresholdText: "Green < 35 C | Yellow 35 - 60 C | Red > 60 C"
  },
  {
    key: "humidity",
    label: "Humidity",
    unit: "%",
    icon: "HUM",
    decimals: 0,
    color: "#0f766e",
    thresholdText: "Green < 30 | Yellow 30 - 50 | Red > 50"
  },
  {
    key: "light",
    label: "Light",
    unit: "lx",
    icon: "LUX",
    decimals: 0,
    color: "#ca8a04",
    thresholdText: "Live BH1750 lux reading"
  },
  {
    key: "dust",
    label: "Air Sensor",
    unit: "mg/m^3",
    icon: "AIR",
    decimals: 3,
    color: "#7c3aed",
    thresholdText: "Green < 10 | Yellow >= 10"
  }
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

function getMetricStatus(metricKey, value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "waiting";
  }

  if (metricKey === "temperature") {
    if (value > 60) {
      return "danger";
    }
    if (value >= 35) {
      return "warning";
    }
    return "safe";
  }

  if (metricKey === "humidity") {
    if (value > 50) {
      return "danger";
    }
    if (value >= 30) {
      return "warning";
    }
    return "safe";
  }

  if (metricKey === "dust") {
    return value < 10 ? "safe" : "warning";
  }

  return "safe";
}

function deriveHealthStatus(actual, inference) {
  const warningStatus = normalizeStatus(inference?.warningLevel);
  if (warningStatus !== "waiting") {
    return warningStatus;
  }

  const metricStatuses = [
    getMetricStatus("temperature", actual?.temperature),
    getMetricStatus("humidity", actual?.humidity),
    getMetricStatus("dust", actual?.dust)
  ];

  if (metricStatuses.includes("danger")) {
    return "danger";
  }
  if (metricStatuses.includes("warning")) {
    return "warning";
  }
  if (metricStatuses.includes("safe")) {
    return "safe";
  }
  return "waiting";
}

function healthScoreFromStatus(status) {
  if (status === "danger") {
    return 42;
  }
  if (status === "warning") {
    return 68;
  }
  if (status === "safe") {
    return 94;
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

async function fetchJson(path) {
  const response = await fetch(toApiUrl(path));
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message || `Request failed for ${path}`);
  }
  return payload;
}

function buildPolyline(points, width = 280, height = 64, padding = 6) {
  const valid = points.filter((point) => Number.isFinite(point.value));
  if (!valid.length) {
    return "";
  }

  const min = Math.min(...valid.map((point) => point.value));
  const max = Math.max(...valid.map((point) => point.value));
  const range = max - min || 1;

  return valid
    .map((point, index) => {
      const x = padding + (index / Math.max(valid.length - 1, 1)) * (width - padding * 2);
      const y = height - padding - ((point.value - min) / range) * (height - padding * 2);
      return `${x},${y}`;
    })
    .join(" ");
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
        fontFamily="'Space Grotesk', sans-serif"
      >
        {score}
      </text>
    </svg>
  );
}

function Sidebar({ active, onNav }) {
  return (
    <aside className="legacy-sidebar" style={styles.sidebar}>
      <div style={styles.sidebarBrand}>
        <div style={styles.brandLogoWrap}>
          <img src={logoImage} alt="Garment monitoring" style={styles.brandLogoImage} />
        </div>
        <div>
          <div style={styles.brandName}>Garment Monitor</div>
          <div style={styles.brandSub}>Storage intelligence console</div>
        </div>
      </div>

      <nav style={styles.nav}>
        {NAV.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onNav(item.id)}
            style={{
              ...styles.navItem,
              ...(active === item.id ? styles.navItemActive : {})
            }}
          >
            <span style={styles.navIcon}>
              <img src={item.icon} alt="" style={styles.navIconImage} />
            </span>
            <span style={styles.navLabel}>{item.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function StatusBadge({ level }) {
  const theme = STATUS_THEME[normalizeStatus(level)] || STATUS_THEME.waiting;
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

function MetricCard({ metric, latestValue, status, trend }) {
  const theme = STATUS_THEME[status] || STATUS_THEME.waiting;
  const trendLabel = trend > 0 ? "UP" : trend < 0 ? "DOWN" : "FLAT";

  return (
    <div style={{ ...styles.metricCard, borderColor: theme.border }}>
      <div style={styles.metricHead}>
        <div style={styles.metricIconWrap}>
          <div
            style={{
              ...styles.metricIcon,
              color: metric.color,
              background: `${metric.color}18`
            }}
          >
            {metric.icon}
          </div>
          <span style={styles.metricLabel}>{metric.label}</span>
        </div>
        <span style={{ color: theme.color, fontSize: 12, fontWeight: 700 }}>{trendLabel}</span>
      </div>

      <div style={styles.metricValue}>
        <span style={{ ...styles.metricNum, color: theme.color }}>{formatValue(latestValue, metric.decimals)}</span>
        <span style={styles.metricUnit}>{metric.unit}</span>
      </div>

      <StatusBadge level={status} />
      <div style={styles.thresholdNote}>{metric.thresholdText}</div>
    </div>
  );
}

function ZoneCard({ reading, active, onSelect }) {
  const status = deriveHealthStatus(reading, null);
  return (
    <button
      type="button"
      onClick={() => onSelect(reading.zone)}
      style={{
        ...styles.zoneCard,
        ...(active ? styles.zoneCardActive : {}),
        borderColor: STATUS_THEME[status]?.border || "#dbe3ef"
      }}
    >
      <div style={styles.zoneCardHead}>
        <span style={styles.zoneName}>{reading.zone}</span>
        <StatusBadge level={status} />
      </div>
      <div style={styles.zoneMetrics}>
        <span>Temp: {formatValue(reading.temperature, 1)} C</span>
        <span>Humidity: {formatValue(reading.humidity, 0)}%</span>
        <span>Air: {formatValue(reading.dust, 3)} mg/m^3</span>
      </div>
      <div style={styles.zoneMeta}>{formatTimestamp(reading.timestamp)}</div>
    </button>
  );
}

function SparklineCard({ title, color, points, footer }) {
  const polyline = buildPolyline(points);

  return (
    <div style={styles.chartCard}>
      <div style={styles.chartHeader}>{title}</div>
      {polyline ? (
        <svg viewBox="0 0 280 64" style={styles.chartSvg}>
          <rect x="0" y="0" width="280" height="64" rx="16" fill="rgba(255,255,255,0.48)" />
          <polyline
            fill="none"
            stroke={color}
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={polyline}
          />
        </svg>
      ) : (
        <div style={styles.emptyChart}>No data yet.</div>
      )}
      <div style={styles.chartFooter}>{footer}</div>
    </div>
  );
}

function MlInsightCard({ title, primary, secondary, status, note }) {
  return (
    <div style={styles.insightCard}>
      <div style={styles.insightEyebrow}>{title}</div>
      <div style={styles.insightValueWrap}>
        <span style={styles.insightValue}>{primary}</span>
        <StatusBadge level={status} />
      </div>
      <div style={styles.insightSubvalue}>{secondary}</div>
      <div style={styles.insightDetail}>{note}</div>
    </div>
  );
}

function HistoryTable({ recent }) {
  return (
    <div style={styles.historyWrap}>
      <div className="legacy-history-grid" style={styles.tableHead}>
        <span>Timestamp</span>
        <span>Zone</span>
        <span>Temp / Humidity</span>
        <span>Light / Air</span>
        <span>Status</span>
      </div>
      {recent.length === 0 ? (
        <p style={{ padding: "16px", color: "#94a3b8" }}>No readings received yet.</p>
      ) : (
        recent.map((reading) => (
          <div key={reading.id} className="legacy-history-grid" style={styles.tableRow}>
            <span style={{ color: "#64748b", fontSize: 13 }}>{formatTimestamp(reading.timestamp)}</span>
            <span style={{ fontWeight: 600 }}>{reading.zone}</span>
            <span>{formatValue(reading.temperature, 1)} C / {formatValue(reading.humidity, 0)}%</span>
            <span>{formatValue(reading.light, 0)} lx / {formatValue(reading.dust, 3)} mg/m^3</span>
            <StatusBadge level={deriveHealthStatus(reading, null)} />
          </div>
        ))
      )}
    </div>
  );
}

export default function App() {
  const [activeNav, setActiveNav] = useState("zones");
  const [activeRange, setActiveRange] = useState("24h");
  const [activeZone, setActiveZone] = useState(DEFAULT_ZONE);
  const [dashboard, setDashboard] = useState({
    latest: null,
    recent: [],
    zones: []
  });
  const [mlLatest, setMlLatest] = useState({
    actual: null,
    tinyml: null,
    inference: null,
    summary: null
  });
  const [mlHistory, setMlHistory] = useState({
    series: {
      actualHumidity: [],
      anomalyScore: [],
      predictedHumidity: [],
      warningLevel: []
    },
    summary: null
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function loadData(isInitialLoad) {
      if (!isInitialLoad) {
        setIsRefreshing(true);
      }

      try {
        const historyQuery = buildRangeQuery(activeRange, activeZone);
        const [dashboardPayload, latestMlPayload, historyPayload] = await Promise.all([
          fetchJson(`/api/dashboard?zone=${encodeURIComponent(activeZone)}&limit=12`),
          fetchJson(`/api/ml/latest?zone=${encodeURIComponent(activeZone)}`),
          fetchJson(`/api/ml/history?${historyQuery}`)
        ]);

        if (cancelled) {
          return;
        }

        startTransition(() => {
          setDashboard({
            latest: dashboardPayload.latest ?? null,
            recent: dashboardPayload.recent ?? [],
            zones: dashboardPayload.zones ?? []
          });
          setMlLatest({
            actual: latestMlPayload.actual ?? null,
            tinyml: latestMlPayload.tinyml ?? null,
            inference: latestMlPayload.inference ?? null,
            summary: latestMlPayload.summary ?? null
          });
          setMlHistory({
            series: historyPayload.series ?? {
              actualHumidity: [],
              anomalyScore: [],
              predictedHumidity: [],
              warningLevel: []
            },
            summary: historyPayload.summary ?? null
          });
          setError("");
          setIsLoading(false);
          setIsRefreshing(false);
        });
      } catch (requestError) {
        if (cancelled) {
          return;
        }

        startTransition(() => {
          setError(requestError.message);
          setIsLoading(false);
          setIsRefreshing(false);
        });
      }
    }

    void loadData(true);

    const intervalId = window.setInterval(() => {
      void loadData(false);
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeRange, activeZone]);

  const actual = dashboard.latest || mlLatest.actual;
  const healthStatus = deriveHealthStatus(actual, mlLatest.inference);
  const healthScore = healthScoreFromStatus(healthStatus);
  const alertCount = dashboard.recent.filter((reading) => deriveHealthStatus(reading, null) !== "safe").length;

  const metricCards = useMemo(() => (
    METRICS.map((metric) => {
      const latestValue = actual?.[metric.key];
      const trendValues = dashboard.recent.map((reading) => reading[metric.key] ?? 0);
      const trend = trendValues.length > 1 ? trendValues[0] - trendValues[trendValues.length - 1] : 0;
      return {
        metric,
        latestValue,
        status: getMetricStatus(metric.key, latestValue),
        trend
      };
    })
  ), [actual, dashboard.recent]);

  const tempTrend = dashboard.recent
    .slice()
    .reverse()
    .map((reading) => ({ value: reading.temperature ?? null }));
  const humidityTrend = dashboard.recent
    .slice()
    .reverse()
    .map((reading) => ({ value: reading.humidity ?? null }));
  const anomalyTrend = (mlHistory.series.anomalyScore || []).map((point) => ({ value: point.value ?? null }));
  const predictionGap = (mlHistory.series.predictedHumidity || []).map((point) => ({
    value: Number.isFinite(point.actualHumidity) && Number.isFinite(point.value)
      ? Math.abs(point.value - point.actualHumidity)
      : null
  }));

  return (
    <>
      <style>{`
        @media (max-width: 1160px) {
          .legacy-shell { flex-direction: column; }
          .legacy-sidebar { width: 100% !important; min-height: auto !important; height: auto !important; position: static !important; }
          .legacy-health-card { grid-template-columns: 1fr !important; }
          .legacy-grid-4 { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .legacy-grid-3 { grid-template-columns: 1fr !important; }
          .legacy-zone-strip { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
        }
        @media (max-width: 760px) {
          .legacy-top-bar { flex-direction: column; align-items: stretch !important; }
          .legacy-top-right { flex-direction: column; align-items: stretch !important; }
          .legacy-grid-4 { grid-template-columns: 1fr !important; }
          .legacy-zone-strip { grid-template-columns: 1fr !important; }
          .legacy-history-grid { grid-template-columns: 1fr !important; }
          .legacy-content { padding: 18px !important; }
        }
      `}</style>

      <div className="legacy-shell" style={styles.shell}>
        <Sidebar active={activeNav} onNav={setActiveNav} />

        <main style={styles.main}>
          <header className="legacy-top-bar" style={styles.topBar}>
            <div>
              <div style={styles.topTitle}>Garment Storage Intelligence</div>
              <div style={styles.topSub}>
                MongoDB-backed monitoring dashboard with zone health, ML snapshots, history, and guided chat.
              </div>
            </div>

            <div className="legacy-top-right" style={styles.topRight}>
              <div style={styles.rangeGroup}>
                {Object.keys(RANGE_WINDOWS).map((range) => (
                  <button
                    key={range}
                    type="button"
                    onClick={() => setActiveRange(range)}
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
                <span style={{ color: "#94a3b8", marginRight: 6 }}>API</span>
                <input readOnly value={getApiBaseUrl() || "same-origin"} style={styles.searchInput} />
              </div>

              <div style={styles.bellWrap}>
                Alerts
                {alertCount > 0 ? <span style={styles.bellBadge}>{alertCount}</span> : null}
              </div>
            </div>
          </header>

          <div className="legacy-content" style={styles.content}>
            <section>
              <div style={styles.sectionTitle}>1. ZONE SNAPSHOT STRIP</div>
              <div className="legacy-zone-strip" style={styles.zoneStrip}>
                {dashboard.zones.map((reading) => (
                  <ZoneCard
                    key={reading.zone}
                    reading={reading}
                    active={reading.zone === activeZone}
                    onSelect={setActiveZone}
                  />
                ))}
              </div>
            </section>

            <section>
              <div style={styles.sectionTitle}>2. SYSTEM HEALTH OVERVIEW</div>
              <div className="legacy-health-card" style={styles.healthCard}>
                <HealthRing score={healthScore} status={healthStatus} />

                <div style={styles.healthInfo}>
                  <div style={styles.healthScoreLabel}>
                    Health Score <span style={{ color: "#94a3b8", fontWeight: 400 }}>/ 100</span>
                  </div>
                  <div style={styles.healthNarrative}>
                    {error
                      ? `Feed unavailable: ${error}`
                      : isLoading
                        ? "Loading zone data from MongoDB..."
                        : `Active zone ${activeZone} is currently ${STATUS_THEME[healthStatus]?.label.toLowerCase() || "waiting"}. The backend reading, ML snapshot, and recent history are rendered together here.`}
                  </div>
                </div>

                <div style={styles.pulseBox}>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Zone</span>
                    <span style={styles.pulseVal}>{activeZone}</span>
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Latest reading</span>
                    <span style={styles.pulseVal}>{formatTimestamp(actual?.timestamp)}</span>
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Current warning</span>
                    <StatusBadge level={mlLatest.inference?.warningLevel || healthStatus} />
                  </div>
                  <div style={styles.pulseRow}>
                    <span style={styles.pulseLabel}>Refresh cadence</span>
                    <span style={styles.pulseVal}>{isRefreshing ? "Refreshing..." : `${POLL_INTERVAL_MS / 1000}s`}</span>
                  </div>
                </div>
              </div>
            </section>

            <section>
              <div style={styles.sectionTitle}>3. ENVIRONMENTAL METRICS</div>
              <div className="legacy-grid-4" style={styles.metricsGrid}>
                {metricCards.map(({ metric, latestValue, status, trend }) => (
                  <MetricCard
                    key={metric.key}
                    metric={metric}
                    latestValue={latestValue}
                    status={status}
                    trend={trend}
                  />
                ))}
              </div>
            </section>

            <section>
              <div style={styles.sectionTitle}>4. ML SNAPSHOT</div>
              <div className="legacy-grid-4" style={styles.insightGrid}>
                <MlInsightCard
                  title="Warning Level"
                  primary={String(mlLatest.inference?.warningLevel || "unknown").toUpperCase()}
                  secondary={`${formatValue((mlLatest.inference?.warningConfidence || 0) * 100, 0)}% confidence`}
                  status={mlLatest.inference?.warningLevel || "waiting"}
                  note={mlLatest.inference?.anomalyReasons?.join(", ") || "No anomaly reasons available."}
                />
                <MlInsightCard
                  title="Anomaly Score"
                  primary={formatValue(mlLatest.inference?.anomalyScore, 2)}
                  secondary={mlLatest.inference?.anomalyFlag ? "Flagged anomaly" : "No anomaly flag"}
                  status={mlLatest.inference?.anomalyFlag ? "danger" : "safe"}
                  note={`Model: ${mlLatest.inference?.modelVersion || "backend-ml"}`}
                />
                <MlInsightCard
                  title="TinyML Humidity"
                  primary={formatValue(mlLatest.tinyml?.predictedHumidity, 1)}
                  secondary={`Actual ${formatValue(mlLatest.tinyml?.actualHumidity, 1)}%`}
                  status={healthStatus}
                  note={`ESP32 model ${mlLatest.tinyml?.modelVersion || "not uploaded"}`}
                />
                <MlInsightCard
                  title="Today Summary"
                  primary={formatValue(mlLatest.summary?.anomalyCountToday, 0)}
                  secondary={`Avg error ${formatValue(mlLatest.summary?.avgHumidityPredictionError, 2)}`}
                  status={mlLatest.summary?.currentWarningState || "waiting"}
                  note="Summary derived from MongoDB prediction documents."
                />
              </div>
            </section>

            <section>
              <div style={styles.sectionTitle}>5. TREND PANELS</div>
              <div className="legacy-grid-3" style={styles.chartsGrid}>
                <SparklineCard
                  title="Temperature Trend"
                  color="#f97316"
                  points={tempTrend}
                  footer={`${dashboard.recent.length} recent sensor readings`}
                />
                <SparklineCard
                  title="Humidity Trend"
                  color="#0f766e"
                  points={humidityTrend}
                  footer={`${activeRange} window`}
                />
                <SparklineCard
                  title="Anomaly Score Trend"
                  color="#dc2626"
                  points={anomalyTrend}
                  footer="Backend anomaly score history"
                />
              </div>
              <div className="legacy-grid-3" style={{ ...styles.chartsGrid, marginTop: 16 }}>
                <SparklineCard
                  title="Prediction Gap"
                  color="#7c3aed"
                  points={predictionGap}
                  footer="Absolute TinyML prediction error"
                />
                <div style={styles.storyCard}>
                  <div style={styles.storyStep}>Focus</div>
                  <div style={styles.storyTitle}>Active zone narrative</div>
                  <div style={styles.storyText}>
                    The dashboard is centered on {activeZone}. Readings come from MongoDB, the ML panels come from the stored prediction collection, and the chat widget stays linked to this active zone.
                  </div>
                </div>
                <div style={styles.storyCard}>
                  <div style={styles.storyStep}>Data path</div>
                  <div style={styles.storyTitle}>Backend-backed frontend</div>
                  <div style={styles.storyText}>
                    `GET /api/dashboard` supplies zone snapshots and recent sensor history, while `GET /api/ml/latest` and `GET /api/ml/history` supply the ML side of the view.
                  </div>
                </div>
              </div>
            </section>

            <section>
              <div style={styles.sectionTitle}>6. RECENT SENSOR CAPTURES</div>
              <div style={styles.card}>
                <HistoryTable recent={dashboard.recent} />
              </div>
            </section>
          </div>
        </main>

        <ChatWidget zone={activeZone} />
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
  zoneStrip: {
    display: "grid",
    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
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
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 16
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
    boxShadow: "0 12px 30px rgba(15, 23, 42, 0.05)"
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
  thresholdNote: {
    fontSize: 12,
    color: "#64748b",
    lineHeight: 1.5
  },
  insightGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
    gap: 16
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
  insightValueWrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  insightValue: {
    fontSize: 32,
    fontWeight: 700,
    lineHeight: 1,
    color: "#172033"
  },
  insightSubvalue: {
    fontSize: 14,
    color: "#64748b"
  },
  insightDetail: {
    minHeight: 44,
    fontSize: 13,
    color: "#64748b",
    lineHeight: 1.6
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
  chartFooter: {
    fontSize: 12,
    color: "#64748b"
  },
  emptyChart: {
    minHeight: 64,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#94a3b8",
    fontSize: 14
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
  card: {
    background: "rgba(255, 255, 255, 0.94)",
    borderRadius: 20,
    border: "1px solid #dbe3ef",
    overflow: "hidden",
    boxShadow: "0 16px 40px rgba(15, 23, 42, 0.05)"
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
    gap: 12
  }
};
