/**
 * A CONTA A RECEBER DO GANHO — #1477.
 *
 * Mover o card para uma etapa `is_won` fechava o negócio no CRM e não dizia nada
 * ao financeiro: quem vendia pelo Kanban tinha de lembrar de abrir a Comandas à
 * mão, em outra tela, sem nenhum vínculo visual. Esta função fecha esse laço no
 * caminho que JÁ existe — ela abre uma comanda (a `sales` da tela de Comandas)
 * com o valor e o contato do negócio e grava a ligação dela com o lead.
 *
 * ─── Por que o vínculo, e não uma coluna nova ────────────────────────────────
 *
 * `sales` não tem `lead_id` (a issue mediu: a tabela nasceu em torno de
 * contato + agendamento) e acrescentar a FK exigiria migration — que está fora
 * do escopo desta fatia. Quem amarra as duas pontas é `crm_lead_links`, cujo
 * CHECK de `target_kind` **já aceita `'order'`** e cujo índice único
 * (`lead_id`, `target_kind`, `target_id`) impede duas ligações para a mesma
 * comanda. `link_kind`, coluna sem CHECK, é vocabulário aberto: quem escreve usa
 * a constante de aqui, nunca a string solta (mesma doutrina de
 * `lib/agenda/tipos.ts`).
 *
 * ─── O que essa mesma ligação responde: idempotência ─────────────────────────
 *
 * Fechar, reabrir e fechar de novo é fluxo normal do funil. Antes de qualquer
 * escrita a função procura o vínculo do negócio com uma comanda; se existe, a
 * comanda que já foi aberta é devolvida (`ja_existia`) e nada mais é escrito —
 * é a trava do "não duplica" sem uma unique nova no banco. A janela que sobra
 * (duas requisições simultâneas) só fecha com índice único, ou seja, com
 * migration: declarada como pendência no PR, não esquecida.
 *
 * ─── Por que comanda e não `financial_entries` ───────────────────────────────
 *
 * Um lançamento em `financial_entries` exige `account_id` (em que conta o
 * dinheiro cai — decisão de produto que a issue deixa em aberto) e a coluna
 * `origin` tem CHECK fechado em `'manual' | 'sale' | 'reversal' | 'recurring'`:
 * gravar uma origem nova seria migration, e gravar `'manual'` seria mentir na
 * origem. A comanda ABERTA é o rascunho que a própria issue aponta como versão
 * mais segura: o operador confere o valor e finaliza com a forma de pagamento —
 * e é `fn_finalizar_comanda`, o caminho de sempre, quem transforma isso em
 * entrada de conta a receber.
 *
 * ─── O que a função NUNCA faz ────────────────────────────────────────────────
 *
 * Derrubar a movimentação do card. Toda falha vira `{ estado: "falhou" }` para a
 * rota registrar, nunca exceção: o negócio já ganhou, e o financeiro atrasado é
 * melhor do que um 500 no arrasto. E não inventa dinheiro: sem `value_cents`
 * válido não há o que lançar, e a função devolve `ignorado`.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";

/** O `target_kind` do vínculo com a comanda — valor que o CHECK já aceita. */
export const ALVO_DE_VINCULO_DA_COMANDA = "order" as const;

/** O `link_kind` da comanda aberta pelo ganho (coluna sem CHECK: vocabulário aqui). */
export const VINCULO_DE_COMANDA_NO_GANHO = "comanda_no_ganho" as const;

/** Como essa comanda nasceu, gravado no `metadata` do vínculo. */
export const ORIGEM_DA_COMANDA_DO_GANHO = "ganho_no_kanban" as const;

export interface EntradaDaComandaDoGanho {
  organizationId: string;
  leadId: string;
  /** O contato do negócio; `null` é legítimo (comanda sem cliente). */
  contactId: string | null;
  /** `crm_leads.value_cents` — bigint, que o PostgREST pode devolver como texto. */
  valorCents?: number | string | null;
  /** `crm_leads.title`: vira a descrição do item, congelada na inclusão. */
  titulo: string;
  /** Quem moveu o card: atendente e autor da comanda. */
  userId: string;
}

export type DesfechoDaComandaDoGanho =
  | { estado: "ignorado"; motivo: "sem_valor_valido" }
  | { estado: "ja_existia"; comandaId: string }
  | { estado: "criado"; comandaId: string; numero: number; valorCents: number }
  | { estado: "falhou"; erro: string };

/**
 * `value_cents` é bigint. Aceito número inteiro positivo OU texto só com
 * dígitos (a forma que o PostgREST devolve bigint em algumas configurações);
 * qualquer outra coisa — `null`, zero, negativo, casa decimal — não é dinheiro
 * lançável e vira `ignorado`.
 */
