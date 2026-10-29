/**
 * Semente do módulo "Financeiro" (Configurações › Financeiro): o catálogo de uma
 * clínica que já começou a se organizar — duas contas, três formas de pagamento
 * (uma ainda sem conta, que é o aviso que a lição ensina a resolver), quatro
 * planos de contas e dois lançamentos de todo mês.
 *
 * A seção "Comissão" (módulo "Comandas") fica de fora de propósito: a lista de
 * pessoas dela lê `name`/`email`, e a rota que a alimenta devolve `full_name`,
 * então toda pessoa aparece como "alguém" e as opções do seletor saem em branco.
 * Não se ensina caminho quebrado — o módulo fica desligado, como na fábrica.
 *
 * Idempotente e só sobre as próprias linhas: as da semente voltam pelo id fixo
 * (upsert, ativas e com os valores originais — sem apagar, porque a conta é
 * `on delete restrict` e um lançamento gerado pelo cron a prenderia); as que as
 * lições criam pela tela saem pelo nome.
 */
import { type Contexto, semErro } from "../semear-demonstracao";

const id = (bloco: number, n: number) => `be7f0${bloco}00-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CONTA = { caixa: id(1, 1), banco: id(1, 2) };

/** O que as lições criam pela tela — some antes da lição seguinte. */
const CRIADO_NAS_LICOES = {
  financial_accounts: "Conta da maquininha",
  payment_methods: "Cartão de débito",
  account_plans: "Material de escritório",
  recurring_entries: "Honorários do contador",
} as const;

export async function semear(c: Contexto) {
  const { db, org, pessoa } = c;

  // ---------- limpa o que as lições criaram (filhos antes das contas) ----------
  for (const tabela of ["recurring_entries", "payment_methods", "account_plans", "financial_accounts"] as const) {
    semErro(
      await db.from(tabela).delete().eq("organization_id", org).eq("name", CRIADO_NAS_LICOES[tabela]),
      `limpar ${tabela}`,
    );
  }

  // ---------- recria as linhas da semente ----------
  semErro(await db.from("financial_accounts").upsert([
    { id: CONTA.caixa, organization_id: org, name: "Caixa da recepção", kind: "cash", opening_balance_cents: 0, currency: "BRL", is_active: true },
    { id: CONTA.banco, organization_id: org, name: "Conta corrente da clínica", kind: "bank", opening_balance_cents: 0, currency: "BRL", is_active: true },
  ], { onConflict: "id" }), "contas");

  semErro(await db.from("payment_methods").upsert([
    { id: id(2, 1), organization_id: org, name: "Pix", account_id: CONTA.banco, is_active: true },
    { id: id(2, 2), organization_id: org, name: "Dinheiro", account_id: CONTA.caixa, is_active: true },
    { id: id(2, 3), organization_id: org, name: "Cartão de crédito", account_id: null, is_active: true },
  ], { onConflict: "id" }), "formas de pagamento");

  semErro(await db.from("account_plans").upsert([
    { id: id(3, 1), organization_id: org, name: "Consultas e sessões", direction: "in", is_active: true },
    { id: id(3, 2), organization_id: org, name: "Convênios", direction: "in", is_active: true },
    { id: id(3, 3), organization_id: org, name: "Aluguel", direction: "out", is_active: true },
    { id: id(3, 4), organization_id: org, name: "Material de consumo", direction: "out", is_active: true },
  ], { onConflict: "id" }), "planos de contas");

  semErro(await db.from("recurring_entries").upsert([
    {
      id: id(4, 1), organization_id: org, name: "Aluguel da sala", account_id: CONTA.banco, account_plan_id: id(3, 3),
      direction: "out", amount_cents: 320_000, currency: "BRL", day_of_month: 5, is_active: true, created_by_user_id: pessoa.helena,
    },
    {
      id: id(4, 2), organization_id: org, name: "Internet e telefone", account_id: CONTA.banco, account_plan_id: null,
      direction: "out", amount_cents: 18_990, currency: "BRL", day_of_month: 10, is_active: true, created_by_user_id: pessoa.helena,
    },
  ], { onConflict: "id" }), "lançamentos de todo mês");
}
