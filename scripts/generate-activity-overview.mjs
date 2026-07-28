#!/usr/bin/env node
/**
 * Gera um radar chart (Activity Overview) com:
 * Commits, Pull requests, Issues e Code review.
 */

import fs from "node:fs";
import path from "node:path";

const username = process.env.GITHUB_ACTOR || "livyson";
const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const query = `
  query($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
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
  };
}

async function fetchContributions() {
  const { from, to, year } = yearWindow();
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "livyson-activity-overview",
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

  const c = payload.data.user.contributionsCollection;
  return {
    year,
    commits: c.totalCommitContributions || 0,
    pullRequests: c.totalPullRequestContributions || 0,
    issues: c.totalIssueContributions || 0,
    codeReview: c.totalPullRequestReviewContributions || 0,
  };
}

function toPercents(counts) {
  const entries = [
    ["commits", counts.commits],
    ["pullRequests", counts.pullRequests],
    ["issues", counts.issues],
    ["codeReview", counts.codeReview],
  ];
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  if (total === 0) {
    return {
      commits: 0,
      pullRequests: 0,
      issues: 0,
      codeReview: 0,
      total: 0,
    };
  }

  // Largest remainder method — soma sempre 100
  const raw = entries.map(([key, value]) => {
    const exact = (value / total) * 100;
    return { key, exact, base: Math.floor(exact), frac: exact - Math.floor(exact) };
  });
  let remaining = 100 - raw.reduce((sum, item) => sum + item.base, 0);
  raw
    .slice()
    .sort((a, b) => b.frac - a.frac)
    .forEach((item) => {
      if (remaining > 0) {
        item.base += 1;
        remaining -= 1;
      }
    });

  return {
    commits: raw.find((item) => item.key === "commits").base,
    pullRequests: raw.find((item) => item.key === "pullRequests").base,
    issues: raw.find((item) => item.key === "issues").base,
    codeReview: raw.find((item) => item.key === "codeReview").base,
    total,
  };
}

function point(cx, cy, radius, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function buildSvg(counts, percents) {
  const width = 560;
  const height = 400;
  const cx = width / 2;
  const cy = height / 2 + 8;
  const maxR = 105;

  // topo=Code review, direita=Issues, baixo=PRs, esquerda=Commits
  const axes = [
    { key: "codeReview", label: "Code review", angle: 0, count: counts.codeReview },
    { key: "issues", label: "Issues", angle: 90, count: counts.issues },
    { key: "pullRequests", label: "Pull requests", angle: 180, count: counts.pullRequests },
    { key: "commits", label: "Commits", angle: 270, count: counts.commits },
  ];

  const dataPoints = axes.map((axis) => {
    const value = percents[axis.key];
    const r = (value / 100) * maxR;
    return { ...axis, value, ...point(cx, cy, r, axis.angle) };
  });

  const polygon = dataPoints
    .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
    .join(" ");

  const axisLines = axes
    .map((axis) => {
      const end = point(cx, cy, maxR, axis.angle);
      return `<line x1="${cx}" y1="${cy}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" stroke="#216e39" stroke-width="1.5" />`;
    })
    .join("\n");

  const rings = [0.25, 0.5, 0.75, 1]
    .map((scale) => {
      const pts = axes
        .map((axis) => {
          const p = point(cx, cy, maxR * scale, axis.angle);
          return `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
        })
        .join(" ");
      return `<polygon points="${pts}" fill="none" stroke="#d0e6d5" stroke-width="1" />`;
    })
    .join("\n");

  const labels = axes
    .map((axis) => {
      const value = percents[axis.key];
      const labelRadius =
        axis.angle === 90 || axis.angle === 270 ? maxR + 78 : maxR + 52;
      const labelPos = point(cx, cy, labelRadius, axis.angle);
      const anchor =
        axis.angle === 90 ? "start" : axis.angle === 270 ? "end" : "middle";

      let y = labelPos.y;
      if (axis.angle === 0) y -= 6;
      if (axis.angle === 180) y += 18;

      // Uma única linha por eixo — evita qualquer sobreposição
      const line = `${value}% ${axis.label} (${axis.count.toLocaleString("en-US")})`;
      return `<text x="${labelPos.x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" fill="#24292f" font-size="14" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${line}</text>`;
    })
    .join("\n");

  const dots = dataPoints
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="#ffffff" stroke="#216e39" stroke-width="2" />`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub activity overview for ${counts.year}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <text x="${cx}" y="26" text-anchor="middle" fill="#57606a" font-size="13" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Activity overview · ${counts.year} · ${percents.total.toLocaleString("en-US")} total</text>
  ${rings}
  ${axisLines}
  <polygon points="${polygon}" fill="rgba(57, 163, 75, 0.28)" stroke="#216e39" stroke-width="2" stroke-linejoin="round" />
  ${dots}
  ${labels}
</svg>
`;
}

async function main() {
  const counts = await fetchContributions();
  const percents = toPercents(counts);
  console.log("Counts:", counts);
  console.log("Percents:", percents);

  const svg = buildSvg(counts, percents);
  const distDir = path.join(process.cwd(), "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const outPath = path.join(distDir, "activity-overview.svg");
  fs.writeFileSync(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
