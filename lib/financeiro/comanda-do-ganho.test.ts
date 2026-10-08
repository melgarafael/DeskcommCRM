/**
 * A CONTA A RECEBER DO GANHO (#1477) — o que este teste prende.
 *
 * Mover o card para uma etapa `is_won` não mexia no financeiro: quem vendia pelo
 * Kanban tinha de lembrar de abrir a Comandas à mão. A fatia entregue é o VÍNCULO:
 * o fecho ganho abre UMA comanda com o valor e o contato do negócio e grava a
 * ligação em `crm_lead_links` (`target_kind = 'order'`, que o CHECK da tabela já
 * aceita) — a ligação é também a trava de idempotência: fechar de novo devolve a
 * comanda que já existe em vez de abrir outra.
 *
 * As quatro promessas da issue, uma por `it`:
 *   1. ganho com valor e contato → comanda certa + vínculo certos;
 *   2. fechar (ou reabrir e fechar) de novo → nada é escrito pela segunda vez;
 *   3. negócio sem valor → não lança nada (sem inventar dinheiro);
 *   4. falha de escrita → devolve `falhou`, nunca exceção para a rota.
 */
import { describe, expect, it } from "vitest";

import {
  ALVO_DE_VINCULO_DA_COMANDA,
  comandaDoGanho,
  MOTIVO_DO_CANCELAMENTO_NA_CORRIDA,
  VINCULO_DE_COMANDA_NO_GANHO,
} from "./comanda-do-ganho";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const COMANDA = "66666666-6666-4666-8666-666666666666";

/** O que o handler passa: vocabulário e nome do funil, nunca o título do negócio. */
const DESCRICAO = "Pedido · Vendas";

type Registro = Record<string, unknown>;

/** Resposta com forma de promise: `await` resolve como no supabase-js. */
function resposta(data: unknown, error: { message: string } | null = null) {
  return {
    then(ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) {
      return Promise.resolve({ data, error }).then(ok, erro);
    },
  };
}

/**
 * Banco falso só com o que a função toca: leitura do vínculo, moeda da org,
 * numeração e as três escritas. Qualquer OUTRA consulta derruba o teste na hora
 * — um mock que aceita tudo também aprova uma consulta que não deveria existir.
 */
