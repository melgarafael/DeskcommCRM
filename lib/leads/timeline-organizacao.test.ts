import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { encodeCursor } from "@/lib/leads/timeline-query";
import { GET } from "@/app/api/v1/leads/[id]/timeline/route";

/**
 * A timeline do NEGÓCIO diz de qual EMPRESA ela está falando.
 *
 * O defeito que este arquivo prende: a rota lia `organization_id` do lead
 * (`route.ts:82-88`), montava a consulta de `crm_lead_activities` sem esse
 * valor e só o reaproveitava depois, para enfeitar a linha com o nome do ator.
 * Todos os índices da tabela começam por `organization_id`
 * (`supabase/baseline.sql:2736`, `:2740`, `:2744`), então a consulta não tinha
 * índice nenhum para usar.
 *
 * As asserções são de duas naturezas, e de propósito as duas:
 *  - FORMA — o duble registra o filtro exato que a rota mandou, então "nunca
 *    pediu" reprova (é o que separa conserto de sorte);
 *  - LINHAS — o duble responde o filtro como o PostgREST responderia, então
 *    "pediu torto" também reprova.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => ({ idioma: "pt-BR" })) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map<string, string>()),
}));

type Linha = Record<string, unknown>;
type Predicado = (linha: Linha) => boolean;

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const LEAD = "11111111-1111-4111-8111-111111111111";
const IRMAO = "22222222-2222-4222-8222-222222222222";
const CONTATO = "33333333-3333-4333-8333-333333333333";

/**
 * O duble do PostgREST: interpreta a árvore booleana que a rota manda
 * (`and(...)` com `or(...)` dentro), em vez de olhar a string.
 *
 * Sem interpretar, o teste de forma passaria a exigir um texto exato — e aí
 * qualquer reordenação legítima do filtro reprovaria um conserto correto.
 */
function separarNoTopo(expr: string): string[] {
  const partes: string[] = [];
  let profundidade = 0;
  let atual = "";
  for (const caractere of expr) {
    if (caractere === "(") profundidade += 1;
    if (caractere === ")") profundidade -= 1;
    if (caractere === "," && profundidade === 0) {
      partes.push(atual);
      atual = "";
      continue;
    }
    atual += caractere;
  }
  if (atual.trim() !== "") partes.push(atual);
  return partes;
}

function interpretar(expr: string): Predicado {
  const e = expr.trim();
  if (e.startsWith("and(") && e.endsWith(")")) {
    const partes = separarNoTopo(e.slice(4, -1)).map(interpretar);
    return (linha) => partes.every((p) => p(linha));
  }
  if (e.startsWith("or(") && e.endsWith(")")) {
    const partes = separarNoTopo(e.slice(3, -1)).map(interpretar);
    return (linha) => partes.some((p) => p(linha));
  }
  const primeiro = e.indexOf(".");
  const segundo = e.indexOf(".", primeiro + 1);
  if (primeiro < 0 || segundo < 0) throw new Error(`condição que o duble não entende: ${e}`);
  const coluna = e.slice(0, primeiro);
  const operador = e.slice(primeiro + 1, segundo);
  const valor = e.slice(segundo + 1);
  return (linha) => {
    const atual = linha[coluna];
    if (operador === "eq") return String(atual) === valor;
    if (operador === "is" && valor === "null") return atual === null || atual === undefined;
    if (operador === "lt") return atual !== null && atual !== undefined && String(atual) < valor;
    throw new Error(`operador que o duble não entende: ${operador}`);
  };
}

/**
 * O argumento de `.or()` é uma LISTA com OR implícito: `a.eq.1,b.eq.2` é o
 * mesmo que `or(a.eq.1,b.eq.2)`. Sem esta camada, o eixo do dossiê (que é uma
 * lista solta) era lido como uma condição única e o duble respondia vazio.
 */
function interpretarListaOu(expr: string): Predicado {
  const partes = separarNoTopo(expr.trim()).map(interpretar);
  return (linha) => partes.some((p) => p(linha));
}

class ConsultaFalsa implements PromiseLike<{ data: Linha[]; error: null }> {
  private readonly filtros: Predicado[] = [];
  private readonly ordem: Array<{ coluna: string; asc: boolean }> = [];
  private limite = Number.POSITIVE_INFINITY;

  constructor(
    private readonly linhas: Linha[],
    private readonly registro: string[],
    private readonly limites: number[],
  ) {}

