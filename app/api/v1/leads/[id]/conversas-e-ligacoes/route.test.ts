/**
 * GET /api/v1/leads/[id]/conversas-e-ligacoes — a leitura agregada dos números
 * do cliente (#3669, fatia 1).
 *
 * O que este arquivo prova, e por que cada um é um lado oposto:
 *
 *  - **GREEN**: a conversa e a ligação do SEGUNDO número (o relacionado)
 *    aparecem junto com as do principal, numa resposta só;
 *  - **outra organização**: linha de contato com org diferente (o link forjado,
 *    que `target_id` não sendo FK permite) não entra na lista E o id dela não
 *    chega ao `.in()` de conversas nem de ligações — é o vazamento que a RLS
 *    pegaria e que não pode depender dela;
 *  - **sem pessoa relacionada**: o negócio mostra exatamente o que mostrava —
 *    só o principal, nada a mais;
 *  - **limite**: vale para o TOTAL da lista, não por contato (duas pessoas e um
 *    limite de 2 devolvem 2, não 4), e `has_more` diz que houve corte;
 *  - **sem N+1**: cinco consultas fixas, e uma única consulta a conversas com
 *    todos os ids;
 *  - **linha do tempo**: conversas e ligações de todos os números no mesmo fio,
 *    por data, cada item com a origem, e o cursor não repete nem pula;
 *  - **permissão**: negócio que a RLS não devolve é 404 e NÃO faz nenhuma
 *    leitura de conversa ou ligação.
 *
 * Roda com: NODE_OPTIONS=--max-old-space-size=5800 npx vitest run \
 *   "app/api/v1/leads/[id]/conversas-e-ligacoes/route.test.ts"
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Linha = Record<string, unknown>;
type Resposta = { data: unknown; error: { message: string } | null };

const estado = vi.hoisted(() => ({
  orgId: "22222222-2222-4222-8222-222222222222",
  outraOrg: "99999999-9999-4999-8999-999999999999",
  leadId: "11111111-1111-4111-8111-111111111111",
  principal: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  segundo: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  intruso: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  lead: null as Linha | null,
  erros: {} as Record<string, { message: string } | null>,
  links: [] as Linha[],
  contatos: [] as Linha[],
  conversas: [] as Linha[],
  ligacoes: [] as Linha[],
  tabelas: [] as string[],
  filtros: [] as Array<{ tabela: string; metodo: string; coluna?: string; valor?: unknown }>,
  limites: [] as Array<{ tabela: string; n: number }>,
}));

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: async () => ({ idioma: "pt-BR" }) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    /** Divide `a,b,and(c,d)` nos termos de fora, respeitando os parênteses. */
    const dividir = (expr: string): string[] => {
      const termos: string[] = [];
      let atual = "";
      let fundo = 0;
      for (const ch of expr) {
        if (ch === "(") fundo += 1;
        if (ch === ")") fundo -= 1;
        if (ch === "," && fundo === 0) {
          termos.push(atual);
          atual = "";
        } else atual += ch;
      }
      if (atual.trim() !== "") termos.push(atual);
      return termos;
    };

    /**
     * O banco compara de verdade. Emular `eq`/`in`/`lt`/`lte`/`or` é requisito
     * do teste do cursor: com um mock que ignora filtro, "não repete nem pula"
     * passaria mesmo se a rota pedisse a tabela inteira.
     */
    const avaliar = (linha: Linha, termo: string): boolean => {
      const t = termo.trim();
      if (t.startsWith("and(") && t.endsWith(")")) {
        return dividir(t.slice(4, -1)).every((parte) => avaliar(linha, parte));
      }
      const [coluna, operador, ...resto] = t.split(".");
      const alvo = resto.join(".");
      const valor = linha[coluna!];
      if (operador === "is") return alvo === "null" ? valor === null || valor === undefined : false;
      if (operador === "eq") return String(valor) === alvo;
      if (operador === "lt" || operador === "lte") {
        if (valor === null || valor === undefined) return false;
        return operador === "lt" ? String(valor) < alvo : String(valor) <= alvo;
      }
      throw new Error(`operador não emulado no teste: ${operador}`);
    };

    return {
      auth: { getUser: async () => ({ data: { user: { id: "u-ana" } }, error: null }) },
      from: (tabela: string) => {
        estado.tabelas.push(tabela);
        const ordens: Array<[string, { ascending?: boolean; nullsFirst?: boolean }]> = [];
        const condicoes: Array<(linha: Linha) => boolean> = [];
        const resposta = (): Resposta => {
          if (estado.erros[tabela]) return { data: null, error: estado.erros[tabela]! };
          if (tabela === "crm_leads") return { data: estado.lead, error: null };
          if (tabela === "crm_lead_links") return { data: estado.links, error: null };
          if (tabela === "contacts") return { data: estado.contatos, error: null };
          if (tabela === "conversations") return { data: estado.conversas, error: null };
          if (tabela === "voice_calls") return { data: estado.ligacoes, error: null };
          return { data: [], error: null };
        };
        let limitePedido: number | null = null;
        const ordenada = (): Resposta => {
          const r = resposta();
          if (r.error || !Array.isArray(r.data)) return r;
          const linhas = [...(r.data as Linha[])].filter((linha) =>
            condicoes.every((condicao) => condicao(linha)),
          );
          // O banco ordena de verdade: sem isto, `order()` seria decoração e o
          // teste de ordenação passaria com a ordem de inserção do fixture.
          // O PRIMEIRO `order()` é o critério principal (como no Postgres), e
          // `sort` é estável — por isso a lista é aplicada de trás para frente.
          for (const [coluna, opcoes] of [...ordens].reverse()) {
            const asc = opcoes.ascending !== false;
            linhas.sort((a, b) => {
              const va = a[coluna] as string | null | undefined;
              const vb = b[coluna] as string | null | undefined;
              if (va === vb) return 0;
              if (va === null || va === undefined) return opcoes.nullsFirst ? -1 : 1;
              if (vb === null || vb === undefined) return opcoes.nullsFirst ? 1 : -1;
              return (va < vb ? -1 : 1) * (asc ? 1 : -1);
            });
          }
          return { data: limitePedido === null ? linhas : linhas.slice(0, limitePedido), error: null };
        };
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: (coluna: string, valor: unknown) => {
            estado.filtros.push({ tabela, metodo: "eq", coluna, valor });
            condicoes.push((linha) => String(linha[coluna]) === String(valor));
            return cadeia;
          },
          in: (coluna: string, valor: unknown) => {
            estado.filtros.push({ tabela, metodo: "in", coluna, valor });
            const aceitos = (valor as unknown[]).map(String);
            condicoes.push((linha) => aceitos.includes(String(linha[coluna])));
            return cadeia;
          },
          or: (filtro: string) => {
            estado.filtros.push({ tabela, metodo: "or", coluna: filtro });
            condicoes.push((linha) => dividir(filtro).some((termo) => avaliar(linha, termo)));
            return cadeia;
          },
          lt: (coluna: string, valor: string) => {
            estado.filtros.push({ tabela, metodo: "lt", coluna, valor });
            condicoes.push((linha) => avaliar(linha, `${coluna}.lt.${valor}`));
            return cadeia;
          },
          lte: (coluna: string, valor: string) => {
            estado.filtros.push({ tabela, metodo: "lte", coluna, valor });
            condicoes.push((linha) => avaliar(linha, `${coluna}.lte.${valor}`));
            return cadeia;
          },
          is: (coluna: string, valor: null) => {
            estado.filtros.push({ tabela, metodo: "is", coluna, valor });
            condicoes.push((linha) => avaliar(linha, `${coluna}.is.${valor === null ? "null" : valor}`));
            return cadeia;
          },
          order: (coluna: string, opcoes?: { ascending?: boolean; nullsFirst?: boolean }) => {
            ordens.push([coluna, opcoes ?? {}]);
            return cadeia;
          },
          limit: (n: number) => {
            estado.limites.push({ tabela, n });
            limitePedido = n;
            return cadeia;
          },
          maybeSingle: async () => resposta(),
          then: (ok: (r: Resposta) => unknown, erro?: (e: unknown) => unknown) =>
            Promise.resolve(ordenada()).then(ok, erro),
        };
        return cadeia;
      },
    };
  },
}));

