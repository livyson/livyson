#!/usr/bin/env node
/**
 * Gera gráfico de pizza (donut) com distribuição de tecnologias
 * agregada dos repositórios do usuário.
 *
 * Além das linguagens do GitHub Linguist, inclui:
 * - MySQL  → arquivos *.sql (Linguist marca SQL como "data" e não entra nas stats)
 * - NoSQL  → scripts Mongo em queries/nosql/*.js (senão viram só JavaScript)
 * - IA     → uso real de API/pipeline de modelo (Gemini, OpenAI, Anthropic, etc.)
 *            Não conta código apenas escrito com Copilot/Cursor.
 *
 * HTML é excluído de propósito (markup de README/templates distorce o gráfico).
 */

import fs from "node:fs";
import path from "node:path";

const username = process.env.GITHUB_ACTOR || "livyson";
// PAT com scope `repo` (secrets.PROFILE_GITHUB_TOKEN) enxerga repos privados;
// GITHUB_TOKEN do Actions só vê o próprio repositório público.
const token = process.env.PROFILE_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
const TOP_N = 8;
const MIN_LIVE_TECHNOLOGIES = 2;
/** Linguagens do Linguist que não entram no gráfico. */
const EXCLUDED_LANGUAGES = new Set(["HTML"]);
const FALLBACK_PATH = path.join(
  process.cwd(),
  "data",
  "tech-distribution-fallback.json",
);

