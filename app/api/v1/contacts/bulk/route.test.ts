import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

import { POST, TETO_DO_LOTE } from "./route";

/**
 * POST /api/v1/contacts/bulk (#2484, fatia F3) — a camada de lote dos contatos.
 *
 * O banco é o MESMO dublê com predicado dos testes das rotas irmãs: a linha do
 * contato só aparece quando `organization_id` casa. É por isso que o caso
 * cross-tenant mede a ROTA (o caminho individual recusando), e não o mock — o
 * contato de ORG_B EXISTE no dublê, e só não é alcançável por quem está na
 * sessão de ORG_A. O `fn_definir_carteira_do_cliente` do dublê repete a regra
 * da função real: valida `p_org` (a da SESSÃO, nunca a do corpo) contra a linha
 * do contato, e recusa `carteira_contato_de_outra` para id alheio.
 *
 * Os caminhos por item NÃO são mockados: são os GET/PATCH reais de
 * `../[id]/route` e o PATCH de `../[id]/carteira/route`, importados pela rota
 * de lote. Quem é mockado é o que eles precisam para rodar sem banco (auth,
 * client, audit) — o mesmo recorte dos testes co-localizados das irmãs.
 */
const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-0000-4000-8000-000000000002";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const DONO = "aaaaaaaa-4444-4000-8000-000000000004";
const CONTATO_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONTATO_A2 = "aaaaaaaa-1111-4000-8000-000000000005";
const CONTATO_B = "bbbbbbbb-1111-4000-8000-000000000002";
const CONTATO_FANTASMA = "cccccccc-1111-4000-8000-000000000003";

type Linha = Record<string, unknown>;

/** Estado mutável do dublê, recriado a cada teste. */
interface Estado {
  contatos: Linha[];
  membros: Linha[];
  rpcs: Array<{ nome: string; params: Linha }>;
  /** Id cujo `rpc` ESTOURA — simula o banco caindo no meio da escrita. */
  explodirEm: string | null;
}

function contato(id: string, organizationId: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: organizationId,
    name: `Contato ${id.slice(0, 4)}`,
    display_name: null,
    email: null,
    email_normalized: null,
    phone_number: null,
    cpf_hash: null,
    birthdate: null,
    is_blocked: false,
    blocked_reason: null,
    is_personal: false,
    is_anonymized: false,
    anonymized_at: null,
    is_merged_into: null,
    merged_at: null,
    consent: {},
    tags: [],
    source: "manual",
    source_metadata: {},
    custom_fields: {},
    carteira_user_id: null,
    created_at: "2026-10-01T12:00:00.000Z",
    updated_at: "2026-10-01T12:00:00.000Z",
    last_activity_at: null,
    first_service_at: null,
    ...extra,
  };
}

/**
 * O dublê de client `.from(...).eq(...).maybeSingle()` com PREDICADO: só casa
 * a linha quando TODO filtro bate, `organization_id` inclusive. `rpc` grava as
 * chamadas em `estado.rpcs` — é assim que o teste prova que o `p_dono` chegou
 * à função da carteira.
 */
function clienteFalso(estado: Estado) {
  function builder(tabela: string) {
    const filtros: Array<[string, unknown]> = [];
    const filtrosIn: Array<[string, unknown[]]> = [];
    let patch: Linha | null = null;
    const linhas = () =>
      tabela === "contacts" ? estado.contatos : tabela === "user_organizations" ? estado.membros : [];
    const casa = (l: Linha) =>
      filtros.every(([c, v]) => l[c] === v) &&
      filtrosIn.every(([c, vs]) => vs.includes(l[c]));
    const q = {
      select: () => q,
      update: (v: Linha) => {
        patch = v;
        return q;
      },
      insert: (v: Linha) => {
        linhas().push(v);
        return q;
      },
      eq: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      neq: () => q,
      is: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
      in: (c: string, vs: unknown[]) => {
        filtrosIn.push([c, vs]);
        return q;
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (patch) {
          const alvos = linhas().filter(casa);
          for (const l of alvos) Object.assign(l, patch);
          patch = null;
          return { data: alvos[0] ?? null, error: null };
        }
        return { data: linhas().find(casa) ?? null, error: null };
      },
      then: (comOk: (v: unknown) => unknown, comErro: (e: unknown) => unknown) =>
        Promise.resolve({ data: linhas().filter(casa), error: null }).then(comOk, comErro),
    };
    return q;
  }
  return {
    from: builder,
    auth: {
      getUser: async () => ({ data: { user: { id: USER } }, error: null }),
    },
    rpc: async (nome: string, params: Linha) => {
      estado.rpcs.push({ nome, params });
      const idDoContato = (params.p_contact ?? params.p_entity_id) as string | undefined;
      if (estado.explodirEm !== null && idDoContato === estado.explodirEm) {
        throw new Error("banco caiu no meio da escrita");
      }
      if (nome === "emit_event") return { data: null, error: null };
      if (nome === "fn_definir_carteira_do_cliente") {
        // A função real revalida o ATOR e o DONO, e recusa contato de outra
        // org — o dublê repete só a segunda, que é o que o teste mede.
        const alvo = estado.contatos.find(
          (c) => c.id === params.p_contact && c.organization_id === params.p_org,
        );
        if (!alvo) {
          return { data: null, error: { message: "carteira_contato_de_outra_org" } };
        }
        const dono = params.p_dono as string | null;
        if (dono !== null) {
          const membro = estado.membros.find(
            (m) => m.user_id === dono && m.organization_id === params.p_org && m.revoked_at === null,
          );
          if (!membro) {
            return { data: null, error: { message: "carteira_dono_invalido" } };
          }
          alvo.carteira_user_id = dono;
        } else {
          alvo.carteira_user_id = null;
        }
        return { data: null, error: null };
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
          user: { id: USER, idioma: "pt-BR" },
          org: { orgId: "aaaaaaaa-0000-4000-8000-000000000001", role: "manager" },
        },
  ),
  // O GET da rota individual resolve a org da SESSÃO por aqui — nunca do corpo.
  orgAtivaDaApi: vi.fn(async () => ({ ok: true, org: { orgId: ORG_A } })),
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => ({ idioma: "pt-BR" })) }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => {}),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/legal/perfil-do-pais", () => ({
  perfilDaOrganizacao: vi.fn(async () => ({
    documento: { valida: () => true, mensagemInvalido: "CPF inválido" },
    telefoneExemplo: "+5511999999999",
  })),
  isValidCpf: () => true,
  // `telefoneDoPais` compara o país do perfil com o padrão (#3301): sem a
  // constante no dublê, o PATCH que o lote chama morre antes de gravar.
  PAIS_PADRAO: "BR",
}));
vi.mock("@/lib/atendimento/origem", () => ({ observeServiceOrigin: vi.fn(async () => null) }));

