import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

/**
 * POST /api/v1/conversations/[id]/transfer — o negócio ABERTO segue a conversa
 * (#3177).
 *
 * O que este arquivo mede, e o que ele NÃO mede:
 *
 *  - MEDE a rota real com o banco dublado: a conversa muda de dono por RPC, e o
 *    card do funil do MESMO contato recebe o novo responsável pelo cliente da
 *    SESSÃO (nunca o admin/service-role — quem transfere a conversa não ganha
 *    permissão nova sobre o negócio).
 *  - MEDE os controles que a issue obriga a decidir: sem negócio aberto nada é
 *    criado, com MAIS de um aberto nada é tocado, e "já era o responsável" não
 *    regrava a linha (uma regravação emitiria um `lead.assigned` que não houve —
 *    o evento nasce do trigger do banco, no UPDATE, e é medido lá em
 *    tests/invariants/gov-3-assignment-events.test.ts).
 *  - NÃO MEDE o `lead.assigned`: ele é do trigger do banco (migration 0070), que
 *    o dublê não executa. O que se prova aqui é o gatilho da porta — a rota
 *    escreve `owner_user_id` + `owner_kind` coerentes (`resolveOwnerPatch`, 0070)
 *    e não inventa evento de automação novo.
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const DESTINO = "aaaaaaaa-4444-4000-8000-000000000004";
const ANTIGO = "aaaaaaaa-6666-4000-8000-000000000006";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONTATO_A = "aaaaaaaa-5555-4000-8000-000000000009";
const OUTRO_CONTATO = "aaaaaaaa-5555-4000-8000-000000000010";
const LEAD_ABERTO = "aaaaaaaa-7777-4000-8000-000000000001";
const LEAD_ABERTO_2 = "aaaaaaaa-7777-4000-8000-000000000002";
const LEAD_GANHO = "aaaaaaaa-7777-4000-8000-000000000003";
const LEAD_DE_OUTRO_CONTATO = "aaaaaaaa-7777-4000-8000-000000000004";

type Linha = Record<string, unknown>;

/**
 * A linha do dublê por id — `linhas[0]` é opcional para o compilador
 * (`noUncheckedIndexedAccess`) e um `?.` transformaria linha ausente em asserção
 * fraca. Aqui, linha que falta estoura.
 */
function linhaDe(linhas: Linha[], id: string): Linha {
  const achada = linhas.find((l) => l.id === id);
  if (!achada) throw new Error(`dublê sem a linha ${id}`);
  return achada;
}


interface Estado {
  conversas: Linha[];
  membros: Linha[];
  leads: Linha[];
  /** Toda RPC chamada pela rota, na ordem. */
  rpcs: Array<{ nome: string; params: Linha }>;
  /** Tabelas tocadas por cada cliente — é assim que se prova quem escreveu. */
  tabelas: { sessao: string[]; admin: string[] };
  /** Os patches que chegaram ao `crm_leads`. */
  escritasDeLead: Linha[];
  /** A leitura dos negócios estoura (banco fora do ar no meio da sincronia). */
  leituraExplode: boolean;
  /**
   * O UPDATE do lead volta com o ERRO 42501 do WITH CHECK — a forma que o
   * Postgres dá à RLS recusando o dono novo (não zero linhas).
   */
  rlsRecusa: boolean;
  /** O card é ganho entre a leitura e a escrita: o UPDATE volta sem linha. */
  ganhoNoMeio: boolean;
}

function conversa(extra: Linha = {}): Linha {
  return {
    id: CONV_A,
    organization_id: ORG_A,
    contact_id: CONTATO_A,
    status: "open",
    assigned_to_user_id: USER,
    assignee_kind: "user",
    ...extra,
  };
}

