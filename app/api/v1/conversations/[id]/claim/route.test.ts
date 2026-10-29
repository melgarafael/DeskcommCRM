import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { registrarTrocaDeComando } from "@/lib/inbox/atividade-de-comando";
import { createClient } from "@/lib/supabase/server";

import { POST } from "./route";

/**
 * POST /api/v1/conversations/[id]/claim — assumir a conversa assume o negócio
 * ABERTO do contato (#3177, sugestão 1 da issue: "ao transferir OU assumir").
 *
 * Aqui o portão de permissão é generoso por construção: o dono novo do card é
 * quem está assumindo (`to_user_id = user.id`), e um negócio SEM dono é visível
 * a todo `agent` nos três `visibility_mode`. Ou seja, o caso comum — card
 * largado no funil, atendente assume a conversa — passa pela RLS sem atalho
 * nenhum. O cliente continua sendo o da SESSÃO; service-role não entra aqui.
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-000000000001";
const USER = "aaaaaaaa-3333-4000-8000-000000000003";
const CONV_A = "aaaaaaaa-1111-4000-8000-000000000001";
const CONTATO_A = "aaaaaaaa-5555-4000-8000-000000000009";
const LEAD_ABERTO = "aaaaaaaa-7777-4000-8000-000000000001";
/** O negócio JÁ encerrado do controle: não pode ser tocado nem ganhar dono. */
const LEAD_PERDIDO = "aaaaaaaa-7777-4000-8000-000000000002";
/** O colega dono do card no controle do assumir (decisão B do #3216). */
const COLEGA = "aaaaaaaa-3333-4000-8000-000000000004";
const AGENTE_IA = "aaaaaaaa-8888-4000-8000-000000000001";

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
  leads: Linha[];
  rpcs: Array<{ nome: string; params: Linha }>;
  escritasDeLead: Linha[];
  /** Tabelas tocadas pelo cliente de SESSÃO. */
  tabelasDaSessao: string[];
  /** O UPDATE do lead volta com o 42501 do WITH CHECK (a forma da recusa da RLS). */
  rlsRecusa: boolean;
}

function lead(id: string, status: string, owner: string | null): Linha {
  return {
    id,
    organization_id: ORG_A,
    contact_id: CONTATO_A,
    status,
    owner_user_id: owner,
    owner_agent_id: null,
    owner_kind: owner ? "user" : null,
    assigned_at: "2026-01-01T00:00:00.000Z",
  };
}

