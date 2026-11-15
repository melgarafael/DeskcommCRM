// @vitest-environment node
/**
 * GET /api/v1/prospecting/:id/exportar — a lista da campanha como ARQUIVO
 * (issue #4360).
 *
 * O que este teste trava:
 *
 *   1. **Por padrão, só a lista não abordada sai.** A empresa que já recebeu
 *      mensagem não aparece nesse CSV: quem já foi abordado não volta para outra
 *      campanha (a triagem recusa com "Contato já existe no CRM"). A lista
 *      inteira é pedida com `?quem=todas` e leva a coluna `situacao`; nas duas,
 *      quem pediu para parar, contato pessoal e dados apagados não saem (D13).
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

function banco(opcoes: {
  campanha?: { id: string; name: string } | null;
  candidatos?: unknown[];
  contatos?: unknown[];
  locale?: string | null;
}) {
  const consultas: Consulta[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/from prospecting_campaigns/.test(sql)) {
      return { rows: opcoes.campanha ? [opcoes.campanha] : [] };
    }
    if (/from prospecting_candidates/.test(sql)) {
      return { rows: opcoes.candidatos ?? [] };
    }
    if (/from contacts c/.test(sql)) {
      return { rows: opcoes.contatos ?? [] };
    }
    if (/from organizations/.test(sql)) {
      return { rows: [{ locale: opcoes.locale ?? null }] };
    }
    return { rows: [] };
  });
  return { query, consultas };
}

let fake: ReturnType<typeof banco>;

function pedido(id = CAMPANHA, busca = "") {
  return new NextRequest(`http://localhost/api/v1/prospecting/${id}/exportar${busca}`, { method: "GET" });
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
        metadata: {
          campaign_id: CAMPANHA,
          quem: "nao_abordadas",
          total: 4,
          nao_abordadas: 2,
          todas: 4,
          fora_da_lista: { dados_apagados: 0, pediu_para_parar: 0, ficha_pessoal: 0 },
        },
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

/**
 * A LISTA INTEIRA (`?quem=todas`) e a contagem do menu (`?resumo=1`).
 *
 * Campanha CONCLUÍDA: todo mundo já foi abordado. O arquivo das não abordadas
 * não tem o que levar (era aí que o botão sumia); a lista inteira leva as M
 * empresas que podem sair, com a situação, e nenhuma das que nunca saem (D13).
 */
