/**
 * A FILA DE CASOS PARA DE CONTAR O QUE A RLS ESCONDE.
 *
 * ## O defeito que esta cerca fecha
 *
 * `conversations` tem RLS por atendente desde a migration 0035
 * (`fn_can_view_conversation`, em `supabase/baseline.sql`): numa organização em
 * `visibility_mode = 'own'`, o papel `agent` só enxerga a conversa que é dele.
 * As rotas de caso, porém, liam com `createAdminClient()` filtrando **só**
 * `organization_id` — e a lista devolve `title`, `summary`, `blocker`, o NOME e o
 * TELEFONE do contato. Ou seja: o que a tela de conversas escondia, a tela de
 * casos entregava, com PII, sem erro em lugar nenhum.
 *
 * ## Onde a sonda olha
 *
 * No EFEITO, não na chamada: o dublê de PostgREST aplica `eq`/`in` sobre linhas
 * de verdade, então "filtrou" significa que a linha SUMIU do resultado — não que
 * um método foi chamado. Um recorte que passasse a lista inteira adiante ficaria
 * vermelho aqui.
 *
 * ## Por que o parâmetro é obrigatório, e como isso é medido
 *
 * `listarChamados`/`lerChamado` são compartilhados com o MCP
 * (`lib/mcp/tools/escalacao.ts`), onde o cliente é admin **por contrato**:
 * embutir o filtro faria o agente de IA enxergar menos casos que hoje. A
 * divergência entre a tela e o agente passa a ser DECLARADA no tipo, sem default
 * implícito — um default escolheria um dos dois lados para todo chamador futuro.
 *
 * Quem prova que o parâmetro é obrigatório é o `@ts-expect-error` abaixo, e quem
 * o executa é `pnpm typecheck` (`tsconfig.typecheck.json` reinclui `tests/**`):
 * se `visiveisPara` virar opcional, a diretiva fica sem uso e o `tsc` reprova.
 * O vitest não typecheca — dele vem a outra metade, a falha fechada em runtime.
 *
 * ## Comando
 *
 *     pnpm exec vitest run tests/unit/chamados-visibilidade.test.ts
 *     pnpm typecheck
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import {
  conversasVisiveisDosCasos,
  lerChamado,
  listarChamados,
} from "@/lib/escalacao/chamados";

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const CONV_MINHA = "bbbbbbbb-0000-4000-8000-00000000000b";
const CONV_ALHEIA = "cccccccc-0000-4000-8000-00000000000c";
const CASO_MEU = "dddddddd-0000-4000-8000-00000000000d";
const CASO_ALHEIO = "eeeeeeee-0000-4000-8000-00000000000e";

type Linha = Record<string, unknown>;

interface Consulta {
  tabela: string;
  colunas: string;
  eqs: Array<[string, unknown]>;
  ins: Array<[string, unknown[]]>;
}

/**
 * Dublê de PostgREST que HONRA os filtros: `eq` e `in` cortam linhas de verdade.
 * Um dublê que devolvesse a tabela inteira independentemente do filtro deixaria
 * este arquivo verde no dia em que o recorte sumisse — que é exatamente o
 * defeito medido aqui.
 */
