#!/usr/bin/env node
/**
 * Bancada de prova das skills embutidas — "a skill certa acionou sozinha?"
 *
 * Roda UMA pergunta de leigo num CLI de IA sem interface (claude | codex |
 * opencode), dentro de um diretório (um clone limpo é o cenário fiel), e
 * resume o que aconteceu: ferramentas usadas, leituras de SKILL.md, turnos,
 * custo/uso, duração e a resposta. O bruto (o JSON de eventos do CLI) vai para
 * `--out`; o resumo sai em JSON no stdout.
 *
 * Foi assim que se mediu o "antes" (origin/main sem os guias: 30 comandos,
 * 200 s, US$ 3,08 para "por onde eu começo a instalar?") e o "depois". Um
 * teste automatizado não prova acionamento; só uma sessão real prova.
 *
 *   node scripts/skills-embutidas/provar.mjs --cli claude|codex|opencode|agy --dir /caminho/do/clone \
 *     --prompt "Comprei uma VPS e quero instalar o CRM. Por onde começo?" \
 *     --out /tmp/prova.jsonl [--max-turns 12] [--env CODEX_HOME=/tmp/codex-limpo] [--env GH_TOKEN=x]
 *
 * Antigravity roda por `agy --print` (o CLI que o app instala em ~/.local/bin). O Cursor
 * tem o `agent` (curl https://cursor.com/install | bash), que exige `agent login`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const args = process.argv.slice(2);
const opt = { env: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--env") opt.env.push(args[++i]);
  else if (a.startsWith("--")) opt[a.slice(2)] = args[++i];
}
if (!opt.cli || !opt.dir || !opt.prompt || !opt.out) {
  console.error("uso: --cli claude|codex|opencode --dir D --prompt P --out F [--max-turns N] [--env K=V]");
  process.exit(2);
}
const env = { ...process.env };
for (const kv of opt.env) { const [k, ...v] = kv.split("="); env[k] = v.join("="); }

const cmd = {
  claude: ["claude", ["-p", opt.prompt, "--output-format", "stream-json", "--verbose", "--max-turns", String(opt["max-turns"] || 12), "--permission-mode", "plan"]],
  codex: ["codex", ["exec", "--json", "--ephemeral", "-s", "read-only", opt.prompt]],
  opencode: ["opencode", ["run", "--format", "json", "--dir", opt.dir, opt.prompt]],
  // --dangerously-skip-permissions: em modo sem interface ninguém clica "permitir", e o
  // primeiro run_command (que uma doutrina global do usuário pode pedir) encerra a corrida
  // sem resposta. Auto-aprovar é o substituto fiel do clique; o clone de prova é descartável.
  agy: ["agy", ["--print", opt.prompt, "--output-format", "stream-json", "--mode", "plan", "--print-timeout", "10m", "--dangerously-skip-permissions"]],
}[opt.cli];
if (!cmd) { console.error("cli desconhecido"); process.exit(2); }

const t0 = Date.now();
const r = spawnSync(cmd[0], cmd[1], { cwd: opt.dir, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, input: "" });
const dur = Date.now() - t0;
fs.writeFileSync(opt.out, r.stdout || "");
if (r.stderr) fs.writeFileSync(opt.out + ".err", r.stderr);

const linhas = (r.stdout || "").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const tools = []; let final = ""; let turns = 0; let custo = null; let uso = null;
const ehSkill = (s) => /SKILL\.md|\.claude\/skills|\.agents\/skills|\.codex\/skills|\.opencode\/skill|\.cursor\/(rules|skills)|\.agent\/(skills|rules|workflows)|deskcomm-[a-z-]+/i.test(s || "");

if (opt.cli === "claude") {
  for (const m of linhas) {
    if (m.type === "assistant" && m.message && Array.isArray(m.message.content)) {
      for (const c of m.message.content) if (c.type === "tool_use") tools.push({ nome: c.name, alvo: String(c.input?.skill || c.input?.file_path || c.input?.pattern || c.input?.command || c.input?.description || "").slice(0, 160) });
    }
    if (m.type === "result") { final = String(m.result || ""); turns = m.num_turns; custo = m.total_cost_usd; uso = m.usage; }
  }
} else if (opt.cli === "codex") {
  for (const m of linhas) {
    if (m.type === "item.completed" && m.item) {
      const it = m.item;
      if (it.type === "command_execution") tools.push({ nome: "command", alvo: String(it.command || "").slice(0, 160) });
      else if (it.type === "file_change") tools.push({ nome: "file_change", alvo: JSON.stringify(it.changes || it).slice(0, 160) });
      else if (it.type === "mcp_tool_call") tools.push({ nome: "mcp:" + (it.server || "") + "/" + (it.tool || ""), alvo: JSON.stringify(it.arguments || {}).slice(0, 160) });
      else if (it.type === "web_search") tools.push({ nome: "web_search", alvo: String(it.query || "").slice(0, 160) });
      else if (it.type === "agent_message") final = String(it.text || "");
      else if (it.type === "error") tools.push({ nome: "ERRO", alvo: String(it.message || "").slice(0, 200) });
    }
    if (m.type === "turn.completed") { turns++; uso = m.usage; }
  }
} else if (opt.cli === "agy") {
  for (const m of linhas) {
    const su = m.step_update;
    if (m.event === "step_update" && su && su.step_type === "tool" && su.state === "ACTIVE") {
      tools.push({ nome: String(su.tool_name || "tool"), alvo: JSON.stringify(su.tool_info?.parameters || {}).slice(0, 160) });
    }
    if (m.event === "result" && m.result) { final = String(m.result.response || ""); turns = m.result.num_turns; uso = m.result.usage; }
  }
} else if (opt.cli === "opencode") {
  for (const m of linhas) {
    const p = m.part || {};
    if (m.type === "tool" || p.type === "tool") tools.push({ nome: String(p.tool || m.tool || "tool"), alvo: JSON.stringify(p.state?.input || p.input || {}).slice(0, 160) });
    if ((m.type === "text" || p.type === "text") && p.text) final += p.text;
    if (m.type === "step_finish" || p.type === "step-finish") { turns++; if (p.tokens) uso = p.tokens; if (p.cost != null) custo = (custo || 0) + p.cost; }
  }
}

const skillReads = tools.filter((t) => ehSkill(t.alvo) || t.nome === "Skill" || /skill/i.test(t.nome)).map((t) => `${t.nome} → ${t.alvo}`);
console.info(JSON.stringify({ cli: opt.cli, dir: opt.dir, exit: r.status, duracao_ms: dur, turnos: turns, ferramentas: tools.length, leituras_de_skill: skillReads, custo_usd: custo, uso, resposta: final.slice(0, 1500), ferramentas_lista: tools.map((t) => `${t.nome} → ${t.alvo}`) }, null, 1));