let estado: Estado;

beforeEach(() => {
  vi.clearAllMocks();
  auth.negar = false;
  estado = {
    contatos: [
      contato(CONTATO_A, ORG_A, {
        tags: ["vip"],
        custom_fields: { Andamento: "negociando", origem: "site" },
      }),
      contato(CONTATO_A2, ORG_A),
      contato(CONTATO_B, ORG_B, { tags: ["de-outra-org"], custom_fields: { origem: "import" } }),
    ],
    membros: [
      { organization_id: ORG_A, user_id: DONO, role: "agent", revoked_at: null },
    ],
    rpcs: [],
    explodirEm: null,
  };
  vi.mocked(createClient).mockResolvedValue(
    clienteFalso(estado) as unknown as SupabaseClient,
  );
  vi.mocked(createAdminClient).mockReturnValue(
    clienteFalso(estado) as unknown as SupabaseClient,
  );
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
});

function req(corpo: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/contacts/bulk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(corpo),
  });
}

interface CorpoDoLote {
  acao?: string;
  teto?: number;
  total?: number;
  feitos?: number;
  recusados?: number;
  resultados?: Array<{
    id: string;
    feito: boolean;
    codigo?: string;
    motivo?: string;
    request_id?: string;
  }>;
}

async function corpoDe(res: Response): Promise<{
  status: number;
  data: CorpoDoLote;
  error?: { code: string; message: string };
}> {
  const json = (await res.json()) as { data?: CorpoDoLote; error?: { code: string; message: string } };
  return { status: res.status, data: json.data ?? {}, error: json.error };
}

