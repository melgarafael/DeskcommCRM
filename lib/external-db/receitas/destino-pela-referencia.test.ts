// O FUNIL DO INTERESSE, ACHADO PELA REFERÊNCIA DO ITEM (Spec 25, R5c).
//
// O que cada caso guarda, e a linha que o deixa vermelho se for revertida:
//
//  1. Uma instância ativa com destino válido → devolve o destino
//     → tirar o `destinos.set(...)`.
//  2. A busca é da ORGANIZAÇÃO de quem chama e só das conexões ATIVAS
//     → tirar `.eq("organization_id", ...)` ou `.eq("enabled", true)`.
//  3. Instância de OUTRA receita, desligada ou sem destino não conta
//     → tirar o `if (!instancia.ativa || instancia.receita !== receita || ...) continue`.
//  4. Destino que não vale mais (funil arquivado) não conta
//     → tirar o `if (!(await nomesDoDestinoValido(...))) continue`.
//  5. Nenhum destino → "sem_destino" (passa para a equipe); dois destinos
//     diferentes → "destino_ambiguo" (o sistema não adivinha)
//     → trocar os ramos `destinos.size === 0` / `> 1`.
//  6. Referência fora do formato nem chega ao banco
//     → tirar o `if (!ehReferenciaExterna(referencia))`.
//  7. `completarDestinoDoNegocio` nunca troca funil/etapa que o chamador informou
//     → tirar o `return { ok: true }` do início.
//  8. Metade da dupla (só funil ou só etapa) é recusada
//     → tirar o ramo `temFunil !== temEtapa`.

import { describe, expect, it, vi } from "vitest";

import { completarDestinoDoNegocio, destinoPelaReferencia } from "./destino-pela-referencia";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FUNIL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ETAPA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FUNIL_2 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ETAPA_2 = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const REF = "wordpress-conteudo:4821";

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
  receita: "wordpress-conteudo",
  rotulo: "Imóveis",
  descricao: "",
  fixos: {},
  ativa: true,
  destino_do_interesse: { pipeline_id: FUNIL, stage_id: ETAPA },
  ...extra,
});

interface Cenario {
  conexoes?: { receitas: unknown }[];
  /** funis que "existem e estão ativos" (os outros fazem o destino virar inválido). */
  funisVivos?: string[];
  erro?: boolean;
}

/** Supabase de mentira que responde por tabela e anota os filtros de cada consulta. */
function supabaseCom({ conexoes = [], funisVivos = [FUNIL, FUNIL_2], erro = false }: Cenario) {
  const filtros: Record<string, [string, unknown][]> = {};
  const cadeia = (tabela: string) => {
    const f: [string, unknown][] = [];
    filtros[tabela] = f;
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => {
        f.push([coluna, valor]);
        return q;
      },
      maybeSingle: async () => {
        const id = f.find(([c]) => c === (tabela === "crm_pipelines" ? "id" : "pipeline_id"))?.[1];
        const vivo = funisVivos.includes(String(id));
        return { data: vivo ? { id: "x", name: "Nome" } : null, error: null };
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve(erro ? { data: null, error: { message: "boom" } } : { data: conexoes, error: null }),
    };
    return q;
  };
  return { cliente: { from: (tabela: string) => cadeia(tabela) } as never, filtros };
}

