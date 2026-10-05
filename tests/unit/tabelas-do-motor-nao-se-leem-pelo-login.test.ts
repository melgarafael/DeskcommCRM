import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TABELAS DO MOTOR SÓ SE LEEM PELO SERVIDOR.
 *
 * Na instalação por VPS (só o baseline), estas tabelas são server-only: o papel
 * `authenticated` não tem privilégio nem policy de leitura nelas. Medido em
 * produção em 2026-10-02: `llm_calls` com 548 linhas e a tela Execuções de IA
 * dizendo "0 execuções", porque a rota lia com o client de SESSÃO.
 *
 * Duas regras, para toda rota em `app/api`:
 *  1. o receptor de `.from(<tabela do motor>)` é `admin` ou `createAdminClient()`;
 *  2. em rota de usuário (requireRole/loadAuthUser/requireAuth), leitura,
 *     update ou delete por esse client filtra `organization_id` — o client de
 *     serviço ignora a RLS, então o filtro é a única cerca de tenancy.
 */
const SO_DO_SERVIDOR = [
  "llm_calls",
  "agent_inbox_items",
  "job_queue",
  "lead_checkpoints",
  "lead_notes",
  "lead_state",
  "before_send_traces",
  "channel_knobs",
  "cron_jobs",
  "flywheel_distiller_proposals",
] as const;

const RAIZ = join(__dirname, "../..");
const API = join(RAIZ, "app/api");

function arquivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivos(caminho);
    return caminho.endsWith(".ts") && !caminho.includes(".test.") ? [caminho] : [];
  });
}

const CONSULTA = new RegExp(`\\.from\\(["'](${SO_DO_SERVIDOR.join("|")})["']\\)`, "g");
const RECEPTOR_DO_SERVIDOR = /(createAdminClient\(\)|\badmin)\s*$/;
// `const db = createAdminClient()` também é o client de serviço (rota de roteamento do Jev).
const NOME_DO_ADMIN = /\b(?:const|let)\s+(\w+)\s*=\s*createAdminClient\(\)/g;

function receptorDoServidor(fonte: string): RegExp {
  const nomes = [...fonte.matchAll(NOME_DO_ADMIN)].map((m) => m[1]!).filter((n) => n !== "admin");
  if (nomes.length === 0) return RECEPTOR_DO_SERVIDOR;
  return new RegExp(`(createAdminClient\\(\\)|\\b(?:admin|${nomes.join("|")}))\\s*$`);
}

const ROTA_DE_USUARIO =/requireRole\(|loadAuthUser\(|requireAuth\(/;

interface Achado {
  arquivo: string;
  linha: number;
  tabela: string;
}

function varrer(): { pelaSessao: Achado[]; semOrganizacao: Achado[]; total: number } {
  const pelaSessao: Achado[] = [];
  const semOrganizacao: Achado[] = [];
  let total = 0;
  for (const caminho of arquivos(API)) {
    const fonte = readFileSync(caminho, "utf8");
    const deUsuario = ROTA_DE_USUARIO.test(fonte);
    const receptor = receptorDoServidor(fonte);
    for (const m of fonte.matchAll(CONSULTA)) {
      total++;
      const inicio = m.index ?? 0;
      const achado: Achado = {
        arquivo: relative(RAIZ, caminho).replace(/\\/g, "/"),
        linha: fonte.slice(0, inicio).split("\n").length,
        tabela: m[1]!,
      };
      const antes = fonte.slice(Math.max(0, inicio - 200), inicio);
      if (!receptor.test(antes)) {
        pelaSessao.push(achado);
        continue;
      }
      // A cadeia vai até o `;` ou o próximo `.from(` (Promise.all de várias consultas).
      const fimPontoVirgula = fonte.indexOf(";", inicio);
      const proximoFrom = fonte.indexOf(".from(", inicio + 6);
      const fim = Math.min(
        fimPontoVirgula < 0 ? fonte.length : fimPontoVirgula,
        proximoFrom < 0 ? fonte.length : proximoFrom,
        inicio + 800,
      );
      const cadeia = fonte.slice(inicio, fim);
      const lêOuMuda = /\.(select|update|delete)\(/.test(cadeia);
      if (deUsuario && lêOuMuda && !cadeia.includes("organization_id")) semOrganizacao.push(achado);
    }
  }
  return { pelaSessao, semOrganizacao, total };
}

describe("tabelas do motor só se leem pelo servidor", () => {
  const { pelaSessao, semOrganizacao, total } = varrer();

  it("a varredura encontra as tabelas (guarda de vacuidade)", () => {
    // Medido na v1.69.0: 51 consultas. Se cair a quase zero, o regex quebrou.
    expect(total).toBeGreaterThan(40);
  });

  it("nenhuma rota lê tabela do motor com o client de sessão", () => {
    expect(
      pelaSessao.map((a) => `${a.arquivo}:${a.linha} ${a.tabela}`),
      "na VPS, `authenticated` não tem leitura nessas tabelas — a consulta volta vazia. " +
        "Use `createAdminClient()` (ou a variável `admin`) e mantenha o filtro de organization_id.",
    ).toEqual([]);
  });

  it("toda leitura pelo serviço em rota de usuário filtra organization_id", () => {
    expect(
      semOrganizacao.map((a) => `${a.arquivo}:${a.linha} ${a.tabela}`),
      "o client de serviço ignora a RLS: sem `organization_id`, a rota lê dados de outra empresa",
    ).toEqual([]);
  });
});
