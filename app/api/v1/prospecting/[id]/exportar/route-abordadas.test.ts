// @vitest-environment node
/**
 * GET /api/v1/prospecting/:id/exportar com a OPÇÃO NOVA da #4632: a lista da
 * campanha INTEIRA, inclusive as empresas já abordadas, com a marca do que foi
 * tentado (data em `abordada_em`, campanha em `campanha_anterior`).
 *
 * O que este arquivo trava, um caso por exigência da issue:
 *
 *   1. a lista PADRÃO não mudou: continua só com as não abordadas;
 *   2. com a opção, as já abordadas entram COM a marca — data e campanha de onde
 *      a abordagem saiu, lidas da trilha `prospecting.approach_sent`;
 *   3. campanha em que TODAS já foram abordadas ainda exporta (era o buraco do
 *      #4360: o botão sumia justamente na campanha que a pessoa quer reusar);
 *   4. opt-out e bloqueio continuam valendo com a opção nova: quem pediu para
 *      parar NUNCA volta para o arquivo (D13);
 *   5. a mesma empresa não duplica na mesma campanha — e, como o arquivo é por
 *      campanha, a mesma empresa sai uma vez em cada campanha em que estiver.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const deps = vi.hoisted(() => ({
  auth: vi.fn(),
  pool: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: deps.auth,
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => deps.pool() }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));

import { GET } from "./route";
import { NextRequest } from "next/server";

const ORG = "99999999-9999-4999-8999-999999999999";
const CAMPANHA = "22222222-2222-4222-8222-222222222222";
const CONTATO_ABORDADO = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CONTATO_OPT_OUT = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function empresa(name: string, phone: string) {
  return {
    name,
    phone,
    website: null,
    category: "Serviços",
    address: "Rua X, 10",
    emails: [] as string[],
    socials: [] as string[],
  };
}

type Linha = {
  status: string;
  attempted_at: string | null;
  place_id: string;
  phone: string;
  contact_id?: string | null;
  data: ReturnType<typeof empresa>;
  suprimida?: boolean;
  respondeu?: boolean;
  contatos?: unknown[];
};

const NAO_ABORDADA: Linha = {
  status: "new",
  attempted_at: null,
  place_id: "place-padaria",
  phone: "+551****0001",
  data: empresa("Padaria Nova", "+551****0001"),
};

const ABORDADA: Linha = {
  status: "sent",
  attempted_at: "2026-11-01T12:00:00.000Z",
  place_id: "place-clinica",
  phone: "+551****0003",
  contact_id: CONTATO_ABORDADO,
  data: empresa("Clínica Já Abordada", "+551****0003"),
};

/** A trilha da abordagem: a empresa já foi tentada por OUTRA campanha, noutro número. */
const TRILHA = [
  {
    contact_id: CONTATO_ABORDADO,
    campanha: "Clínicas — primeira oferta",
    em: "2026-11-01T12:00:00.000Z",
  },
];

const CONTATOS = [
  {
    id: CONTATO_ABORDADO,
    telefone: "+551****0003",
    is_blocked: false,
    is_personal: false,
    is_anonymized: false,
    consent: null,
  },
];

type Consulta = { sql: string; params: unknown[] };

function banco(opcoes: {
  campanha?: { id: string; name: string } | null;
  candidatos?: unknown[];
  contatos?: unknown[];
  trilha?: unknown[];
  fuso?: string | null;
}) {
  const consultas: Consulta[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/from prospecting_campaigns/.test(sql)) {
      return { rows: opcoes.campanha ? [opcoes.campanha] : [] };
    }
    if (/from prospecting_candidates/.test(sql)) return { rows: opcoes.candidatos ?? [] };
    if (/from contacts c/.test(sql)) return { rows: opcoes.contatos ?? [] };
    if (/from api_audit_log/.test(sql)) return { rows: opcoes.trilha ?? [] };
    if (/from organizations/.test(sql)) return { rows: [{ locale: null, timezone: opcoes.fuso ?? null }] };
    return { rows: [] };
  });
  return { query, consultas };
}

let fake: ReturnType<typeof banco>;

function pedido(busca = "") {
  return new NextRequest(`http://localhost/api/v1/prospecting/${CAMPANHA}/exportar${busca}`, {
    method: "GET",
  });
}

const contexto = { params: Promise.resolve({ id: CAMPANHA }) };

function linhasDoCsv(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split("\r\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  fake = banco({
    campanha: { id: CAMPANHA, name: "Clínicas — site" },
    candidatos: [NAO_ABORDADA, ABORDADA],
    contatos: CONTATOS,
    trilha: TRILHA,
  });
  deps.pool.mockReturnValue({ query: fake.query });
  deps.auth.mockResolvedValue({
    ok: true,
    via: "session",
    organizationId: ORG,
    actor: { type: "user", id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
  });
  deps.audit.mockResolvedValue(undefined);
});

