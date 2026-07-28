#!/usr/bin/env node
/**
 * Mantém os bloquinhos de contribuição sempre visíveis no SVG do Pac-Man.
 * A action anima fill de verde → cinza quando o Pac-Man "come"; este script
 * remove essa animação e fixa a cor original da contribuição.
 */

import fs from "node:fs";
import path from "node:path";

const EMPTY_FILLS = new Set([
  "#ebedf0", // github light empty
  "#161b22", // github dark empty
]);

const files = [
  "pacman-contribution-graph.svg",
  "pacman-contribution-graph-dark.svg",
];

function keepContributions(svg) {
  return svg.replace(
    /<rect(\s+id="c-\d+-\d+"[^>]*)>([\s\S]*?)<\/rect>/g,
    (full, attrs, inner) => {
      const animateMatch = inner.match(
        /<animate\b[^>]*attributeName="fill"[^>]*values="([^"]+)"[^>]*\/?>/,
      );
      if (!animateMatch) return full;

      const colors = animateMatch[1].split(";").map((c) => c.trim().toLowerCase());
      const contribution = colors.find((c) => c && !EMPTY_FILLS.has(c));
      if (!contribution) return full;

      // Remove animações de fill e fixa a cor da contribuição
      const cleanedInner = inner.replace(
        /<animate\b[^>]*attributeName="fill"[^>]*\/?>\s*/g,
        "",
      );
      let nextAttrs = attrs;
      if (/\sfill="/.test(nextAttrs)) {
        nextAttrs = nextAttrs.replace(/\sfill="[^"]*"/, ` fill="${contribution}"`);
      } else {
        nextAttrs += ` fill="${contribution}"`;
      }
      return `<rect${nextAttrs}>${cleanedInner}</rect>`;
    },
  );
}

const distDir = path.join(process.cwd(), "dist");
for (const file of files) {
  const filePath = path.join(distDir, file);
  if (!fs.existsSync(filePath)) {
    console.warn(`Skip missing ${file}`);
    continue;
  }
  const before = fs.readFileSync(filePath, "utf8");
  const after = keepContributions(before);
  fs.writeFileSync(filePath, after, "utf8");
  const removed = (before.match(/attributeName="fill"/g) || []).length -
    (after.match(/attributeName="fill"/g) || []).length;
  console.log(`Updated ${file}: removed ${removed} fill animations`);
}
