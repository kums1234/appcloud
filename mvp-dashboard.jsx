/**
 * ============================================================
 * MVP DASHBOARD TEMPLATE — Infrastructure Topology & Governance
 * ============================================================
 *
 * PURPOSE:
 *   A reusable, extensible frontend shell for the Infrastructure
 *   Change Management platform. Built to support Phase 1 through
 *   Phase 3 features with minimal structural changes.
 *
 * ARCHITECTURE:
 *   - Single-file React component (JSX) for portability
 *   - CSS-in-JS via inline style objects + a global <style> tag
 *   - Client-side router via hash-based navigation (no deps needed)
 *   - Each "page" is a self-contained component — easy to swap out
 *
 * EXTENDING THIS TEMPLATE:
 *   1. Add a new entry to NAV_ITEMS to create a sidebar link
 *   2. Add a corresponding component below and map it in PAGES
 *   3. Use the <Card>, <Badge>, <StatusDot>, <Table> primitives for
 *      visual consistency across all pages
 *
 * AESTHETIC:
 *   Blueprint/Technical Dark — deep navy (#0a0f1e), electric cyan
 *   accents (#00d4ff), monospace type for data, sharp geometry.
 *   Designed to feel like an engineering control room.
 *
 * DEPENDENCIES (CDN):
 *   - React 18 (react + react-dom)
 *   - Lucide React (icons)
 *   All loaded via import maps — no build step required for prototyping.
 *   For production: migrate to Next.js pages/app directory structure.
 *
 * LOGGING:
 *   All navigation events and simulated API calls are logged to the
 *   browser console with a [MVP] prefix for easy filtering.
 *   Search: "[MVP]" in DevTools console to trace all app activity.
 *
 * AUTHOR: Generated MVP Template
 * VERSION: 1.0.0 — Phase 1
 * ============================================================
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  GitBranch, Network, FileText, CheckSquare, BarChart2,
  Settings, Bell, Search, ChevronRight, ChevronDown,
  AlertTriangle, CheckCircle, Clock, XCircle, Plus,
  ArrowRight, Layers, Shield, Zap, Terminal, User,
  MoreVertical, Filter, Download, RefreshCw, Eye,
  GitMerge, Database, Cloud, Server, Link2, Activity
} from "lucide-react";

// ============================================================
// DESIGN TOKENS
// All colours, spacing, and type decisions live here.
// Change these to re-skin the entire app instantly.
// ============================================================
const TOKENS = {
  // Colour palette
  bg:         "#080d1a",        // Page background — deepest navy
  bgPanel:    "#0d1526",        // Cards and sidebar
  bgHover:    "#111d35",        // Interactive hover state
  bgActive:   "#152040",        // Selected / active state
  border:     "#1a2a4a",        // Subtle borders
  borderBright: "#00d4ff33",    // Cyan-tinted borders for focus states

  // Accent colours
  cyan:       "#00d4ff",        // Primary accent — electric cyan
  cyanDim:    "#00d4ff88",      // Muted cyan for secondary elements
  cyanGlow:   "#00d4ff22",      // Background glow

  amber:      "#f59e0b",        // Warning / pending states
  green:      "#10b981",        // Success / approved states
  red:        "#ef4444",        // Error / rejected states
  purple:     "#8b5cf6",        // Info / neutral states

  // Typography
  textPrimary:   "#e8f4f8",     // Main readable text
  textSecondary: "#7a9bb5",     // Labels, metadata
  textMuted:     "#3d5a73",     // Placeholders, disabled

  // Spacing scale (px)
  xs: "4px", sm: "8px", md: "16px", lg: "24px", xl: "40px",

  // Typography scale
  fontMono: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
  fontSans: "'DM Sans', 'Segoe UI', system-ui, sans-serif",
  fontDisplay: "'Space Grotesk', 'DM Sans', system-ui, sans-serif",
};

// ============================================================
// NAVIGATION CONFIG
// Add new pages here. The `phase` field controls a "COMING SOON"
// badge — set to 1 for Phase 1 MVP, 2 or 3 for future features.
// ============================================================
const NAV_ITEMS = [
  {
    section: "TOPOLOGY",
    items: [
      { id: "overview",       label: "Overview",         icon: Network,      phase: 1 },
      { id: "graph-editor",   label: "Graph Editor",     icon: GitBranch,    phase: 1 },
      { id: "impact",         label: "Impact Analysis",  icon: Activity,     phase: 1 },
    ]
  },
  {
    section: "GOVERNANCE",
    items: [
      { id: "changes",        label: "Change Requests",  icon: FileText,     phase: 1 },
      { id: "approvals",      label: "Approval Flows",   icon: CheckSquare,  phase: 1 },
      { id: "policies",       label: "Policy Engine",    icon: Shield,       phase: 2 },
    ]
  },
  {
    section: "INTEGRATIONS",
    items: [
      { id: "autodiscovery",  label: "Auto-Discovery",   icon: Cloud,        phase: 2 },
      { id: "cicd",           label: "CI/CD Hooks",      icon: GitMerge,     phase: 2 },
    ]
  },
  {
    section: "INTELLIGENCE",
    items: [
      { id: "ai-impact",      label: "AI Impact",        icon: Zap,          phase: 3 },
      { id: "risk",           label: "Risk Scoring",     icon: BarChart2,    phase: 3 },
      { id: "costs",          label: "Cost Attribution", icon: Database,     phase: 3 },
    ]
  },
];

// ============================================================
// MOCK DATA
// Simulates API responses for Phase 1 features.
// In production, replace these with actual API calls to your
// Node.js/Kotlin backend. Each dataset is clearly labelled.
// ============================================================

/** Mock: Change Requests — maps to /api/changes */
const MOCK_CHANGES = [
  { id: "CR-1041", title: "Update prod-db-cluster replication factor", status: "pending",  author: "sarah.chen",   created: "2 hours ago",  priority: "high",   service: "Database" },
  { id: "CR-1040", title: "Add load balancer to payments-svc",          status: "approved", author: "mike.torres",  created: "5 hours ago",  priority: "medium", service: "Networking" },
  { id: "CR-1039", title: "Resize compute nodes in eu-west-1",          status: "rejected", author: "alex.kumar",   created: "1 day ago",    priority: "low",    service: "Compute" },
  { id: "CR-1038", title: "Configure VPC peering for analytics cluster", status: "review",   author: "priya.nair",   created: "1 day ago",    priority: "high",   service: "Networking" },
  { id: "CR-1037", title: "Migrate Redis cache to ElastiCache",          status: "approved", author: "james.white",  created: "2 days ago",   priority: "medium", service: "Cache" },
  { id: "CR-1036", title: "Update IAM roles for data-pipeline service",  status: "pending",  author: "sarah.chen",   created: "3 days ago",   priority: "high",   service: "IAM" },
];

