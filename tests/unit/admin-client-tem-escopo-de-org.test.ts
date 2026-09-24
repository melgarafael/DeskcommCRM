import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * SERVICE ROLE SEMPRE COM ESCOPO DE ORGANIZAÇÃO.
 *
 * ─── Por que um guarda, e não uma auditoria anual ───────────────────────────
 *
 * `createAdminClient()` (`lib/supabase/admin.ts`) bypasa o RLS. Cada rota que o
 * usa precisa filtrar `organization_id` de fonte confiável (cookie/JWT validado,
 * webhook secret, path token — nunca do body). Sem gate, um PR novo pode
 * esquecer o filtro e vazar dados entre tenants em silêncio: nenhum teste
 * quebra, nenhum log acusa, e quem descobre é o cliente errado lendo o dado
 * errado.
 *
 * ─── O que cada parte prova, e o que NÃO prova ──────────────────────────────
 *
 * Este teste prova DECLARAÇÃO, não fluxo de dados: que toda rota com service
 * role ou filtra `organization_id` direto, ou entrega o orgId a um helper, ou
 * está na allowlist com o motivo escrito. Ele NÃO prova que o helper filtra de
 * verdade — isso é invariante de cada helper, coberta pelos testes dele (a
 * auditoria de 2026-09-23 verificou os principais: `carrega` em
 * `lib/followup/intervencao.ts`, `lerChamado` em `lib/escalacao/chamados.ts`,
 * `findPartnerSession` em `lib/channels/connect.ts`,
 * `openSharedContactConversation` em `lib/messaging/`).
 *
 * Tokens fracos (`orgId` num comentário) passam — o teste não lê AST de fluxo.
 * O que ele fecha é a porta mais comum: rota nova com admin client e nenhuma
 * menção a organização em lugar nenhum.
 *
 * ─── Os três níveis ─────────────────────────────────────────────────────────
 *
 * Nível A (filtro direto): o arquivo menciona `organization_id` — `.eq()`,
 * `.match()`, payload de insert/update, ou SQL com `$n`.
 * Nível B (delegado): o arquivo entrega `org.orgId`/`orgId`/`organizationId` a
 * um helper — o padrão da casa; o helper é quem filtra.
 * Nível C (exceção): `ROTAS_ADMIN_SEM_ORG_DE_PROPOSITO` — sem dado de tenant
 * (tabela de plataforma, cron com secret que itera as orgs, rota pública com
 * slug). Cada entrada carrega o motivo; a lista SÓ ENCOLHE.
 */

const RAIZ = join(__dirname, "..", "..");
const DIR_API = join(RAIZ, "app", "api");

/**
 * Rotas que usam service role SEM dado de tenant — uma a uma, com o motivo
 * escrito. Entrada nova aqui precisa do mesmo argumento: "não há dado de
 * tenant nesta rota", nunca "não deu tempo de escopar".
 */