function lead(id: string, status: string, owner: string | null, contactId = CONTATO_A): Linha {
  return {
    id,
    organization_id: ORG_A,
    contact_id: contactId,
    status,
    owner_user_id: owner,
    owner_agent_id: null,
    owner_kind: owner ? "user" : null,
    assigned_at: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * Dublê com PREDICADO (mesmo dos testes das rotas irmãs): a linha só aparece
 * quando TODO filtro bate, `organization_id` inclusive. A leitura da régua é
 * aguardada como thenable (`.select().eq()…`) e a escrita termina em
 * `.maybeSingle()` — os dois caminhos usados por `sincronizarNegocioAbertoDoContato`.
 */
function clienteFalso(estado: Estado, rotulo: "sessao" | "admin") {
  function builder(tabela: string) {
    estado.tabelas[rotulo].push(tabela);
    const filtros: Array<[string, unknown]> = [];
    let patch: Linha | null = null;
    const linhas = () =>
      tabela === "conversations"
        ? estado.conversas
        : tabela === "user_organizations"
          ? estado.membros
          : tabela === "crm_leads"
            ? estado.leads
            : [];
    const casa = (l: Linha) => filtros.every(([c, v]) => l[c] === v);
    const q = {
      select: () => q,
      update: (v: Linha) => {
        patch = v;
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      is: () => q,
      in: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (patch) {
          if (tabela === "crm_leads" && estado.rlsRecusa) {
            return {
              data: null,
              error: {
                code: "42501",
                message: 'new row violates row-level security policy for table "crm_leads"',
              },
            };
          }
          if (tabela === "crm_leads" && estado.ganhoNoMeio) {
            for (const l of estado.leads) l.status = "won";
          }
          const alvos = linhas().filter(casa);
          if (alvos.length > 0) estado.escritasDeLead.push({ ...patch });
          for (const l of alvos) Object.assign(l, patch);
          patch = null;
          return { data: alvos[0] ?? null, error: null };
        }
        return { data: linhas().find(casa) ?? null, error: null };
      },
      then: (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) => {
        if (tabela === "crm_leads" && estado.leituraExplode) {
          return Promise.reject(new Error("banco caiu na leitura do funil")).then(comOk, comErro);
        }
        return Promise.resolve({ data: linhas().filter(casa), error: null }).then(comOk, comErro);
      },
    };
    return q;
  }
  return {
    from: builder,
    rpc: async (nome: string, params: Linha) => {
      estado.rpcs.push({ nome, params });
      if (nome === "fn_conversation_assign") {
        const conv = estado.conversas.find((c) => c.id === params.p_conversation_id);
        if (!conv) return { data: [], error: null };
        conv.assigned_to_user_id = params.p_to_user_id as string;
        return { data: [conv], error: null };
      }
      return { data: null, error: null };
    },
  };
}

/** Mutável por teste, lido de dentro do mock (hoisted: nasce antes dos imports). */
const auth = vi.hoisted(() => ({ negar: false }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(() =>
    auth.negar
      ? {
          ok: false,
          response: NextResponse.json(
            { error: { code: "forbidden_role", message: "Sem permissão." } },
            { status: 403 },
          ),
        }
      : {
          ok: true,
          user: { id: "aaaaaaaa-3333-4000-8000-000000000003", idioma: "pt-BR" },
          org: { orgId: "aaaaaaaa-0000-4000-8000-000000000001", role: "agent" },
        },
  ),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {}),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => {}),
}));

let estado: Estado;

beforeEach(() => {
  vi.clearAllMocks();
  auth.negar = false;
  estado = {
    conversas: [conversa()],
    membros: [
      { organization_id: ORG_A, user_id: DESTINO, role: "agent", revoked_at: null },
    ],
    leads: [lead(LEAD_ABERTO, "open", ANTIGO)],
    rpcs: [],
    tabelas: { sessao: [], admin: [] },
    escritasDeLead: [],
    leituraExplode: false,
    rlsRecusa: false,
    ganhoNoMeio: false,
  };
  vi.mocked(createClient).mockResolvedValue(clienteFalso(estado, "sessao") as unknown as SupabaseClient);
  vi.mocked(createAdminClient).mockReturnValue(
    clienteFalso(estado, "admin") as unknown as SupabaseClient,
  );
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
});

