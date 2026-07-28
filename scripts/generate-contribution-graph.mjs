#!/usr/bin/env node
/**
 * Gera Contribution Graph quinzenal (agregado a cada 15 dias).
 */

import fs from "node:fs";
import path from "node:path";

const username = process.env.GITHUB_ACTOR || "livyson";
const token = process.env.GITHUB_TOKEN;
const BUCKET_DAYS = 15;

if (!token) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const query = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
            }
          }
        }
      }
    }
  }
`;

function yearWindow() {
  const now = new Date();
  const year = now.getUTCFullYear();
  return {
    from: `${year}-01-01T00:00:00.000Z`,
    to: now.toISOString(),
    year,
    now,
  };
}

async function fetchDailyContributions() {
  const { from, to, year, now } = yearWindow();
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "livyson-contribution-graph",
    },
    body: JSON.stringify({
      query,
      variables: { login: username, from, to },
    }),
  });

  const payload = await res.json();
  if (!res.ok || payload.errors) {
    throw new Error(
      `GitHub GraphQL failed: ${JSON.stringify(payload.errors || payload)}`,
    );
  }

  const calendar = payload.data.user.contributionsCollection.contributionCalendar;
  const days = calendar.weeks.flatMap((week) => week.contributionDays);
  return {
    year,
    now,
    total: calendar.totalContributions || 0,
    days: days.map((d) => ({
      date: d.date,
      count: d.contributionCount || 0,
    })),
  };
}

function toUtcDate(isoDay) {
  const [y, m, d] = isoDay.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function formatLabel(date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function aggregateBiweekly(days, year) {
  const yearStart = Date.UTC(year, 0, 1);
  const buckets = new Map();

  for (const day of days) {
    const ts = toUtcDate(day.date).getTime();
    if (ts < yearStart) continue;
    const offsetDays = Math.floor((ts - yearStart) / 86_400_000);
    const bucketIndex = Math.floor(offsetDays / BUCKET_DAYS);
    const bucketStart = new Date(yearStart + bucketIndex * BUCKET_DAYS * 86_400_000);
    const key = bucketStart.toISOString().slice(0, 10);
    const current = buckets.get(key) || {
      start: bucketStart,
      end: new Date(bucketStart.getTime() + (BUCKET_DAYS - 1) * 86_400_000),
      count: 0,
    };
    current.count += day.count;
    buckets.set(key, current);
  }

  return [...buckets.values()].sort((a, b) => a.start - b.start);
}

function buildSvg(buckets, meta) {
  const width = 900;
  const height = 320;
  const pad = { top: 48, right: 28, bottom: 48, left: 48 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;
  const maxCount = Math.max(1, ...buckets.map((b) => b.count));
  const n = buckets.length;

  const points = buckets.map((bucket, i) => {
    const x = pad.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
    const y = pad.top + plotH - (bucket.count / maxCount) * plotH;
    return { ...bucket, x, y };
  });

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");
  const areaPath =
    points.length === 0
      ? ""
      : `${linePath} L${points[points.length - 1].x.toFixed(1)},${(pad.top + plotH).toFixed(1)} L${points[0].x.toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

  const gridLines = [0, 0.25, 0.5, 0.75, 1]
    .map((t) => {
      const y = pad.top + plotH * (1 - t);
      const value = Math.round(maxCount * t);
      return `
        <line x1="${pad.left}" y1="${y.toFixed(1)}" x2="${width - pad.right}" y2="${y.toFixed(1)}" stroke="#21262d" stroke-width="1" />
        <text x="${pad.left - 10}" y="${(y + 4).toFixed(1)}" text-anchor="end" fill="#8b949e" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${value}</text>
      `;
    })
    .join("");

  // Mostra ~8 rótulos no eixo X para não poluir
  const labelStep = Math.max(1, Math.ceil(n / 8));
  const xLabels = points
    .filter((_, i) => i % labelStep === 0 || i === n - 1)
    .map(
      (p) =>
        `<text x="${p.x.toFixed(1)}" y="${height - 18}" text-anchor="middle" fill="#8b949e" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${formatLabel(p.start)}</text>`,
    )
    .join("\n");

  const dots = points
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5" fill="#ea580c" stroke="#0d1117" stroke-width="1.5"><title>${formatLabel(p.start)} – ${formatLabel(p.end)}: ${p.count} contributions</title></circle>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Biweekly contribution graph for ${meta.year}">
  <rect width="100%" height="100%" rx="8" fill="#0d1117"/>
  <text x="${width / 2}" y="28" text-anchor="middle" fill="#fdba74" font-size="16" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Contribution Graph · biweekly (15 days) · ${meta.year}</text>
  <text x="${width / 2}" y="46" text-anchor="middle" fill="#8b949e" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${meta.total.toLocaleString("en-US")} contributions total</text>
  ${gridLines}
  <path d="${areaPath}" fill="rgba(249, 115, 22, 0.28)" />
  <path d="${linePath}" fill="none" stroke="#f97316" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
  ${dots}
  ${xLabels}
</svg>
`;
}

async function main() {
  const data = await fetchDailyContributions();
  const buckets = aggregateBiweekly(data.days, data.year);
  console.log(
    `Buckets: ${buckets.length} · total=${data.total} · max=${Math.max(0, ...buckets.map((b) => b.count))}`,
  );

  const svg = buildSvg(buckets, { year: data.year, total: data.total });
  const distDir = path.join(process.cwd(), "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const outPath = path.join(distDir, "contribution-graph.svg");
  fs.writeFileSync(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
