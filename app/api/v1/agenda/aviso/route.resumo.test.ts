// @vitest-environment node
/**
 * PUT /api/v1/agenda/aviso — "Enviar o resumo do dia só quando houver
 * agendamento" (#4988, migration 9434).
 *
 * A escolha tem porta própria (`fn_definir_resumo_do_aviso_de_agendamento`),
 * chamada DEPOIS da porta principal, como a do lembrete (9326). Aqui se prova
 * o que a rota controla: a porta só é chamada quando o corpo traz o campo, com
 * a organização da SESSÃO (nunca do corpo); a recusa dela vira a frase certa;
 * e a auditoria registra o antes e o depois.
 *
 * A guarda da porta (admin, suporte, MFA, só a própria linha) é do banco e está
 * em `tests/invariants/resumo-so-com-agendamento-escrita.test.ts`.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

import { PUT } from "./route";

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({ limparCacheDoNumeroInterno: vi.fn() }));
vi.mock("@/lib/agenda/tela-do-aviso-de-agendamento", () => ({
  lerEstadoDaTelaDoAvisoDeAgendamento: vi.fn(async () => ({ config: null })),
}));

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "11111111-1111-4111-8111-111111111111";

type Resposta = { data: unknown; error: { message: string } | null };
let respostas: Record<string, Resposta>;
const rpc = vi.fn(async (nome: string) => respostas[nome] ?? { data: null, error: null });

function put(corpo: Record<string, unknown>) {
  return PUT(
    new NextRequest("http://localhost/api/v1/agenda/aviso", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    }),
  );
}

const BASE = { usa_numero_do_aviso_de_caso: true, ligado: true };
const chamadas = (nome: string) => rpc.mock.calls.filter(([n]) => n === nome);

beforeEach(() => {
  vi.clearAllMocks();
  respostas = {
    fn_definir_aviso_de_agendamento: { data: { trocou_numero: false, antes_ligado: true }, error: null },
    fn_definir_resumo_do_aviso_de_agendamento: { data: false, error: null },
  };
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: ORG },
    user: { id: USER_ID, idioma: "pt-BR" },
  } as never);
  vi.mocked(createClient).mockResolvedValue({ rpc } as never);
});

describe("PUT /api/v1/agenda/aviso — resumo só com agendamento", () => {
  it("sem o campo, a porta do resumo não é chamada (o formulário antigo continua valendo)", async () => {
    const r = await put(BASE);
    expect(r.status).toBe(200);
    expect(chamadas("fn_definir_resumo_do_aviso_de_agendamento")).toHaveLength(0);
    const meta = vi.mocked(audit).mock.calls[0]![0].metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty("depois_resumo_so_com_agendamento");
  });

  it("com o campo, chama a porta com a organização da sessão e audita antes e depois", async () => {
    const r = await put({ ...BASE, resumo_so_com_agendamento: true });
    expect(r.status).toBe(200);
    expect(chamadas("fn_definir_resumo_do_aviso_de_agendamento")).toEqual([
      ["fn_definir_resumo_do_aviso_de_agendamento", { p_org: ORG, p_so_com_agendamento: true }],
    ]);
    // Depois da porta principal: a linha de configuração já existe.
    expect(rpc.mock.calls.map(([n]) => n)).toEqual([
      "fn_definir_aviso_de_agendamento",
      "fn_definir_resumo_do_aviso_de_agendamento",
    ]);
    expect(vi.mocked(audit).mock.calls[0]![0].metadata).toMatchObject({
      antes_resumo_so_com_agendamento: false,
      depois_resumo_so_com_agendamento: true,
    });
  });

  it("a organização vem da sessão: um campo de organização no corpo é recusado", async () => {
    const r = await put({ ...BASE, resumo_so_com_agendamento: true, organization_id: OUTRA_ORG });
    expect(r.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("valor que não é booleano é recusado antes de qualquer escrita", async () => {
    const r = await put({ ...BASE, resumo_so_com_agendamento: "sim" });
    expect(r.status).toBe(422);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("a recusa da porta vira a frase do produto, e não 500", async () => {
    respostas.fn_definir_resumo_do_aviso_de_agendamento = {
      data: null,
      error: { message: "aviso_de_agendamento_mfa_required" },
    };
    const r = await put({ ...BASE, resumo_so_com_agendamento: true });
    expect(r.status).toBe(403);
    const corpo = (await r.json()) as { error: { code: string } };
    expect(corpo.error.code).toBe("mfa_required");
    expect(audit).not.toHaveBeenCalled();
  });

  it("erro desconhecido da porta é 500 sem vazar a mensagem do banco", async () => {
    respostas.fn_definir_resumo_do_aviso_de_agendamento = { data: null, error: { message: "boom interno" } };
    const r = await put({ ...BASE, resumo_so_com_agendamento: false });
    expect(r.status).toBe(500);
    expect(JSON.stringify(await r.json())).not.toContain("boom interno");
  });
});