describe("a lista inteira da campanha concluída", () => {
  const BLOQUEADO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
  const PESSOAL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
  const enviada = (nome: string, telefone: string, extra: Record<string, unknown> = {}) => ({
    status: "sent",
    attempted_at: "2026-11-01T12:00:00.000Z",
    phone: telefone,
    contact_id: null,
    suprimida: false,
    respondeu: false,
    data: empresa(nome, telefone),
    ...extra,
  });
  const CONCLUIDA = [
    enviada("Sem Resposta", "+5511911110001"),
    enviada("Respondeu Sim", "+5511911110002", { respondeu: true }),
    enviada("Pediu Parar", "+5511911110003", { contact_id: BLOQUEADO }),
    enviada("Contato Pessoal", "+5511987650004"),
    enviada("Recusou Marketing", "+5511911110005"),
    { ...enviada("Cliente Anonimizado #9", "", { phone: null, suprimida: true }), status: "skipped" },
  ];
  const CONTATOS = [
    { id: BLOQUEADO, telefone: "+5511911110003", is_blocked: true, is_personal: false, is_anonymized: false, consent: {} },
    // Achado pelo telefone extra, na grafia sem o nono dígito.
    { id: PESSOAL, telefone: "+551187650004", is_blocked: false, is_personal: true, is_anonymized: false, consent: {} },
    {
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb3",
      telefone: "+5511911110005",
      is_blocked: false,
      is_personal: false,
      is_anonymized: false,
      consent: { marketing: { declined_at: "2026-11-02T00:00:00.000Z" } },
    },
  ];

  beforeEach(() => {
    fake = banco({ campanha: { id: CAMPANHA, name: "Clínicas" }, candidatos: CONCLUIDA, contatos: CONTATOS });
    deps.pool.mockReturnValue({ query: fake.query });
  });

  it("leva as M empresas com a situação, e ninguém que pediu para parar, é pessoal ou foi apagado", async () => {
    const resposta = await GET(pedido(CAMPANHA, "?quem=todas"), contexto());
    expect(resposta.status).toBe(200);
    expect(resposta.headers.get("content-disposition")).toContain("lista-completa-clinicas-");

    const csv = (await resposta.text()).replace("\uFEFF", "");
    const [cabecalho, ...linhas] = csv.trim().split("\r\n");
    expect(cabecalho).toBe("empresa;telefone;site;segmento;endereco;email;redes;situacao");
    expect(linhas).toHaveLength(2);
    expect(linhas[0]).toMatch(/^Sem Resposta;\+5511911110001;.*;abordada$/);
    expect(linhas[1]).toMatch(/^Respondeu Sim;\+5511911110002;.*;respondeu$/);
    for (const vetado of ["Pediu Parar", "Contato Pessoal", "Recusou Marketing", "Anonimizado"])
      expect(csv).not.toContain(vetado);
  });

  it("a lista das não abordadas continua recusando a campanha concluída", async () => {
    const resposta = await GET(pedido(), contexto());
    expect(resposta.status).toBe(422);
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("a contagem do menu sai da mesma leitura, e contar não vai para a auditoria", async () => {
    const resposta = await GET(pedido(CAMPANHA, "?resumo=1"), contexto());
    expect(resposta.status).toBe(200);
    await expect(resposta.json()).resolves.toEqual({
      data: {
        total: 6,
        nao_abordadas: 0,
        todas: 2,
        fora_da_lista: { dados_apagados: 1, pediu_para_parar: 2, ficha_pessoal: 1 },
        truncada: false,
      },
    });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("os contatos são lidos só da organização da sessão, pelo vínculo e pelas duas grafias do telefone", async () => {
    await GET(pedido(CAMPANHA, "?quem=todas"), contexto());
    const sql = fake.consultas.find((c) => /from contacts c/.test(c.sql));
    expect(sql?.params[0]).toBe(ORG);
    expect(sql?.params[1]).toEqual([BLOQUEADO]);
    expect(sql?.params[2]).toEqual(expect.arrayContaining(["+5511987650004", "+551187650004"]));
    // As DUAS metades da união filtram a organização: este pool passa por cima
    // da RLS, e um contato bloqueado de outra empresa com o mesmo telefone não
    // pode tirar ninguém da lista daqui (nem aparecer no resumo dela).
    expect(sql?.sql).toMatch(/from contacts c\s+where c\.organization_id=\$1 and \(c\.id=any/);
    expect(sql?.sql).toMatch(/cp\.organization_id=\$1 and c\.organization_id=\$1/);
    expect(sql?.sql).toMatch(/join contacts c on c\.organization_id=cp\.organization_id and c\.id=cp\.contact_id/);
    // E as linhas da campanha, inclusive a conversa que diz quem respondeu.
    const linhasSql = fake.consultas.find((c) => /from prospecting_candidates/.test(c.sql));
    expect(linhasSql?.params.slice(0, 2)).toEqual([ORG, CAMPANHA]);
    expect(linhasSql?.sql).toMatch(/where p\.organization_id=\$1 and p\.campaign_id=\$2/);
    expect(linhasSql?.sql).toMatch(/v\.organization_id=p\.organization_id and v\.id=p\.conversation_id/);
  });

  it("tentativa sem envio confirmado não sai como `abordada`", async () => {
    fake = banco({
      campanha: { id: CAMPANHA, name: "Clínicas" },
      candidatos: [{ ...enviada("IA Sem Texto", "+5511911110008"), status: "failed" }],
    });
    deps.pool.mockReturnValue({ query: fake.query });
    const csv = await (await GET(pedido(CAMPANHA, "?quem=todas"), contexto())).text();
    expect(csv).toContain(";envio não confirmado\r\n");
    expect(csv).not.toContain(";abordada\r\n");
  });

  it("a situação sai no idioma da organização", async () => {
    fake = banco({ campanha: { id: CAMPANHA, name: "Clínicas" }, candidatos: CONCLUIDA, contatos: CONTATOS, locale: "es" });
    deps.pool.mockReturnValue({ query: fake.query });
    const csv = await (await GET(pedido(CAMPANHA, "?quem=todas"), contexto())).text();
    expect(csv).toContain(";contactada\r\n");
    expect(csv).toContain(";respondió\r\n");
  });

  it("a auditoria diz qual lista saiu e quantas ficaram de fora", async () => {
    await GET(pedido(CAMPANHA, "?quem=todas"), contexto());
    expect(deps.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "prospecting.exported",
        metadata: expect.objectContaining({
          quem: "todas",
          todas: 2,
          fora_da_lista: { dados_apagados: 1, pediu_para_parar: 2, ficha_pessoal: 1 },
        }),
      }),
    );
  });

  it("lista desconhecida é 422 e não chega ao banco", async () => {
    const resposta = await GET(pedido(CAMPANHA, "?quem=tudo"), contexto());
    expect(resposta.status).toBe(422);
    expect(fake.consultas).toEqual([]);
  });

  it("é LEITURA também na lista inteira", async () => {
    await GET(pedido(CAMPANHA, "?quem=todas"), contexto());
    for (const consulta of fake.consultas)
      expect(consulta.sql.trim().toLowerCase().startsWith("select")).toBe(true);
  });
});
