// setup-claude-guard.mjs — arma o guard PreToolUse do gov-loop no .claude/settings.json
// LOCAL do checkout onde rodar. Merge ADITIVO e idempotente: preserva TUDO que já
// existir no arquivo (ex.: hooks do Lina Space) e só acrescenta a entrada do guard
// se uma idêntica ainda não estiver lá.
//
// Uso: node loop/setup-claude-guard.mjs [caminho-do-settings.json]
// (o argumento opcional existe para teste; default = .claude/settings.json na raiz do repo)

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const settingsPath = process.argv[2] ?? join(repoRoot, ".claude", "settings.json");

const GUARD_COMMAND = "$CLAUDE_PROJECT_DIR/loop/hooks/guard-protected-paths.sh";
const GUARD_MATCHER = "Edit|Write|Bash";
const guardEntry = {
  matcher: GUARD_MATCHER,
  hooks: [{ type: "command", command: GUARD_COMMAND }],
};

let settings = {};
if (existsSync(settingsPath)) {
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch (err) {
    console.error(`setup-claude-guard: ${settingsPath} existe mas não é JSON válido: ${err.message}`);
    console.error("Nada foi alterado — conserte o arquivo antes de re-rodar.");
    process.exit(1);
  }
}

settings.hooks ??= {};
settings.hooks.PreToolUse ??= [];
if (!Array.isArray(settings.hooks.PreToolUse)) {
  console.error("setup-claude-guard: hooks.PreToolUse existe mas não é array — nada foi alterado.");
  process.exit(1);
}

const alreadyArmed = settings.hooks.PreToolUse.some(
  (entry) =>
    entry?.matcher === GUARD_MATCHER &&
    Array.isArray(entry?.hooks) &&
    entry.hooks.some((h) => h?.type === "command" && h?.command === GUARD_COMMAND)
);

if (alreadyArmed) {
  console.log(`ok: guard já armado em ${settingsPath} (nada a fazer).`);
  process.exit(0);
}

settings.hooks.PreToolUse.push(guardEntry);
mkdirSync(dirname(settingsPath), { recursive: true });
writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
console.log(`ok: guard PreToolUse (${GUARD_MATCHER} → guard-protected-paths.sh) adicionado em ${settingsPath}.`);
