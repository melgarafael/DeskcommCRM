import { describe, expect, it } from "vitest";

import {
  LIMITE_DE_LINHAS,
  montarRelatorioComercial,
  type NegocioBruto,
  type RelatorioComercial,
} from "./comercial";
import { janelaDoRelatorio } from "./janela";

const JANELA_SETEMBRO = janelaDoRelatorio("2026-09-01", "2026-09-30", "UTC");

function negocio(patch: Partial<NegocioBruto> & { id: string }): NegocioBruto {
  return {
    status: "won",
    value_cents: 10_000,
    currency: "BRL",
    contact_id: null,
    tags: [],
    closed_at: "2026-09-10T12:00:00.000Z",
    ...patch,
  };
}

function montar(
  negocios: NegocioBruto[],
  janela: RelatorioComercial["janela"] = JANELA_SETEMBRO,
): RelatorioComercial {
  return montarRelatorioComercial({
    negocios,
    moedaDaOrganizacao: "BRL",
    janela,
  });
}

/**
 * (a) FATURAMENTO = soma de `value_cents` dos negócios GANHOS DENTRO da janela.
 *
 * O caso roda com cinco negócios e só dois podem entrar na soma: um perdido e um
 * aberto dentro da janela (que NÃO são venda), um ganho fora da janela (que é
 * venda de outro mês) e um ganho com valor nulo (que soma 0 mas aparece como
 * "sem valor", não como venda de zero).
 */
describe("(a) faturamento do período", () => {
  it("soma só o ganho dentro da janela, e valor nulo soma 0 sem virar venda de zero", () => {
    const relatorio = montar([
      negocio({ id: "ganho", value_cents: 25_000, contact_id: "c1" }),
      negocio({ id: "ganho-sem-valor", value_cents: null, contact_id: "c1" }),
      negocio({ id: "perdido", status: "lost", value_cents: 999_999 }),
      negocio({ id: "aberto", status: "open", value_cents: 888_888 }),
      negocio({ id: "ganho-fora", value_cents: 777_777, closed_at: "2026-08-31T23:59:59.000Z" }),
    ]);

    // A soma é lida na linha do cliente: só o ganho da janela, e o nulo soma 0.
    expect(relatorio.clientes).toEqual([{ contact_id: "c1", centavos: 25_000, negocios: 2 }]);
    expect(relatorio.negocios_ganhos).toBe(2);
    expect(relatorio.negocios_sem_valor).toBe(1);
    expect(relatorio.sem_dados).toBe(false);
    // O valor ausente é DITO — não pode sumir como se o negócio valesse zero.
    expect(relatorio.nota).toContain("sem valor preenchido");
  });

  it("valor negativo ou inválido não diminui o faturamento", () => {
    const relatorio = montar([
      negocio({ id: "ok", value_cents: 10_000, tags: ["plano"] }),
      negocio({ id: "estragado", value_cents: -5_000, tags: ["plano"] }),
      negocio({ id: "nan", value_cents: Number.NaN, tags: ["plano"] }),
    ]);

    expect(relatorio.tags).toEqual([{ tag: "plano", centavos: 10_000, negocios: 3 }]);
    expect(relatorio.negocios_ganhos).toBe(3);
  });

  it("negócio de outra moeda fica fora dos dois rankings e é CONTADO", () => {
    const relatorio = montar([
      negocio({ id: "brl", value_cents: 10_000, contact_id: "c1", tags: ["plano"] }),
      negocio({
        id: "usd",
        value_cents: 20_000,
        currency: "USD",
        contact_id: "c2",
        tags: ["plano"],
      }),
    ]);

    expect(relatorio.negocios_ganhos).toBe(1);
    expect(relatorio.excluidos.outra_moeda).toBe(1);
    expect(relatorio.tags).toEqual([{ tag: "plano", centavos: 10_000, negocios: 1 }]);
    expect(relatorio.clientes.map((c) => c.contact_id)).toEqual(["c1"]);
    expect(relatorio.nota).toContain("outra moeda");
  });
});