function bancoFalso(opcoes: {
  vinculos?: Registro[];
  /** A comanda que já tem item (padrão) ou ficou VAZIA — item 3 da #2475. */
  itens?: Registro[];
  /** O que `sales` devolve quando a consulta É de leitura (a comanda já existe). */
  comandaExistente?: Registro | null;
  /** Código de erro do insert do vínculo — `23505` é a corrida (item 2 da #2475). */
  falhaVinculo?: { message: string; code: string } | null;
  /**
   * Na corrida, a leitura INICIAL não acha nada (a outra instância ainda não
   * gravou) — só a leitura DEPOIS do 23505 acha a vencedora.
   */
  vinculoSoAposConflito?: Registro[];
  /** Erro do `update` que cancela a comanda vazia de quem perdeu a corrida. */
  falhaCancelamento?: { message: string } | null;
  falhaRpc?: boolean;
  numero?: number;
} = {}) {
  const escritas: { tabela: string; dados: Registro }[] = [];
  const rpcs: { fn: string; args: Registro }[] = [];
  const selecoes: { tabela: string; filtros: Registro }[] = [];
  const atualizacoes: { tabela: string; dados: Registro; filtros: Registro }[] = [];

  const cadeia = (tabela: string) => {
    const estado: { filtros: Registro; inserido: Registro | null; atualizado: boolean } = {
      filtros: {},
      inserido: null,
      atualizado: false,
    };
    const resolver = () => {
      if (estado.atualizado) return resposta(null, opcoes.falhaCancelamento ?? null);
      if (estado.inserido) {
        if (tabela === "crm_lead_links" && opcoes.falhaVinculo) {
          return resposta(null, opcoes.falhaVinculo);
        }
        if (tabela === "sales") {
          return resposta({ id: COMANDA, number: opcoes.numero ?? 7, status: "open" });
        }
        return resposta({ id: `${tabela}-novo` });
      }
      if (tabela === "crm_lead_links") {
        if (opcoes.vinculoSoAposConflito) {
          // Primeira leitura (antes da corrida): ainda não existe nada.
          const jaLeu = selecoes.filter((s) => s.tabela === "crm_lead_links").length > 1;
          return resposta(jaLeu ? (opcoes.vinculoSoAposConflito[0] ?? null) : null);
        }
        return resposta(opcoes.vinculos?.[0] ?? null);
      }
      // Leitura do item: `itens: []` é a comanda vazia que o retry tem que completar.
      if (tabela === "sale_items") return resposta(opcoes.itens?.[0] ?? null);
      if (tabela === "sales") {
        return resposta(opcoes.comandaExistente ?? { id: COMANDA, number: opcoes.numero ?? 7 });
      }
      if (tabela === "organizations") return resposta({ currency: "BRL" });
      throw new Error(`consulta inesperada no teste: ${tabela}`);
    };
    const c: Record<string, unknown> = {};
    Object.assign(c, {
      select: () => {
        // Mesmo objeto que `eq` vai preencher: a leitura grava a referência.
        selecoes.push({ tabela, filtros: estado.filtros });
        return c;
      },
      eq: (coluna: string, valor: unknown) => {
        estado.filtros[coluna] = valor;
        return c;
      },
      limit: () => c,
      update: (dados: Registro) => {
        estado.atualizado = true;
        atualizacoes.push({ tabela, dados, filtros: estado.filtros });
        return c;
      },
      insert: (dados: Registro) => {
        estado.inserido = dados;
        escritas.push({ tabela, dados });
        return c;
      },
      maybeSingle: async () => resolver(),
      single: async () => resolver(),
      then: (ok: (v: unknown) => unknown, erro?: (e: unknown) => unknown) =>
        Promise.resolve(resolver()).then(ok, erro),
    });
    return c;
  };

  const supabase = {
    from: (tabela: string) => cadeia(tabela),
    rpc: (fn: string, args: Registro) => {
      rpcs.push({ fn, args });
      if (opcoes.falhaRpc) return resposta(null, { message: "sequência indisponível" });
      return resposta((opcoes.numero ?? 7) as number);
    },
  };

  return { supabase: supabase as never, escritas, rpcs, selecoes, atualizacoes };
}

const entrada = (sobrescrita: Partial<Parameters<typeof comandaDoGanho>[1]> = {}) => ({
  organizationId: ORG,
  leadId: LEAD,
  contactId: CONTATO,
  valorCents: 150_000,
  descricao: DESCRICAO,
  userId: USER,
  ...sobrescrita,
});

