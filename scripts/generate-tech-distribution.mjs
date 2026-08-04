#!/usr/bin/env node
/**
 * Gera gráfico de pizza (donut) com distribuição de tecnologias
 * agregada dos repositórios do usuário.
 *
 * Além das linguagens do GitHub Linguist, inclui:
 * - MySQL  → arquivos *.sql (Linguist marca SQL como "data" e não entra nas stats)
 * - NoSQL  → scripts Mongo em queries/nosql/*.js (senão viram só JavaScript)
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
          name
          isArchived
          defaultBranchRef {
            name
            target {
              ... on Commit {
                oid
              }
            }
          }
          languages(first: 20, orderBy: { field: SIZE, direction: DESC }) {
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
  "#2DD4BF",
  "#F0A202",
  "#4f8a97",
  "#9AA6B8",
  "#14b8a6",
  "#0ea5e9",
  "#fbbf24",
  "#5eead4",
  "#64748b",
  "#94a3b8",
];

const CUSTOM_COLORS = {
  MySQL: "#F0A202",
  NoSQL: "#2DD4BF",
  SQL: "#F0A202",
};

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

async function restJson(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "livyson-tech-distribution",
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub REST failed ${res.status}: ${body}`);
  }
  return res.json();
}

function addBytes(totals, name, size, color = null) {
  if (!size || size <= 0) return;
  const current = totals.get(name) || { name, color: color || null, size: 0 };
  current.size += size;
  if (!current.color && color) current.color = color;
  if (CUSTOM_COLORS[name]) current.color = CUSTOM_COLORS[name];
  totals.set(name, current);
}

async function fetchRepoTreesExtras(repos) {
  let mysqlBytes = 0;
  let nosqlBytes = 0;
  let scanned = 0;

  for (const repo of repos) {
    const sha = repo.defaultBranchRef?.target?.oid;
    if (!sha) continue;

    try {
      const tree = await restJson(
        `https://api.github.com/repos/${username}/${repo.name}/git/trees/${sha}?recursive=1`,
      );
      scanned += 1;
      for (const item of tree.tree || []) {
        if (item.type !== "blob" || !item.path || !item.size) continue;
        const filePath = item.path.replaceAll("\\", "/");
        if (/\.sql$/i.test(filePath)) {
          mysqlBytes += item.size;
          continue;
        }
        // Scripts de prática Mongo/NoSQL (query-forge e similares)
        if (
          /(^|\/)(queries\/)?nosql\//i.test(filePath) &&
          /\.(js|ts|mongodb)$/i.test(filePath)
        ) {
          nosqlBytes += item.size;
        }
      }
    } catch (error) {
      console.warn(`Skip tree ${repo.name}: ${error.message}`);
    }
  }

  return { mysqlBytes, nosqlBytes, scanned };
}

async function fetchTechnologyBytes() {
  const totals = new Map();
  const repoNodes = [];
  let cursor = null;
  let pages = 0;

  do {
    const data = await graphql({ login: username, cursor });
    const repos = data.user.repositories;
    for (const repo of repos.nodes) {
      if (!repo || repo.isArchived) continue;
      repoNodes.push(repo);
      for (const edge of repo.languages.edges) {
        addBytes(totals, edge.node.name, edge.size || 0, edge.node.color);
      }
    }
    cursor = repos.pageInfo.hasNextPage ? repos.pageInfo.endCursor : null;
    pages += 1;
  } while (cursor && pages < 5);

  // Linguist não inclui SQL (type: data). Contamos *.sql como MySQL
  // e queries/nosql/*.js como NoSQL (em vez de só JavaScript).
  const extras = await fetchRepoTreesExtras(repoNodes);
  console.log(
    `Tree scan: repos=${extras.scanned} mysqlBytes=${extras.mysqlBytes} nosqlBytes=${extras.nosqlBytes}`,
  );

  if (extras.mysqlBytes > 0) {
    addBytes(totals, "MySQL", extras.mysqlBytes, CUSTOM_COLORS.MySQL);
  }
  if (extras.nosqlBytes > 0) {
    addBytes(totals, "NoSQL", extras.nosqlBytes, CUSTOM_COLORS.NoSQL);
    // Evita contar duas vezes os mesmos bytes como JavaScript
    const js = totals.get("JavaScript");
    if (js) {
      js.size = Math.max(0, js.size - extras.nosqlBytes);
      if (js.size === 0) totals.delete("JavaScript");
      else totals.set("JavaScript", js);
    }
  }

  // Se o Linguist trouxe "SQL", consolida em MySQL
  if (totals.has("SQL")) {
    const sql = totals.get("SQL");
    totals.delete("SQL");
    addBytes(totals, "MySQL", sql.size, CUSTOM_COLORS.MySQL);
  }

  return [...totals.values()]
    .filter((item) => item.size > 0)
    .sort((a, b) => b.size - a.size);
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
    color:
      item.color ||
      CUSTOM_COLORS[item.name] ||
      FALLBACK_COLORS[index % FALLBACK_COLORS.length],
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

  // Ajusta altura da legenda se houver muitos itens
  const legendHeight = Math.max(420, 88 + slices.length * 34 + 40);
  const svgHeight = Math.max(height, legendHeight);

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
      `<path d="${d}" fill="${slice.color}" stroke="#07090D" stroke-width="2" opacity="0">
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
        <text x="490" y="${y + 5}" fill="#F4F7FB" font-size="15" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${slice.name}</text>
        <text x="860" y="${y + 5}" text-anchor="end" fill="#9AA6B8" font-size="14" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${slice.percent.toFixed(1)}%</text>
        <line x1="490" y1="${y + 14}" x2="860" y2="${y + 14}" stroke="#1C2430" stroke-width="1" />
      `;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${svgHeight}" viewBox="0 0 ${width} ${svgHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Technology distribution pie chart">
  <rect width="100%" height="100%" rx="16" fill="#07090D"/>
  <text x="36" y="42" fill="#2DD4BF" font-size="22" font-weight="700" font-family="ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace">Tech distribution</text>
  <text x="36" y="66" fill="#9AA6B8" font-size="13" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Languages + MySQL/NoSQL by bytes · top ${Math.min(TOP_N, slices.length)}</text>

  <circle cx="${cx}" cy="${cy}" r="${outerR + 10}" fill="#121821"/>
  ${pathEls.join("\n")}
  <circle cx="${cx}" cy="${cy}" r="${innerR - 2}" fill="#07090D"/>
  <text x="${cx}" y="${cy - 8}" text-anchor="middle" fill="#F4F7FB" font-size="28" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${top ? top.percent.toFixed(0) + "%" : "—"}</text>
  <text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="#9AA6B8" font-size="13" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${top ? top.name : "No data"}</text>

  ${legend}
  <text x="36" y="${svgHeight - 18}" fill="#9AA6B8" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${meta.repoHint}</text>
</svg>
`;
}

async function main() {
  const languages = await fetchTechnologyBytes();
  const { total, slices } = toSlices(languages);
  console.log(
    `Technologies: ${languages.length} · slices: ${slices.length} · totalBytes=${total}`,
  );
  if (slices[0]) {
    console.log(
      "Top:",
      slices
        .slice(0, 8)
        .map((s) => `${s.name} ${s.percent.toFixed(1)}%`)
        .join(", "),
    );
  }

  const svg = buildSvg(slices, {
    repoHint: `Owned repos + *.sql as MySQL + queries/nosql as NoSQL · ${languages.length} technologies`,
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
