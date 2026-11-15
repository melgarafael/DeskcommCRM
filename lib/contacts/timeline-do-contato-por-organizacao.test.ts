import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { GET } from "@/app/api/v1/contacts/[id]/timeline/route";

/**
 * A TIMELINE DO CONTATO TAMBÉM DIZ DE QUAL EMPRESA É (#4324).
 *
 * ─── O que ficou de fora no conserto do dossiê do negócio ──────────────────
 *
 * A rota do negócio passou a levar `organization_id` no filtro (PR #4332) e a
 * do contato ficou como estava: lia `organization_id` do contato
 * (`route.ts:71-75`), usava o valor só para enfeitar o nome do ator
 * (`comNomeDoAtor`, `:148`) e mandava as duas consultas de
 * `crm_lead_activities` sem dizer a empresa. A issue #4324 cita as duas rotas
 * no mesmo parágrafo; esta é a metade que sobrou.
 *
 * ─── Por que duas empresas, e não uma ──────────────────────────────────────
 *
 * `contact_id` e `lead_id` são únicos por instalação, então uma instalação
 * correta nunca tem atividade de OUTRA empresa apontando para este contato —
 * hoje. O que este teste prende é o dia em que tiver: o gatilho
 * `trg_validate_activity_lead_org` confere a organização do LEAD, não a do
 * CONTATO, e um `contact_id` cruzado (importação, fusão de fichas, escrita de
 * serviço) voltaria na tela como se fosse deste dossiê. O duble devolve a linha
 * intrusa DE PROPÓSITO: quem tem de descartá-la é a consulta.
 *
 * A asserção de FORMA (o filtro que a rota mandou) anda junto porque o plano é
 * a outra metade do defeito: sem `organization_id` a consulta não desce por
 * nenhum dos índices `(organization_id, …)` da tabela.
 */

vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: vi.fn(async () => ({ idioma: "pt-BR" })) }));
vi.mock("@/lib/users/nome-do-atendente", () => ({
  nomesDosAtendentes: vi.fn(async () => new Map<string, string>()),
}));

type Linha = Record<string, unknown>;

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRA_ORG = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CONTATO = "33333333-3333-4333-8333-333333333333";
const OUTRO_CONTATO = "44444444-4444-4444-8444-444444444444";
const NEGOCIO = "11111111-1111-4111-8111-111111111111";
const NEGOCIO_IRMAO = "22222222-2222-4222-8222-222222222222";

function atividade(id: string, performedAt: string, extra: Linha = {}): Linha {
  return {
    id,
    organization_id: ORG,
    lead_id: null,
    contact_id: CONTATO,
    type: "nota",
    payload: {},
    performed_at: performedAt,
    actor_agent_id: null,
    performed_by_user_id: null,
    ...extra,
  };
}

/** Atividade direta do contato: lado 1 da consulta. */
const DIRETA = atividade("00000000-0000-4000-8000-000000000001", "2026-11-09T10:00:00.000+00:00");
/** Atividade de um negócio DESTE contato: lado 2. */
const DO_NEGOCIO = atividade("00000000-0000-4000-8000-000000000002", "2026-11-09T11:00:00.000+00:00", {
  contact_id: null,
  lead_id: NEGOCIO,
});
/** Mesmo `contact_id`, OUTRA empresa: não é deste dossiê. */
const DE_OUTRA_EMPRESA = atividade(
  "00000000-0000-4000-8000-000000000003",
  "2026-11-09T12:00:00.000+00:00",
  { organization_id: OUTRA_ORG },
);
/** Atividade de outro contato da MESMA empresa: também não é deste dossiê. */
const DE_OUTRO_CONTATO = atividade(
  "00000000-0000-4000-8000-000000000004",
  "2026-11-09T13:00:00.000+00:00",
  { contact_id: OUTRO_CONTATO },
);
/** Atividade do negócio IRMÃO (de outro contato): fica de fora por construção. */
const DO_IRMAO = atividade("00000000-0000-4000-8000-000000000005", "2026-11-09T14:00:00.000+00:00", {
  contact_id: null,
  lead_id: NEGOCIO_IRMAO,
});

type Predicado = (linha: Linha) => boolean;

/**
 * O duble do PostgREST: registra o filtro exato que a rota mandou E responde
 * como o banco responderia. Sem a segunda metade, um filtro só de forma
 * passaria verde mesmo que o dado intruso voltasse.
 */
class ConsultaFalsa implements PromiseLike<{ data: Linha[]; error: null }> {
  private readonly filtros: Predicado[] = [];
  private readonly registro: Array<Record<string, unknown>>;
  private limite = Number.POSITIVE_INFINITY;

  constructor(
    private readonly linhas: Linha[],
    registro: Array<Record<string, unknown>>,
  ) {
    this.registro = registro;
  }