describe("comandaDoGanho", () => {
  it("ganho com valor e contato: abre a comanda com o valor e o contato do negócio e grava o vínculo", async () => {
    const falso = bancoFalso();

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({
      estado: "criado",
      comandaId: COMANDA,
      numero: 7,
      valorCents: 150_000,
    });

    const comanda = falso.escritas.find((e) => e.tabela === "sales");
    expect(comanda?.dados).toMatchObject({
      organization_id: ORG,
      contact_id: CONTATO,
      number: 7,
      currency: "BRL",
      attendant_user_id: USER,
      created_by_user_id: USER,
    });

    // O VALOR viaja como item da comanda: comanda aberta sem item some com o
    // R$ do negócio e o operador vê zero na tela que existe para cobrar.
    const item = falso.escritas.find((e) => e.tabela === "sale_items");
    expect(item?.dados).toMatchObject({
      organization_id: ORG,
      sale_id: COMANDA,
      description: DESCRICAO,
      quantity: 1,
      unit_price_cents: 150_000,
      total_cents: 150_000,
      attendant_user_id: USER,
    });

    // A ORIGEM do lançamento: sem migration não existe `financial_entries.origin
    // = 'crm'` (o CHECK é 'manual' | 'sale' | 'reversal' | 'recurring'), então a
    // marca fica no vínculo, que é onde o dossiê do negócio já procura.
    const vinculo = falso.escritas.find((e) => e.tabela === "crm_lead_links");
    expect(vinculo?.dados).toMatchObject({
      organization_id: ORG,
      lead_id: LEAD,
      target_kind: ALVO_DE_VINCULO_DA_COMANDA,
      target_id: COMANDA,
      link_kind: VINCULO_DE_COMANDA_NO_GANHO,
      created_by_user_id: USER,
      metadata: { origem: "ganho_no_kanban", value_cents: 150_000, number: 7 },
    });
    // O vínculo já aponta para o lead; uma cópia do título ficaria fora da
    // cascata de redact da LGPD.
    expect((vinculo?.dados as { metadata: Registro }).metadata).not.toHaveProperty("titulo");
  });

  it("fechar de novo não duplica: com o vínculo já gravado devolve a comanda que existe e não escreve nada", async () => {
    const falso = bancoFalso({
      vinculos: [{ id: "link", target_id: COMANDA }],
      // A comanda tem item: é o caso do "já está tudo lá" — nada a completar.
      itens: [{ id: "item-que-ja-existe" }],
    });

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({ estado: "ja_existia", comandaId: COMANDA });
    expect(falso.escritas).toHaveLength(0);
    expect(falso.rpcs).toHaveLength(0);

    // A trava lê o marcador certo: sem `target_kind`/`link_kind` na consulta, a
    // idempotência dependia de qualquer vínculo qualquer do lead.
    const leitura = falso.selecoes.find((s) => s.tabela === "crm_lead_links");
    expect(leitura?.filtros).toMatchObject({
      lead_id: LEAD,
      target_kind: ALVO_DE_VINCULO_DA_COMANDA,
      link_kind: VINCULO_DE_COMANDA_NO_GANHO,
    });
  });

  it("negócio sem valor não lança nada: sem dinheiro não há conta a receber a criar", async () => {
    for (const valorCents of [null, undefined, 0, -100]) {
      const falso = bancoFalso();
      const desfecho = await comandaDoGanho(falso.supabase, entrada({ valorCents: valorCents as number }));
      expect(desfecho).toEqual({ estado: "ignorado", motivo: "sem_valor_valido" });
      expect(falso.escritas).toHaveLength(0);
    }
  });

  it("falha na numeração devolve `falhou` e não escreve nada — a rota do move nunca é derrubada", async () => {
    const falso = bancoFalso({ falhaRpc: true });

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({ estado: "falhou", erro: expect.stringContaining("sequência indisponível") });
    expect(falso.escritas).toHaveLength(0);
  });

  // ─── #2475, item 3 ─────────────────────────────────────────────────────────
  it("vínculo gravado mas comanda VAZIA: a repetição completa o item em vez de devolver ok com zero", async () => {
    // O cenário da issue: o insert do item falhou na tentativa anterior, o
    // vínculo foi gravado de propósito (não duplicar dinheiro) e a próxima
    // rodada viajava o vínculo. Antes disto, o desfecho era `ja_existia` e o
    // handler devolvia `ok` — comanda de R$ 0 para sempre, ninguém avisado.
    const falso = bancoFalso({
      vinculos: [{ id: "link", target_id: COMANDA }],
      itens: [], // comanda sem item = a falha de antes
      comandaExistente: { id: COMANDA, number: 12, status: "open" },
    });

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({
      estado: "criado",
      comandaId: COMANDA,
      numero: 12,
      valorCents: 150_000,
    });
    const item = falso.escritas.find((e) => e.tabela === "sale_items");
    expect(item?.dados).toMatchObject({
      sale_id: COMANDA,
      description: DESCRICAO,
      unit_price_cents: 150_000,
      total_cents: 150_000,
    });
    // E o ponto da issue: a comanda VAZIA não vira a segunda comanda. A
    // numeração nem é consultada — nada novo nasce, só o item que faltava.
    expect(falso.escritas.find((e) => e.tabela === "sales")).toBeUndefined();
    expect(falso.rpcs).toHaveLength(0);
  });

  it("comanda vazia que o operador já FINALIZOU: a repetição não põe item nela", async () => {
    // O gatilho do retry é "vinculada e sem item" — e isso inclui a comanda que
    // alguém já fechou. Dinheiro numa comanda finalizada mudaria um registro que
    // já saiu da mão de quem cobra.
    const falso = bancoFalso({
      vinculos: [{ id: "link", target_id: COMANDA }],
      itens: [],
      comandaExistente: { id: COMANDA, number: 12, status: "finalized" },
    });

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({ estado: "ja_existia", comandaId: COMANDA });
    expect(falso.escritas).toHaveLength(0);
    expect(falso.rpcs).toHaveLength(0);
  });

  it("comanda que JÁ tem item: a repetição não mexe em nada (o caso normal do 'já existia')", async () => {
    const falso = bancoFalso({
      vinculos: [{ id: "link", target_id: COMANDA }],
      itens: [{ id: "item-01" }],
    });

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({ estado: "ja_existia", comandaId: COMANDA });
    expect(falso.escritas).toHaveLength(0);
    expect(falso.rpcs).toHaveLength(0);
    // Nem a comanda é relida: sem item a faltar, não há o que perguntar.
    expect(falso.selecoes.find((s) => s.tabela === "sales")).toBeUndefined();
  });

  // ─── #2475, item 2 ─────────────────────────────────────────────────────────
  it("corrida perdida (23505 do índice novo) devolve a comanda da vencedora, sem girar no retry", async () => {
    // Worker e cron processando duas linhas `lead.won` do mesmo negócio: a
    // segunda não passa mais pela trava de leitura (a primeira ainda não gravou)
    // e só o índice único da migration 0582 segura. O desfecho tem que ser
    // `ja_existia` — devolver `falhou` mandaria o dreno reagendar para sempre.
    const falso = bancoFalso({
      falhaVinculo: { message: "duplicate key value violates unique constraint", code: "23505" },
      // A leitura inicial acha nada (a outra ainda não gravou); a que vem DEPOIS
      // do 23505 acha a vencedora.
      vinculoSoAposConflito: [{ id: "link-da-outra", target_id: "77777777-7777-4777-8777-777777777777" }],
    });

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({
      estado: "ja_existia",
      comandaId: "77777777-7777-4777-8777-777777777777",
    });
    // Sem item: a perdedora não chega a pôr dinheiro em jogo.
    expect(falso.escritas.find((e) => e.tabela === "sale_items")).toBeUndefined();
  });

  it("corrida perdida: a comanda vazia que a perdedora abriu é CANCELADA, não fica aberta e órfã", async () => {
    const falso = bancoFalso({
      falhaVinculo: { message: "duplicate key value violates unique constraint", code: "23505" },
      vinculoSoAposConflito: [{ id: "link-da-outra", target_id: "77777777-7777-4777-8777-777777777777" }],
    });

    await comandaDoGanho(falso.supabase, entrada());

    // `sales` cancela, nunca apaga — e só a comanda desta instância, ainda aberta.
    expect(falso.atualizacoes).toEqual([
      {
        tabela: "sales",
        dados: {
          status: "cancelled",
          cancelled_at: expect.any(String),
          cancel_reason: MOTIVO_DO_CANCELAMENTO_NA_CORRIDA,
        },
        filtros: { organization_id: ORG, id: COMANDA, status: "open" },
      },
    ]);
  });

  it("corrida perdida e o cancelamento falha: devolve `falhou` com o motivo, não esconde a comanda órfã", async () => {
    const falso = bancoFalso({
      falhaVinculo: { message: "duplicate key value violates unique constraint", code: "23505" },
      vinculoSoAposConflito: [{ id: "link-da-outra", target_id: "77777777-7777-4777-8777-777777777777" }],
      falhaCancelamento: { message: "conexão caiu" },
    });

    const desfecho = await comandaDoGanho(falso.supabase, entrada());

    expect(desfecho).toEqual({ estado: "falhou", erro: expect.stringContaining("conexão caiu") });
    expect(falso.escritas.find((e) => e.tabela === "sale_items")).toBeUndefined();
  });

  it("a trava vem ANTES do dinheiro: o vínculo é gravado antes do item", async () => {
    // A ordem é o que decide o tamanho do estrago da corrida — a perdedora
    // entrega uma comanda vazia (que ela mesma cancela) em vez de uma segunda comanda
    // com o mesmo valor (lançamento duplicado).
    const falso = bancoFalso();

    await comandaDoGanho(falso.supabase, entrada());

    const ordem = falso.escritas.map((e) => e.tabela);
    expect(ordem).toEqual(["sales", "crm_lead_links", "sale_items"]);
  });
});
