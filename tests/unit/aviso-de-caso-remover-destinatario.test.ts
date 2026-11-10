/**
 * DELETE /api/v1/ai/cases/alerta — a REMOÇÃO do destinatário dos avisos (issue
 * #3338).
 *
 * ## O que este arquivo prova
 *
 * Três coisas que a tela e a regra, medidas separadamente, não provam juntas:
 *
 *   1. que a remoção APAGA a configuração de verdade — sem um E.164 fantasma e
 *      sem o `destino_jid`, que é a OUTRA porta do mesmo corte;
 *   2. que, depois dela, aquele número deixa de ser tratado como interno e a
 *      ingestão para de cortar a mensagem. A regra medida é a de
 *      `lib/escalacao/numero-interno-de-aviso.ts` (a dona dela), com o memo de
 *      30 s no meio: é ele que continuaria respondendo "é interno" se a rota
 *      esquecesse de esvaziá-lo depois de gravar;
 *   3. que remover NÃO é pausar. A decisão de pausa continua sendo a do usuário,
 *      e um número AINDA cadastrado segue interno com os avisos desligados — o
 *      comportamento que a issue pede, por escrito, para não mudar.
 *
 * ## O banco é um dublê com ESTADO
 *
 * As leituras da regra e o `DELETE` da rota olham o MESMO array de linhas. Sem
 * isso, "removi" e "a ingestão parou de cortar" seriam duas afirmações sobre
 * objetos diferentes — e as duas ficariam verdes sobre um banco que não perdeu
 * nada.
 *
 * ## O que este arquivo NÃO prova
 *
 * Que a guarda de suporte está no handler: quem a cobra por TEXTO é
 * `tests/unit/suporte-cobertura-de-efeitos.test.ts`. Aqui ela aparece uma vez
 * por comportamento, com a função mockada — apagar a chamada deixaria verde se
 * este fosse o único instrumento.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { lerEstadoDaTelaDeAviso } from "@/lib/escalacao/tela-do-aviso";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: vi.fn(async () => false) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/escalacao/tela-do-aviso", () => ({ lerEstadoDaTelaDeAviso: vi.fn() }));

const { DELETE } = await import("@/app/api/v1/ai/cases/alerta/route");
const { ehNumeroInternoDeAviso, limparCacheDoNumeroInterno } =
  await import("@/lib/escalacao/numero-interno-de-aviso");

const ORG = "11111111-1111-4111-8111-111111111111";
const ORG_VIZINHA = "99999999-9999-4999-8999-999999999999";
const USER = "22222222-2222-4222-8222-222222222222";
const CANAL = "33333333-3333-4333-8333-333333333333";
/** Número de mentira, com os assinantes zerados: não é de ninguém. */
const TELEFONE = "+5511900000000";
const JID = "5511900000000@s.whatsapp.net";
const TELEFONE_VIZINHO = "+5511900000009";
const JID_VIZINHO = "5511900000009@s.whatsapp.net";

const ESTADO_SEM_CONFIG = {
  config: null,
  conexoes: [],
  avisos: [],
  pode_ligar: false,
  entregas: [],
  laco: {
    comAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
    semAviso: { casos: 0, respondidos: 0, medianaMinutos: null },
    medianaAteOAvisoMinutos: null,
  },
};

interface LinhaDaConfig {
  organization_id: string;
  channel_session_id: string | null;
  telefone_destino: string;
  destino_jid: string | null;
  ligado: boolean;
  resposta_whatsapp_habilitada: boolean;
}

function linha(patch: Partial<LinhaDaConfig> = {}): LinhaDaConfig {
  return {
    organization_id: ORG,
    channel_session_id: CANAL,
    telefone_destino: TELEFONE,
    destino_jid: JID,
    ligado: true,
    resposta_whatsapp_habilitada: false,
    ...patch,
  };
}

/** Toda operação que o dublê viu, na ordem — inclusive as que não deveriam existir. */
const operacoes: string[] = [];
let linhas: LinhaDaConfig[] = [];

type Corrente = {
  select: () => Corrente;
  eq: (coluna: string, valor: unknown) => Corrente;
  delete: () => Corrente;
  update: () => Corrente;
  maybeSingle: () => Promise<{ data: LinhaDaConfig | null; error: null }>;
  then: (resolve: (valor: unknown) => unknown) => Promise<unknown>;
};

/** A tabela que o dublê conhece. `null` = sem linha nenhuma (as outras da regra). */
function linhasDe(tabela: string): LinhaDaConfig[] | null {
  return tabela === "config_aviso_de_caso" ? linhas : null;
}

