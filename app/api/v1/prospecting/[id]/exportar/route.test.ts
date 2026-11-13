// @vitest-environment node
/**
 * GET /api/v1/prospecting/:id/exportar — a lista da campanha como ARQUIVO
 * (issue #4360).
 *
 * O que este teste trava:
 *
 *   1. **Só a lista não abordada sai.** A empresa que já recebeu mensagem não
 *      aparece no CSV: quem já foi abordado não volta para outra campanha (a
 *      triagem recusa com "Contato já existe no CRM"), e o arquivo prometeria uma
 *      reimportação que não acontece.
 *   2. **É LEITURA.** A rota faz `select` e mais nada — nenhum contato, campanha
 *      ou candidato é criado. Exportar é devolver o que a tela mostra; gravar por
 *      baixo seria outra feature (e a origem da lista tem de ficar intacta).
 *   3. **Escopo da organização vem da sessão**, nunca da URL.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  auth: vi.fn(),
  pool: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: deps.auth,
  // O teto de escrita é cobrado pela cerca `rotas-bearer-aplicam-teto-de-escrita`
  // em TODA rota com `resolveAuthDual`; aqui ele devolve "dentro da cota" para o
  // caso medir a exportação, não o limitador. O 429 de verdade é provado em
  // `conversations/[id]/media/route.test.ts`.
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => deps.pool() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

import { GET } from "./route";
import { NextRequest } from "next/server";

const ORG = "99999999-9999-4999-8999-999999999999";
const CAMPANHA = "22222222-2222-4222-8222-222222222222";
const OUTRA_CAMPANHA = "22222222-2222-4222-8222-222222222223";
const USUARIO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function empresa(name: string, phone: string) {
  return {
    key: `place:${name}`,
    name,
    phone,
    website: null,
    category: "Serviços",
    address: "Rua X, 10",
    maps_url: null,
    rating: 4.5,
    reviews: 30,
    emails: [] as string[],
    socials: [] as string[],
  };
}

const CANDIDATOS = [
  // Ainda não abordada: entra no arquivo.
  { status: "new", attempted_at: null, phone: "+5511911110001", data: empresa("Padaria Nova", "+5511911110001") },
  { status: "queued", attempted_at: null, phone: "+5511911110002", data: empresa("Mercado Fila", "+5511911110002") },
  // Já abordada: fica de fora, com ou sem contato no CRM.
  { status: "sent", attempted_at: "2026-11-01T12:00:00.000Z", phone: "+5511911110003", data: empresa("Já Abordada", "+5511911110003") },
  { status: "skipped", attempted_at: null, phone: "+5511911110004", data: empresa("Contato Existente", "+5511911110004") },
];

type Consulta = { sql: string; params: unknown[] };

function banco(opcoes: { campanha?: { id: string; name: string } | null; candidatos?: unknown[] }) {
  const consultas: Consulta[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/from prospecting_campaigns/.test(sql)) {
      return { rows: opcoes.campanha ? [opcoes.campanha] : [] };
    }
    if (/from prospecting_candidates/.test(sql)) {
      return { rows: opcoes.candidatos ?? [] };
    }
    return { rows: [] };
  });
  return { query, consultas };
}

let fake: ReturnType<typeof banco>;

function pedido(id = CAMPANHA) {
  return new NextRequest(`http://localhost/api/v1/prospecting/${id}/exportar`, { method: "GET" });
}

function contexto(id = CAMPANHA) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = banco({ campanha: { id: CAMPANHA, name: "Clínicas" }, candidatos: CANDIDATOS });
  deps.pool.mockReturnValue({ query: fake.query });
  deps.auth.mockResolvedValue({
    ok: true,
    via: "session",
    organizationId: ORG,
    actor: { type: "user", id: USUARIO },
  });
  deps.audit.mockResolvedValue(undefined);
});

describe("quem pode baixar", () => {
  it("sem sessão, devolve a recusa da autenticação e não lê nada", async () => {
    deps.auth.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
    });
    const resposta = await GET(pedido(), contexto());
    expect(resposta.status).toBe(403);
    expect(fake.consultas).toEqual([]);
  });

  it("exige papel admin, como o resto da prospecção", async () => {
    await GET(pedido(), contexto());
    expect(deps.auth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ resource: "prospecting", role: "admin", scope: "mcp:read" }),
    );
  });
});

describe("a campanha é da organização da sessão", () => {
  it("campanha de outra organização é 404, e a busca filtra pela organização", async () => {
    fake = banco({ campanha: null });
    deps.pool.mockReturnValue({ query: fake.query });
    const resposta = await GET(pedido(OUTRA_CAMPANHA), contexto(OUTRA_CAMPANHA));
    expect(resposta.status).toBe(404);
    const campanhaSql = fake.consultas.find((c) => /from prospecting_campaigns/.test(c.sql));
    expect(campanhaSql?.params).toEqual([ORG, OUTRA_CAMPANHA]);
  });

  it("id que não é uuid não chega ao banco", async () => {
    const resposta = await GET(pedido("nao-e-uuid"), contexto("nao-e-uuid"));
    expect(resposta.status).toBe(400);
    expect(fake.consultas).toEqual([]);
  });
});

describe("o arquivo", () => {
  it("leva só as empresas ainda não abordadas", async () => {
    const resposta = await GET(pedido(), contexto());
    expect(resposta.status).toBe(200);

    const csv = await resposta.text();
    expect(csv).toContain("Padaria Nova");
    expect(csv).toContain("Mercado Fila");
    // Nada de quem já recebeu mensagem nem de quem já é contato do CRM.
    expect(csv).not.toContain("Já Abordada");
    expect(csv).not.toContain("+5511911110003");
    expect(csv).not.toContain("Contato Existente");
    expect(csv).not.toContain("+5511911110004");
  });

  it("sai como anexo CSV no formato da planilha de importação", async () => {
    const resposta = await GET(pedido(), contexto());

    expect(resposta.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(resposta.headers.get("cache-control")).toBe("no-store");
    expect(resposta.headers.get("content-disposition")).toContain("attachment");
    expect(resposta.headers.get("content-disposition")).toContain("lista-clinicas-");
    const csv = await resposta.text();
    expect(csv.replace("\uFEFF", "")).toMatch(/^empresa;telefone;site;segmento;endereco;email;redes\r\n/);
  });

  it("sem empresa abordável, 422 em vez de arquivo vazio", async () => {
    fake = banco({
      campanha: { id: CAMPANHA, name: "Clínicas" },
      candidatos: CANDIDATOS.filter((c) => c.status === "sent"),
    });
    deps.pool.mockReturnValue({ query: fake.query });
    const resposta = await GET(pedido(), contexto());
    expect(resposta.status).toBe(422);
    await expect(resposta.text()).resolves.toContain("não há lista para baixar");
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("a trilha registra QUANTAS empresas saíram, não o conteúdo", async () => {
    await GET(pedido(), contexto());

    expect(deps.audit).toHaveBeenCalledTimes(1);
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.exported",
        organizationId: ORG,
        actorUserId: USUARIO,
        metadata: { campaign_id: CAMPANHA, total: 4, nao_abordadas: 2 },
      }),
    );
  });

  it("é LEITURA: nenhuma escrita em contato, campanha ou candidato", async () => {
    await GET(pedido(), contexto());

    expect(fake.consultas.length).toBeGreaterThan(0);
    for (const consulta of fake.consultas) {
      expect(consulta.sql.trim().toLowerCase().startsWith("select")).toBe(true);
    }
  });
});
