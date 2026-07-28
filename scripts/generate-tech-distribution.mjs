#!/usr/bin/env node
/**
 * Gera gráfico de pizza (donut) com distribuição de linguagens
 * agregada dos repositórios do usuário.
 */

import fs from "node:fs";
import path from "node:path";

const username = process.env.GITHUB_ACTOR || "livyson";
const token = process.env.GITHUB_TOKEN;
const TOP_N = 8;

if (!token) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(1);
}

const query = `
  query($login: String!, $cursor: String) {
    user(login: $login) {
      repositories(
        ownerAffiliations: OWNER
        isFork: false
        first: 100
        after: $cursor
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          isArchived
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges {
              size
              node {
                name
                color
              }
            }
          }
        }
      }
    }
  }
`;

const FALLBACK_COLORS = [
  "#f97316",
  "#ea580c",
  "#fb923c",
  "#fdba74",
  "#f59e0b",
  "#0ea5e9",
  "#14b8a6",
  "#6366f1",
  "#22c55e",
  "#64748b",
];

async function graphql(variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "livyson-tech-distribution",
    },
    body: JSON.stringify({ query, variables }),
  });
  const payload = await res.json();
  if (!res.ok || payload.errors) {
    throw new Error(
      `GitHub GraphQL failed: ${JSON.stringify(payload.errors || payload)}`,
    );
  }
  return payload.data;
}

async function fetchLanguageBytes() {
  const totals = new Map();
  let cursor = null;
  let pages = 0;

  do {
    const data = await graphql({ login: username, cursor });
    const repos = data.user.repositories;
    for (const repo of repos.nodes) {
      if (!repo || repo.isArchived) continue;
      for (const edge of repo.languages.edges) {
        const name = edge.node.name;
        const color = edge.node.color || null;
        const size = edge.size || 0;
        const current = totals.get(name) || { name, color, size: 0 };
        current.size += size;
        if (!current.color && color) current.color = color;
        totals.set(name, current);
      }
    }
    cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < 5);

  return [...totals.values()].sort((a, b) => b.size - a.size);
}

function toSlices(languages) {
  const total = languages.reduce((sum, item) => sum + item.size, 0);
  if (total === 0) return { total: 0, slices: [] };

  const top = languages.slice(0, TOP_N);
  const rest = languages.slice(TOP_N);
  const restSize = rest.reduce((sum, item) => sum + item.size, 0);

  const slices = top.map((item, index) => ({
    name: item.name,
    size: item.size,
    percent: (item.size / total) * 100,
    color: item.color || FALLBACK_COLORS[index % FALLBACK_COLORS.length],
  }));

  if (restSize > 0) {
    slices.push({
      name: "Other",
      size: restSize,
      percent: (restSize / total) * 100,
      color: "#94a3b8",
    });
  }

  return { total, slices };
}

function polar(cx, cy, radius, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return {
    x: cx + radius * Math.cos(rad),
    y: cy + radius * Math.sin(rad),
  };
}

function donutSlice(cx, cy, innerR, outerR, startAngle, endAngle) {
  const large = endAngle - startAngle > 180 ? 1 : 0;
  const o1 = polar(cx, cy, outerR, startAngle);
  const o2 = polar(cx, cy, outerR, endAngle);
  const i2 = polar(cx, cy, innerR, endAngle);
  const i1 = polar(cx, cy, innerR, startAngle);
  return [
    `M ${o1.x.toFixed(2)} ${o1.y.toFixed(2)}`,
    `A ${outerR} ${outerR} 0 ${large} 1 ${o2.x.toFixed(2)} ${o2.y.toFixed(2)}`,
    `L ${i2.x.toFixed(2)} ${i2.y.toFixed(2)}`,
    `A ${innerR} ${innerR} 0 ${large} 0 ${i1.x.toFixed(2)} ${i1.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

function buildSvg(slices, meta) {
  const width = 900;
  const height = 420;
  const cx = 250;
  const cy = 230;
  const outerR = 138;
  const innerR = 78;
  const gap = slices.length > 1 ? 1.2 : 0;

  const pathEls = [];
  let angle = 0;
  slices.forEach((slice, index) => {
    const sweep = (slice.percent / 100) * 360;
    const start = angle + gap / 2;
    const end = angle + sweep - gap / 2;
    angle += sweep;
    if (end <= start) return;
    const d = donutSlice(cx, cy, innerR, outerR, start, end);
    pathEls.push(
      `<path d="${d}" fill="${slice.color}" stroke="#ffffff" stroke-width="2" opacity="0">
        <title>${slice.name}: ${slice.percent.toFixed(1)}%</title>
        <animate attributeName="opacity" from="0" to="1" begin="${(index * 0.07).toFixed(2)}s" dur="0.4s" fill="freeze" />
      </path>`,
    );
  });

  const top = slices[0];
  const legend = slices
    .map((slice, index) => {
      const y = 88 + index * 34;
      return `
        <circle cx="470" cy="${y}" r="7" fill="${slice.color}" />
        <text x="490" y="${y + 5}" fill="#0f172a" font-size="15" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${slice.name}</text>
        <text x="860" y="${y + 5}" text-anchor="end" fill="#64748b" font-size="14" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${slice.percent.toFixed(1)}%</text>
        <line x1="490" y1="${y + 14}" x2="860" y2="${y + 14}" stroke="#f1f5f9" stroke-width="1" />
      `;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Technology distribution pie chart">
  <rect width="100%" height="100%" rx="16" fill="#ffffff"/>
  <text x="36" y="42" fill="#ea580c" font-size="22" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Tech distribution</text>
  <text x="36" y="66" fill="#64748b" font-size="13" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Languages by bytes across owned repositories · top ${Math.min(TOP_N, slices.length)}</text>

  <circle cx="${cx}" cy="${cy}" r="${outerR + 10}" fill="#fff7ed"/>
  ${pathEls.join("\n")}
  <circle cx="${cx}" cy="${cy}" r="${innerR - 2}" fill="#ffffff"/>
  <text x="${cx}" y="${cy - 8}" text-anchor="middle" fill="#0f172a" font-size="28" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${top ? top.percent.toFixed(0) + "%" : "—"}</text>
  <text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#64748b" font-size="13" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${top ? top.name : "No data"}</text>

  ${legend}
  <text x="36" y="${height - 18}" fill="#94a3b8" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${meta.repoHint}</text>
</svg>
`;
}

async function main() {
  const languages = await fetchLanguageBytes();
  const { total, slices } = toSlices(languages);
  console.log(
    `Languages: ${languages.length} · slices: ${slices.length} · totalBytes=${total}`,
  );
  if (slices[0]) {
    console.log(
      "Top:",
      slices
        .slice(0, 5)
        .map((s) => `${s.name} ${s.percent.toFixed(1)}%`)
        .join(", "),
    );
  }

  const svg = buildSvg(slices, {
    repoHint: `Aggregated from owned non-fork repositories · ${languages.length} languages detected`,
  });
  const distDir = path.join(process.cwd(), "dist");
  fs.mkdirSync(distDir, { recursive: true });
  const outPath = path.join(distDir, "tech-distribution.svg");
  fs.writeFileSync(outPath, svg, "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