function clienteFalso(estado: Estado) {
  function builder(tabela: string) {
    estado.tabelasDaSessao.push(tabela);
    const filtros: Array<[string, unknown]> = [];
    let patch: Linha | null = null;
    const linhas = () => (tabela === "crm_leads" ? estado.leads : []);
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
      is: (c: string, v: unknown) => {
        filtros.push([c, v]);
        return q;
      },
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
          const alvos = linhas().filter(casa);
          if (alvos.length > 0) estado.escritasDeLead.push({ ...patch });
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
    rpc: async (nome: string, params: Linha) => {
      estado.rpcs.push({ nome, params });
      if (nome === "fn_conversation_assign") {
        return {
          data: [
            {
              id: CONV_A,
              organization_id: ORG_A,
              contact_id: CONTATO_A,
              status: "open",
              assigned_to_user_id: params.p_to_user_id,
            },
          ],
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
}

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(() => ({
    ok: true,
    user: { id: "aaaaaaaa-3333-4000-8000-000000000003", idioma: "pt-BR" },
    org: { orgId: "aaaaaaaa-0000-4000-8000-000000000001", role: "agent" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/inbox/atividade-de-comando", () => ({
  registrarTrocaDeComando: vi.fn(async () => {}),
}));

let estado: Estado;

beforeEach(() => {
  vi.clearAllMocks();
  estado = {
    leads: [lead(LEAD_ABERTO, "open", null)],
    rpcs: [],
    escritasDeLead: [],
    tabelasDaSessao: [],
    rlsRecusa: false,
  };
  vi.mocked(createClient).mockResolvedValue(clienteFalso(estado) as unknown as SupabaseClient);
  vi.mocked(requireSupportWrite).mockResolvedValue(
    null as unknown as Awaited<ReturnType<typeof requireSupportWrite>>,
  );
});

function req(): NextRequest {
  return new NextRequest(`http://localhost/api/v1/conversations/${CONV_A}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
}

const params = { params: Promise.resolve({ id: CONV_A }) };

describe("POST /api/v1/conversations/[id]/claim — o negócio aberto segue (#3177)", () => {
  it("assumir aplica o responsável ao negócio ABERTO e sem dono do contato", async () => {
    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(linhaDe(estado.leads, LEAD_ABERTO)).toMatchObject({
      owner_user_id: USER,
      owner_agent_id: null,
      owner_kind: "user",
    });
    expect(estado.escritasDeLead).toHaveLength(1);
    expect(estado.tabelasDaSessao).toContain("crm_leads");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "conversation.claimed",
        metadata: expect.objectContaining({ negocio_aberto: "sincronizado" }),
      }),
    );
  });

  it("CONTROLE: sem negócio aberto, assumir não cria card nenhum", async () => {
    estado.leads = [lead(LEAD_PERDIDO, "lost", null)];

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(estado.leads).toHaveLength(1);
    expect(linhaDe(estado.leads, LEAD_PERDIDO)).toMatchObject({ status: "lost", owner_user_id: null });
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ negocio_aberto: "sem_negocio_aberto" }),
      }),
    );
  });

  it("CONTROLE: o card de quem JÁ é o responsável não é regravado", async () => {
    estado.leads = [lead(LEAD_ABERTO, "open", USER)];

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(linhaDe(estado.leads, LEAD_ABERTO).assigned_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("CONTROLE (#3216, B): o card de um colega NÃO muda ao assumir", async () => {
    estado.leads = [lead(LEAD_ABERTO, "open", COLEGA)];

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(linhaDe(estado.leads, LEAD_ABERTO)).toMatchObject({
      owner_user_id: COLEGA,
      owner_kind: "user",
      assigned_at: "2026-01-01T00:00:00.000Z",
    });
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ negocio_aberto: "ja_tinha_responsavel" }),
      }),
    );
  });

  it("CONTROLE (#3216, B): o card de um agente de IA também não muda ao assumir", async () => {
    estado.leads = [
      { ...lead(LEAD_ABERTO, "open", null), owner_agent_id: AGENTE_IA, owner_kind: "ai" },
    ];

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(linhaDe(estado.leads, LEAD_ABERTO)).toMatchObject({
      owner_user_id: null,
      owner_agent_id: AGENTE_IA,
    });
    expect(estado.escritasDeLead).toHaveLength(0);
  });

  it("CORRIDA (#3216, B): o card que ganhou dono entre a leitura e a escrita não é tomado", async () => {
    // A leitura vê o card sem dono; antes do UPDATE, um colega o pega. O filtro
    // "sem dono" da escrita é o que impede o assumir de passar por cima.
    const card = lead(LEAD_ABERTO, "open", null);
    estado.leads = [card];
    const cliente = clienteFalso(estado);
    const fromOriginal = cliente.from;
    cliente.from = (tabela: string) => {
      const q = fromOriginal(tabela);
      const updateOriginal = q.update;
      q.update = (v: Linha) => {
        Object.assign(card, { owner_user_id: COLEGA, owner_kind: "user" });
        return updateOriginal(v);
      };
      return q;
    };
    vi.mocked(createClient).mockResolvedValue(cliente as unknown as SupabaseClient);

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(card.owner_user_id).toBe(COLEGA);
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ negocio_aberto: "mudou_entre_leitura_e_escrita" }),
      }),
    );
  });

  it("o banco recusando (42501) não derruba o assumir e o motivo é a recusa", async () => {
    estado.rlsRecusa = true;

    const res = await POST(req(), params);

    expect(res.status).toBe(200);
    expect(linhaDe(estado.leads, LEAD_ABERTO).owner_user_id).toBeNull();
    expect(estado.escritasDeLead).toHaveLength(0);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ negocio_aberto: "recusado_pelo_banco" }),
      }),
    );
  });

  it("a rota de assumir não inventa evento de automação novo", async () => {
    await POST(req(), params);

    const eventos = estado.rpcs
      .filter((r) => r.nome === "emit_event")
      .map((r) => r.params.p_event_type);
    expect(eventos).toEqual(["conversation.claimed"]);
    expect(eventos).not.toContain("conversation.assigned");
    expect(registrarTrocaDeComando).toHaveBeenCalledTimes(1);
  });
});
