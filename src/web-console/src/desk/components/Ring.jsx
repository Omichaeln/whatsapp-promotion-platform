import { useState } from "react";

function arcPath(cx, cy, rOuter, rInner, a0, a1) {
  const pt = (r, a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const large = a1 - a0 > Math.PI ? 1 : 0;
  const [x0, y0] = pt(rOuter, a0);
  const [x1, y1] = pt(rOuter, a1);
  const [x2, y2] = pt(rInner, a1);
  const [x3, y3] = pt(rInner, a0);
  return `M${x0},${y0} A${rOuter},${rOuter} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${rInner},${rInner} 0 ${large} 0 ${x3},${y3} Z`;
}

export function Ring({ data, size = 108, selected, onSelect, centreLabel }) {
  const [hover, setHover] = useState(null);
  const live = data.filter(d => d.value > 0);
  const total = live.reduce((s, d) => s + d.value, 0);
  const r = size / 2;
  const gap = 0.035;
  let angle = -Math.PI / 2;
  const slices = live.map(d => {
    const span = (d.value / total) * Math.PI * 2;
    const a0 = angle + gap / 2;
    const a1 = angle + span - gap / 2;
    angle += span;
    return { d, a0, a1: Math.max(a0 + 0.01, a1) };
  });
  const shown = hover || data.find(d => d.key === selected) || null;
  return (
    <div style={{ position: "relative", width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size}>
        {!live.length && <circle cx={r} cy={r} r={r * 0.82} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth={r * 0.2} />}
        {slices.map(({ d, a0, a1 }) => {
          const grown = hover?.key === d.key;
          return (
            <path key={d.key}
              d={arcPath(r, r, grown ? r : r * 0.95, grown ? r * 0.63 : r * 0.66, a0, a1)}
              fill={d.color}
              opacity={selected && selected !== d.key ? 0.2 : 0.85}
              style={{ cursor: onSelect ? "pointer" : "default", transition: "opacity 0.15s" }}
              onMouseEnter={() => setHover(d)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect?.(selected === d.key ? null : d.key)} />
          );
        })}
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none", padding: 18 }}>
        <span className="mono" style={{ fontSize: 22, fontWeight: 500, letterSpacing: -0.5, color: shown ? shown.color : "var(--text-primary)" }}>
          {shown ? shown.value : total}
        </span>
        <span style={{ fontSize: 8.5, fontWeight: 500, letterSpacing: 1.1, textTransform: "uppercase", color: "var(--text-tertiary)", textAlign: "center", marginTop: 2, lineHeight: 1.3 }}>
          {shown ? shown.label : (centreLabel || "total")}
        </span>
      </div>
    </div>
  );
}

export function Legend({ data, selected, onSelect }) {
  const rows = data.filter(d => d.value > 0);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
      {rows.map(d => {
        const on = selected === d.key;
        return (
          <button key={d.key} onClick={() => onSelect?.(on ? null : d.key)} style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%",
            border: "none", background: on ? "var(--accent-dim)" : "transparent",
            borderRadius: 7, padding: "5px 8px", textAlign: "left",
            opacity: selected && !on ? 0.45 : 1, transition: "background 0.15s, opacity 0.15s",
          }}
            onMouseEnter={e => { if (!on) e.currentTarget.style.background = "rgba(0,0,0,0.03)"; }}
            onMouseLeave={e => { if (!on) e.currentTarget.style.background = "transparent"; }}
          >
            <span style={{ width: 7, height: 7, borderRadius: 999, background: d.color, flexShrink: 0 }} />
            <span className="one-line" style={{ flex: 1, minWidth: 0, fontSize: 11.5, color: on ? "var(--accent)" : "var(--text-secondary)" }}>{d.label}</span>
            <span className="mono" style={{ fontSize: 11, color: "var(--text-tertiary)" }}>{d.value}</span>
          </button>
        );
      })}
    </div>
  );
}
