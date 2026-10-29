/**
 * As server actions que autorizam por `podeAdministrarEmpresa` cobram, logo
 * depois do papel, a prova do segundo fator (`mfaEmDivida`) — a mesma régua de
 * `updateMarcaDaOrganizacao` e `apagarDadosOperacionaisDaOrganizacao`.
 *
 * `podeAdministrarEmpresa` deixa passar o admin da plataforma em qualquer
 * organização onde ele é membro, e `mfaEmDivida` é quem distingue: para quem age
 * pelo poder de plataforma ela exige o código provado nesta sessão. Server
 * action é endpoint público — a tela não é o portão.
 *
 * Dois blocos: (1) cada action, chamada como admin da plataforma com a sessão
 * devendo o código, devolve `mfa_required` sem abrir client de banco — e, com a
 * sessão em dia, passa do portão (o controle que prova que é a guarda quem
 * recusa); (2) a varredura de `app/actions/**`, para a próxima action que
 * chamar `podeAdministrarEmpresa(` não nascer sem a régua.
 */
import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { arquivosDeCodigo, caminhoRelativo } from "./helpers/varrer-codigo";

const ORG = "22222222-2222-4222-8222-222222222222";

const h = vi.hoisted(() => ({ emDivida: true, clientes: 0 }));

/** Abrir client de banco é o primeiro efeito de toda action depois do portão. */
const PASSOU = "passou-do-portao";
function clienteQueAcusa(): never {
  h.clientes += 1;
  throw new Error(PASSOU);
}

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error(PASSOU);
  },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/impersonate/support", () => ({
  supportWriteError: () => null,
  authenticatedSessionId: async () => "sessao",
}));
vi.mock("@/lib/auth/server", () => ({
  // Admin da plataforma com scope `full`, e só `agent` na organização ativa:
  // quem o autoriza é o atalho de plataforma de `podeAdministrarEmpresa` (real).
  loadAuthUser: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    is_platform_admin: true,
    platform_admin_scope: "full",
    support: null,
    idioma: "pt-BR",
  }),
  resolveActiveOrg: async () => ({ orgId: ORG, role: "agent" }),
  mfaEmDivida: async () => h.emDivida,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: clienteQueAcusa }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => clienteQueAcusa() }));
// connectNuvemshop: sem configuração, devolveria `not_configured` antes do redirect.
vi.mock("@/lib/nuvemshop/config", () => ({ getConfig: () => ({ appId: "1" }) }));
vi.mock("@/lib/nuvemshop/state", () => ({ issueState: () => "estado" }));
vi.mock("@/lib/nuvemshop/oauth", () => ({ buildAuthorizeUrl: () => "https://exemplo.test" }));

import { connectNuvemshop } from "@/app/actions/integrations/connectNuvemshop";
import { disconnectNuvemshop } from "@/app/actions/integrations/disconnectNuvemshop";
import {
  atualizarBloqueioAteAssumir,
  atualizarInterfaceDaEmpresa,
} from "@/app/actions/settings/atualizarInterfaceDaEmpresa";
import { atualizarLembreteDeCasoParado } from "@/app/actions/settings/atualizarLembreteDeCasoParado";
import { conectarLoginCodex, desconectarLoginCodexAgora } from "@/app/actions/settings/conectarLoginCodex";
import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import { updateTenant } from "@/app/actions/settings/updateTenant";

const ACOES: Array<[string, () => Promise<{ ok: boolean; error?: string }>]> = [
  ["connectNuvemshop", () => connectNuvemshop()],
  ["disconnectNuvemshop", () => disconnectNuvemshop()],
  ["atualizarInterfaceDaEmpresa", () => atualizarInterfaceDaEmpresa({ preset: "completa" })],
  ["atualizarBloqueioAteAssumir", () => atualizarBloqueioAteAssumir(true)],
  ["atualizarLembreteDeCasoParado", () => atualizarLembreteDeCasoParado({ ligado: true, intervaloHoras: 24, teto: 3 })],
  ["conectarLoginCodex", () => conectarLoginCodex({ codigo: "x", codeVerifier: "v".repeat(43) })],
  ["desconectarLoginCodexAgora", () => desconectarLoginCodexAgora()],
  ["updatePipelineConfig", () => updatePipelineConfig("ffffffff-0000-4000-8000-00000000000f", {})],
  [
    "updateTenant",
    () =>
      updateTenant({
        display_name: "Loja",
        legal_name: "Loja SA",
        cnpj: null,
        timezone: "America/Sao_Paulo",
        locale: "pt-BR",
        currency: "BRL",
        media_retention_days: 365,
        media_retention_enforced: true,
        dpo_email: null,
        privacy_policy_url: null,
      } as never),
  ],
];

/** O código devolvido, ou `PASSOU` quando a action chegou ao primeiro efeito. */
async function desfecho(acao: () => Promise<{ ok: boolean; error?: string }>): Promise<string> {
  try {
    const r = await acao();
    return r.ok ? "ok" : String(r.error);
  } catch (e) {
    return e instanceof Error && e.message === PASSOU ? PASSOU : `lançou: ${String(e)}`;
  }
}

beforeEach(() => {
  h.clientes = 0;
});

describe("admin da plataforma devendo o código nesta sessão", () => {
  it.each(ACOES)("%s devolve mfa_required sem abrir client de banco", async (_nome, acao) => {
    h.emDivida = true;
    expect(await desfecho(acao)).toBe("mfa_required");
    expect(h.clientes).toBe(0);
  });

  // Passar do portão: ou chega ao primeiro client de banco, ou para numa
  // validação que vem DEPOIS dele (o código colado do Codex, por exemplo).
  it.each(ACOES)("CONTROLE: %s, com a sessão em dia, passa do portão", async (_nome, acao) => {
    h.emDivida = false;
    const r = await desfecho(acao);
    expect(r).not.toBe("mfa_required");
    expect(r).not.toMatch(/^lançou|forbidden|unauthenticated|auth_required/);
  });
});

describe("varredura: toda action que autoriza por podeAdministrarEmpresa cobra mfaEmDivida", () => {
  const acoes = arquivosDeCodigo(["app/actions"]);

  it("a varredura enxerga as actions (controle positivo)", () => {
    const comAtalho = acoes.filter((f) => readFileSync(f, "utf8").includes("podeAdministrarEmpresa("));
    expect(comAtalho.length).toBeGreaterThanOrEqual(15);
  });

  it("nenhuma action chama podeAdministrarEmpresa( sem chamar mfaEmDivida(", () => {
    const semRegua = acoes
      .filter((f) => {
        const codigo = readFileSync(f, "utf8");
        return codigo.includes("podeAdministrarEmpresa(") && !codigo.includes("mfaEmDivida(");
      })
      .map(caminhoRelativo);
    expect(semRegua).toEqual([]);
  });
});