/**
 * (b) ORDEM COM DESEMPATE DETERMINÍSTICO.
 *
 * Empate em centavos e em quantidade só se resolve por chave: `a` antes de `b`,
 * `c1` antes de `c2`. Sem isso a ordem dependeria da ordem de inserção no
 * banco — e a tela mostraria "quem mais compra" diferente a cada recarga.
 */
describe("(b) tags e clientes ordenados com desempate determinístico", () => {
  it("tags: centavos desc → negócios desc → tag asc", () => {
    const relatorio = montar([
      negocio({ id: "1", value_cents: 5_000, tags: ["beta"] }),
      negocio({ id: "2", value_cents: 5_000, tags: ["alfa"] }),
      negocio({ id: "3", value_cents: 9_000, tags: ["gama"] }),
      negocio({ id: "4", value_cents: 7_000, tags: ["alfa"] }),
    ]);

    expect(relatorio.tags).toEqual([
      { tag: "alfa", centavos: 12_000, negocios: 2 },
      { tag: "gama", centavos: 9_000, negocios: 1 },
      { tag: "beta", centavos: 5_000, negocios: 1 },
    ]);
    // Denominador honesto: um negócio de duas tags conta em duas linhas.
    expect(relatorio.total_etiquetagens).toBe(4);
  });

  it("tags: normaliza caixa e espaço, e a mesma tag não conta duas vezes no mesmo negócio", () => {
    const relatorio = montar([
      negocio({ id: "1", value_cents: 3_000, tags: [" Cliente ", "cliente", ""] }),
    ]);

    expect(relatorio.tags).toEqual([{ tag: "cliente", centavos: 3_000, negocios: 1 }]);
    expect(relatorio.total_etiquetagens).toBe(1);
  });

  it("clientes: centavos desc → negócios desc → contact_id asc", () => {
    const relatorio = montar([
      negocio({ id: "1", value_cents: 5_000, contact_id: "c2" }),
      negocio({ id: "2", value_cents: 5_000, contact_id: "c1" }),
      negocio({ id: "3", value_cents: 8_000, contact_id: "c3" }),
      negocio({ id: "4", value_cents: 0, contact_id: "sem-valor" }),
    ]);

    expect(relatorio.clientes).toEqual([
      { contact_id: "c3", centavos: 8_000, negocios: 1 },
      { contact_id: "c1", centavos: 5_000, negocios: 1 },
      { contact_id: "c2", centavos: 5_000, negocios: 1 },
      { contact_id: "sem-valor", centavos: 0, negocios: 1 },
    ]);
  });

  it("negócio ganho sem contato não é cliente: fica fora da lista e é contado", () => {
    const relatorio = montar([
      negocio({ id: "1", value_cents: 5_000, contact_id: null }),
      negocio({ id: "2", value_cents: 5_000, contact_id: "c1" }),
    ]);

    expect(relatorio.clientes.map((c) => c.contact_id)).toEqual(["c1"]);
    expect(relatorio.negocios_sem_contato).toBe(1);
    // Fora da lista de clientes, mas continua sendo negócio ganho do período.
    expect(relatorio.negocios_ganhos).toBe(2);
  });

  it("o corte é de LISTA: 10 linhas, e a contagem de ganhos continua vendo todos", () => {
    const negocios = Array.from({ length: LIMITE_DE_LINHAS + 3 }, (_, i) =>
      negocio({
        id: `n${i}`,
        value_cents: 1_000,
        contact_id: `contato-${String(i).padStart(2, "0")}`,
      }),
    );
    const relatorio = montar(negocios);

    expect(relatorio.clientes).toHaveLength(LIMITE_DE_LINHAS);
    expect(relatorio.negocios_ganhos).toBe(LIMITE_DE_LINHAS + 3);
  });
});

/**
 * (c) PERÍODO VAZIO = ZEROS EXPLÍCITOS, e não erro nem lista que finge ser
 * relatório. O `motivo` viaja junto para a tela dizer o que houve.
 */