describe("exportar a lista da campanha incluindo as empresas já abordadas", () => {
  it("lista padrão continua só com as não abordadas (controle)", async () => {
    const resposta = await GET(pedido(), contexto);

    expect(resposta.status).toBe(200);
    const csv = await resposta.text();
    const linhas = linhasDoCsv(csv);
    expect(linhas[0]).toBe("empresa;telefone;site;segmento;endereco;email;redes");
    expect(linhas[0]).not.toContain("abordada_em");
    expect(linhas[0]).not.toContain("campanha_anterior");
    expect(linhas).toHaveLength(2);
    expect(linhas[1]).toContain("Padaria Nova");
    // O CONTROLE: sem a opção, a abordada não aparece em nenhuma coluna.
    expect(csv).not.toContain("Clínica Já Abordada");
  });

  it("com a opção, vêm as já abordadas com a data e a campanha anterior", async () => {
    const resposta = await GET(pedido("?quem=todas"), contexto);

    expect(resposta.status).toBe(200);
    const linhas = linhasDoCsv(await resposta.text());
    expect(linhas[0]!.endsWith("situacao;abordada_em;campanha_anterior")).toBe(true);

    const abordada = linhas.find((l) => l.includes("Clínica Já Abordada"));
    expect(abordada).toBeDefined();
    // A marca: quando foi tentada e por qual campanha — não a exportada.
    expect(abordada).toContain("2026-11-01");
    expect(abordada).toContain("Clínicas — primeira oferta");
    expect(abordada).toContain("abordada");

    // A não abordada sai sem marca: as duas colunas ficam vazias, porque
    // "nunca tentamos" não é o mesmo que "tentamos na campanha exportada".
    const naoAbordada = linhas.find((l) => l.includes("Padaria Nova"))!;
    expect(naoAbordada).toContain("não abordada");
    expect(naoAbordada.trimEnd().endsWith(";;")).toBe(true);
  });

  // 00:30 de 04/11 em UTC é 21:30 de 03/11 em São Paulo e 00:30 de 04/11 em
  // Lisboa: o dia que a pessoa viveu depende do fuso da ORGANIZAÇÃO, e Lisboa
  // prova que a rota o lê, em vez de cair no padrão do produto.
  it.each([
    ["America/Sao_Paulo", "2026-11-03"],
    ["Europe/Lisbon", "2026-11-04"],
  ])("abordada_em é o dia no fuso da organização (%s), não o de UTC", async (fuso, dia) => {
    fake = banco({
      campanha: { id: CAMPANHA, name: "Clínicas — site" },
      candidatos: [{ ...ABORDADA, attempted_at: "2026-11-04T00:30:00.000Z", contact_id: null }],
      contatos: [],
      trilha: [],
      fuso,
    });
    deps.pool.mockReturnValue({ query: fake.query });

    const linhas = linhasDoCsv(await (await GET(pedido("?quem=todas"), contexto)).text());
    const abordada = linhas.find((l) => l.includes("Clínica Já Abordada"))!;
    expect(abordada).toContain(`;${dia};`);
  });

  it("campanha com todas as empresas já abordadas ainda exporta", async () => {
    fake = banco({
      campanha: { id: CAMPANHA, name: "Clínicas — site" },
      candidatos: [ABORDADA, { ...ABORDADA, place_id: "place-2", phone: "+551****0005", contact_id: null, data: empresa("Outra Abordada", "+551****0005") }],
      contatos: CONTATOS,
      trilha: TRILHA,
    });
    deps.pool.mockReturnValue({ query: fake.query });

    const resposta = await GET(pedido("?quem=todas"), contexto);
    expect(resposta.status).toBe(200);
    const linhas = linhasDoCsv(await resposta.text());
    expect(linhas).toHaveLength(3);

    // A lista de reimportar continua recusando — com mensagem, não arquivo vazio.
    const padrao = await GET(pedido(), contexto);
    expect(padrao.status).toBe(422);
    expect((await padrao.json()).error.message).toContain("ainda pode ser abordada");
  });

  it("opt-out fica fora mesmo com a opção", async () => {
    fake = banco({
      campanha: { id: CAMPANHA, name: "Clínicas — site" },
      candidatos: [
        ABORDADA,
        {
          ...NAO_ABORDADA,
          place_id: "place-optout",
          phone: "+551****0009",
          contact_id: CONTATO_OPT_OUT,
          data: empresa("Pediu Para Parar", "+551****0009"),
        },
      ],
      contatos: [
        ...CONTATOS,
        {
          id: CONTATO_OPT_OUT,
          telefone: "+551****0009",
          is_blocked: true,
          is_personal: false,
          is_anonymized: false,
          consent: null,
        },
      ],
      trilha: TRILHA,
    });
    deps.pool.mockReturnValue({ query: fake.query });

    const resposta = await GET(pedido("?quem=todas"), contexto);
    const csv = await resposta.text();
    expect(resposta.status).toBe(200);
    expect(csv).toContain("Clínica Já Abordada");
    expect(csv).not.toContain("Pediu Para Parar");

    // A mesma régua no contador que a tela mostra: 1 fora por ter pedido para parar.
    const resumo = await GET(pedido("?resumo=1"), contexto);
    const dados = (await resumo.json()).data;
    expect(dados.fora_da_lista.pediu_para_parar).toBe(1);
    expect(dados.todas).toBe(1);
  });

  it("a mesma empresa não duplica na mesma campanha", async () => {
    fake = banco({
      campanha: { id: CAMPANHA, name: "Clínicas — site" },
      // A MESMA empresa (mesmo place_id) em duas linhas: uma já abordada e uma
      // que voltou para a fila. Sai UMA linha, e é a abordada — a marca não pode
      // ser escondida pela linha sem tentativa.
      candidatos: [
        { ...NAO_ABORDADA, place_id: ABORDADA.place_id, phone: ABORDADA.phone },
        ABORDADA,
      ],
      contatos: CONTATOS,
      trilha: TRILHA,
    });
    deps.pool.mockReturnValue({ query: fake.query });

    const resposta = await GET(pedido("?quem=todas"), contexto);
    const linhas = linhasDoCsv(await resposta.text());
    expect(linhas).toHaveLength(2);
    expect(linhas.filter((l) => l.includes("Clínica Já Abordada"))).toHaveLength(1);
    expect(linhas[1]).toContain("2026-11-01");
  });
});