import { GET } from "./route";

async function pergunta(id = estado.leadId, query = "") {
  const res = await GET(new NextRequest(`http://localhost/api/v1/leads/${id}/conversas-e-ligacoes${query}`), {
    params: Promise.resolve({ id }),
  });
  return {
    status: res.status,
    corpo: (await res.json()) as {
      data?: {
        numeros: Array<{ contact_id: string; nome: string | null; papel: string; telefone?: string }>;
        conversas: Array<{ id: string; contact_id: string; nao_lidas: number }>;
        ligacoes: Array<{ id: string; contact_id: string; atendida: boolean; em_andamento: boolean }>;
        linha_do_tempo: Array<{
          tipo: "conversa" | "ligacao";
          id: string;
          contact_id: string;
          nome: string | null;
          telefone?: string;
          em: string | null;
        }>;
      };
      meta?: {
        limite: number;
        tem_mais_conversas: boolean;
        tem_mais_ligacoes: boolean;
        tem_mais: boolean;
        proximo_cursor: string | null;
      };
      error?: { code: string; message: string };
    },
  };
}

function contato(id: string, nome: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: estado.orgId,
    name: nome,
    display_name: null,
    phone_number: "+5511999990000",
    is_anonymized: false,
    ...extra,
  };
}

function conversa(id: string, contactId: string, quando: string, extra: Linha = {}): Linha {
  return {
    id,
    contact_id: contactId,
    organization_id: estado.orgId,
    last_message_preview: "previa",
    last_message_at: quando,
    unread_count_for_assignee: 0,
    ...extra,
  };
}

