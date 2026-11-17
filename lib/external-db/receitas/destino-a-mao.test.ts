// O NEGÓCIO ABERTO COM O FUNIL À MÃO CONFERE O ITEM (#4763, item 2).
//
// Medido com IA real (`gpt-6-luna`, 16/11): numa rodada em que a receita estava
// inacessível, o modelo chamou `crm_create_lead` com `pipeline_id`/`stage_id` à
// mão e SEM `referencia_externa`, e nasceu o negócio "Casa com piscina em
// Alphaville — AU-9999", de um item que não existe. A conferência do item só
// rodava pelo caminho da referência.
//
// O que cada caso guarda, e o que o deixa vermelho:
//
//  1. Funil à mão que é o destino de uma receita ativa, em turno de conversa,
//     sem referência → `item_obrigatorio` e o negócio não nasce
//     → voltar a exigir `referencia_externa` para conferir (o `if` do
//     `conferirItem` devolvendo `ok` sem referência).
//  2. O mesmo caminho COM a referência → o item é conferido no banco de origem
//     → tirar a chamada de `conferirItem` do ramo do funil à mão.
//  3. Item inexistente nesse caminho → `item_inexistente` (o AU-9999 com
//     referência declarada) → conferir sem olhar o item (devolver `ok` sempre).
//  4. Criação manual sem item, em funil que NÃO é destino de receita →
//     permitida, com a declaração `funil_a_mao_sem_item`
//     → recusar todo funil à mão.
//  5. Com referência e sem funil → idêntico a hoje (destino da receita, item
//     conferido) e nenhuma leitura de conexões a mais
//     → consultar os destinos também nesse ramo.
//  6. A guarda confere o item UMA vez por criação, não uma por campo
//     → conferir por `pipeline_id` e de novo por `stage_id`.

import { describe, expect, it, vi } from "vitest";

// A consulta do item tem o próprio teste (`item-da-referencia.test.ts`).
const conferirItem = vi.hoisted(() => vi.fn(async () => ({ ok: true }) as const));
vi.mock("./item-da-referencia", () => ({ conferirItemDaReferencia: conferirItem }));

import {
  DECLARACAO_SEM_ITEM,
  completarDestinoDoNegocio,
} from "./destino-pela-referencia";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FUNIL_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ETAPA_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REF = "tabela-direta:4457";

type Instancia = {
  id: string;
  receita: string;
  rotulo: string;
  descricao: string;
  fixos: unknown;
  ativa: boolean;
  destino_do_interesse?: { pipeline_id: string; stage_id: string } | null;
};

const instancia = (extra: Partial<Instancia> = {}): Instancia => ({
  id: "11111111-1111-4111-8111-111111111111",
  receita: "tabela-direta",
  rotulo: "Imóveis",
  descricao: "",
  fixos: {},
  ativa: true,
  destino_do_interesse: { pipeline_id: FUNIL, stage_id: ETAPA },
  ...extra,
});

/** Supabase de mentira: uma resposta por tabela, e anota quantas leituras houve. */
function supabaseCom({
  conexoes = [],
  erro = false,
}: {
  conexoes?: { receitas: unknown }[];
  erro?: boolean;
} = {}) {
  const ler = vi.fn();
  const cadeia = () => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      maybeSingle: async () => ({ data: { id: "x", name: "Nome" }, error: null }),
      then: (resolve: (v: unknown) => unknown) => {
        ler();
        return resolve(erro ? { data: null, error: { message: "boom" } } : { data: conexoes, error: null });
      },
    };
    return q;
  };
  return { cliente: { from: () => cadeia() } as never, ler };
}