/** Mock: Approval Workflows — maps to /api/approvals */
const MOCK_APPROVALS = [
  {
    id: "AP-201", changeId: "CR-1041", title: "Prod DB replication change",
    stages: [
      { name: "Security Review",   status: "approved", approver: "sec-team",    at: "10:30 AM" },
      { name: "Platform Review",   status: "approved", approver: "platform-ops", at: "11:45 AM" },
      { name: "VP Engineering",    status: "pending",  approver: "eng-vp",      at: null },
    ],
    currentStage: 2, priority: "high"
  },
  {
    id: "AP-200", changeId: "CR-1038", title: "VPC peering configuration",
    stages: [
      { name: "Network Review",    status: "approved", approver: "net-team",    at: "Yesterday" },
      { name: "Security Review",   status: "review",   approver: "sec-team",    at: null },
      { name: "CTO Sign-off",      status: "pending",  approver: "cto",         at: null },
    ],
    currentStage: 1, priority: "high"
  },
];

/** Mock: Impact Analysis nodes — maps to /api/impact/{changeId} */
const MOCK_IMPACT_NODES = [
  { id: "payments-svc",   type: "service",  risk: "high",   label: "payments-svc",   deps: 3 },
  { id: "auth-svc",       type: "service",  risk: "medium", label: "auth-svc",        deps: 1 },
  { id: "prod-db-01",     type: "database", risk: "high",   label: "prod-db-01",      deps: 0 },
  { id: "prod-db-02",     type: "database", risk: "high",   label: "prod-db-02",      deps: 0 },
  { id: "analytics-svc",  type: "service",  risk: "low",    label: "analytics-svc",   deps: 2 },
  { id: "cache-layer",    type: "cache",    risk: "medium", label: "cache-layer",      deps: 4 },
];

/** Mock: Overview stats — maps to /api/stats/summary */
const MOCK_STATS = [
  { label: "Active Services",   value: "142",  delta: "+3",  trend: "up",   icon: Server },
  { label: "Open Changes",      value: "17",   delta: "+2",  trend: "up",   icon: FileText },
  { label: "Pending Approvals", value: "6",    delta: "-1",  trend: "down", icon: Clock },
  { label: "Policy Violations", value: "2",    delta: "+2",  trend: "warn", icon: AlertTriangle },
];

// ============================================================
// UTILITY HELPERS
// ============================================================

/**
 * Simulates an async API call with artificial delay.
 * Replace the body of this function with real fetch() calls in production.
 * @param {string} endpoint - The API endpoint being "called"
 * @param {any} mockData - The mock data to return
 */
const fakeApiCall = (endpoint, mockData) => {
  console.log(`[MVP] → API call: ${endpoint}`);
  return new Promise((resolve) => {
    setTimeout(() => {
      console.log(`[MVP] ← API response: ${endpoint}`, mockData);
      resolve(mockData);
    }, 400);
  });
};

/** Maps a status string to its display colour token */
const statusColor = (status) => ({
  approved: TOKENS.green,
  pending:  TOKENS.amber,
  rejected: TOKENS.red,
  review:   TOKENS.purple,
  high:     TOKENS.red,
  medium:   TOKENS.amber,
  low:      TOKENS.green,
}[status] ?? TOKENS.textSecondary);

/** Maps a status string to an icon component */
const StatusIcon = ({ status, size = 14 }) => {
  const icons = {
    approved: CheckCircle,
    pending:  Clock,
    rejected: XCircle,
    review:   Eye,
  };
  const Icon = icons[status] ?? Clock;
  return <Icon size={size} color={statusColor(status)} />;
};

// ============================================================
// PRIMITIVE UI COMPONENTS
// These are the building blocks used across all pages.
// Keep them generic so they can be reused across projects.
// ============================================================

/**
 * Card — the primary container component.
 * @param {string} title - Optional header text
 * @param {ReactNode} headerRight - Optional element in the top-right corner
 * @param {boolean} noPad - Disable inner padding (for tables etc)
 */
const Card = ({ title, children, headerRight, noPad, style }) => (
  <div style={{
    background: TOKENS.bgPanel,
    border: `1px solid ${TOKENS.border}`,
    borderRadius: "8px",
    overflow: "hidden",
    ...style
  }}>
    {title && (
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: `${TOKENS.md} ${TOKENS.lg}`,
        borderBottom: `1px solid ${TOKENS.border}`,
      }}>
        <span style={{
          fontFamily: TOKENS.fontMono, fontSize: "11px",
          letterSpacing: "0.12em", color: TOKENS.textSecondary,
          textTransform: "uppercase"
        }}>
          {title}
        </span>
        {headerRight}
      </div>
    )}
    <div style={noPad ? {} : { padding: TOKENS.lg }}>
      {children}
    </div>
  </div>
);

/**
 * Badge — status pill chip.
 * @param {string} status - "approved" | "pending" | "rejected" | "review" | "high" | "medium" | "low"
 */
const Badge = ({ status, label }) => {
  const color = statusColor(status);
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: "4px",
      padding: "2px 8px", borderRadius: "100px",
      background: `${color}18`, border: `1px solid ${color}44`,
      color, fontSize: "11px", fontFamily: TOKENS.fontMono,
      letterSpacing: "0.05em", fontWeight: 600,
      textTransform: "uppercase",
    }}>
      {label ?? status}
    </span>
  );
};