describe("destinoPelaReferencia", () => {
  it("instância ativa com destino válido: devolve o destino", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    const r = await destinoPelaReferencia(cliente, ORG, REF);

    expect(r).toEqual({ ok: true, destino: { pipeline_id: FUNIL, stage_id: ETAPA } });
  });

  it("a busca é da organização de quem chama e só das conexões ativas", async () => {
    const { cliente, filtros } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    await destinoPelaReferencia(cliente, ORG, REF);

    expect(filtros.external_db_connections).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["enabled", true],
      ]),
    );
  });

  it.each<[string, Partial<Instancia>]>([
    ["de outra receita", { receita: "woocommerce-produtos" }],
    ["desligada", { ativa: false }],
    ["sem destino", { destino_do_interesse: null }],
  ])("instância %s não conta: sem destino", async (_motivo, extra) => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia(extra)] }] });

    const r = await destinoPelaReferencia(cliente, ORG, REF);

    expect(r).toMatchObject({ ok: false, motivo: "sem_destino" });
    expect((r as { mensagem: string }).mensagem).toContain("crm_request_human_handoff");
  });

  it("funil arquivado depois de configurado: o destino não vale mais", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }], funisVivos: [] });

    expect(await destinoPelaReferencia(cliente, ORG, REF)).toMatchObject({ ok: false, motivo: "sem_destino" });
  });

  it("duas instâncias da receita com o MESMO destino: serve; com destinos DIFERENTES: ambíguo", async () => {
    const igual = instancia({ id: "22222222-2222-4222-8222-222222222222" });
    const outro = instancia({
      id: "33333333-3333-4333-8333-333333333333",
      destino_do_interesse: { pipeline_id: FUNIL_2, stage_id: ETAPA_2 },
    });

    const { cliente: mesmo } = supabaseCom({ conexoes: [{ receitas: [instancia(), igual] }] });
    expect(await destinoPelaReferencia(mesmo, ORG, REF)).toMatchObject({ ok: true });

    const { cliente: ambiguo } = supabaseCom({ conexoes: [{ receitas: [instancia(), outro] }] });
    expect(await destinoPelaReferencia(ambiguo, ORG, REF)).toMatchObject({ ok: false, motivo: "destino_ambiguo" });
  });

  it("referência fora do formato nem consulta o banco", async () => {
    const from = vi.fn();

    const r = await destinoPelaReferencia({ from } as never, ORG, "4821");

    expect(r).toMatchObject({ ok: false, motivo: "referencia_invalida" });
    expect(from).not.toHaveBeenCalled();
  });

  it("erro ao ler as conexões: indisponível, e passa para a equipe", async () => {
    const { cliente } = supabaseCom({ erro: true });

    expect(await destinoPelaReferencia(cliente, ORG, REF)).toMatchObject({ ok: false, motivo: "indisponivel" });
  });
});

describe("completarDestinoDoNegocio", () => {
  it("funil e etapa informados: não troca nada e nem consulta o banco", async () => {
    const from = vi.fn();
    const args: Record<string, unknown> = { pipeline_id: FUNIL_2, stage_id: ETAPA_2, referencia_externa: REF };

    const r = await completarDestinoDoNegocio({ from } as never, ORG, args);

    expect(r).toEqual({ ok: true });
    expect(args).toMatchObject({ pipeline_id: FUNIL_2, stage_id: ETAPA_2 });
    expect(from).not.toHaveBeenCalled();
  });

  it("só a referência: completa funil e etapa a partir da receita", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });
    const args: Record<string, unknown> = { referencia_externa: REF };

    const r = await completarDestinoDoNegocio(cliente, ORG, args);

    expect(r).toEqual({ ok: true });
    expect(args).toMatchObject({ pipeline_id: FUNIL, stage_id: ETAPA });
  });

  it("só o funil, sem a etapa (ou o contrário): recusa", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia()] }] });

    const r = await completarDestinoDoNegocio(cliente, ORG, { pipeline_id: FUNIL, referencia_externa: REF });

    expect(r).toMatchObject({ ok: false, resposta: { erro: "funil_e_etapa_juntos" } });
  });

  it("sem funil, sem etapa e sem referência: recusa com a mensagem de ensino", async () => {
    const { cliente } = supabaseCom({});

    const r = await completarDestinoDoNegocio(cliente, ORG, {});

    expect(r).toMatchObject({ ok: false, resposta: { erro: "funil_obrigatorio" } });
  });

  it("referência de receita sem destino: recusa e manda para a equipe", async () => {
    const { cliente } = supabaseCom({ conexoes: [{ receitas: [instancia({ destino_do_interesse: null })] }] });

    const r = await completarDestinoDoNegocio(cliente, ORG, { referencia_externa: REF });

    expect(r).toMatchObject({ ok: false, resposta: { erro: "sem_destino" } });
  });
});