describe("POST /api/v1/contacts/bulk", () => {
  it("ids MISTOS (tag): o de outra organização é recusado NO ITEM e não derruba os demais", async () => {
    const res = await POST(
      req({ action: "tag", ids: [CONTATO_A, CONTATO_B, CONTATO_FANTASMA], op: "add", tag: " ATRASO " }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.acao).toBe("tag");
    // O teto devolvido no relatório: a tela sabe o limite sem chamar de novo.
    expect(corpo.data.teto).toBe(TETO_DO_LOTE);
    expect(corpo.data.total).toBe(3);
    expect(corpo.data.feitos).toBe(1);
    expect(corpo.data.recusados).toBe(2);
    expect(corpo.data.resultados).toEqual([
      { id: CONTATO_A, feito: true, request_id: expect.any(String) },
      {
        id: CONTATO_B,
        feito: false,
        codigo: "not_found",
        motivo: "Contato não encontrado.",
        request_id: expect.any(String),
      },
      {
        id: CONTATO_FANTASMA,
        feito: false,
        codigo: "not_found",
        motivo: "Contato não encontrado.",
        request_id: expect.any(String),
      },
    ]);
    // O item bom recebeu a etiqueta (merge com as que já tinha, normalizada);
    // o da outra organização segue intacto.
    const a = estado.contatos.find((c) => c.id === CONTATO_A);
    expect(a?.tags).toEqual(["vip", "atraso"]);
    expect(estado.contatos.find((c) => c.id === CONTATO_B)?.tags).toEqual(["de-outra-org"]);
    // Auditoria POR ITEM: UMA entrada, a do contato que existia para a sessão.
    // Uma entrada de lote apagaria qual contato sofreu qual ação.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.updated",
        resourceType: "contact",
        resourceId: CONTATO_A,
      }),
    );
  });

  it("ids MISTOS (carteira): recusa por item e UMA auditoria por contato, não uma do lote", async () => {
    const res = await POST(
      req({ action: "carteira", ids: [CONTATO_A, CONTATO_B, CONTATO_FANTASMA], dono_user_id: DONO }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(corpo.data.recusados).toBe(2);
    expect(corpo.data.resultados?.[1]).toMatchObject({
      id: CONTATO_B,
      feito: false,
      codigo: "contact_not_found",
    });
    expect(corpo.data.resultados?.[2]).toMatchObject({
      id: CONTATO_FANTASMA,
      feito: false,
      codigo: "contact_not_found",
    });
    // A carteira passou pela PORTA ÚNICA (`fn_definir_carteira_do_cliente`),
    // com a org da SESSÃO — nunca gravada direto pela rota de lote.
    expect(estado.contatos.find((c) => c.id === CONTATO_A)?.carteira_user_id).toBe(DONO);
    expect(estado.contatos.find((c) => c.id === CONTATO_B)?.carteira_user_id).toBeNull();
    expect(estado.rpcs).toContainEqual(
      expect.objectContaining({
        nome: "fn_definir_carteira_do_cliente",
        params: expect.objectContaining({ p_org: ORG_A, p_contact: CONTATO_A, p_dono: DONO }),
      }),
    );
    // Uma entrada de auditoria SÓ, a do contato que mudou de dono.
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.carteira_changed",
        resourceId: CONTATO_A,
      }),
    );
  });

  it("campo personalizado: MERGE da chave pedida, os outros campos do contato permanecem", async () => {
    const res = await POST(
      req({
        action: "custom-field",
        ids: [CONTATO_A, CONTATO_B],
        chave: "Andamento",
        valor: "contrato enviado",
      }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(corpo.data.recusados).toBe(1);
    const a = estado.contatos.find((c) => c.id === CONTATO_A);
    expect(a?.custom_fields).toEqual({ Andamento: "contrato enviado", origem: "site" });
    expect(estado.contatos.find((c) => c.id === CONTATO_B)?.custom_fields).toEqual({
      origem: "import",
    });
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("campo personalizado com valor null APAGA a chave e preserva as demais", async () => {
    const res = await POST(
      req({ action: "custom-field", ids: [CONTATO_A], chave: "origem", valor: null }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(estado.contatos.find((c) => c.id === CONTATO_A)?.custom_fields).toEqual({
      Andamento: "negociando",
    });
  });

  it(`teto: acima de ${TETO_DO_LOTE} ids a CHAMADA é recusada com 422 e nada é tocado`, async () => {
    const ids = Array.from(
      { length: TETO_DO_LOTE + 1 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );

    const res = await POST(req({ action: "tag", ids, op: "add", tag: "vip" }));

    expect(res.status).toBe(422);
    const corpo = await corpoDe(res);
    expect(corpo.error?.code).toBe("bulk_too_large");
    expect(corpo.error?.message).toContain(String(TETO_DO_LOTE));
    // Nenhuma subchamada foi feita: o teto é portão da CHAMADA, antes do laço.
    expect(audit).not.toHaveBeenCalled();
    expect(estado.rpcs).toEqual([]);
    expect(estado.contatos.find((c) => c.id === CONTATO_A)?.tags).toEqual(["vip"]);
  });

  it("sem permissão na chamada, o viewer recebe 403 e NENHUM item roda", async () => {
    auth.negar = true;

    const res = await POST(
      req({ action: "tag", ids: [CONTATO_A, CONTATO_B], op: "add", tag: "vip" }),
    );

    expect(res.status).toBe(403);
    expect(audit).not.toHaveBeenCalled();
    expect(estado.contatos.find((c) => c.id === CONTATO_A)?.tags).toEqual(["vip"]);
  });

  it("um item que ESTOURA recusa só ele; o resto do lote continua", async () => {
    estado.explodirEm = CONTATO_A2;

    const res = await POST(
      req({ action: "carteira", ids: [CONTATO_A2, CONTATO_A], dono_user_id: DONO }),
    );

    expect(res.status).toBe(200);
    const corpo = await corpoDe(res);
    expect(corpo.data.feitos).toBe(1);
    expect(corpo.data.resultados?.[0]).toMatchObject({
      id: CONTATO_A2,
      feito: false,
      codigo: "internal_error",
      motivo: "banco caiu no meio da escrita",
    });
    expect(corpo.data.resultados?.[1]).toMatchObject({ id: CONTATO_A, feito: true });
    expect(estado.contatos.find((c) => c.id === CONTATO_A)?.carteira_user_id).toBe(DONO);
  });

  it("corpo inválido (ação desconhecida) é 422 da CHAMADA, sem item nenhum", async () => {
    const res = await POST(req({ action: "delete", ids: [CONTATO_A] }));

    expect(res.status).toBe(422);
    const corpo = await corpoDe(res);
    expect(corpo.error?.code).toBe("validation_error");
    expect(audit).not.toHaveBeenCalled();
  });
});