function ligacao(id: string, contactId: string, quando: string, extra: Linha = {}): Linha {
  return {
    id,
    contact_id: contactId,
    organization_id: estado.orgId,
    direction: "inbound",
    status: "ended",
    started_at: quando,
    answered_at: quando,
    duration_ms: 42000,
    end_reason: "user_ended",
    ...extra,
  };
}

/** Um vínculo de "Pessoa relacionada", como `crm_lead_links` guarda. */
function vinculo(targetId: string, papel: string, org = estado.orgId): Linha {
  return {
    lead_id: estado.leadId,
    organization_id: org,
    target_kind: "contact",
    link_kind: "related",
    target_id: targetId,
    metadata: { papel },
  };
}

beforeEach(() => {
  estado.lead = { id: estado.leadId, organization_id: estado.orgId, contact_id: estado.principal };
  estado.erros = {};
  estado.links = [vinculo(estado.segundo, "comprador")];
  estado.contatos = [
    contato(estado.principal, "Dono da loja"),
    contato(estado.segundo, "Comprador", { phone_number: "+5511988887777" }),
  ];
  estado.conversas = [
    conversa("conv-principal", estado.principal, "2026-11-01T10:00:00.000Z"),
    conversa("conv-segundo", estado.segundo, "2026-11-02T10:00:00.000Z", {
      last_message_preview: "manda o pedido",
      unread_count_for_assignee: 3,
    }),
  ];
  estado.ligacoes = [
    ligacao("call-principal", estado.principal, "2026-11-01T09:00:00.000Z"),
    ligacao("call-segundo", estado.segundo, "2026-11-02T09:00:00.000Z", {
      direction: "outbound",
      answered_at: null,
      status: "ended",
      end_reason: "busy",
      duration_ms: null,
    }),
  ];
  estado.tabelas = [];
  estado.filtros = [];
  estado.limites = [];
});