function req(corpo: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV_A}/transfer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

const params = { params: Promise.resolve({ id: CONV_A }) };

function transferir() {
  return POST(req({ to_user_id: DESTINO, reason: "cliente pediu o financeiro" }), params);
}

/** O metadata da auditoria de transferência — onde a régua deixa o rastro. */
function metadataDaTransferencia(): Record<string, unknown> {
  const entrada = vi
    .mocked(audit)
    .mock.calls.map(([e]) => e)
    .find((e) => e.action === "conversation.transferred");
  return (entrada?.metadata ?? {}) as Record<string, unknown>;
}

describe("POST /api/v1/conversations/[id]/transfer — o negócio aberto segue (#3177)", () => {
  it("transferir aplica o MESMO responsável ao negócio ABERTO do contato", async () => {
    const res = await transferir();

    expect(res.status).toBe(200);
    // A conversa mudou de dono (o que já era o comportamento)…
    expect(linhaDe(estado.conversas, CONV_A).assigned_to_user_id).toBe(DESTINO);
    expect(estado.rpcs.find((r) => r.nome === "fn_conversation_assign")?.params).toMatchObject({
      p_to_user_id: DESTINO,
      p_reason: "transfer",
    });
    // …e o card do funil foi junto: dono humano e `owner_kind` coerente (0070).
    expect(linhaDe(estado.leads, LEAD_ABERTO)).toMatchObject({
      owner_user_id: DESTINO,
      owner_agent_id: null,
      owner_kind: "user",
    });
    expect(linhaDe(estado.leads, LEAD_ABERTO).assigned_at).not.toBe("2026-01-01T00:00:00.000Z");
    expect(estado.escritasDeLead).toHaveLength(1);
    expect(metadataDaTransferencia()).toMatchObject({
      to_user_id: DESTINO,
      negocio_aberto: "sincronizado",
      negocio_id: LEAD_ABERTO,
    });
  });

  it("CONTROLE: sem negócio aberto, nada é criado e a transferência segue", async () => {
    // O contato só tem um negócio ENCERRADO: ganho é desfecho de quem
    // trabalhou, não de quem passa a atender a conversa.
    estado.leads = [lead(LEAD_GANHO, "won", ANTIGO)];

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(estado.leads).toHaveLength(1);
    expect(linhaDe(estado.leads, LEAD_GANHO)).toMatchObject({ status: "won", owner_user_id: ANTIGO });
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(metadataDaTransferencia()).toMatchObject({ negocio_aberto: "sem_negocio_aberto" });
  });

  it("CONTROLE: sem contato nenhum (conversa órfã), nem a leitura do funil acontece", async () => {
    estado.conversas = [conversa({ contact_id: null })];

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(estado.tabelas.sessao).not.toContain("crm_leads");
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(metadataDaTransferencia()).toMatchObject({ negocio_aberto: "sem_negocio_aberto" });
  });

  it("CONTROLE: com MAIS de um negócio aberto, NENHUM é tocado (a régua declarada no PR)", async () => {
    // Dois negócios abertos do mesmo contato: a issue pede perguntar "quais
    // levar" (sugestão 2). Transferir a conversa é UM clique, sem tela de
    // escolha — então a regra desta rodada é não adivinhar: nenhum card muda e
    // o motivo fica escrito.
    estado.leads = [
      lead(LEAD_ABERTO, "open", ANTIGO),
      lead(LEAD_ABERTO_2, "open", null),
      // O de OUTRO contato nunca entra na conta, mesmo aberto e sem dono.
      lead(LEAD_DE_OUTRO_CONTATO, "open", null, OUTRO_CONTATO),
    ];

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(estado.leads.map((l) => l.owner_user_id)).toEqual([ANTIGO, null, null]);
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(metadataDaTransferencia()).toMatchObject({ negocio_aberto: "varios_negocios_abertos" });
  });

  it("CONTROLE: já era o responsável — não regrava (e não inventa lead.assigned)", async () => {
    estado.leads = [lead(LEAD_ABERTO, "open", DESTINO)];

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(linhaDe(estado.leads, LEAD_ABERTO).assigned_at).toBe("2026-01-01T00:00:00.000Z");
    expect(metadataDaTransferencia()).toMatchObject({
      negocio_aberto: "ja_era_o_responsavel",
      negocio_id: LEAD_ABERTO,
    });
  });

  it("o banco recusando o dono novo (RLS) não derruba a transferência da conversa", async () => {
    // Em `visibility_mode = 'own'`/'own_and_unassigned'`, um `agent` não
    // atribui o card a um colega (#2556): o WITH CHECK da `crm_leads_update`
    // devolve 42501. A conversa já é do destino — o 200 permanece — e o card
    // fica como estava. É a régua funcionando, não falha: nada vai ao log.
    estado.rlsRecusa = true;
    const aviso = vi.spyOn(logger, "warn");

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(linhaDe(estado.conversas, CONV_A).assigned_to_user_id).toBe(DESTINO);
    expect(linhaDe(estado.leads, LEAD_ABERTO).owner_user_id).toBe(ANTIGO);
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(metadataDaTransferencia()).toMatchObject({ negocio_aberto: "recusado_pelo_banco" });
    expect(aviso).not.toHaveBeenCalled();
  });

  it("o card ganho entre a leitura e a escrita é a corrida, não a recusa do banco", async () => {
    estado.ganhoNoMeio = true;

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(linhaDe(estado.conversas, CONV_A).assigned_to_user_id).toBe(DESTINO);
    expect(linhaDe(estado.leads, LEAD_ABERTO)).toMatchObject({ status: "won", owner_user_id: ANTIGO });
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(metadataDaTransferencia()).toMatchObject({
      negocio_aberto: "mudou_entre_leitura_e_escrita",
    });
  });

  it("leitura do funil estourando também não vira 500: a transferência é o pedido", async () => {
    estado.leituraExplode = true;

    const res = await transferir();

    expect(res.status).toBe(200);
    expect(linhaDe(estado.conversas, CONV_A).assigned_to_user_id).toBe(DESTINO);
    expect(metadataDaTransferencia()).toMatchObject({ negocio_aberto: "falha" });
  });

  it("quem escreve no negócio é o cliente da SESSÃO; o admin só confere o destino", async () => {
    const res = await transferir();

    expect(res.status).toBe(200);
    // Service-role na frente do funil é a porta que a issue manda NÃO abrir:
    // quem transfere a conversa não ganha, por aqui, o que a rota de negócios
    // nega. O admin client continua no único uso que ele já tinha.
    expect(estado.tabelas.admin).toEqual(["user_organizations"]);
    expect(estado.tabelas.sessao).toContain("crm_leads");
  });

  it("nenhum gatilho de automação novo: a rota só emite os eventos que já emitia", async () => {
    const res = await transferir();

    expect(res.status).toBe(200);
    const eventos = estado.rpcs
      .filter((r) => r.nome === "emit_event")
      .map((r) => r.params.p_event_type);
    expect(eventos).toEqual(["conversation.transferred"]);
    // A sugestão 3 da issue (`conversation.assigned`) NÃO entrou nesta rodada.
    expect(eventos).not.toContain("conversation.assigned");
    expect(registrarTrocaDeComando).toHaveBeenCalledTimes(1);
  });

  it("a auditoria continua a mesma entrada, agora com o rastro do funil", async () => {
    await transferir();

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.transferred",
        actorUserId: USER,
        organizationId: ORG_A,
        resourceId: CONV_A,
        metadata: expect.objectContaining({
          to_user_id: DESTINO,
          note: "cliente pediu o financeiro",
        }),
      }),
    );
  });
});