  select(): this {
    return this;
  }
  order(coluna: string, opcoes?: { ascending?: boolean }): this {
    this.ordem.push({ coluna, asc: opcoes?.ascending !== false });
    return this;
  }
  limit(quantidade: number): this {
    this.limite = quantidade;
    this.limites.push(quantidade);
    return this;
  }
  eq(coluna: string, valor: unknown): this {
    // Registrado no mesmo diário dos `or(...)`: o caso sem contato usa
    // igualdade simples, e o teste da organização não pode depender de QUAL
    // forma o eixo tomou.
    this.registro.push(`${coluna}.eq.${String(valor)}`);
    this.filtros.push((linha) => String(linha[coluna]) === String(valor));
    return this;
  }
  in(coluna: string, valores: readonly unknown[]): this {
    const alvos = valores.map(String);
    this.filtros.push((linha) => alvos.includes(String(linha[coluna])));
    return this;
  }
  or(expr: string): this {
    this.registro.push(expr);
    this.filtros.push(interpretarListaOu(expr));
    return this;
  }
  async maybeSingle(): Promise<{ data: Linha | null; error: null }> {
    return { data: this.resultado()[0] ?? null, error: null };
  }
  then<T1 = { data: Linha[]; error: null }, T2 = never>(
    onfulfilled?: ((valor: { data: Linha[]; error: null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((motivo: unknown) => T2 | PromiseLike<T2>) | null,
  ): Promise<T1 | T2> {
    return Promise.resolve({ data: this.resultado(), error: null }).then(onfulfilled, onrejected);
  }

  private resultado(): Linha[] {
    const filtradas = this.linhas.filter((linha) => this.filtros.every((p) => p(linha)));
    const ordenadas = [...filtradas].sort((a, b) => {
      for (const { coluna, asc } of this.ordem) {
        const va = String(a[coluna] ?? "");
        const vb = String(b[coluna] ?? "");
        if (va === vb) continue;
        return (va < vb ? -1 : 1) * (asc ? 1 : -1);
      }
      return 0;
    });
    return ordenadas.slice(0, this.limite);
  }
}

function atividade(id: string, performedAt: string, extra: Linha): Linha {
  return {
    id,
    organization_id: ORG,
    lead_id: null,
    contact_id: null,
    source_module: "crm",
    source_id: null,
    type: "nota",
    payload: {},
    metadata: {},
    performed_at: performedAt,
    performed_by_user_id: null,
    actor_kind: "sistema",
    actor_agent_id: null,
    reason: null,
    evidence: null,
    ...extra,
  };
}

/** Atividade do NEGÓCIO (lado 1 do dossiê). */
const DO_NEGOCIO = atividade("00000000-0000-4000-8000-000000000001", "2026-11-09T10:00:00.000+00:00", {
  lead_id: LEAD,
});
/** Atividade que nasce da CONVERSA (lado 2: contato do lead e lead nulo). */
const DA_CONVERSA = atividade("00000000-0000-4000-8000-000000000002", "2026-11-09T11:00:00.000+00:00", {
  contact_id: CONTATO,
  type: "mensagem",
});
/** Atividade do negócio IRMÃO — mesmo contato, outro lead: fica de fora. */
const DO_IRMAO = atividade("00000000-0000-4000-8000-000000000003", "2026-11-09T12:00:00.000+00:00", {
  lead_id: IRMAO,
  contact_id: CONTATO,
});
/** Mesmo `lead_id`, OUTRA empresa: não é deste dossiê. */
const DE_OUTRA_EMPRESA = atividade("00000000-0000-4000-8000-000000000004", "2026-11-09T13:00:00.000+00:00", {
  organization_id: OUTRA_ORG,
  lead_id: LEAD,
});

function bancoFalso(opcoes: { contactId: string | null; atividades: Linha[] }) {
  const filtrosDaAtividade: string[] = [];
  const limitesDaAtividade: number[] = [];
  const lead: Linha = { id: LEAD, contact_id: opcoes.contactId, organization_id: ORG };
  const cliente = {
    auth: { getUser: async () => ({ data: { user: { id: "usuario-da-sessao" } }, error: null }) },
    from: (tabela: string) => {
      if (tabela === "crm_leads") return new ConsultaFalsa([lead], [], []);
      if (tabela === "crm_lead_activities")
        return new ConsultaFalsa(opcoes.atividades, filtrosDaAtividade, limitesDaAtividade);
      return new ConsultaFalsa([], [], []);
    },
  };
  return { cliente, filtrosDaAtividade, limitesDaAtividade };
}

async function pedirTimeline(
  banco: ReturnType<typeof bancoFalso>,
  consulta = "",
): Promise<{ status: number; corpo: { data: Linha[] } }> {
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
  const resposta = await GET(new NextRequest(`http://x/api/v1/leads/${LEAD}/timeline${consulta}`), {
    params: Promise.resolve({ id: LEAD }),
  });
  return { status: resposta.status, corpo: (await resposta.json()) as { data: Linha[] } };
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

describe("a consulta da timeline do negócio diz de qual empresa é", () => {
  it("a primeira página carrega a organização, junto dos dois lados do dossiê", async () => {
    const banco = bancoFalso({ contactId: CONTATO, atividades: [DO_NEGOCIO, DA_CONVERSA, DO_IRMAO] });
    const { status } = await pedirTimeline(banco);

    expect(status).toBe(200);
    expect(banco.filtrosDaAtividade).toHaveLength(1);
    const filtro = banco.filtrosDaAtividade[0]!;
    expect(filtro).toContain(`organization_id.eq.${ORG}`);
    // O conserto acrescenta o eixo da empresa; NÃO troca nem simplifica os dois
    // lados do dossiê.
    expect(filtro).toContain(`lead_id.eq.${LEAD}`);
    expect(filtro).toContain(`contact_id.eq.${CONTATO}`);
    expect(filtro).toContain("lead_id.is.null");
    // `limit + 1` continua: é ele que diz se há próxima página.
    expect(banco.limitesDaAtividade).toEqual([51]);
  });

  it("o cursor também carrega a organização, e não só a chave da paginação", async () => {
    const banco = bancoFalso({ contactId: CONTATO, atividades: [DO_NEGOCIO] });
    const cursor = encodeCursor({ performed_at: "2026-11-09T12:30:00.000+00:00", id: "00000000-0000-4000-8000-000000000009" });
    const { status } = await pedirTimeline(banco, `?cursor=${cursor}`);

    expect(status).toBe(200);
    expect(banco.filtrosDaAtividade).toHaveLength(2);
    // O primeiro filtro é o do eixo (coberto acima); o SEGUNDO é o do cursor, e
    // é este que precisa carregar a organização por conta própria.
    const filtroDoCursor = banco.filtrosDaAtividade[1]!;
    expect(filtroDoCursor).toContain(`organization_id.eq.${ORG}`);
    // E o cursor continua sendo o cursor: só o que vem depois do último item.
    expect(filtroDoCursor).toContain("performed_at.lt.2026-11-09T12:30:00.000+00:00");
    expect(filtroDoCursor).toContain("id.lt.00000000-0000-4000-8000-000000000009");
  });
});

describe("as linhas que voltam são as do dossiê da organização dona", () => {
  it("atividade do negócio e atividade da conversa voltam; a do irmão não", async () => {
    const banco = bancoFalso({ contactId: CONTATO, atividades: [DO_NEGOCIO, DA_CONVERSA, DO_IRMAO] });
    const { corpo } = await pedirTimeline(banco);

    // Ordem preservada: performed_at desc, id desc.
    expect(corpo.data.map((l) => l.id)).toEqual([DA_CONVERSA.id, DO_NEGOCIO.id]);
    expect(corpo.data.map((l) => l.id)).not.toContain(DO_IRMAO.id);
  });

  it("atividade de OUTRA organização com o mesmo lead_id não volta", async () => {
    const banco = bancoFalso({
      contactId: CONTATO,
      atividades: [DO_NEGOCIO, DE_OUTRA_EMPRESA],
    });
    const { corpo } = await pedirTimeline(banco);

    // O duble devolve a linha intrusa de propósito: quem tem de descartá-la é a
    // consulta. Se a rota parar de pedir a organização, esta linha reaparece.
    expect(corpo.data.map((l) => l.id)).not.toContain(DE_OUTRA_EMPRESA.id);
    expect(corpo.data.map((l) => l.id)).toEqual([DO_NEGOCIO.id]);
    expect(banco.filtrosDaAtividade[0]).toContain(`organization_id.eq.${ORG}`);
  });

  it("negócio sem contato continua com a porta que o eixo antigo não dava", async () => {
    const banco = bancoFalso({ contactId: null, atividades: [DO_NEGOCIO, DA_CONVERSA, DO_IRMAO] });
    const { status, corpo } = await pedirTimeline(banco);

    expect(status).toBe(200);
    // Sem contato, o lado da conversa não existe — mas o lado do negócio vale.
    expect(corpo.data.map((l) => l.id)).toEqual([DO_NEGOCIO.id]);
    const filtro = banco.filtrosDaAtividade[0]!;
    expect(filtro).toContain(`lead_id.eq.${LEAD}`);
    expect(filtro).toContain(`organization_id.eq.${ORG}`);
    expect(filtro).not.toContain("contact_id");
  });
});
