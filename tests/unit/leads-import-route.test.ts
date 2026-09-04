/**
 * A IMPORTAÇÃO DE LEADS NÃO ACEITA NADA NO ESCURO.
 *
 * Guarda o que a extração do PR #418 mudou de contrato:
 *
 *  - O funil e a etapa vêm do FORM, mas a ORGANIZAÇÃO vem da sessão. Sem isto,
 *    uma planilha podia despejar 300 negócios no funil de outro tenant.
 *  - Uma linha ruim não derruba as outras; uma ETAPA ruim derruba tudo, e a
 *    diferença é o que separa "corrija a linha 7" de "300 tentativas para dar
 *    o mesmo erro 300 vezes".
 *  - O mesmo telefone repetido vira UM contato. O original criava um contato por
 *    linha, e o produto passava a ter a duplicata que ele mesmo fabricou.
 *  - `viewer` não importa.
 */
import { NextRequest } from "next/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

import { ApiError } from "@/lib/api/types";
import { fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK, type AuthUser, type Role } from "@/lib/auth/types";
import { createLeadHandler } from "@/app/api/v1/leads/_handler";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/app/api/v1/leads/_handler", () => ({ createLeadHandler: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const FUNIL = "33333333-3333-4333-8333-333333333333";
const ETAPA = "44444444-4444-4444-8444-444444444444";

function sessao(papel: Role) {
  const user: AuthUser = {
    id: ANA,
    email: "ana@example.com",
    full_name: "Ana",
    avatar_url: null,
    is_platform_admin: false,
    idioma: "pt-BR" as const,
    organizations: [{ organization_id: ORG, organization_name: "Org", role: papel }],
  };
  vi.mocked(requireRole).mockImplementation(async (min: Role) =>
    ROLE_RANK[papel] >= ROLE_RANK[min]
      ? { ok: true, user, org: { orgId: ORG, name: "Org", role: papel } }
      : { ok: false, response: fail("forbidden_role", `Requer role >= ${min}.`, 403, {}) },
  );
}

/** Dublê de `contacts` que anota os INSERTs — é como se conta duplicata. */
function fazerSupabase(existente: { id: string } | null) {
  const inseridos: Record<string, unknown>[] = [];
  const from = (tabela: string) => {
    const elo: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "limit", "order"]) elo[m] = () => elo;
    elo.insert = (linha: Record<string, unknown>) => {
      if (tabela === "contacts") inseridos.push(linha);
      return elo;
    };
    elo.single = () => Promise.resolve({ data: { id: `novo-${inseridos.length}` }, error: null });
    elo.maybeSingle = () => Promise.resolve({ data: existente, error: null });
    return elo;
  };
  vi.mocked(createClient).mockResolvedValue({ from } as never);
  return { inseridos };
}

/**
 * O corpo multipart é montado NA MÃO, byte a byte — e não com `new FormData()`.
 *
 * Medido: sob o ambiente `jsdom` da suíte, passar um `FormData` do jsdom como
 * `body` de um `NextRequest` faz o undici (que é quem serializa) não reconhecer
 * o `File` do jsdom e gravá-lo como a STRING "undefined". O arquivo chega à
 * rota com 9 bytes, nome "blob" e conteúdo `undefined` — e o teste passaria a
 * medir o realm do ambiente, não a rota.
 *
 * Montar o multipart à mão remove a variável: é exatamente o que o navegador
 * põe no fio, e o `req.formData()` da rota o lê com o parser de produção.
 */