/**
 * StatusDot — a small pulsing indicator dot.
 * @param {string} color - Any CSS colour value
 * @param {boolean} pulse - Enable CSS pulse animation
 */
const StatusDot = ({ color, pulse }) => (
  <span style={{
    display: "inline-block", width: "7px", height: "7px",
    borderRadius: "50%", background: color,
    boxShadow: pulse ? `0 0 0 3px ${color}33` : "none",
    animation: pulse ? "pulse 2s infinite" : "none",
  }} />
);

/**
 * Button — primary action button.
 * @param {string} variant - "primary" | "ghost" | "danger"
 */
const Button = ({ children, onClick, variant = "ghost", icon: Icon, disabled }) => {
  const styles = {
    primary: {
      background: TOKENS.cyan, color: "#000",
      border: "none", fontWeight: 700,
    },
    ghost: {
      background: "transparent", color: TOKENS.textSecondary,
      border: `1px solid ${TOKENS.border}`,
    },
    danger: {
      background: `${TOKENS.red}18`, color: TOKENS.red,
      border: `1px solid ${TOKENS.red}44`,
    },
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: "inline-flex", alignItems: "center", gap: "6px",
        padding: "7px 14px", borderRadius: "6px",
        fontSize: "12px", fontFamily: TOKENS.fontMono,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        letterSpacing: "0.04em", transition: "all 0.15s ease",
        ...styles[variant]
      }}
    >
      {Icon && <Icon size={13} />}
      {children}
    </button>
  );
};

/**
 * Table — a styled data table component.
 * @param {string[]} columns - Column header labels
 * @param {ReactNode[][]} rows - 2D array of row cells
 */
const Table = ({ columns, rows }) => (
  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
    <thead>
      <tr style={{ borderBottom: `1px solid ${TOKENS.border}` }}>
        {columns.map((col) => (
          <th key={col} style={{
            padding: `${TOKENS.sm} ${TOKENS.md}`,
            textAlign: "left", color: TOKENS.textMuted,
            fontFamily: TOKENS.fontMono, fontSize: "10px",
            letterSpacing: "0.1em", textTransform: "uppercase",
            fontWeight: 500,
          }}>
            {col}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {rows.map((row, i) => (
        <tr key={i} style={{
          borderBottom: `1px solid ${TOKENS.border}`,
          transition: "background 0.1s",
          cursor: "pointer",
        }}
          onMouseEnter={(e) => e.currentTarget.style.background = TOKENS.bgHover}
          onMouseLeave={(e) => e.currentTarget.style.background = "transparent"}
        >
          {row.map((cell, j) => (
            <td key={j} style={{
              padding: `12px ${TOKENS.md}`,
              color: TOKENS.textPrimary, verticalAlign: "middle",
            }}>
              {cell}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table>
);

/**
 * EmptyState — shown when a data set is empty.
 */
const EmptyState = ({ icon: Icon, message }) => (
  <div style={{
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", padding: TOKENS.xl, gap: TOKENS.md,
    color: TOKENS.textMuted,
  }}>
    {Icon && <Icon size={36} strokeWidth={1} />}
    <p style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", letterSpacing: "0.05em" }}>
      {message}
    </p>
  </div>
);

/**
 * Loader — simple skeleton shimmer for async states.
 */
const Loader = () => (
  <div style={{ padding: TOKENS.lg }}>
    {[1, 2, 3].map((i) => (
      <div key={i} style={{
        height: "40px", background: TOKENS.bgHover, borderRadius: "4px",
        marginBottom: TOKENS.sm, opacity: 1 - i * 0.2,
        animation: "shimmer 1.5s infinite",
      }} />
    ))}
  </div>
);

// ============================================================
// COMING SOON PAGE
// Used for Phase 2 and Phase 3 features
// ============================================================
const ComingSoonPage = ({ label, phase }) => (
  <div style={{
    display: "flex", flexDirection: "column", alignItems: "center",
    justifyContent: "center", height: "60vh", gap: TOKENS.lg,
    color: TOKENS.textMuted,
  }}>
    <div style={{
      width: "80px", height: "80px", borderRadius: "50%",
      border: `2px dashed ${TOKENS.border}`,
      display: "flex", alignItems: "center", justifyContent: "center",
    }}>
      <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textMuted }}>
        P{phase}
      </span>
    </div>
    <div style={{ textAlign: "center" }}>
      <p style={{ fontFamily: TOKENS.fontDisplay, fontSize: "20px", color: TOKENS.textSecondary, marginBottom: "8px" }}>
        {label}
      </p>
      <p style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", letterSpacing: "0.05em" }}>
        Planned for Phase {phase} — not yet built
      </p>
    </div>
    <div style={{
      padding: "6px 16px", borderRadius: "100px",
      background: `${TOKENS.purple}18`, border: `1px solid ${TOKENS.purple}33`,
      color: TOKENS.purple, fontFamily: TOKENS.fontMono, fontSize: "11px",
    }}>
      PHASE {phase} ROADMAP
    </div>
  </div>
);

// ============================================================
// PAGE: OVERVIEW DASHBOARD
// The landing page showing a high-level system summary.
// Data source: /api/stats/summary + /api/changes (recent 5)
// ============================================================
const OverviewPage = () => {
  const [stats, setStats] = useState(null);
  const [recentChanges, setRecentChanges] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Log: Starting data fetch for overview page
    console.log("[MVP] OverviewPage mounted — fetching summary data");

    Promise.all([
      fakeApiCall("/api/stats/summary", MOCK_STATS),
      fakeApiCall("/api/changes?limit=5", MOCK_CHANGES.slice(0, 5)),
    ]).then(([statsData, changesData]) => {
      setStats(statsData);
      setRecentChanges(changesData);
      setLoading(false);
      console.log("[MVP] OverviewPage data loaded successfully");
    });
  }, []);

  if (loading) return <Loader />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.lg }}>

      {/* Stat cards row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: TOKENS.md }}>
        {stats.map((stat) => {
          const Icon = stat.icon;
          const trendColor = stat.trend === "up" ? TOKENS.green : stat.trend === "warn" ? TOKENS.amber : TOKENS.textSecondary;
          return (
            <Card key={stat.label} style={{ position: "relative", overflow: "hidden" }}>
              {/* Decorative accent line */}
              <div style={{
                position: "absolute", top: 0, left: 0, right: 0,
                height: "2px", background: trendColor,
              }} />
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <p style={{
                    fontFamily: TOKENS.fontMono, fontSize: "10px",
                    letterSpacing: "0.1em", color: TOKENS.textMuted,
                    textTransform: "uppercase", marginBottom: "8px"
                  }}>
                    {stat.label}
                  </p>
                  <p style={{
                    fontFamily: TOKENS.fontMono, fontSize: "28px",
                    fontWeight: 700, color: TOKENS.textPrimary, lineHeight: 1,
                  }}>
                    {stat.value}
                  </p>
                  <p style={{
                    fontFamily: TOKENS.fontMono, fontSize: "11px",
                    color: trendColor, marginTop: "6px"
                  }}>
                    {stat.delta} this week
                  </p>
                </div>
                <div style={{
                  width: "36px", height: "36px", borderRadius: "8px",
                  background: `${trendColor}18`,
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Icon size={18} color={trendColor} />
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {/* Recent changes + system health */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: TOKENS.md }}>

        {/* Recent changes table */}
        <Card
          title="Recent Change Requests"
          headerRight={<Button icon={ArrowRight}>View All</Button>}
          noPad
        >
          <Table
            columns={["ID", "Title", "Service", "Author", "Status", "Age"]}
            rows={recentChanges.map((c) => [
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.cyan }}>
                {c.id}
              </span>,
              <span style={{ color: TOKENS.textPrimary, fontSize: "13px" }}>{c.title}</span>,
              <Badge status="review" label={c.service} />,
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.textSecondary }}>
                {c.author}
              </span>,
              <Badge status={c.status} />,
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textMuted }}>
                {c.created}
              </span>,
            ])}
          />
        </Card>

        {/* System health panel */}
        <Card title="System Health">
          <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.md }}>
            {[
              { label: "Graph DB (Neo4j)",      status: "healthy", latency: "4ms" },
              { label: "Metadata DB (Postgres)", status: "healthy", latency: "6ms" },
              { label: "Auth / SSO",             status: "healthy", latency: "12ms" },
              { label: "Terraform Sync",         status: "degraded", latency: "—" },
              { label: "AWS API Connector",      status: "healthy", latency: "89ms" },
            ].map((svc) => {
              const color = svc.status === "healthy" ? TOKENS.green : TOKENS.amber;
              return (
                <div key={svc.label} style={{
                  display: "flex", alignItems: "center",
                  justifyContent: "space-between",
                  padding: `${TOKENS.sm} 0`,
                  borderBottom: `1px solid ${TOKENS.border}`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                    <StatusDot color={color} pulse={svc.status === "healthy"} />
                    <span style={{
                      fontSize: "12px", color: TOKENS.textSecondary,
                      fontFamily: TOKENS.fontMono,
                    }}>
                      {svc.label}
                    </span>
                  </div>
                  <span style={{
                    fontFamily: TOKENS.fontMono, fontSize: "11px", color
                  }}>
                    {svc.latency}
                  </span>
                </div>
              );
            })}
          </div>
        </Card>
      </div>
    </div>
  );
};

