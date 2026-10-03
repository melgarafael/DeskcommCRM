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
  VINCULO_DE_COMANDA_NO_GANHO,
} from "./comanda-do-ganho";

const ORG = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const CONTATO = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const COMANDA = "66666666-6666-4666-8666-666666666666";

const TITULO = "Pedido de customização";

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
  falhaRpc?: boolean;
  numero?: number;
} = {}) {
  const escritas: { tabela: string; dados: Registro }[] = [];
  const rpcs: { fn: string; args: Registro }[] = [];
  const selecoes: { tabela: string; filtros: Registro }[] = [];

  const cadeia = (tabela: string) => {
    const estado: { filtros: Registro; inserido: Registro | null } = {
      filtros: {},
      inserido: null,
    };
    const resolver = () => {
      if (estado.inserido) {
        if (tabela === "sales") {
          return resposta({ id: COMANDA, number: opcoes.numero ?? 7, status: "open" });
        }
        return resposta({ id: `${tabela}-novo` });
      }
      if (tabela === "crm_lead_links") return resposta(opcoes.vinculos?.[0] ?? null);
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

  return { supabase: supabase as never, escritas, rpcs, selecoes };
}

const entrada = (sobrescrita: Partial<Parameters<typeof comandaDoGanho>[1]> = {}) => ({
  organizationId: ORG,
  leadId: LEAD,
  contactId: CONTATO,
  valorCents: 150_000,
  titulo: TITULO,
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
      description: TITULO,
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
    expect(vinculo?.dados).toBeDefined();
    expect((vinculo?.dados as { metadata: { titulo: string } }).metadata.titulo).toBe(TITULO);
  });

  it("fechar de novo não duplica: com o vínculo já gravado devolve a comanda que existe e não escreve nada", async () => {
    const falso = bancoFalso({ vinculos: [{ id: "link", target_id: COMANDA }] });

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
});