function bancoFalso() {
  return {
    from(tabela: string): Corrente {
      const filtros: Record<string, unknown> = {};
      let removendo = false;
      const corrente: Corrente = {
        select: () => corrente,
        eq: (coluna: string, valor: unknown) => {
          filtros[coluna] = valor;
          operacoes.push(`eq:${coluna}=${String(valor)}`);
          return corrente;
        },
        delete: () => {
          removendo = true;
          operacoes.push(`delete:${tabela}`);
          return corrente;
        },
        update: () => {
          operacoes.push(`update:${tabela}`);
          return corrente;
        },
        maybeSingle: async () => {
          operacoes.push(`maybeSingle:${tabela}`);
          const alvo = linhasDe(tabela);
          const achada = alvo?.find((l) => l.organization_id === filtros.organization_id) ?? null;
          return { data: achada, error: null };
        },
        then: (resolve: (valor: unknown) => unknown) => {
          const alvo = linhasDe(tabela);
          if (!alvo) return Promise.resolve({ data: null, error: null }).then(resolve);
          const casam = (l: LinhaDaConfig) =>
            Object.entries(filtros).every(
              ([coluna, valor]) => (l as unknown as Record<string, unknown>)[coluna] === valor,
            );
          const casadas = alvo.filter(casam);
          if (removendo) {
            // O efeito de verdade: a linha sai do array que a REGRA vai ler.
            linhas = linhas.filter((l) => !casadas.includes(l));
            return Promise.resolve({ data: casadas, error: null }).then(resolve);
          }
          return Promise.resolve({ data: casadas, error: null }).then(resolve);
        },
      };
      return corrente;
    },
  };
}

function sessao(role: Role = "admin") {
  const user: AuthUser = {
    id: USER,
    email: "a@example.com",
    full_name: null,
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) => {
    if (ROLE_RANK[role] >= ROLE_RANK[min]) {
      return { ok: true, user, org: { orgId: ORG, name: "Org", role } };
    }
    return { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) };
  });
}

const pedido = () =>
  new NextRequest("http://localhost/api/v1/ai/cases/alerta", { method: "DELETE" });

/** O que o ingestor pergunta: este chat é o número interno de avisos? */
const chatDaEquipe = { kind: "phone", phone: TELEFONE, lid: null };

/** A organização que ficou, depois da remoção. */
const daVizinha = () => linhas.filter((l) => l.organization_id === ORG_VIZINHA);

beforeEach(() => {
  vi.clearAllMocks();
  // O memo da regra é do MÓDULO: sem esvaziá-lo entre os casos, o primeiro
  // decidiria o resultado dos seguintes.
  limparCacheDoNumeroInterno();
  operacoes.length = 0;
  linhas = [
    linha(),
    linha({
      organization_id: ORG_VIZINHA,
      telefone_destino: TELEFONE_VIZINHO,
      destino_jid: JID_VIZINHO,
    }),
  ];
  sessao();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(mfaEmDivida).mockResolvedValue(false);
  vi.mocked(lerEstadoDaTelaDeAviso).mockResolvedValue(ESTADO_SEM_CONFIG as never);
  vi.mocked(createClient).mockResolvedValue(bancoFalso() as never);
  vi.mocked(createAdminClient).mockReturnValue(bancoFalso() as never);
});