  select(): this {
    return this;
  }
  order(): this {
    return this;
  }
  limit(quantidade: number): this {
    this.limite = quantidade;
    return this;
  }
  eq(coluna: string, valor: unknown): this {
    this.registro.push({ tipo: "eq", coluna, valor });
    this.filtros.push((linha) => String(linha[coluna]) === String(valor));
    return this;
  }
  in(coluna: string, valores: readonly unknown[]): this {
    this.registro.push({ tipo: "in", coluna, valores });
    const conjunto = new Set(valores.map(String));
    this.filtros.push((linha) => conjunto.has(String(linha[coluna])));
    return this;
  }
  /** O `contacts`/`crm_leads` desta rota são lidos com `maybeSingle()`. */
  async maybeSingle(): Promise<{ data: Linha | null; error: null }> {
    const casadas = this.linhas.filter((linha) => this.filtros.every((p) => p(linha)));
    return { data: casadas[0] ?? null, error: null };
  }
  or(expressao: string): this {
    // O cursor é o único `or` desta rota; sem cursor ele não aparece. Falhar
    // alto é melhor do que ignorar e devolver tudo.
    throw new Error(`or() inesperado neste teste: ${expressao}`);
  }

  then<T1 = { data: Linha[]; error: null }, T2 = never>(
    aoConcluir?: ((v: { data: Linha[]; error: null }) => T1 | PromiseLike<T1>) | null,
    aoFalhar?: ((r: T2) => unknown) | null,
  ): PromiseLike<T1 | T2> {
    const casadas = this.linhas
      .filter((linha) => this.filtros.every((predicado) => predicado(linha)))
      .sort((a, b) => (String(a["performed_at"]) < String(b["performed_at"]) ? 1 : -1));
    const resultado = { data: casadas.slice(0, this.limite), error: null as null };
    return Promise.resolve(resultado).then(aoConcluir, aoFalhar) as PromiseLike<T1 | T2>;
  }
}

function bancoFalso(atividades: Linha[]) {
  const registroDaAtividade: Array<Record<string, unknown>> = [];
  const cliente = {
    auth: { getUser: async () => ({ data: { user: { id: "usuario-da-sessao" } }, error: null }) },
    from: (tabela: string) => {
      if (tabela === "contacts") {
        return new ConsultaFalsa(
          [{ id: CONTATO, organization_id: ORG }],
          registroDaAtividade,
        );
      }
      if (tabela === "crm_leads") {
        return new ConsultaFalsa(
          [{ id: NEGOCIO, contact_id: CONTATO }],
          registroDaAtividade,
        );
      }
      if (tabela === "crm_lead_activities") {
        return new ConsultaFalsa(atividades, registroDaAtividade);
      }
      return new ConsultaFalsa([], registroDaAtividade);
    },
  };
  return { cliente, registroDaAtividade };
}

async function pedirTimeline(banco: ReturnType<typeof bancoFalso>) {
  vi.mocked(createClient).mockResolvedValue(banco.cliente as never);
  const resposta = await GET(
    new NextRequest(`http://x/api/v1/contacts/${CONTATO}/timeline`),
    { params: Promise.resolve({ id: CONTATO }) },
  );
  return { status: resposta.status, corpo: (await resposta.json()) as { data: Linha[] } };
}

beforeEach(() => {
  vi.mocked(createClient).mockReset();
});

describe("a timeline do CONTATO não mistura empresas (#4324)", () => {
  it("a consulta das atividades diz de qual empresa é", async () => {
    const banco = bancoFalso([DIRETA, DO_NEGOCIO]);
    const { status } = await pedirTimeline(banco);

    expect(status).toBe(200);
    // Duas consultas (lado do contato e lado dos negócios dele), e as DUAS com a
    // organização — o defeito original era nenhuma das duas dizer a empresa.
    const daAtividade = banco.registroDaAtividade.filter(
      (r) => r["tipo"] === "eq" && r["coluna"] === "organization_id",
    );
    expect(daAtividade).toEqual([
      { tipo: "eq", coluna: "organization_id", valor: ORG },
      { tipo: "eq", coluna: "organization_id", valor: ORG },
    ]);
  });

  it("atividade de OUTRA empresa com o mesmo contact_id não volta", async () => {
    const banco = bancoFalso([DIRETA, DE_OUTRA_EMPRESA]);
    const { corpo } = await pedirTimeline(banco);

    // O duble entrega a linha intrusa; quem tem de descartá-la é a consulta.
    expect(corpo.data.map((l) => l.id)).toEqual([DIRETA.id]);
    expect(corpo.data.map((l) => l.id)).not.toContain(DE_OUTRA_EMPRESA.id);
  });

  it("atividade de outro contato e do negócio irmão também ficam de fora", async () => {
    const banco = bancoFalso([DIRETA, DO_NEGOCIO, DE_OUTRO_CONTATO, DO_IRMAO]);
    const { corpo } = await pedirTimeline(banco);

    expect(corpo.data.map((l) => l.id)).toEqual([DO_NEGOCIO.id, DIRETA.id]);
  });
});