// ============================================================
// PAGE: GRAPH EDITOR
// Visual canvas for creating and editing topology nodes.
// In production, integrate with a library like React Flow or
// Cytoscape.js and connect to GET/POST /api/graph endpoints.
// ============================================================
const GraphEditorPage = () => {
  const [selectedNode, setSelectedNode] = useState(null);

  // Placeholder nodes for the canvas
  const nodes = [
    { id: "n1", x: 160, y: 100, label: "api-gateway",   type: "service" },
    { id: "n2", x: 360, y: 60,  label: "auth-svc",      type: "service" },
    { id: "n3", x: 360, y: 160, label: "payments-svc",  type: "service" },
    { id: "n4", x: 580, y: 100, label: "prod-db-01",    type: "database" },
    { id: "n5", x: 580, y: 200, label: "cache-layer",   type: "cache" },
  ];

  const edges = [
    { from: "n1", to: "n2" }, { from: "n1", to: "n3" },
    { from: "n2", to: "n4" }, { from: "n3", to: "n4" },
    { from: "n3", to: "n5" },
  ];

  const nodeColor = (type) => ({
    service: TOKENS.cyan, database: TOKENS.amber, cache: TOKENS.purple,
  }[type] ?? TOKENS.textSecondary);

  const getNode = (id) => nodes.find((n) => n.id === id);

  console.log("[MVP] GraphEditorPage — selected node:", selectedNode);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.md }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <p style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.textMuted }}>
          Drag nodes to reposition · Click to inspect · Double-click to edit
        </p>
        <div style={{ display: "flex", gap: TOKENS.sm }}>
          <Button icon={Plus} variant="primary">Add Node</Button>
          <Button icon={Link2}>Add Edge</Button>
          <Button icon={Download}>Export Graph</Button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 280px", gap: TOKENS.md }}>
        {/* Canvas */}
        <Card noPad style={{ height: "520px", position: "relative" }}>
          <svg
            width="100%" height="100%"
            style={{ position: "absolute", top: 0, left: 0, cursor: "crosshair" }}
          >
            {/* Grid dots — engineering graph-paper feel */}
            <defs>
              <pattern id="grid" width="30" height="30" patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" fill={TOKENS.border} />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#grid)" />

            {/* Edges */}
            {edges.map((e, i) => {
              const a = getNode(e.from), b = getNode(e.to);
              if (!a || !b) return null;
              return (
                <g key={i}>
                  <line
                    x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                    stroke={TOKENS.border} strokeWidth={1.5}
                    strokeDasharray="4 3"
                  />
                  {/* Arrow head */}
                  <polygon
                    points={`${b.x},${b.y - 5} ${b.x - 5},${b.y + 5} ${b.x + 5},${b.y + 5}`}
                    fill={TOKENS.border}
                  />
                </g>
              );
            })}

            {/* Nodes */}
            {nodes.map((node) => {
              const color = nodeColor(node.type);
              const selected = selectedNode?.id === node.id;
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x}, ${node.y})`}
                  onClick={() => {
                    console.log(`[MVP] Node selected: ${node.id} (${node.type})`);
                    setSelectedNode(node);
                  }}
                  style={{ cursor: "pointer" }}
                >
                  {/* Glow ring when selected */}
                  {selected && (
                    <circle r="28" fill={`${color}18`} stroke={color} strokeWidth={1} strokeDasharray="3 2" />
                  )}
                  <circle
                    r="20"
                    fill={TOKENS.bgPanel}
                    stroke={color}
                    strokeWidth={selected ? 2 : 1}
                  />
                  <text
                    textAnchor="middle" dominantBaseline="middle"
                    fontSize="9" fontFamily={TOKENS.fontMono}
                    fill={color} letterSpacing="0.02em"
                  >
                    {node.type === "service" ? "SVC" : node.type === "database" ? "DB" : "CACHE"}
                  </text>
                  <text
                    y="36" textAnchor="middle"
                    fontSize="10" fontFamily={TOKENS.fontMono}
                    fill={TOKENS.textSecondary}
                  >
                    {node.label}
                  </text>
                </g>
              );
            })}
          </svg>
        </Card>

        {/* Inspector panel */}
        <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.md }}>
          <Card title="Node Inspector">
            {selectedNode ? (
              <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.md }}>
                {[
                  { label: "ID",   value: selectedNode.id },
                  { label: "Name", value: selectedNode.label },
                  { label: "Type", value: selectedNode.type },
                  { label: "X",    value: selectedNode.x },
                  { label: "Y",    value: selectedNode.y },
                ].map(({ label, value }) => (
                  <div key={label}>
                    <p style={{ fontFamily: TOKENS.fontMono, fontSize: "10px", color: TOKENS.textMuted, marginBottom: "3px", letterSpacing: "0.08em" }}>
                      {label.toUpperCase()}
                    </p>
                    <p style={{ fontFamily: TOKENS.fontMono, fontSize: "13px", color: TOKENS.textPrimary }}>
                      {value}
                    </p>
                  </div>
                ))}
                <div style={{ display: "flex", gap: TOKENS.sm, marginTop: TOKENS.sm }}>
                  <Button variant="primary">Edit</Button>
                  <Button variant="danger">Remove</Button>
                </div>
              </div>
            ) : (
              <EmptyState icon={Network} message="Select a node to inspect" />
            )}
          </Card>

          <Card title="Legend">
            {[
              { color: TOKENS.cyan, label: "Service" },
              { color: TOKENS.amber, label: "Database" },
              { color: TOKENS.purple, label: "Cache / Queue" },
            ].map(({ color, label }) => (
              <div key={label} style={{
                display: "flex", alignItems: "center", gap: "10px",
                marginBottom: TOKENS.sm,
              }}>
                <div style={{ width: "10px", height: "10px", borderRadius: "50%", background: color }} />
                <span style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.textSecondary }}>
                  {label}
                </span>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
};

// ============================================================
// PAGE: CHANGE REQUESTS
// List view of all change requests with filtering and detail.
// Data source: GET /api/changes
// ============================================================
const ChangesPage = () => {
  const [changes, setChanges] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");

  useEffect(() => {
    console.log("[MVP] ChangesPage mounted — fetching changes");
    fakeApiCall("/api/changes", MOCK_CHANGES).then((data) => {
      setChanges(data);
      setLoading(false);
    });
  }, []);

  const filtered = filter === "all" ? changes : changes.filter((c) => c.status === filter);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.md }}>

      {/* Toolbar */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", gap: TOKENS.sm }}>
          {["all", "pending", "review", "approved", "rejected"].map((f) => (
            <button
              key={f}
              onClick={() => {
                console.log(`[MVP] ChangesPage filter changed to: ${f}`);
                setFilter(f);
              }}
              style={{
                padding: "5px 12px", borderRadius: "6px",
                fontFamily: TOKENS.fontMono, fontSize: "11px",
                letterSpacing: "0.05em", textTransform: "uppercase",
                cursor: "pointer", transition: "all 0.15s",
                background: filter === f ? `${TOKENS.cyan}22` : "transparent",
                border: filter === f ? `1px solid ${TOKENS.cyan}66` : `1px solid ${TOKENS.border}`,
                color: filter === f ? TOKENS.cyan : TOKENS.textMuted,
              }}
            >
              {f}
            </button>
          ))}
        </div>
        <Button icon={Plus} variant="primary">New Change Request</Button>
      </div>

      {/* Table */}
      <Card noPad>
        {loading ? <Loader /> : (
          <Table
            columns={["Change ID", "Title", "Service", "Priority", "Author", "Status", "Created"]}
            rows={filtered.map((c) => [
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.cyan }}>
                {c.id}
              </span>,
              <span style={{ color: TOKENS.textPrimary, maxWidth: "280px", display: "block" }}>
                {c.title}
              </span>,
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textSecondary }}>
                {c.service}
              </span>,
              <Badge status={c.priority} />,
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.textSecondary }}>
                {c.author}
              </span>,
              <Badge status={c.status} />,
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textMuted }}>
                {c.created}
              </span>,
            ])}
          />
        )}
      </Card>
    </div>
  );
};

// ============================================================
// PAGE: APPROVAL FLOWS
// Visual multi-stage approval workflow tracker.
// Data source: GET /api/approvals
// ============================================================
const ApprovalsPage = () => {
  const [approvals, setApprovals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log("[MVP] ApprovalsPage mounted — fetching approval workflows");
    fakeApiCall("/api/approvals", MOCK_APPROVALS).then((data) => {
      setApprovals(data);
      setLoading(false);
    });
  }, []);

  if (loading) return <Loader />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.md }}>
      {approvals.map((ap) => (
        <Card
          key={ap.id}
          title={`${ap.id} — ${ap.title}`}
          headerRight={
            <div style={{ display: "flex", gap: TOKENS.sm, alignItems: "center" }}>
              <Badge status={ap.priority} label={`${ap.priority} priority`} />
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textMuted }}>
                {ap.changeId}
              </span>
            </div>
          }
        >
          {/* Stage timeline */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 0 }}>
            {ap.stages.map((stage, i) => {
              const color = statusColor(stage.status);
              const isActive = i === ap.currentStage;
              const isFuture = i > ap.currentStage;
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", flex: 1 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1 }}>
                    {/* Circle */}
                    <div style={{
                      width: "40px", height: "40px", borderRadius: "50%",
                      background: isFuture ? TOKENS.bgHover : `${color}18`,
                      border: `2px solid ${isFuture ? TOKENS.border : color}`,
                      display: "flex", alignItems: "center", justifyContent: "center",
                      position: "relative",
                      boxShadow: isActive ? `0 0 16px ${color}44` : "none",
                    }}>
                      <StatusIcon status={stage.status} size={16} />
                      {isActive && (
                        <span style={{
                          position: "absolute", top: "-8px", left: "50%",
                          transform: "translateX(-50%)",
                          fontFamily: TOKENS.fontMono, fontSize: "8px",
                          color: color, letterSpacing: "0.05em",
                          background: TOKENS.bgPanel, padding: "1px 4px",
                        }}>
                          ACTIVE
                        </span>
                      )}
                    </div>
                    {/* Label */}
                    <div style={{ marginTop: "10px", textAlign: "center" }}>
                      <p style={{
                        fontFamily: TOKENS.fontMono, fontSize: "11px",
                        color: isFuture ? TOKENS.textMuted : TOKENS.textPrimary,
                        marginBottom: "2px",
                      }}>
                        {stage.name}
                      </p>
                      <p style={{ fontFamily: TOKENS.fontMono, fontSize: "10px", color: TOKENS.textMuted }}>
                        {stage.approver}
                      </p>
                      {stage.at && (
                        <p style={{ fontFamily: TOKENS.fontMono, fontSize: "10px", color }}>
                          {stage.at}
                        </p>
                      )}
                    </div>
                  </div>
                  {/* Connector line */}
                  {i < ap.stages.length - 1 && (
                    <div style={{
                      height: "2px", flex: 1, marginTop: "-28px",
                      background: i < ap.currentStage ? TOKENS.green : TOKENS.border,
                    }} />
                  )}
                </div>
              );
            })}
          </div>

          {/* Action buttons — shown only if at a pending stage */}
          {ap.stages[ap.currentStage]?.status === "pending" && (
            <div style={{ display: "flex", gap: TOKENS.sm, marginTop: TOKENS.lg }}>
              <Button variant="primary" icon={CheckCircle}>Approve</Button>
              <Button variant="danger" icon={XCircle}>Reject</Button>
              <Button icon={Eye}>View Change Details</Button>
            </div>
          )}
        </Card>
      ))}
    </div>
  );
};

// ============================================================
// PAGE: IMPACT ANALYSIS
// Read-only view showing downstream impact of a change.
// Data source: GET /api/impact/{changeId}
// ============================================================
const ImpactPage = () => {
  const [nodes, setNodes] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    console.log("[MVP] ImpactPage mounted — fetching impact analysis for CR-1041");
    fakeApiCall("/api/impact/CR-1041", MOCK_IMPACT_NODES).then((data) => {
      setNodes(data);
      setLoading(false);
    });
  }, []);

  const highCount   = nodes.filter((n) => n.risk === "high").length;
  const mediumCount = nodes.filter((n) => n.risk === "medium").length;
  const lowCount    = nodes.filter((n) => n.risk === "low").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: TOKENS.md }}>
      {/* Context banner */}
      <div style={{
        padding: TOKENS.md, borderRadius: "8px",
        background: `${TOKENS.amber}11`, border: `1px solid ${TOKENS.amber}33`,
        display: "flex", alignItems: "center", gap: TOKENS.md,
      }}>
        <AlertTriangle size={16} color={TOKENS.amber} />
        <span style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.amber }}>
          Impact analysis for <strong>CR-1041</strong> — Update prod-db-cluster replication factor
        </span>
        <span style={{ marginLeft: "auto", fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textMuted }}>
          Read-only · Last computed 4 min ago
        </span>
      </div>

      {/* Risk summary */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: TOKENS.md }}>
        {[
          { label: "High Risk",   count: highCount,   color: TOKENS.red },
          { label: "Medium Risk", count: mediumCount, color: TOKENS.amber },
          { label: "Low Risk",    count: lowCount,    color: TOKENS.green },
        ].map(({ label, count, color }) => (
          <Card key={label}>
            <p style={{
              fontFamily: TOKENS.fontMono, fontSize: "10px",
              color: TOKENS.textMuted, letterSpacing: "0.1em",
              textTransform: "uppercase", marginBottom: "8px"
            }}>
              {label}
            </p>
            <p style={{
              fontFamily: TOKENS.fontMono, fontSize: "32px",
              fontWeight: 700, color,
            }}>
              {count}
            </p>
            <p style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textMuted }}>
              affected components
            </p>
          </Card>
        ))}
      </div>

      {/* Affected nodes */}
      <Card title="Affected Components" headerRight={<Button icon={Download}>Export Report</Button>} noPad>
        {loading ? <Loader /> : (
          <Table
            columns={["Component", "Type", "Risk Level", "Downstream Deps", "Action"]}
            rows={nodes.map((n) => [
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "13px", color: TOKENS.textPrimary }}>
                {n.label}
              </span>,
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", color: TOKENS.textSecondary }}>
                {n.type}
              </span>,
              <Badge status={n.risk} />,
              <span style={{ fontFamily: TOKENS.fontMono, fontSize: "12px", color: TOKENS.textSecondary }}>
                {n.deps} services
              </span>,
              <Button icon={Eye}>View in Graph</Button>,
            ])}
          />
        )}
      </Card>
    </div>
  );
};

// ============================================================
// PAGE REGISTRY
// Map nav item IDs to their component and page title.
// Add new entries here as you build out Phase 2 and 3.
// ============================================================
const PAGES = {
  "overview":       { component: OverviewPage,    title: "System Overview" },
  "graph-editor":   { component: GraphEditorPage, title: "Graph Editor" },
  "changes":        { component: ChangesPage,     title: "Change Requests" },
  "approvals":      { component: ApprovalsPage,   title: "Approval Flows" },
  "impact":         { component: ImpactPage,      title: "Impact Analysis" },
  // Phase 2
  "policies":       { component: () => <ComingSoonPage label="Policy Engine"    phase={2} />, title: "Policy Engine" },
  "autodiscovery":  { component: () => <ComingSoonPage label="Auto-Discovery"   phase={2} />, title: "Auto-Discovery" },
  "cicd":           { component: () => <ComingSoonPage label="CI/CD Hooks"      phase={2} />, title: "CI/CD Hooks" },
  // Phase 3
  "ai-impact":      { component: () => <ComingSoonPage label="AI Impact"        phase={3} />, title: "AI Impact" },
  "risk":           { component: () => <ComingSoonPage label="Risk Scoring"     phase={3} />, title: "Risk Scoring" },
  "costs":          { component: () => <ComingSoonPage label="Cost Attribution" phase={3} />, title: "Cost Attribution" },
};

// ============================================================
// TOPBAR COMPONENT
// ============================================================
const Topbar = ({ currentTitle }) => (
  <div style={{
    height: "56px", background: TOKENS.bgPanel,
    borderBottom: `1px solid ${TOKENS.border}`,
    display: "flex", alignItems: "center",
    padding: `0 ${TOKENS.lg}`,
    gap: TOKENS.md, flexShrink: 0,
  }}>
    {/* Breadcrumb */}
    <div style={{ display: "flex", alignItems: "center", gap: "6px", flex: 1 }}>
      <span style={{
        fontFamily: TOKENS.fontMono, fontSize: "10px",
        color: TOKENS.textMuted, letterSpacing: "0.08em"
      }}>
        INFRAMAP
      </span>
      <ChevronRight size={12} color={TOKENS.textMuted} />
      <span style={{
        fontFamily: TOKENS.fontMono, fontSize: "12px",
        color: TOKENS.textSecondary, letterSpacing: "0.05em"
      }}>
        {currentTitle}
      </span>
    </div>

    {/* Search bar */}
    <div style={{
      display: "flex", alignItems: "center", gap: "8px",
      background: TOKENS.bg, border: `1px solid ${TOKENS.border}`,
      borderRadius: "6px", padding: "6px 12px",
      width: "220px",
    }}>
      <Search size={12} color={TOKENS.textMuted} />
      <input
        placeholder="Search services, changes..."
        style={{
          background: "transparent", border: "none", outline: "none",
          color: TOKENS.textSecondary, fontFamily: TOKENS.fontMono,
          fontSize: "12px", width: "100%",
        }}
        onChange={(e) => {
          // Log: Search input — in production connect to /api/search
          if (e.target.value) console.log(`[MVP] Search query: "${e.target.value}"`);
        }}
      />
    </div>

    {/* Right icons */}
    <div style={{ display: "flex", alignItems: "center", gap: TOKENS.md }}>
      <button style={{
        position: "relative", background: "transparent",
        border: "none", cursor: "pointer", color: TOKENS.textMuted,
        display: "flex", alignItems: "center",
      }}>
        <Bell size={16} />
        <span style={{
          position: "absolute", top: "-4px", right: "-4px",
          width: "8px", height: "8px", borderRadius: "50%",
          background: TOKENS.red,
        }} />
      </button>

      <div style={{
        width: "30px", height: "30px", borderRadius: "50%",
        background: `${TOKENS.cyan}22`, border: `1px solid ${TOKENS.cyan}44`,
        display: "flex", alignItems: "center", justifyContent: "center",
        cursor: "pointer",
      }}>
        <User size={14} color={TOKENS.cyan} />
      </div>
    </div>
  </div>
);

// ============================================================
// SIDEBAR COMPONENT
// ============================================================
const Sidebar = ({ currentPage, onNavigate }) => (
  <div style={{
    width: "220px", flexShrink: 0,
    background: TOKENS.bgPanel,
    borderRight: `1px solid ${TOKENS.border}`,
    display: "flex", flexDirection: "column",
    height: "100vh", overflowY: "auto",
  }}>
    {/* Logo area */}
    <div style={{
      padding: `${TOKENS.lg} ${TOKENS.md}`,
      borderBottom: `1px solid ${TOKENS.border}`,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <div style={{
          width: "28px", height: "28px", borderRadius: "6px",
          background: `${TOKENS.cyan}22`, border: `1px solid ${TOKENS.cyan}44`,
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <Network size={14} color={TOKENS.cyan} />
        </div>
        <div>
          <p style={{
            fontFamily: TOKENS.fontDisplay, fontSize: "13px",
            fontWeight: 700, color: TOKENS.textPrimary, letterSpacing: "0.02em",
          }}>
            InfraMap
          </p>
          <p style={{
            fontFamily: TOKENS.fontMono, fontSize: "9px",
            color: TOKENS.textMuted, letterSpacing: "0.06em",
          }}>
            MVP · Phase 1
          </p>
        </div>
      </div>
    </div>

    {/* Navigation sections */}
    <nav style={{ flex: 1, padding: `${TOKENS.md} ${TOKENS.sm}` }}>
      {NAV_ITEMS.map((section) => (
        <div key={section.section} style={{ marginBottom: TOKENS.lg }}>
          <p style={{
            fontFamily: TOKENS.fontMono, fontSize: "9px",
            color: TOKENS.textMuted, letterSpacing: "0.14em",
            textTransform: "uppercase", padding: `0 ${TOKENS.sm}`,
            marginBottom: TOKENS.sm,
          }}>
            {section.section}
          </p>
          {section.items.map((item) => {
            const Icon = item.icon;
            const active = currentPage === item.id;
            const future = item.phase > 1;
            return (
              <button
                key={item.id}
                onClick={() => {
                  // Log: Navigation event
                  console.log(`[MVP] Navigation → ${item.id} (Phase ${item.phase})`);
                  onNavigate(item.id);
                }}
                style={{
                  width: "100%", display: "flex", alignItems: "center",
                  gap: "8px", padding: "8px 10px", borderRadius: "6px",
                  marginBottom: "2px", cursor: "pointer", border: "none",
                  textAlign: "left", transition: "all 0.12s",
                  background: active ? TOKENS.bgActive : "transparent",
                  borderLeft: active ? `2px solid ${TOKENS.cyan}` : "2px solid transparent",
                }}
              >
                <Icon
                  size={14}
                  color={active ? TOKENS.cyan : future ? TOKENS.textMuted : TOKENS.textSecondary}
                />
                <span style={{
                  fontFamily: TOKENS.fontMono, fontSize: "12px",
                  letterSpacing: "0.02em", flex: 1,
                  color: active ? TOKENS.cyan : future ? TOKENS.textMuted : TOKENS.textSecondary,
                }}>
                  {item.label}
                </span>
                {/* Phase badge for future features */}
                {future && (
                  <span style={{
                    fontFamily: TOKENS.fontMono, fontSize: "8px",
                    color: TOKENS.textMuted, background: TOKENS.bgHover,
                    padding: "1px 5px", borderRadius: "3px",
                    letterSpacing: "0.04em",
                  }}>
                    P{item.phase}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </nav>

    {/* Footer */}
    <div style={{
      padding: TOKENS.md, borderTop: `1px solid ${TOKENS.border}`,
      display: "flex", flexDirection: "column", gap: TOKENS.sm,
    }}>
      <button style={{
        display: "flex", alignItems: "center", gap: "8px",
        background: "transparent", border: "none",
        cursor: "pointer", padding: "6px 10px", borderRadius: "6px",
        color: TOKENS.textMuted,
      }}>
        <Settings size={13} />
        <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", letterSpacing: "0.04em" }}>
          Settings
        </span>
      </button>
      <button style={{
        display: "flex", alignItems: "center", gap: "8px",
        background: "transparent", border: "none",
        cursor: "pointer", padding: "6px 10px", borderRadius: "6px",
        color: TOKENS.textMuted,
      }}>
        <Terminal size={13} />
        <span style={{ fontFamily: TOKENS.fontMono, fontSize: "11px", letterSpacing: "0.04em" }}>
          API Console
        </span>
      </button>
    </div>
  </div>
);

// ============================================================
// ROOT APP COMPONENT
// Entry point — manages routing and global layout.
// ============================================================
export default function App() {
  // Current page state — defaults to "overview"
  const [currentPage, setCurrentPage] = useState("overview");

  /**
   * handleNavigate — called when a sidebar link is clicked.
   * In production with Next.js, replace this with router.push().
   */
  const handleNavigate = useCallback((pageId) => {
    console.log(`[MVP] Route change: ${currentPage} → ${pageId}`);
    setCurrentPage(pageId);
  }, [currentPage]);

  // Resolve current page metadata and component
  const pageConfig = PAGES[currentPage] ?? PAGES["overview"];
  const PageComponent = pageConfig.component;

  return (
    <>
      {/*
       * Global styles injected via a <style> tag.
       * Includes: font imports, CSS animations, and
       * reset rules for a consistent base.
       */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=DM+Sans:wght@400;500;600;700&family=Space+Grotesk:wght@500;700&display=swap');
        
        * { box-sizing: border-box; margin: 0; padding: 0; }
        
        body {
          background: ${TOKENS.bg};
          color: ${TOKENS.textPrimary};
          font-family: ${TOKENS.fontSans};
          height: 100vh; overflow: hidden;
        }
        
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: ${TOKENS.bg}; }
        ::-webkit-scrollbar-thumb { background: ${TOKENS.border}; border-radius: 2px; }
        
        /* Pulsing dot animation for status indicators */
        @keyframes pulse {
          0%, 100% { box-shadow: 0 0 0 0 currentColor; opacity: 1; }
          50% { box-shadow: 0 0 0 4px transparent; opacity: 0.8; }
        }
        
        /* Skeleton shimmer animation */
        @keyframes shimmer {
          0% { opacity: 0.4; }
          50% { opacity: 0.7; }
          100% { opacity: 0.4; }
        }
        
        /* Fade-in for page transitions */
        @keyframes fadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        
        .page-enter { animation: fadeIn 0.2s ease forwards; }
      `}</style>

      {/* App shell layout: sidebar + main area */}
      <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>

        {/* Left sidebar */}
        <Sidebar currentPage={currentPage} onNavigate={handleNavigate} />

        {/* Main content area */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>

          {/* Top navigation bar */}
          <Topbar currentTitle={pageConfig.title} />

          {/* Page content scroll container */}
          <main
            key={currentPage}     /* Key change triggers fade-in animation */
            className="page-enter"
            style={{
              flex: 1, overflowY: "auto",
              padding: TOKENS.lg,
            }}
          >
            {/* Page title */}
            <div style={{ marginBottom: TOKENS.lg }}>
              <h1 style={{
                fontFamily: TOKENS.fontDisplay,
                fontSize: "22px", fontWeight: 700,
                color: TOKENS.textPrimary, letterSpacing: "-0.01em",
              }}>
                {pageConfig.title}
              </h1>
              {/* Decorative underline */}
              <div style={{
                width: "32px", height: "2px",
                background: TOKENS.cyan, marginTop: "6px",
                borderRadius: "1px",
              }} />
            </div>

            {/* Render the active page */}
            <PageComponent />
          </main>
        </div>
      </div>
    </>
  );
}