describe("GET /api/v1/leads/[id]/conversas-e-ligacoes (#3669)", () => {
  it("⭐ a conversa e a ligação do 2º número aparecem junto com as do principal", async () => {
    const { status, corpo } = await pergunta();

    expect(status).toBe(200);
    expect(corpo.data!.numeros.map((n) => [n.contact_id, n.papel])).toEqual([
      [estado.principal, "principal"],
      [estado.segundo, "relacionado"],
    ]);
    // A pessoa relacionada vem com nome, telefone próprio e o papel do vínculo.
    expect(corpo.data!.numeros[1]).toMatchObject({
      nome: "Comprador",
      telefone: "+5511988887777",
      papel_do_vinculo: "comprador",
    });

    // O defeito de hoje, como asserção: a conversa do segundo número tem de
    // estar aqui, e não só a do `crm_leads.contact_id`.
    expect(corpo.data!.conversas.map((c) => c.id)).toEqual(["conv-segundo", "conv-principal"]);
    expect(corpo.data!.conversas[0]).toMatchObject({ contact_id: estado.segundo, nao_lidas: 3 });

    // E a ligação do segundo número, com o estado que a tela vai pintar:
    // não atendida (sem `answered_at`), encerrada.
    const doSegundo = corpo.data!.ligacoes.find((l) => l.contact_id === estado.segundo)!;
    expect(doSegundo).toMatchObject({ atendida: false, em_andamento: false });
  });

  it("⭐ SEM pessoa relacionada: exatamente o que o negócio mostrava — só o principal", async () => {
    estado.links = [];
    estado.contatos = [contato(estado.principal, "Dono da loja")];
    estado.conversas = [conversa("conv-principal", estado.principal, "2026-11-01T10:00:00.000Z")];
    estado.ligacoes = [ligacao("call-principal", estado.principal, "2026-11-01T09:00:00.000Z")];

    const { corpo } = await pergunta();

    expect(corpo.data!.numeros).toHaveLength(1);
    expect(corpo.data!.numeros[0]!.papel).toBe("principal");
    expect(corpo.data!.conversas.map((c) => c.id)).toEqual(["conv-principal"]);
    expect(corpo.data!.ligacoes.map((l) => l.id)).toEqual(["call-principal"]);
  });

  it("⭐ contato de OUTRA organização (link forjado) não entra nem vira id na consulta", async () => {
    estado.links = [
      vinculo(estado.segundo, "comprador"),
      // `crm_lead_links.target_id` não é FK: este vínculo pode existir no banco.
      vinculo(estado.intruso, "dono"),
    ];
    estado.contatos = [
      contato(estado.principal, "Dono da loja"),
      contato(estado.segundo, "Comprador"),
      contato(estado.intruso, "Cliente de outra empresa", { organization_id: estado.outraOrg }),
    ];

    const { corpo } = await pergunta();

    expect(corpo.data!.numeros.map((n) => n.contact_id)).toEqual([estado.principal, estado.segundo]);

    const idsConsultados = estado.filtros.filter(
      (f) => f.metodo === "in" && f.coluna === "contact_id",
    );
    // Uma consulta para conversas e uma para ligações — e nenhuma delas leva o
    // id da outra organização.
    expect(idsConsultados.length).toBe(2);
    for (const filtro of idsConsultados) {
      expect(filtro.valor).toEqual([estado.principal, estado.segundo]);
      expect(filtro.valor).not.toContain(estado.intruso);
    }
  });

  it("⭐ o limite é do TOTAL da lista, não por contato", async () => {
    // Duas pessoas, três conversas e três ligações: com limite 2, a resposta
    // traz DUAS de cada — e não duas por pessoa.
    estado.conversas = [
      conversa("c1", estado.segundo, "2026-11-03T10:00:00.000Z"),
      conversa("c2", estado.segundo, "2026-11-02T10:00:00.000Z"),
      conversa("c3", estado.principal, "2026-11-01T10:00:00.000Z"),
    ];
    estado.ligacoes = [
      ligacao("l1", estado.segundo, "2026-11-03T09:00:00.000Z"),
      ligacao("l2", estado.principal, "2026-11-02T09:00:00.000Z"),
      ligacao("l3", estado.principal, "2026-11-01T09:00:00.000Z"),
    ];

    const { corpo } = await pergunta(estado.leadId, "?limit=2");

    expect(corpo.meta).toMatchObject({ limite: 2, tem_mais_conversas: true, tem_mais_ligacoes: true });
    expect(corpo.data!.conversas.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(corpo.data!.ligacoes.map((l) => l.id)).toEqual(["l1", "l2"]);
    // `limite + 1` em cada consulta: é assim que "tem mais" é sabido sem
    // `count(*)` — e UMA consulta por tabela, não uma por pessoa.
    expect(estado.limites).toEqual([
      { tabela: "conversations", n: 3 },
      { tabela: "voice_calls", n: 3 },
    ]);
  });

  it("⭐ sem N+1: cinco consultas fixas, com todos os números de uma vez", async () => {
    await pergunta();

    expect(estado.tabelas).toEqual([
      "crm_leads",
      "crm_lead_links",
      "contacts",
      "conversations",
      "voice_calls",
    ]);
    const sobreConversas = estado.filtros.filter((f) => f.tabela === "conversations");
    expect(sobreConversas.filter((f) => f.metodo === "in")).toHaveLength(1);
    // Filtro de organização EXPLÍCITO, além da RLS (doutrina multi-tenancy).
    for (const tabela of ["crm_lead_links", "contacts", "conversations", "voice_calls"]) {
      expect(
        estado.filtros.some(
          (f) => f.tabela === tabela && f.metodo === "eq" && f.coluna === "organization_id" && f.valor === estado.orgId,
        ),
        `a consulta de ${tabela} não filtra a organização`,
      ).toBe(true);
    }
  });

  it("⭐ quem não vê o negócio não vê os números dele: 404 e nenhuma leitura de conversa", async () => {
    estado.lead = null; // a RLS do caller não devolve a linha

    const { status, corpo } = await pergunta();

    expect(status).toBe(404);
    expect(corpo.error?.code).toBe("not_found");
    expect(estado.tabelas).toEqual(["crm_leads"]);
  });

  it("negócio sem contato nenhum: resposta vazia, sem consultar conversa", async () => {
    estado.lead = { id: estado.leadId, organization_id: estado.orgId, contact_id: null };
    estado.links = [];

    const { status, corpo } = await pergunta();

    expect(status).toBe(200);
    expect(corpo.data).toEqual({ numeros: [], conversas: [], ligacoes: [], linha_do_tempo: [] });
    expect(estado.tabelas).not.toContain("conversations");
  });

  it("falha ao ler as conversas é 500, não lista vazia (erro ≠ silêncio)", async () => {
    estado.erros.conversations = { message: "boom" };

    const { status, corpo } = await pergunta();

    expect(status).toBe(500);
    expect(corpo.error?.code).toBe("internal_error");
  });

  it("a pessoa anonimizada não expõe o telefone, e continua na lista", async () => {
    estado.contatos = [
      contato(estado.principal, "Dono da loja"),
      contato(estado.segundo, "Comprador", { is_anonymized: true, phone_number: "+5511988887777" }),
    ];

    const { corpo } = await pergunta();

    expect(corpo.data!.numeros[1]).not.toHaveProperty("telefone");
    expect(corpo.data!.numeros[1]!.nome).toBe("Comprador");
  });
});

/**
 * A LINHA DO TEMPO — a leitura que a tela usa (#3669, fatia 1).
 *
 * As listas por tipo resolveram "o segundo número aparece"; estas provas são do
 * fio único: ordem por data, origem em cada item, cursor que não repete nem
 * pula, organização que não vaza, e o negócio de UM número idêntico ao de antes.
 */
describe("a linha do tempo de todos os números (#3669)", () => {
  it("⭐ duas pessoas: conversas e ligações das duas no mesmo fio, por data", async () => {
    estado.conversas = [
      conversa("conv-principal", estado.principal, "2026-11-01T10:00:00.000Z"),
      conversa("conv-segundo", estado.segundo, "2026-11-04T10:00:00.000Z"),
    ];
    estado.ligacoes = [
      ligacao("call-principal", estado.principal, "2026-11-03T09:00:00.000Z"),
      ligacao("call-segundo", estado.segundo, "2026-11-05T09:00:00.000Z"),
    ];

    const { corpo } = await pergunta();

    // Intercalado por data, mais recente primeiro — e não "conversas, depois
    // ligações". O item é de uma pessoa OU de outra, misturados.
    expect(corpo.data!.linha_do_tempo.map((i) => [i.tipo, i.id])).toEqual([
      ["ligacao", "call-segundo"],
      ["conversa", "conv-segundo"],
      ["ligacao", "call-principal"],
      ["conversa", "conv-principal"],
    ]);
    const datas = corpo.data!.linha_do_tempo.map((i) => i.em!);
    expect([...datas].sort().reverse()).toEqual(datas);
    // O limite da linha do tempo é o do fio inteiro, não o de cada lista.
    expect(corpo.meta).toMatchObject({ tem_mais: false, proximo_cursor: null });
  });

  it("⭐ cada item diz de qual número falou (nome e telefone do contato)", async () => {
    estado.conversas = [conversa("conv-segundo", estado.segundo, "2026-11-04T10:00:00.000Z")];
    estado.ligacoes = [ligacao("call-principal", estado.principal, "2026-11-03T09:00:00.000Z")];

    const { corpo } = await pergunta();
    // 11-04 vem antes de 11-03: a conversa é o primeiro item do fio.
    const [daConversa, daLigacao] = corpo.data!.linha_do_tempo;

    expect(daConversa).toMatchObject({
      contact_id: estado.segundo,
      nome: "Comprador",
      telefone: "+5511988887777",
    });
    expect(daLigacao).toMatchObject({ contact_id: estado.principal, nome: "Dono da loja" });
    // O telefone é o da pessoa que falou — não o do card.
    expect(daLigacao!.telefone).not.toBe(daConversa!.telefone);
  });

  it("⭐ cursor: a página seguinte continua de onde a anterior parou, sem repetir nem pular", async () => {
    // As colunas são uuid, e o cursor só aceita uuid: o fixture fala a língua do banco.
    const ID = {
      c1: "c1000000-0000-4000-8000-000000000001",
      c2: "c2000000-0000-4000-8000-000000000002",
      c3: "c3000000-0000-4000-8000-000000000003",
      l1: "d1000000-0000-4000-8000-000000000001",
      l2: "d2000000-0000-4000-8000-000000000002",
    };
    estado.conversas = [
      conversa(ID.c1, estado.segundo, "2026-11-05T10:00:00.000Z"),
      conversa(ID.c2, estado.segundo, "2026-11-03T10:00:00.000Z"),
      conversa(ID.c3, estado.principal, "2026-11-01T10:00:00.000Z"),
    ];
    estado.ligacoes = [
      ligacao(ID.l1, estado.principal, "2026-11-04T09:00:00.000Z"),
      ligacao(ID.l2, estado.segundo, "2026-11-02T09:00:00.000Z"),
    ];

    const primeira = await pergunta(estado.leadId, "?limit=2");
    expect(primeira.corpo.data!.linha_do_tempo.map((i) => i.id)).toEqual([ID.c1, ID.l1]);
    expect(primeira.corpo.meta?.tem_mais).toBe(true);

    const cursor1 = primeira.corpo.meta!.proximo_cursor!;
    expect(cursor1).toBeTruthy();

    const segunda = await pergunta(estado.leadId, `?limit=2&cursor=${encodeURIComponent(cursor1)}`);
    expect(segunda.corpo.data!.linha_do_tempo.map((i) => i.id)).toEqual([ID.c2, ID.l2]);
    // Nada da página 1 volta na página 2.
    expect(segunda.corpo.data!.linha_do_tempo.map((i) => i.id)).not.toContain(ID.c1);
    expect(segunda.corpo.data!.linha_do_tempo.map((i) => i.id)).not.toContain(ID.l1);

    const terceira = await pergunta(
      estado.leadId,
      `?limit=2&cursor=${encodeURIComponent(segunda.corpo.meta!.proximo_cursor!)}`,
    );
    expect(terceira.corpo.data!.linha_do_tempo.map((i) => i.id)).toEqual([ID.c3]);
    expect(terceira.corpo.meta).toMatchObject({ tem_mais: false, proximo_cursor: null });

    // A união das páginas é a lista inteira, na ordem — sem buraco.
    const todos = [
      ...primeira.corpo.data!.linha_do_tempo.map((i) => i.id),
      ...segunda.corpo.data!.linha_do_tempo.map((i) => i.id),
      ...terceira.corpo.data!.linha_do_tempo.map((i) => i.id),
    ];
    expect(todos).toEqual([ID.c1, ID.l1, ID.c2, ID.l2, ID.c3]);
    expect(new Set(todos).size).toBe(todos.length);

    // Cursor de fora é dado de fora: quebrado é 400, não página errada.
    const quebrado = await pergunta(estado.leadId, "?cursor=nao-e-um-cursor");
    expect(quebrado.status).toBe(400);
    expect(quebrado.corpo.error?.code).toBe("invalid_cursor");
  });

  it("cursor com data fora do ISO do banco é 400, não 500 (vírgula não entra no or())", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ e: "Jan 1 2026 (a,b)", t: "conversa", i: "c1000000-0000-4000-8000-000000000001" }),
      "utf8",
    ).toString("base64url");
    const { status, corpo } = await pergunta(estado.leadId, `?cursor=${cursor}`);
    expect(status).toBe(400);
    expect(corpo.error?.code).toBe("invalid_cursor");
    expect(estado.tabelas).not.toContain("conversations");
  });

  it("cursor com id que não é uuid é 400, não 500 (a coluna id é uuid)", async () => {
    const cursor = Buffer.from(
      JSON.stringify({ e: "2026-11-01T10:00:00.123456+00:00", t: "conversa", i: "x" }),
      "utf8",
    ).toString("base64url");
    const { status, corpo } = await pergunta(estado.leadId, `?cursor=${cursor}`);
    expect(status).toBe(400);
    expect(corpo.error?.code).toBe("invalid_cursor");
    expect(estado.tabelas).not.toContain("conversations");
  });

  it("⭐ pessoa de OUTRA organização não aparece na linha do tempo", async () => {
    estado.links = [vinculo(estado.segundo, "comprador"), vinculo(estado.intruso, "dono")];
    estado.contatos = [
      contato(estado.principal, "Dono da loja"),
      contato(estado.segundo, "Comprador"),
      contato(estado.intruso, "Cliente de outra empresa", { organization_id: estado.outraOrg }),
    ];
    estado.conversas = [
      conversa("conv-segundo", estado.segundo, "2026-11-04T10:00:00.000Z"),
      conversa("conv-intruso", estado.intruso, "2026-11-06T10:00:00.000Z", {
        organization_id: estado.outraOrg,
      }),
    ];
    estado.ligacoes = [
      ligacao("call-intruso", estado.intruso, "2026-11-06T09:00:00.000Z", {
        organization_id: estado.outraOrg,
      }),
    ];

    const { corpo } = await pergunta();

    const origens = corpo.data!.linha_do_tempo.map((i) => i.contact_id);
    expect(origens).not.toContain(estado.intruso);
    expect(new Set(origens)).toEqual(new Set([estado.segundo]));
    // Nem a pessoa entra na lista de números do negócio.
    expect(corpo.data!.numeros.map((n) => n.contact_id)).toEqual([estado.principal, estado.segundo]);
    // Nem o id dela chega a ser consultado — a cerca é antes da consulta.
    for (const filtro of estado.filtros.filter((f) => f.metodo === "in" && f.coluna === "contact_id")) {
      expect(filtro.valor).not.toContain(estado.intruso);
    }
  });

  it("⭐ controle: negócio com UMA pessoa rende o mesmo de antes", async () => {
    // Sem pessoa relacionada — o caso de quem tem um número só. Nada a mais.
    estado.links = [];
    estado.contatos = [contato(estado.principal, "Dono da loja")];
    estado.conversas = [conversa("conv-principal", estado.principal, "2026-11-01T10:00:00.000Z")];
    estado.ligacoes = [ligacao("call-principal", estado.principal, "2026-11-01T09:00:00.000Z")];

    const { corpo } = await pergunta();

    // As duas listas por tipo continuam exatamente como estavam...
    expect(corpo.data!.conversas.map((c) => c.id)).toEqual(["conv-principal"]);
    expect(corpo.data!.ligacoes.map((l) => l.id)).toEqual(["call-principal"]);
    expect(corpo.data!.numeros).toHaveLength(1);
    // ...e a linha do tempo não inventa item nem pede segunda página.
    expect(corpo.data!.linha_do_tempo.map((i) => i.id)).toEqual(["conv-principal", "call-principal"]);
    expect(corpo.meta).toMatchObject({ tem_mais: false, proximo_cursor: null });
  });
});
