import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";

import { DELETE } from "./route";

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";

/**
 * DESMARCAR VOLTA TUDO, HISTÓRICO INTACTO (spec 21, etapa 5, critério 10).
 *
 * Desmarcar é SÓ `is_personal=false` + auditoria + timeline (D8): não reativa
 * follow-up, campanha nem prospecção, e nunca tocou mensagem nenhuma — então a
 * volta encontra tudo onde estava. A reaparição no inbox e no board é leitura
 * filtrada (fatia 2); aqui a prova é que o desmarcar não destrói nem religa.
 *
 * ─── SABOTAGEM (prova no CI; linha para reverter: `route.ts`) ──────────────
 * - Limpar mensagens ao marcar: a volta viria vazia — aqui, qualquer toque na
 *   tabela `messages` cai no caso "não toca mensagem".
 * - Reativar follow-up ao desmarcar: o caso "não reativa" acusa.
 * - Reutilizar `contact.unblocked`: o caso "nomes exatos" acusa (critério 9).
 */

interface Linha {
  id: string;
  organization_id: string;
  [k: string]: unknown;
}

let contatos: Record<string, Linha>;
let atividades: Array<Record<string, unknown>>;
const tabelasTocadas = new Set<string>();

const contexto = (id = CONTATO) => ({ params: Promise.resolve({ id }) });
const req = () => new NextRequest(`http://localhost/api/v1/contacts/${CONTATO}/personal`, { method: "DELETE" });

function fakeQuery(tabela: string) {
  tabelasTocadas.add(tabela);
  const estado = { op: "select" as "select" | "update" | "insert", patch: {} as Record<string, unknown>, filtros: {} as Record<string, unknown> };
  const resultado = () => {
    if (estado.op === "insert") {
      atividades.push(estado.patch);
      return { data: null, error: null };
    }
    const linha = contatos[estado.filtros["id"] as string];
    const casa = linha && linha["organization_id"] === estado.filtros["organization_id"];
    if (estado.op === "update") {
      if (!casa) return { data: null, error: null };
      Object.assign(linha, estado.patch);
      return { data: { ...linha }, error: null };
    }
    return { data: casa ? { ...linha } : null, error: null };
  };
  const q = {
    select: () => q,
    update: (p: Record<string, unknown>) => {
      estado.op = "update";
      estado.patch = p;
      return q;
    },
    insert: (linha: Record<string, unknown>) => {
      estado.op = "insert";
      estado.patch = linha;
      return q;
    },
    eq: (k: string, v: unknown) => {
      estado.filtros[k] = v;
      return q;
    },
    in: () => q,
    is: () => q,
    order: () => q,
    limit: () => q,
    maybeSingle: async () => resultado(),
    single: async () => resultado(),
    then: (res: (v: unknown) => unknown) => Promise.resolve(resultado()).then(res),
  };
  return q;
}

beforeEach(() => {
  vi.clearAllMocks();
  contatos = {
    [CONTATO]: { id: CONTATO, organization_id: ORG, display_name: "Mello", is_personal: true },
  };
  atividades = [];
  tabelasTocadas.clear();
  vi.mocked(loadAuthUser).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: ORG, idioma: "pt-BR" },
    org: { orgId: ORG, role: "manager" },
  } as Awaited<ReturnType<typeof requireRole>>);
  vi.mocked(createAdminClient).mockReturnValue({
    // Negócio aberto: nenhum (o D6 manda pular a timeline em silêncio); a
    // timeline com negócio ancorado é coberta no teste do marcar.
    from: (tabela: string) => fakeQuery(tabela),
  } as unknown as ReturnType<typeof createAdminClient>);
  vi.mocked(audit).mockResolvedValue(undefined);
});

describe("desmarcar contato pessoal (spec 21, etapa 5)", () => {
  it("só gerente e dono desmarcam — atendente recebe 403", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("forbidden", "Acesso negado.", 403),
    });
    const resposta = await DELETE(req(), contexto());
    expect(resposta.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(audit).not.toHaveBeenCalled();
  });

  it("desmarca: desliga a coluna e audita o evento NOVO, sem telefone", async () => {
    const resposta = await DELETE(req(), contexto());
    expect(resposta.status).toBe(200);
    expect(contatos[CONTATO]!["is_personal"]).toBe(false);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "contact.unmarked_personal",
        actorUserId: ORG,
        organizationId: ORG,
        resourceType: "contact",
        resourceId: CONTATO,
      }),
    );
    const metadata = vi.mocked(audit).mock.calls[0]?.[0]?.metadata ?? {};
    expect(JSON.stringify(metadata)).not.toContain("+55");
  });

  it("nomes exatos: nunca reutiliza evento de desbloqueio (critério 9)", async () => {
    await DELETE(req(), contexto());
    const acao = vi.mocked(audit).mock.calls[0]?.[0]?.action;
    expect(acao).toBe("contact.unmarked_personal");
    expect(acao).not.toBe("contact.unblocked");
  });

  it("já operacional é idempotente: não reaudita", async () => {
    contatos[CONTATO]!["is_personal"] = false;
    const resposta = await DELETE(req(), contexto());
    expect(resposta.status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("não toca mensagem nenhuma — a volta encontra o histórico inteiro", async () => {
    await DELETE(req(), contexto());
    expect(tabelasTocadas.has("messages")).toBe(false);
  });

  it("não reativa nada: só contatos, leads (leitura) e auditoria são tocados", async () => {
    await DELETE(req(), contexto());
    for (const t of tabelasTocadas) {
      expect(["contacts", "crm_leads", "crm_pipelines", "crm_lead_activities"]).toContain(t);
    }
  });
});