function valorLancavel(bruto: unknown): number | null {
  if (typeof bruto === "number") {
    return Number.isInteger(bruto) && bruto > 0 ? bruto : null;
  }
  if (typeof bruto === "string" && /^\d+$/.test(bruto)) {
    const n = Number(bruto);
    return n > 0 ? n : null;
  }
  return null;
}

/**
 * Abre a comanda do negócio ganho e liga as duas pontas. Idempotente pelo
 * vínculo; nunca lança exceção para quem chamou.
 */
export async function comandaDoGanho(
  supabase: SupabaseClient,
  entrada: EntradaDaComandaDoGanho,
): Promise<DesfechoDaComandaDoGanho> {
  const valor = valorLancavel(entrada.valorCents);
  if (valor === null) return { estado: "ignorado", motivo: "sem_valor_valido" };

  // A trava ANTES de qualquer escrita: fechar de novo devolve o que já existe.
  const { data: vinculo, error: erroLeitura } = await supabase
    .from("crm_lead_links")
    .select("id, target_id")
    .eq("organization_id", entrada.organizationId)
    .eq("lead_id", entrada.leadId)
    .eq("target_kind", ALVO_DE_VINCULO_DA_COMANDA)
    .eq("link_kind", VINCULO_DE_COMANDA_NO_GANHO)
    .limit(1)
    .maybeSingle();
  if (erroLeitura) return { estado: "falhou", erro: `vínculo: ${erroLeitura.message}` };
  if (vinculo) {
    return { estado: "ja_existia", comandaId: String((vinculo as { target_id: string }).target_id) };
  }

  const { data: numero, error: erroNumero } = await supabase.rpc("fn_proximo_numero_de_comanda", {
    p_org: entrada.organizationId,
  });
  if (erroNumero || numero === null || numero === undefined) {
    return { estado: "falhou", erro: `numeração: ${erroNumero?.message ?? "sem número"}` };
  }

  // A MOEDA VEM DA ORGANIZAÇÃO, nunca do corpo (#2160) — mesma fonte da rota de
  // comanda: ler de outro lugar é como uma tela passa a mostrar R$ ao lado de €.
  const moeda = await moedaDaOrganizacao(supabase, entrada.organizationId);

  const { data: comanda, error: erroComanda } = await supabase
    .from("sales")
    .insert({
      organization_id: entrada.organizationId,
      number: Number(numero),
      contact_id: entrada.contactId ?? null,
      appointment_id: null,
      attendant_user_id: entrada.userId,
      created_by_user_id: entrada.userId,
      currency: moeda,
    })
    .select("id, number")
    .single();
  if (erroComanda || !comanda) {
    return { estado: "falhou", erro: `comanda: ${erroComanda?.message ?? "linha não devolvida"}` };
  }
  const comandaId = String((comanda as { id: string }).id);
  const numeroDaComanda = Number((comanda as { number: number }).number);

  // O item leva o VALOR. Comanda aberta sem item tem total derivado zero e a
  // tela de Comandas mostraria R$ 0,00 para um negócio de mil — o número errado
  // que o operador acredita. `total_cents` é resolvido AQUI (doutrina da
  // `sale_items`: a finalização não recalcula).
  const { error: erroItem } = await supabase
    .from("sale_items")
    .insert({
      organization_id: entrada.organizationId,
      sale_id: comandaId,
      description: entrada.titulo,
      quantity: 1,
      unit_price_cents: valor,
      total_cents: valor,
      attendant_user_id: entrada.userId,
    })
    .select("id")
    .single();

  // O vínculo é o rastro E a trava: gravado mesmo quando o item falhou, porque a
  // alternativa é abrir a SEGUNDA comanda na próxima tentativa — duplicar
  // dinheiro é o erro pior que um item faltando à vista do operador.
  const { error: erroVinculo } = await supabase
    .from("crm_lead_links")
    .insert({
      organization_id: entrada.organizationId,
      lead_id: entrada.leadId,
      target_kind: ALVO_DE_VINCULO_DA_COMANDA,
      target_id: comandaId,
      link_kind: VINCULO_DE_COMANDA_NO_GANHO,
      created_by_user_id: entrada.userId,
      metadata: {
        origem: ORIGEM_DA_COMANDA_DO_GANHO,
        value_cents: valor,
        currency: moeda,
        number: numeroDaComanda,
        titulo: entrada.titulo,
      },
    })
    .select("id")
    .single();
  if (erroVinculo) {
    return { estado: "falhou", erro: `vínculo: ${erroVinculo.message}` };
  }
  if (erroItem) {
    return { estado: "falhou", erro: `item: ${erroItem.message}` };
  }

  return { estado: "criado", comandaId, numero: numeroDaComanda, valorCents: valor };
}