describe("DELETE — as guardas antes do efeito", () => {
  it("exige admin: quem não administra não remove a configuração de ninguém", async () => {
    sessao("manager");
    const r = await DELETE(pedido());
    expect(r.status).toBe(403);
    expect(linhas).toHaveLength(2);
    expect(operacoes.some((o) => o.startsWith("delete:"))).toBe(false);
  });

  it("a guarda de suporte vem PRIMEIRO: acompanhamento somente-leitura não remove", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(
      fail("support_read_only", "Somente leitura.", 403, {}),
    );
    const r = await DELETE(pedido());
    expect(r.status).toBe(403);
    expect(linhas).toHaveLength(2);
    expect(operacoes.some((o) => o.startsWith("delete:"))).toBe(false);
  });

  it("cobra a MFA na MESMA régua do RPC — e sem prova não há remoção", async () => {
    vi.mocked(mfaEmDivida).mockResolvedValue(true);
    const r = await DELETE(pedido());
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("mfa_required");
    expect(linhas).toHaveLength(2);
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("DELETE — o efeito: a configuração sai e o número volta", () => {
  it("apaga a configuração DA organização, e só a dela: nem telefone nem JID fantasma", async () => {
    const r = await DELETE(pedido());
    expect(r.status).toBe(200);

    // Nada sobra da organização que removeu: nem o E.164 (que é `not null` no
    // schema, então "zerar o campo" não é uma opção) nem o `destino_jid`, que é
    // a outra porta do corte.
    expect(linhas.filter((l) => l.organization_id === ORG)).toEqual([]);
    expect(JSON.stringify(linhas)).not.toContain(TELEFONE);
    expect(JSON.stringify(linhas)).not.toContain(JID);
    // E a fronteira entre tenants: o `eq` do `organization_id` no DELETE.
    expect(daVizinha()).toHaveLength(1);
    expect(daVizinha()[0]?.telefone_destino).toBe(TELEFONE_VIZINHO);
  });

  it("o número removedor volta à ingestão normal: a regra para de cortar a mensagem", async () => {
    const db = bancoFalso() as never;
    // CONTROLE POSITIVO: antes de remover, este número É o número interno — é o
    // que produz o "[ingest] mensagem do número interno de avisos ignorada" da
    // issue. A leitura também deixa o memo de 30 s preenchido.
    expect(await ehNumeroInternoDeAviso(db, ORG, chatDaEquipe)).toBe(true);

    expect((await DELETE(pedido())).status).toBe(200);

    // A MESMA pergunta, o MESMO dublê: sem destino e sem JID, não há o que
    // reconhecer. Se a rota esquecesse de esvaziar o memo, esta linha
    // responderia `true` com a configuração antiga em cache.
    expect(await ehNumeroInternoDeAviso(db, ORG, chatDaEquipe)).toBe(false);
    // E a vizinha, que ninguém tocou, continua interna pelo número dela.
    expect(
      await ehNumeroInternoDeAviso(db, ORG_VIZINHA, {
        kind: "phone",
        phone: TELEFONE_VIZINHO,
        lid: null,
      }),
    ).toBe(true);
  });

  it("remover NÃO é pausar: a decisão de pausa continua a que o usuário escolheu", async () => {
    // O usuário tinha PAUSADO os avisos sem trocar de número (`ligado: false`).
    linhas = [linha({ ligado: false })];
    const db = bancoFalso() as never;

    // Pausar preserva o telefone e, por decisão registrada no cabeçalho da
    // regra, o número segue interno. Isto NÃO muda com esta frente.
    expect(await ehNumeroInternoDeAviso(db, ORG, chatDaEquipe)).toBe(true);

    expect((await DELETE(pedido())).status).toBe(200);

    // A remoção não ESCREVE `ligado`: se ela fosse um `update ligado = false`
    // disfarçado, o dublê teria a operação e a linha continuaria aqui.
    expect(operacoes.filter((o) => o.startsWith("update:"))).toEqual([]);
    expect(linhas).toEqual([]);
    // A decisão que existia entra no rastro como ela estava, e não invertida.
    const entrada = vi.mocked(audit).mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
    expect(entrada.metadata.antes_ligado).toBe(false);
    // E o estado de pausa continua sendo um estado de CONFIGURADO: quem volta a
    // cadastrar um número pausado tem de novo o corte, como antes desta frente.
    linhas = [linha({ ligado: false, destino_jid: null })];
    limparCacheDoNumeroInterno();
    expect(await ehNumeroInternoDeAviso(db, ORG, chatDaEquipe)).toBe(true);
  });

  it("sem configuração, remover não é mutação: o estado volta, sem auditoria", async () => {
    linhas = [];
    const r = await DELETE(pedido());
    expect(r.status).toBe(200);
    expect((await r.json()) as unknown).toEqual({ data: ESTADO_SEM_CONFIG });
    expect(audit).not.toHaveBeenCalled();
  });
});

describe("DELETE — o rastro e a resposta", () => {
  it("a auditoria leva o número MASCARADO, nunca o telefone inteiro", async () => {
    await DELETE(pedido());
    const entrada = vi.mocked(audit).mock.calls[0]?.[0] as {
      action: string;
      organizationId: string;
      actorUserId: string;
      metadata: Record<string, unknown>;
    };
    expect(entrada.action).toBe("ai.case_alert_settings_removed");
    expect(entrada.organizationId).toBe(ORG);
    expect(entrada.actorUserId).toBe(USER);
    expect(entrada.metadata.destino_mascarado).toBe("••••0000");
    // `api_audit_log` é append-only e a cascata de LGPD não o alcança.
    expect(JSON.stringify(entrada.metadata)).not.toContain("11900000000");
  });

  it("devolve o estado recalculado — a tela não precisa adivinhar nem reconsultar", async () => {
    const r = await DELETE(pedido());
    expect((await r.json()) as unknown).toEqual({ data: ESTADO_SEM_CONFIG });
    expect(lerEstadoDaTelaDeAviso).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG }),
    );
  });
});