function bancoFake(tabelas: Record<string, Linha[]>) {
  const consultas: Consulta[] = [];

  function from(tabela: string) {
    const consulta: Consulta = { tabela, colunas: "", eqs: [], ins: [] };
    let contagem = false;
    let faixa: [number, number] | null = null;

    const linhas = () => {
      const filtradas = (tabelas[tabela] ?? []).filter(
        (linha) =>
          consulta.eqs.every(([coluna, valor]) => linha[coluna] === valor) &&
          consulta.ins.every(([coluna, valores]) => valores.includes(linha[coluna])),
      );
      return faixa ? filtradas.slice(faixa[0], faixa[1] + 1) : filtradas;
    };
    const resultado = () =>
      contagem
        ? { data: null, count: linhas().length, error: null }
        : { data: linhas(), count: null, error: null };

    const cadeia = {
      select(colunas: string, opts?: { count?: string; head?: boolean }) {
        consulta.colunas = colunas;
        contagem = opts?.head === true;
        consultas.push(consulta);
        return cadeia;
      },
      eq(coluna: string, valor: unknown) {
        consulta.eqs.push([coluna, valor]);
        return cadeia;
      },
      in(coluna: string, valores: unknown[]) {
        consulta.ins.push([coluna, valores]);
        return cadeia;
      },
      order: () => cadeia,
      limit: () => cadeia,
      // A leitura do universo é paginada (`lerPaginado`): a página seguinte
      // à última tem de vir VAZIA, senão o laço não prova o fim.
      range(inicio: number, fim: number) {
        faixa = [inicio, fim];
        return cadeia;
      },
      maybeSingle: async () => ({ data: linhas()[0] ?? null, error: null }),
      then: (aceita: (valor: unknown) => unknown) => Promise.resolve(resultado()).then(aceita),
    };
    return cadeia;
  }

  return { cliente: { from } as unknown as SupabaseClient, consultas };
}

function casoFixture(id: string, conversationId: string, nome: string): Linha {
  return {
    id,
    organization_id: ORG,
    title: `Caso ${nome}`,
    summary: "Cliente pediu desconto",
    blocker: "Alçada",
    status: "awaiting_human",
    kind: "negociacao",
    source: "agent",
    opened_at: "2026-09-16T10:00:00.000Z",
    closed_at: null,
    conversation_id: conversationId,
    conversations: { contacts: { name: nome, phone_number: "+5511999998888" } },
  };
}

/**
 * O banco como um atendente restrito o vê: as DUAS conversas têm caso, mas só
 * uma delas passa pela RLS de `conversations` — o dublê omite a outra da tabela
 * `conversations`, que é o que a policy faz.
 */
function bancoDeUmAtendenteRestrito() {
  return bancoFake({
    agent_cases: [
      casoFixture(CASO_MEU, CONV_MINHA, "Joana"),
      casoFixture(CASO_ALHEIO, CONV_ALHEIA, "Pedro"),
    ],
    agent_case_events: [],
    conversations: [{ id: CONV_MINHA, organization_id: ORG }],
  });
}

// ---------------------------------------------------------------------------
// listarChamados
// ---------------------------------------------------------------------------

describe("listarChamados recorta pela conversa", () => {
  it("o caso cuja conversa a RLS esconde some da lista", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    const { chamados } = await listarChamados(cliente, ORG, {
      estado: "abertos",
      visiveisPara: [CONV_MINHA],
    });

    expect(
      chamados.map((c) => c.id),
      "a fila entregou o caso de uma conversa que a RLS esconde — com o nome e o telefone do contato junto",
    ).toEqual([CASO_MEU]);
  });

  it("a contagem de abertos conta só o que a pessoa pode abrir", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    const { abertos } = await listarChamados(cliente, ORG, {
      estado: "abertos",
      visiveisPara: [CONV_MINHA],
    });

    // O contador é o crachá da navegação: dizer "2 em aberto" e mostrar um só
    // manda a pessoa procurar um caso que ela nunca vai achar.
    expect(abertos).toBe(1);
  });

  it('com "todas" não filtra nada — é o contrato do MCP e do motor', async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    const { chamados, abertos } = await listarChamados(cliente, ORG, {
      estado: "abertos",
      visiveisPara: "todas",
    });

    // Par de vacuidade: sem ele, um recorte que zerasse TUDO passaria pelos
    // dois casos acima.
    expect(chamados.map((c) => c.id).sort()).toEqual([CASO_MEU, CASO_ALHEIO].sort());
    expect(abertos).toBe(2);
  });

  it("conjunto vazio devolve fila vazia, não a fila inteira", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    const { chamados, abertos } = await listarChamados(cliente, ORG, {
      estado: "abertos",
      visiveisPara: [],
    });

    expect(chamados).toEqual([]);
    expect(abertos).toBe(0);
  });

  it("sem o parâmetro falha FECHADO — nunca devolvendo tudo", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    await expect(
      // @ts-expect-error — `visiveisPara` é obrigatório de propósito: se esta
      // diretiva ficar sem uso, alguém pôs um default e o `tsc` reprova aqui.
      listarChamados(cliente, ORG, { estado: "abertos" }),
    ).rejects.toThrow(/visiveisPara/);
  });
});