describe("(c) período sem negócio ganho", () => {
  it("devolve zero explícito, listas vazias e o motivo — sem lançar", () => {
    const relatorio = montar([]);

    expect(relatorio.negocios_ganhos).toBe(0);
    expect(relatorio.tags).toEqual([]);
    expect(relatorio.clientes).toEqual([]);
    expect(relatorio.total_etiquetagens).toBe(0);
    expect(relatorio.sem_dados).toBe(true);
    expect(relatorio.motivo).toBe("nenhum_negocio_ganho_no_periodo");
    expect(relatorio.nota).toBeNull();
  });

  it("ganhos todos fora da janela também são período vazio", () => {
    const relatorio = montar([
      negocio({ id: "antes", closed_at: "2026-08-31T23:59:59.000Z" }),
      negocio({ id: "depois", closed_at: "2026-10-01T00:00:00.000Z" }),
    ]);

    expect(relatorio.sem_dados).toBe(true);
    expect(relatorio.negocios_ganhos).toBe(0);
  });
});

/**
 * A DECISÃO DO DONO (doc 306, A): os rankings moram na tela de Faturamento e NÃO
 * trazem um total próprio de "quanto vendemos". Se o campo voltar, a tela passa a
 * ter dois números de faturamento de fontes diferentes — e este caso reprova.
 */
describe("sem um segundo número de faturamento", () => {
  it("a resposta não carrega total de vendas — só as linhas dos rankings", () => {
    const relatorio = montar([negocio({ id: "1", contact_id: "c1", tags: ["plano"] })]);

    expect(relatorio).not.toHaveProperty("faturamento_centavos");
  });
});

/**
 * (d) RECORTE DE FUSO NA VIRADA DO DIA.
 *
 * O MESMO instante — 2026-09-01T02:30Z — é 31/08 23:30 em São Paulo e 01/09
 * 02:30 em UTC. Na janela de agosto de São Paulo ele é venda de AGOSTO; na de
 * setembro, de SETEMBRO. Se o recorte fosse em UTC, a venda da noite do último
 * dia do mês cairia no mês seguinte para o cliente brasileiro.
 */
describe("(d) o dia civil é o da organização", () => {
  const instante = "2026-09-01T02:30:00.000Z";

  it("São Paulo: 02:30Z do dia 1º ainda é dia 31 no recorte", () => {
    const agostoSp = janelaDoRelatorio("2026-08-01", "2026-08-31", "America/Sao_Paulo");
    const setembroSp = janelaDoRelatorio("2026-09-01", "2026-09-30", "America/Sao_Paulo");

    expect(agostoSp.from).toBe("2026-08-01T03:00:00.000Z");
    expect(agostoSp.to).toBe("2026-09-01T03:00:00.000Z");

    const emAgosto = montar([negocio({ id: "noite", closed_at: instante })], agostoSp);
    const emSetembro = montar([negocio({ id: "noite", closed_at: instante })], setembroSp);

    expect(emAgosto.negocios_ganhos).toBe(1);
    expect(emSetembro.negocios_ganhos).toBe(0);
  });

  it("UTC: o mesmo instante já é dia 1º", () => {
    const outra = montar(
      [negocio({ id: "noite", closed_at: instante })],
      janelaDoRelatorio("2026-09-01", "2026-09-30", "UTC"),
    );
    expect(outra.negocios_ganhos).toBe(1);
  });

  it("a meia-noite do dia seguinte não conta duas vezes", () => {
    const fim = "2026-09-01T00:00:00.000Z";
    const agosto = montar([negocio({ id: "exato", closed_at: fim })], janelaDoRelatorio("2026-08-01", "2026-08-31", "UTC"));
    const setembro = montar([negocio({ id: "exato", closed_at: fim })], janelaDoRelatorio("2026-09-01", "2026-09-30", "UTC"));

    expect(agosto.negocios_ganhos).toBe(0);
    expect(setembro.negocios_ganhos).toBe(1);
  });
});
