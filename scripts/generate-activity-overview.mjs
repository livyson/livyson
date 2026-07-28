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
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        totalCommitContributions
        totalIssueContributions
        totalPullRequestContributions
        totalPullRequestReviewContributions
      }
    }
  }
`;

async function fetchContributions() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "livyson-activity-overview",
    },
    body: JSON.stringify({ query, variables: { login: username } }),
  });

  const payload = await res.json();
  if (!res.ok || payload.errors) {
    throw new Error(
      `GitHub GraphQL failed: ${JSON.stringify(payload.errors || payload)}`,
    );
  }

  const c = payload.data.user.contributionsCollection;
  return {
    commits: c.totalCommitContributions || 0,
    pullRequests: c.totalPullRequestContributions || 0,
    issues: c.totalIssueContributions || 0,
    codeReview: c.totalPullRequestReviewContributions || 0,
  };
}

function toPercents(counts) {
  const total =
    counts.commits + counts.pullRequests + counts.issues + counts.codeReview;
  if (total === 0) {
    return {
      commits: 0,
      pullRequests: 0,
      issues: 0,
      codeReview: 0,
    };
  }

  const raw = {
    commits: (counts.commits / total) * 100,
    pullRequests: (counts.pullRequests / total) * 100,
    issues: (counts.issues / total) * 100,
    codeReview: (counts.codeReview / total) * 100,
  };

  // Arredonda preservando soma ~100
  const rounded = {
    commits: Math.round(raw.commits),
    pullRequests: Math.round(raw.pullRequests),
    issues: Math.round(raw.issues),
    codeReview: Math.round(raw.codeReview),
  };
  const drift =
    100 -
    (rounded.commits +
      rounded.pullRequests +
      rounded.issues +
      rounded.codeReview);
  rounded.commits += drift;
  return rounded;
}

function point(cx, cy, radius, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function buildSvg(percents) {
  const width = 420;
  const height = 320;
  const cx = width / 2;
  const cy = height / 2 + 8;
  const maxR = 95;

  // Ordem igual ao Activity Overview do GitHub:
  // topo=Code review, direita=Issues, baixo=PRs, esquerda=Commits
  const axes = [
    { key: "codeReview", label: "Code review", angle: 0 },
    { key: "issues", label: "Issues", angle: 90 },
    { key: "pullRequests", label: "Pull requests", angle: 180 },
    { key: "commits", label: "Commits", angle: 270 },
  ];

  const dataPoints = axes.map((axis) => {
    const value = percents[axis.key];
    const r = (Math.max(value, 2) / 100) * maxR;
    return { ...axis, value, ...point(cx, cy, r, axis.angle) };
  });

  const polygon = dataPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const axisLines = axes
    .map((axis) => {
      const end = point(cx, cy, maxR, axis.angle);
      return `<line x1="${cx}" y1="${cy}" x2="${end.x.toFixed(1)}" y2="${end.y.toFixed(1)}" stroke="#216e39" stroke-width="1.5" />`;
    })
    .join("\n");

  const rings = [0.33, 0.66, 1]
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
      const labelPos = point(cx, cy, maxR + 34, axis.angle);
      const anchor =
        axis.angle === 90 ? "start" : axis.angle === 270 ? "end" : "middle";
      const dy =
        axis.angle === 0 ? "-0.2em" : axis.angle === 180 ? "1.1em" : "0.35em";
      return `<text x="${labelPos.x.toFixed(1)}" y="${labelPos.y.toFixed(1)}" text-anchor="${anchor}" dominant-baseline="middle" dy="${dy}" fill="#57606a" font-size="14" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${value}% ${axis.label}</text>`;
    })
    .join("\n");

  const dots = dataPoints
    .map(
      (p) =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="5" fill="#ffffff" stroke="#216e39" stroke-width="2" />`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="GitHub activity overview">
  <rect width="100%" height="100%" fill="#ffffff"/>
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

  const svg = buildSvg(percents);
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