// ---------------------------------------------------------------------------
// lerChamado
// ---------------------------------------------------------------------------

describe("lerChamado recorta pela conversa", () => {
  it("o caso da conversa visível abre", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    const chamado = await lerChamado(cliente, ORG, CASO_MEU, { visiveisPara: [CONV_MINHA] });

    expect(chamado?.id).toBe(CASO_MEU);
    expect(chamado?.contact_name).toBe("Joana");
  });

  it("o caso que EXISTE mas cuja conversa a RLS esconde volta nulo — o mesmo nulo de um caso inexistente", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    const escondido = await lerChamado(cliente, ORG, CASO_ALHEIO, { visiveisPara: [CONV_MINHA] });
    const inexistente = await lerChamado(cliente, ORG, "ffffffff-0000-4000-8000-00000000000f", {
      visiveisPara: [CONV_MINHA],
    });

    // Os dois pelo MESMO caminho: é o que faz a rota devolver 404 nos dois
    // casos. Um 403 aqui confirmaria que o caso existe.
    expect(escondido).toBeNull();
    expect(inexistente).toBeNull();
  });

  it('com "todas" o caso alheio abre — o agente de IA não perde alcance', async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    const chamado = await lerChamado(cliente, ORG, CASO_ALHEIO, { visiveisPara: "todas" });

    expect(chamado?.id).toBe(CASO_ALHEIO);
  });

  it("sem o parâmetro falha FECHADO", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    await expect(
      // @ts-expect-error — mesma razão da lista: o tipo obriga quem chama a
      // declarar de que lado está.
      lerChamado(cliente, ORG, CASO_MEU),
    ).rejects.toThrow(/visiveisPara/);
  });
});

// ---------------------------------------------------------------------------
// conversasVisiveisDosCasos — quem resolve o conjunto
// ---------------------------------------------------------------------------

describe("conversasVisiveisDosCasos pergunta ao banco quem vê o quê", () => {
  it("devolve só as conversas que a sessão enxerga", async () => {
    const { cliente } = bancoDeUmAtendenteRestrito();

    expect(await conversasVisiveisDosCasos(cliente, ORG)).toEqual([CONV_MINHA]);
  });

  it("o gate é a tabela `conversations`, não `agent_cases`", async () => {
    const { cliente, consultas } = bancoDeUmAtendenteRestrito();

    await conversasVisiveisDosCasos(cliente, ORG);

    // A sabotagem que este caso existe para pegar: devolver as candidatas de
    // `agent_cases` sem confrontá-las com `conversations` recorta NADA — a
    // policy de `agent_cases` é org-wide — e todos os outros casos deste arquivo
    // continuariam verdes, porque o conjunto ainda "vem da sessão".
    expect(consultas.map((c) => c.tabela)).toContain("conversations");
    expect(consultas.every((c) => c.eqs.some(([col, v]) => col === "organization_id" && v === ORG))).toBe(
      true,
    );
  });

  it("com um caso nomeado, o universo é só aquele caso — não a organização inteira", async () => {
    const { cliente, consultas } = bancoDeUmAtendenteRestrito();

    expect(await conversasVisiveisDosCasos(cliente, ORG, { caseId: CASO_ALHEIO })).toEqual([]);

    // Enumerar todas as conversas da organização voltaria numa query string até
    // o PostgREST: numa instalação antiga, uma URL de megabytes.
    const dosCasos = consultas.find((c) => c.tabela === "agent_cases");
    expect(dosCasos?.eqs).toContainEqual(["id", CASO_ALHEIO]);
  });

  it("organização sem caso nenhum devolve conjunto vazio sem ir a `conversations`", async () => {
    const { cliente, consultas } = bancoFake({ agent_cases: [], conversations: [] });

    expect(await conversasVisiveisDosCasos(cliente, ORG)).toEqual([]);
    expect(consultas.map((c) => c.tabela)).not.toContain("conversations");
  });
});