function pedido(csv: string, campos: Record<string, string | null> = {}) {
  const B = "----deskcommTesteDeImportacao";
  const parte = (nome: string, valor: string, arquivo?: string) =>
    `--${B}\r\nContent-Disposition: form-data; name="${nome}"` +
    (arquivo ? `; filename="${arquivo}"\r\nContent-Type: text/csv` : "") +
    `\r\n\r\n${valor}\r\n`;

  let corpo = parte("file", csv, "leads.csv");
  const funil = campos.pipeline_id === null ? null : (campos.pipeline_id ?? FUNIL);
  const etapa = campos.stage_id === null ? null : (campos.stage_id ?? ETAPA);
  if (funil !== null) corpo += parte("pipeline_id", funil);
  if (etapa !== null) corpo += parte("stage_id", etapa);
  corpo += `--${B}--\r\n`;

  return new NextRequest("http://x/api/v1/leads/import", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${B}` },
    body: corpo,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessao("agent");
  vi.mocked(createLeadHandler).mockResolvedValue({ id: "lead" } as never);
});

describe("POST /api/v1/leads/import", () => {
  it("cria um negócio por linha, com a ORG da sessão", async () => {
    fazerSupabase(null);
    const { POST } = await import("@/app/api/v1/leads/import/route");

    const res = await POST(pedido("nome,valor\nAna,100\nBruno,200"));

    expect(res.status).toBe(200);
    expect(vi.mocked(createLeadHandler)).toHaveBeenCalledTimes(2);
    for (const [, ctx] of vi.mocked(createLeadHandler).mock.calls) {
      expect((ctx as { organization_id: string }).organization_id).toBe(ORG);
    }
  });

  it("uma linha ruim não derruba as outras — e o motivo volta com o número da linha", async () => {
    fazerSupabase(null);
    const { POST } = await import("@/app/api/v1/leads/import/route");

    const res = await POST(pedido("nome,valor\nAna,100\nBruno,doze mil\nCarla,300"));
    const corpo = (await res.json()) as { data: { criados: number; erros: { linha: number }[] } };

    expect(corpo.data.criados).toBe(2);
    expect(corpo.data.erros.map((e) => e.linha)).toEqual([3]);
  });

  it("uma ETAPA de outra organização derruba a importação inteira, e cedo", async () => {
    // Se a etapa não é desta org, ela não será na linha 2 nem na 300. Seguir
    // gastaria 300 tentativas para colher 300 vezes o mesmo erro.
    fazerSupabase(null);
    vi.mocked(createLeadHandler).mockRejectedValue(
      new ApiError(404, "not_found", undefined, "rid", "Stage não encontrado."),
    );
    const { POST } = await import("@/app/api/v1/leads/import/route");

    const res = await POST(pedido("nome\nAna\nBruno\nCarla"));

    expect(res.status).toBe(404);
    expect(vi.mocked(createLeadHandler)).toHaveBeenCalledTimes(1);
  });

  it("o mesmo telefone em três linhas vira UM contato", async () => {
    const espiao = fazerSupabase(null);
    const { POST } = await import("@/app/api/v1/leads/import/route");

    await POST(
      pedido(
        "nome,telefone\nAna,11988887777\nAna (2),(11) 98888-7777\nAna (3),+5511988887777",
      ),
    );

    expect(espiao.inseridos).toHaveLength(1);
  });

  it("contato que já existe é REUSADO, não duplicado", async () => {
    const espiao = fazerSupabase({ id: "contato-existente" });
    const { POST } = await import("@/app/api/v1/leads/import/route");

    await POST(pedido("nome,telefone\nAna,11988887777"));

    expect(espiao.inseridos).toHaveLength(0);
    expect(vi.mocked(createLeadHandler).mock.calls[0]![2]).toMatchObject({
      contact_id: "contato-existente",
    });
  });

  it("audita o GESTO, não só os 300 lead.created soltos", async () => {
    fazerSupabase(null);
    const { POST } = await import("@/app/api/v1/leads/import/route");

    await POST(pedido("nome\nAna\nBruno"));

    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lead.imported",
        organizationId: ORG,
        metadata: expect.objectContaining({ criados: 2 }),
      }),
    );
  });

  it("sem funil escolhido, 422 antes de ler o arquivo", async () => {
    fazerSupabase(null);
    const { POST } = await import("@/app/api/v1/leads/import/route");
    const res = await POST(pedido("nome\nAna", { pipeline_id: null, stage_id: null }));
    expect(res.status).toBe(422);
    expect(vi.mocked(createLeadHandler)).not.toHaveBeenCalled();
  });

  it("planilha sem coluna que nomeie o negócio é recusada com 422", async () => {
    fazerSupabase(null);
    const { POST } = await import("@/app/api/v1/leads/import/route");
    const res = await POST(pedido("valor,origem\n100,site"));
    expect(res.status).toBe(422);
    expect(vi.mocked(createLeadHandler)).not.toHaveBeenCalled();
  });

  it("viewer não importa", async () => {
    sessao("viewer");
    fazerSupabase(null);
    const { POST } = await import("@/app/api/v1/leads/import/route");
    const res = await POST(pedido("nome\nAna"));
    expect(res.status).toBe(403);
  });
});