if (!token) {
  console.error("Missing PROFILE_GITHUB_TOKEN or GITHUB_TOKEN");
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

// Mesma paleta dos badges Data / Infra do README
const BADGE_PALETTE = [
  "#4169E1", // PostgreSQL
  "#47A248", // MongoDB
  "#DC382D", // Redis
  "#FF6600", // RabbitMQ
  "#FF694B", // dbt
  "#017CEE", // Airflow
];

const FALLBACK_COLORS = BADGE_PALETTE;

const CUSTOM_COLORS = {
  MySQL: "#4169E1", // PostgreSQL
  SQL: "#4169E1",
  NoSQL: "#47A248", // MongoDB
  IA: "#8B5CF6",
  Java: "#FF6600", // RabbitMQ
  Python: "#017CEE", // Airflow
  JavaScript: "#DC382D", // Redis
  TypeScript: "#FF694B", // dbt
};

const AI_ASSISTED_PATHS = [
  /(^|\/)\.cursor(\/|$)/,
  /(^|\/)\.cursorrules$/,
  /(^|\/)AGENTS\.md$/i,
  /copilot-instructions/i,
  /(^|\/)\.github\/(copilot|instructions|prompts)\//i,
];

const AI_OUTPUT_PATHS = [/(^|\/)content\/articles\/.*\.md$/i];

const AI_API_USAGE = [
  /\bGEMINI_API_KEY\b/,
  /\bOPENAI_API_KEY\b/,
  /\bANTHROPIC_API_KEY\b/,
  /\bCLAUDE_API_KEY\b/,
  /\bGROQ_API_KEY\b/,
  /\bMISTRAL_API_KEY\b/,
  /generativelanguage\.googleapis\.com/,
  /api\.openai\.com/,
  /api\.anthropic\.com/,
  /ai\.google\.dev/,
  /aistudio\.google/,
  /@google\/generative-ai/,
  /@google\/genai/,
  /google-generativeai/,
  /google\.generativeai/,
  /GoogleGenerativeAI/,
  /GoogleGenAI/,
  /from ["']openai["']/,
  /from openai import/,
  /require\(["']openai["']\)/,
  /from anthropic import/,
  /new OpenAI\s*\(/,
  /\bAnthropic\s*\(/,
  /openai\.chat/,
  /chat\.completions/,
  /@langchain\//,
  /from langchain/,
  /bedrock-runtime/,
  /["']@google\/generative-ai["']/,
  /["']openai["']\s*:/,
  /["']anthropic["']\s*:/,
];

const LANGUAGE_BY_EXTENSION = {
  ".mjs": "JavaScript",
  ".js": "JavaScript",
  ".cjs": "JavaScript",
  ".ts": "TypeScript",
  ".tsx": "TypeScript",
  ".py": "Python",
  ".java": "Java",
  ".rb": "Ruby",
};

function isAiAssistedEditorPath(filePath) {
  return AI_ASSISTED_PATHS.some((pattern) => pattern.test(filePath));
}

function isAiGeneratedOutputPath(filePath) {
  return AI_OUTPUT_PATHS.some((pattern) => pattern.test(filePath));
}

function isAiCandidatePath(filePath) {
  if (isAiAssistedEditorPath(filePath) || isAiGeneratedOutputPath(filePath)) {
    return false;
  }
  // O próprio detector menciona nomes de APIs e não deve contar como uso de IA.
  if (/(^|\/)generate-tech-distribution\.mjs$/.test(filePath)) {
    return false;
  }

  return (
    /(^|\/)(package\.json|requirements[^/]*\.txt|pyproject\.toml)$/i.test(
      filePath,
    ) ||
    /gemini|openai|anthropic|langchain|huggingface|vertex.?ai|bedrock|chatgpt|groq|mistral|ollama/i.test(
      filePath,
    ) ||
    /(generate[-_].*article|weekly-article)/i.test(filePath) ||
    /(^|\/)(llm|genai|ai-client|ai_client)s?\./i.test(filePath)
  );
}

function usesAiApi(content) {
  return AI_API_USAGE.some((pattern) => pattern.test(content));
}

function languageForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return LANGUAGE_BY_EXTENSION[ext] || null;
}

function contentsUrl(repoName, filePath, ref) {
  const encoded = filePath.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${username}/${repoName}/contents/${encoded}?ref=${encodeURIComponent(ref)}`;
}

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

async function restJsonOrNull(url) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "livyson-tech-distribution",
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub REST failed ${res.status}: ${body}`);
  }
  return res.json();
}

async function fetchFileText(repoName, filePath, ref) {
  const payload = await restJsonOrNull(contentsUrl(repoName, filePath, ref));
  if (!payload || payload.type !== "file" || !payload.content) return "";
  return Buffer.from(payload.content.replaceAll("\n", ""), "base64").toString(
    "utf8",
  );
}

function addBytes(totals, name, size, color = null) {
  if (!size || size <= 0) return;
  if (EXCLUDED_LANGUAGES.has(name)) return;
  const current = totals.get(name) || { name, color: color || null, size: 0 };
  current.size += size;
  if (!current.color && color) current.color = color;
  if (CUSTOM_COLORS[name]) current.color = CUSTOM_COLORS[name];
  totals.set(name, current);
}

async function ensureOwnedRepo(repoNodes, name) {
  if (repoNodes.some((repo) => repo.name === name)) return;

  try {
    const repo = await restJson(
      `https://api.github.com/repos/${username}/${name}`,
    );
    if (repo.archived || repo.fork) return;
    const branch = repo.default_branch;
    const ref = await restJson(
      `https://api.github.com/repos/${username}/${name}/git/ref/heads/${branch}`,
    );
    repoNodes.push({
      name: repo.name,
      isArchived: false,
      defaultBranchRef: {
        name: branch,
        target: { oid: ref.object?.sha },
      },
      languages: { edges: [] },
    });
    console.log(`Included extra owned repo: ${name}`);
  } catch (error) {
    console.warn(`Could not include extra repo ${name}: ${error.message}`);
  }
}

function fallbackIaBytes() {
  try {
    const ia = loadFallbackLanguages().find((item) => item.name === "IA");
    return ia?.size || 0;
  } catch {
    return 0;
  }
}

async function fetchRepoTreesExtras(repos) {
  let mysqlBytes = 0;
  let nosqlBytes = 0;
  let aiBytes = 0;
  const aiLanguageDeduct = new Map();
  const aiFiles = [];
  let scanned = 0;

  for (const repo of repos) {
    const sha = repo.defaultBranchRef?.target?.oid;
    const ref = repo.defaultBranchRef?.name;
    if (!sha || !ref) continue;

    try {
      const tree = await restJson(
        `https://api.github.com/repos/${username}/${repo.name}/git/trees/${sha}?recursive=1`,
      );
      scanned += 1;
      const aiCandidates = [];

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
        if (item.size <= 500_000 && isAiCandidatePath(filePath)) {
          aiCandidates.push({ path: filePath, size: item.size });
        }
      }

      for (const candidate of aiCandidates) {
        try {
          const content = await fetchFileText(repo.name, candidate.path, ref);
          if (!usesAiApi(content)) continue;
          aiBytes += candidate.size;
          aiFiles.push(`${repo.name}/${candidate.path}`);
          const language = languageForPath(candidate.path);
          if (language) {
            aiLanguageDeduct.set(
              language,
              (aiLanguageDeduct.get(language) || 0) + candidate.size,
            );
          }
        } catch (error) {
          console.warn(
            `Skip AI file ${repo.name}/${candidate.path}: ${error.message}`,
          );
        }
      }
    } catch (error) {
      console.warn(`Skip tree ${repo.name}: ${error.message}`);
    }
  }

  return {
    mysqlBytes,
    nosqlBytes,
    aiBytes,
    aiLanguageDeduct,
    aiFiles,
    scanned,
  };
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

  await ensureOwnedRepo(repoNodes, "professional-site");
  console.log(
    `Owned repos: ${repoNodes.length} · professional-site=${repoNodes.some((repo) => repo.name === "professional-site")}`,
  );

  // Linguist não inclui SQL (type: data). Contamos *.sql como MySQL
  // e queries/nosql/*.js como NoSQL (em vez de só JavaScript).
  const extras = await fetchRepoTreesExtras(repoNodes);
  console.log(
    `Tree scan: repos=${extras.scanned} mysqlBytes=${extras.mysqlBytes} nosqlBytes=${extras.nosqlBytes} aiBytes=${extras.aiBytes}`,
  );
  if (extras.aiFiles.length) {
    console.log(`IA files: ${extras.aiFiles.join(", ")}`);
  }
  if (extras.aiBytes === 0) {
    extras.aiBytes = fallbackIaBytes();
    if (extras.aiBytes > 0) {
      console.warn(
        `No live AI API files found; using fallback IA bytes=${extras.aiBytes}`,
      );
    }
  }

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
  if (extras.aiBytes > 0) {
    addBytes(totals, "IA", extras.aiBytes, CUSTOM_COLORS.IA);
    for (const [language, size] of extras.aiLanguageDeduct) {
      const current = totals.get(language);
      if (!current) continue;
      current.size = Math.max(0, current.size - size);
      if (current.size === 0) totals.delete(language);
      else totals.set(language, current);
    }
  }

  // Se o Linguist trouxe "SQL", consolida em MySQL
  if (totals.has("SQL")) {
    const sql = totals.get("SQL");
    totals.delete("SQL");
    addBytes(totals, "MySQL", sql.size, CUSTOM_COLORS.MySQL);
  }

  return [...totals.values()]
    .filter((item) => item.size > 0 && !EXCLUDED_LANGUAGES.has(item.name))
    .sort((a, b) => b.size - a.size);
}

function toSlices(languages) {
  const total = languages.reduce((sum, item) => sum + item.size, 0);
  if (total === 0) return { total: 0, slices: [] };

  const ia = languages.find((item) => item.name === "IA");
  const withoutIa = languages.filter((item) => item.name !== "IA");
  const topSlots = ia ? Math.max(1, TOP_N - 1) : TOP_N;
  const top = ia
    ? [...withoutIa.slice(0, topSlots), ia].sort((a, b) => b.size - a.size)
    : withoutIa.slice(0, topSlots);
  const rest = withoutIa.slice(topSlots);
  const restSize = rest.reduce((sum, item) => sum + item.size, 0);

  const slices = top.map((item, index) => ({
    name: item.name,
    size: item.size,
    percent: (item.size / total) * 100,
    // Sempre a paleta dos badges — ignora cores do Linguist
    color:
      CUSTOM_COLORS[item.name] ||
      BADGE_PALETTE[index % BADGE_PALETTE.length],
  }));

  if (restSize > 0) {
    slices.push({
      name: "Other",
      size: restSize,
      percent: (restSize / total) * 100,
      color: BADGE_PALETTE[slices.length % BADGE_PALETTE.length],
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
      `<path class="slice" d="${d}" fill="${slice.color}" stroke-width="2" opacity="0">
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
        <text class="fg" x="490" y="${y + 5}" font-size="15" font-weight="600" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${slice.name}</text>
        <text class="muted" x="860" y="${y + 5}" text-anchor="end" font-size="14" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${slice.percent.toFixed(1)}%</text>
        <line class="rule" x1="490" y1="${y + 14}" x2="860" y2="${y + 14}" stroke-width="1" />
      `;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${svgHeight}" viewBox="0 0 ${width} ${svgHeight}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Technology distribution pie chart">
  <style>
    .muted { fill: #57606a; }
    .fg { fill: #24292f; }
    .rule { stroke: #d0d7de; }
    .slice { stroke: rgba(255, 255, 255, 0.65); }
    .halo { fill: rgba(249, 115, 22, 0.10); }
    @media (prefers-color-scheme: dark) {
      .muted { fill: #8b949e; }
      .fg { fill: #e6edf3; }
      .rule { stroke: #30363d; }
      .slice { stroke: rgba(13, 17, 23, 0.65); }
      .halo { fill: rgba(249, 115, 22, 0.14); }
    }
  </style>
  <text x="36" y="42" fill="#ea580c" font-size="22" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Tech distribution</text>
  <text class="muted" x="36" y="66" font-size="13" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">Languages + MySQL/NoSQL/IA by bytes · top ${Math.min(TOP_N, slices.length)}</text>

  <circle class="halo" cx="${cx}" cy="${cy}" r="${outerR + 10}" />
  ${pathEls.join("\n")}
  <text class="fg" x="${cx}" y="${cy - 8}" text-anchor="middle" font-size="28" font-weight="700" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${top ? top.percent.toFixed(0) + "%" : "—"}</text>
  <text class="muted" x="${cx}" y="${cy + 18}" text-anchor="middle" font-size="13" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${top ? top.name : "No data"}</text>

  ${legend}
  <text class="muted" x="36" y="${svgHeight - 18}" font-size="11" font-family="-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">${meta.repoHint}</text>
</svg>
`;
}

function loadFallbackLanguages() {
  const raw = JSON.parse(fs.readFileSync(FALLBACK_PATH, "utf8"));
  return (raw.languages || [])
    .filter((item) => item.size > 0 && !EXCLUDED_LANGUAGES.has(item.name))
    .map((item) => ({
      name: item.name,
      size: item.size,
      color: item.color || CUSTOM_COLORS[item.name] || null,
    }))
    .sort((a, b) => b.size - a.size);
}

async function main() {
  let languages = await fetchTechnologyBytes();
  let source = "live GitHub scan";

  if (languages.length < MIN_LIVE_TECHNOLOGIES) {
    console.warn(
      `Live scan returned only ${languages.length} technolog(y/ies); using fallback from ${FALLBACK_PATH}`,
    );
    console.warn(
      "Tip: set repo secret PROFILE_GITHUB_TOKEN (classic PAT with `repo` scope) to include private owned repos.",
    );
    languages = loadFallbackLanguages();
    source = "fallback cache";
  }

  const { total, slices } = toSlices(languages);
  console.log(
    `Technologies: ${languages.length} · slices: ${slices.length} · totalBytes=${total} · source=${source}`,
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
    repoHint: `Owned repos (HTML excluded) + *.sql as MySQL + queries/nosql as NoSQL + AI APIs as IA · ${languages.length} technologies`,
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
