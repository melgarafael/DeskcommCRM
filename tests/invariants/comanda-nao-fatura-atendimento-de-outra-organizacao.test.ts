import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A COMANDA NÃO FATURA O ATENDIMENTO DE OUTRA EMPRESA (#4845).
 *
 * ## O defeito que este arquivo prende
 *
 * `fn_finalizar_comanda` é `SECURITY DEFINER` e conferia a empresa da COMANDA
 * (`p_sale`), da forma de pagamento e da conta de destino — nunca a do
 * `appointment_id` nem a do `contact_id` que a comanda carrega. Como ela grava
 * `commissions` e um `financial_entries` `status='paid'` na `p_org`, uma
 * comanda da A apontando para um atendimento da B criava dinheiro na A por um
 * serviço prestado na B.
 *
 * E o passo que marca o agendamento filtra `organization_id = p_org`: o da B
 * continuava `confirmed`, pronto para ser faturado outra vez lá. O índice
 * único é por `(organization_id, appointment_id)`, então nada impedia a
 * cobrança dupla.
 *
 * ## Por que a guarda é do banco, e não só da rota
 *
 * A rota `financeiro/comandas/faturar-lote` foi consertada (lê com
 * `.eq("organization_id", org)` e recusa o lote inteiro quando um id é de
 * fora), mas ela não é a única porta: `financeiro/comandas/[id]/finalizar`
 * chama esta mesma função, e ela é `grant execute ... to authenticated` — pelo
 * PostgREST, qualquer sessão com papel `agent` na empresa alcança o RPC direto.
 *
 * ## O que se mede
 *
 * O erro nomeado, a AUSÊNCIA de escrita (contagem de `commissions` e
 * `financial_entries`, status da venda e do agendamento de origem) e o caminho
 * feliz — a comanda da própria empresa continua finalizando, com comissão,
 * lançamento e agendamento concluído.
 *
 * A chamada passa por um ajudante que captura a exceção: o bloco de exceção do
 * plpgsql é uma subtransação, então o que a função tiver escrito antes de
 * recusar volta atrás — e é exatamente isso que as contagens depois provam.
 */

const ORG_A = "a4845000-0000-4000-8000-000000000001";
const ORG_B = "a4845000-0000-4000-8000-000000000002";
/** Membro das DUAS: é o caso que a RLS não barra e que o defeito exige. */
const USER = "a4845000-1111-4000-8000-000000000001";

const CONTA_A = "a4845000-2222-4000-8000-000000000001";
const FORMA_A = "a4845000-3333-4000-8000-000000000001";
const CONTATO_A = "a4845000-4444-4000-8000-000000000001";
const CONTATO_B = "a4845000-4444-4000-8000-000000000002";
const AGENDA_A = "a4845000-5555-4000-8000-000000000001";
const AGENDA_B = "a4845000-5555-4000-8000-000000000002";

/** Comanda da A apontando para atendimento da B — o defeito. */
const VENDA_AGENDA_DE_FORA = "a4845000-6666-4000-8000-000000000001";
/** Comanda da A apontando para contato da B. */
const VENDA_CONTATO_DE_FORA = "a4845000-6666-4000-8000-000000000002";
/** Caminho feliz: tudo da A. */
const VENDA_DA_CASA = "a4845000-6666-4000-8000-000000000003";

const ITEM_AGENDA_DE_FORA = "a4845000-7777-4000-8000-000000000001";
const ITEM_CONTATO_DE_FORA = "a4845000-7777-4000-8000-000000000002";
const ITEM_DA_CASA = "a4845000-7777-4000-8000-000000000003";

/** Chama a função como `authenticated` com as claims da pessoa e devolve o erro (ou `sem_erro`). */
function finalizar(org: string, sale: string, forma: string): string {
  const out = sql(`
    select public.teste_4845_finalizar('${org}'::uuid, '${sale}'::uuid, '${forma}'::uuid, '${USER}'::uuid);
  `);
  return lastLine(out);
}

/** Quantas linhas desta tabela apontam para a venda/atendimento informado. */
function contar(tabela: string, filtro: string): number {
  return Number(lastLine(sql(`select count(*) from public.${tabela} where ${filtro};`)));
}

beforeAll(() => {
  // O módulo financeiro INSTALADO antes de semear: `sales` e `sale_items` saíram
  // do `baseline.sql` e nascem na provisionadora (ADR-0002 D2/D3).
  sql("select public.fn_financeiro_provisionar();");

  sql(`
    insert into auth.users (id, email) values
      ('${USER}', 'comanda-4845-multi@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'comanda-4845-a', 'Comanda 4845 A', 'Comanda A'),
      ('${ORG_B}', 'comanda-4845-b', 'Comanda 4845 B', 'Comanda B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER}', '${ORG_A}', 'manager', now()),
      ('${USER}', '${ORG_B}', 'manager', now())
      on conflict do nothing;

    insert into public.financial_accounts (id, organization_id, name) values
      ('${CONTA_A}', '${ORG_A}', 'Caixa 4845 A')
      on conflict (id) do nothing;

    insert into public.payment_methods (id, organization_id, name, account_id, is_active) values
      ('${FORMA_A}', '${ORG_A}', 'Pix 4845', '${CONTA_A}', true)
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name) values
      ('${CONTATO_A}', '${ORG_A}', 'Cliente da casa'),
      ('${CONTATO_B}', '${ORG_B}', 'Cliente da outra empresa')
      on conflict (id) do nothing;

    insert into public.calendar_appointments
      (id, organization_id, title, starts_at, ends_at, status, owner_user_id, contact_id) values
      ('${AGENDA_A}', '${ORG_A}', 'Corte', '2026-11-10 12:00Z', '2026-11-10 13:00Z', 'confirmed', '${USER}', '${CONTATO_A}'),
      ('${AGENDA_B}', '${ORG_B}', 'Corte', '2026-11-10 12:00Z', '2026-11-10 13:00Z', 'confirmed', '${USER}', '${CONTATO_B}')
      on conflict (id) do nothing;

    insert into public.sales
      (id, organization_id, number, contact_id, appointment_id, attendant_user_id,
       payment_method_id, status, total_cents, currency)
    values
      -- 1. a comanda é da A; o atendimento é da B
      ('${VENDA_AGENDA_DE_FORA}', '${ORG_A}', 1, '${CONTATO_A}', '${AGENDA_B}', '${USER}', '${FORMA_A}', 'open', 0, 'BRL'),
      -- 2. a comanda é da A; o cliente é da B (sem agendamento)
      ('${VENDA_CONTATO_DE_FORA}', '${ORG_A}', 2, '${CONTATO_B}', null, '${USER}', '${FORMA_A}', 'open', 0, 'BRL'),
      -- 3. tudo da A
      ('${VENDA_DA_CASA}', '${ORG_A}', 3, '${CONTATO_A}', '${AGENDA_A}', '${USER}', '${FORMA_A}', 'open', 0, 'BRL')
      on conflict (id) do nothing;

    insert into public.sale_items
      (id, organization_id, sale_id, description, attendant_user_id,
       quantity, unit_price_cents, total_cents, commission_percent) values
      ('${ITEM_AGENDA_DE_FORA}', '${ORG_A}', '${VENDA_AGENDA_DE_FORA}', 'Corte', '${USER}', 1, 5000, 5000, 10),
      ('${ITEM_CONTATO_DE_FORA}', '${ORG_A}', '${VENDA_CONTATO_DE_FORA}', 'Corte', '${USER}', 1, 5000, 5000, 10),
      ('${ITEM_DA_CASA}', '${ORG_A}', '${VENDA_DA_CASA}', 'Corte', '${USER}', 1, 5000, 5000, 10)
      on conflict (id) do nothing;

    -- O ajudante: põe as claims da sessão e captura a recusa, para o teste
    -- poder OLHAR o que sobrou depois dela.
    create or replace function public.teste_4845_finalizar(
      p_org uuid, p_sale uuid, p_forma uuid, p_user uuid
    ) returns text language plpgsql as $fn$
    begin
      perform set_config('request.jwt.claims', json_build_object('sub', p_user)::text, false);
      perform public.fn_finalizar_comanda(p_org, p_sale, p_forma, 0);
      return 'sem_erro';
    exception when others then
      return sqlerrm;
    end $fn$;
  `);
});

describe("fn_finalizar_comanda recusa comanda que aponta para fora da empresa", () => {
  it("atendimento de outra empresa: erro nomeado e NADA gravado", async () => {
    const antes = {
      comissoes: contar("commissions", `sale_item_id = '${ITEM_AGENDA_DE_FORA}'`),
      lancamentos: contar("financial_entries", `sale_id = '${VENDA_AGENDA_DE_FORA}'`),
    };

    const erro = finalizar(ORG_A, VENDA_AGENDA_DE_FORA, FORMA_A);

    expect(erro).toContain("agendamento_de_outra_organizacao");
    expect(contar("commissions", `sale_item_id = '${ITEM_AGENDA_DE_FORA}'`)).toBe(antes.comissoes);
    expect(contar("financial_entries", `sale_id = '${VENDA_AGENDA_DE_FORA}'`)).toBe(
      antes.lancamentos,
    );
    // A venda continua ABERTA e o atendimento da B continua pendente lá: a
    // recusa não pode ter marcado nada de um lado nem do outro.
    expect(lastLine(sql(`select status from public.sales where id = '${VENDA_AGENDA_DE_FORA}';`))).toBe(
      "open",
    );
    expect(
      lastLine(sql(`select status from public.calendar_appointments where id = '${AGENDA_B}';`)),
    ).toBe("confirmed");
  });

  it("cliente de outra empresa: erro nomeado e NADA gravado", async () => {
    const erro = finalizar(ORG_A, VENDA_CONTATO_DE_FORA, FORMA_A);

    expect(erro).toContain("contato_de_outra_organizacao");
    expect(contar("financial_entries", `sale_id = '${VENDA_CONTATO_DE_FORA}'`)).toBe(0);
    expect(contar("commissions", `sale_item_id = '${ITEM_CONTATO_DE_FORA}'`)).toBe(0);
    expect(
      lastLine(sql(`select status from public.sales where id = '${VENDA_CONTATO_DE_FORA}';`)),
    ).toBe("open");
  });

  it("a mensagem da recusa não diz de quem é o atendimento (nem nome, nem valor)", async () => {
    const erro = finalizar(ORG_A, VENDA_AGENDA_DE_FORA, FORMA_A);

    expect(erro).not.toContain("Cliente da outra empresa");
    expect(erro).not.toContain(ORG_B);
    expect(erro).not.toContain("5000");
  });

  it("caminho feliz: a comanda da própria empresa finaliza, com comissão e lançamento", async () => {
    const erro = finalizar(ORG_A, VENDA_DA_CASA, FORMA_A);

    expect(erro).toBe("sem_erro");
    expect(lastLine(sql(`select status from public.sales where id = '${VENDA_DA_CASA}';`))).toBe(
      "finalized",
    );
    expect(lastLine(sql(`select status from public.calendar_appointments where id = '${AGENDA_A}';`))).toBe(
      "completed",
    );
    expect(contar("financial_entries", `sale_id = '${VENDA_DA_CASA}'`)).toBe(1);
    expect(contar("commissions", `sale_item_id = '${ITEM_DA_CASA}'`)).toBe(1);
  });
});