describe("funil à mão que é destino de receita ativa, sem item", () => {
  it("em turno de conversa: item_obrigatorio, e o negócio não nasce", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    const r = await completarDestinoDoNegocio(
      cliente,
      ORG,
      { pipeline_id: FUNIL, stage_id: ETAPA },
      { turnoComContato: true },
    );

    expect(r).toMatchObject({ ok: false, resposta: { erro: "item_obrigatorio" } });
    // O discriminante é `ok`: estreitar por ele evita o cast de um tipo que não
    // tem `resposta` (o tsc recusa `DestinoCompletado` → `{ resposta }`).
    if (r.ok) throw new Error("esperava a recusa de item obrigatório");
    const mensagem = String(r.resposta.mensagem);
    // As duas saídas legítimas, nomeadas para o modelo: o item, ou a equipe.
    expect(mensagem).toContain("referencia_externa");
    expect(mensagem).toContain("crm_request_human_handoff");
    // O item não foi perguntado: não havia referência para perguntar.
    expect(conferirItem).not.toHaveBeenCalled();
  });

  it("fora do turno (rota/integração): permitido, com a declaração", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    const r = await completarDestinoDoNegocio(cliente, ORG, { pipeline_id: FUNIL, stage_id: ETAPA });

    expect(r).toEqual({ ok: true, declaracao: DECLARACAO_SEM_ITEM });
  });
});

describe("o item no contexto do turno é conferido — com o funil à mão também", () => {
  it("com referencia_externa: confere o item no banco de origem", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    const r = await completarDestinoDoNegocio(
      cliente,
      ORG,
      { pipeline_id: FUNIL, stage_id: ETAPA, referencia_externa: REF },
      { turnoComContato: true },
    );

    expect(r).toEqual({ ok: true });
    expect(conferirItem).toHaveBeenCalledWith(cliente, ORG, REF);
  });

  it("item inexistente (o AU-9999): não vira negócio", async () => {
    conferirItem.mockResolvedValueOnce({
      ok: false,
      motivo: "item_inexistente",
      mensagem: "não existe",
    } as never);
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    const r = await completarDestinoDoNegocio(
      cliente,
      ORG,
      { pipeline_id: FUNIL, stage_id: ETAPA, referencia_externa: "tabela-direta:AU-9999" },
      { turnoComContato: true },
    );

    expect(r).toMatchObject({ ok: false, resposta: { erro: "item_inexistente" } });
  });

  it("confere UMA vez por criação, não uma por campo", async () => {
    conferirItem.mockClear();
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    await completarDestinoDoNegocio(
      cliente,
      ORG,
      { pipeline_id: FUNIL, stage_id: ETAPA, referencia_externa: REF },
      { turnoComContato: true },
    );

    expect(conferirItem).toHaveBeenCalledTimes(1);
  });
});

describe("o que não regride", () => {
  it("criação manual sem item, em funil que não é destino de receita: permitida, com o registro", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    const r = await completarDestinoDoNegocio(
      cliente,
      ORG,
      { pipeline_id: FUNIL_2, stage_id: ETAPA_2 },
      { turnoComContato: true },
    );

    expect(r).toEqual({ ok: true, declaracao: DECLARACAO_SEM_ITEM });
  });

  it("organização sem receita ativa: nada muda e nada é registrado", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia({ ativa: false })] }] });

    const r = await completarDestinoDoNegocio(
      cliente,
      ORG,
      { pipeline_id: FUNIL_2, stage_id: ETAPA_2 },
      { turnoComContato: true },
    );

    expect(r).toEqual({ ok: true });
  });

  it("com referencia_externa e sem funil: o destino sai da receita, como hoje", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });
    const args: Record<string, unknown> = { referencia_externa: REF };

    const r = await completarDestinoDoNegocio(cliente, ORG, args, { turnoComContato: true });

    expect(r).toEqual({ ok: true });
    expect(args).toMatchObject({ pipeline_id: FUNIL, stage_id: ETAPA });
    expect(conferirItem).toHaveBeenLastCalledWith(cliente, ORG, REF);
  });

  it("conexões ilegíveis: não inventa bloqueio, mas o registro fica", async () => {
    const { cliente } = supabaseCom({ erro: true });

    const r = await completarDestinoDoNegocio(
      cliente,
      ORG,
      { pipeline_id: FUNIL, stage_id: ETAPA },
      { turnoComContato: true },
    );

    expect(r).toEqual({ ok: true, declaracao: DECLARACAO_SEM_ITEM });
  });
});