const ROTAS_ADMIN_SEM_ORG_DE_PROPOSITO: { arquivo: string; motivo: string }[] = [
  {
    arquivo: "app/api/mcp/route.ts",
    motivo: "lê só platform_config (tabela global da instalação) via modulosLigados; nenhum dado de tenant",
  },
  {
    arquivo: "app/api/v1/mcp/tools/route.ts",
    motivo: "idem: só platform_config, nenhum dado de tenant",
  },
  {
    arquivo: "app/api/v1/admin/platform-admins/route.ts",
    motivo: "tabela platform_admins, rota de platform admin (requirePlatformAdmin) — o escopo É a plataforma",
  },
  {
    arquivo: "app/api/v1/admin/tenants/route.ts",
    motivo: "gestão de tenants pelo platform admin; cross-org por desenho, com requirePlatformAdmin",
  },
  {
    arquivo: "app/api/v1/cron/campaign-worker/route.ts",
    motivo: "cron com autorizaCron (fail-closed); o worker itera as organizações internamente",
  },
  {
    arquivo: "app/api/v1/cron/prospecting/route.ts",
    motivo: "idem: cron autenticado, worker itera as orgs",
  },
  {
    arquivo: "app/api/v1/cron/event-log-drain/route.ts",
    motivo: "idem: dreno do event_log global",
  },
  {
    arquivo: "app/api/v1/cron/sync-model-catalog/route.ts",
    motivo: "idem: lê ai_models, catálogo global de modelos",
  },
  {
    arquivo: "app/api/v1/cron/webhook-log-retention/route.ts",
    motivo: "idem: retenção de logs global",
  },
  {
    arquivo: "app/api/v1/system/update/route.ts",
    motivo: "tabelas system_version/system_update_runs — nível instalação, não tenant",
  },
  {
    arquivo: "app/api/v1/system/agent/route.ts",
    motivo: "idem: telemetria de update da instalação",
  },
  {
    arquivo: "app/api/v1/system/version/route.ts",
    motivo: "idem: versão da instalação",
  },
  {
    arquivo: "app/api/v1/anuncios/meta/[org]/route.ts",
    motivo:
      "rota pública de captura: a org vem do slug público (lookup .eq(\"slug\")), com rate limit por IP; sem sessão de usuário para escopar",
  },
  {
    arquivo: "app/api/v1/anuncios/google/[org]/route.ts",
    motivo: "idem, para gclid do Google Ads",
  },
];

function coletarRotas(dir: string): string[] {
  const achados: string[] = [];
  for (const entrada of readdirSync(dir)) {
    const caminho = join(dir, entrada);
    if (statSync(caminho).isDirectory()) {
      achados.push(...coletarRotas(caminho));
    } else if (entrada === "route.ts") {
      achados.push(caminho);
    }
  }
  return achados;
}

function usaAdminClient(conteudo: string): boolean {
  return conteudo.includes("createAdminClient") || conteudo.includes("supabase/admin");
}

/**
 * Nível A: filtro direto de organization_id. Nível B: orgId entregue a helper.
 * Intencionalmente textual — ver o cabeçalho sobre o que isto prova.
 */
function temEvidenciaDeEscopo(conteudo: string): boolean {
  if (conteudo.includes("organization_id")) return true;
  if (/\borg\.orgId\b|\bactiveOrg\.orgId\b|\bauth\.org\.orgId\b/.test(conteudo)) return true;
  return /\borgId\b|\borganizationId\b/.test(conteudo);
}

function caminhoRelativo(absoluto: string): string {
  return relative(RAIZ, absoluto).split(sep).join("/");
}

describe("service role sempre com escopo de organização", () => {
  const rotasComAdmin = coletarRotas(DIR_API).filter((arquivo) =>
    usaAdminClient(readFileSync(arquivo, "utf8")),
  );

  it("toda rota com admin client declara seu escopo (ou está na allowlist)", () => {
    const allowlist = new Set(ROTAS_ADMIN_SEM_ORG_DE_PROPOSITO.map((e) => e.arquivo));
    const semEscopo = rotasComAdmin
      .map(caminhoRelativo)
      .filter((rel) => !allowlist.has(rel) && !temEvidenciaDeEscopo(readFileSync(join(RAIZ, rel), "utf8")));
    expect(semEscopo).toEqual([]);
  });

  it("a allowlist não tem entrada podre (arquivo que já não usa admin)", () => {
    for (const { arquivo } of ROTAS_ADMIN_SEM_ORG_DE_PROPOSITO) {
      const conteudo = readFileSync(join(RAIZ, arquivo), "utf8");
      expect(usaAdminClient(conteudo)).toBe(true);
    }
  });

  it("toda entrada da allowlist existe no disco", () => {
    for (const { arquivo } of ROTAS_ADMIN_SEM_ORG_DE_PROPOSITO) {
      expect(() => statSync(join(RAIZ, arquivo))).not.toThrow();
    }
  });
});
