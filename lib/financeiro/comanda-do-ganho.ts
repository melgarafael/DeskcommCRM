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
 * Derrubar o ganho. Toda falha vira `{ estado: "falhou" }` para quem chamou
 * registrar, nunca exceção: o negócio já ganhou, e o financeiro atrasado é
 * melhor do que derrubar o fecho. E não inventa dinheiro: sem `value_cents`
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

/** `sales.cancel_reason` da comanda vazia que perdeu a corrida do ganho. */
export const MOTIVO_DO_CANCELAMENTO_NA_CORRIDA = "corrida_do_ganho" as const;

export interface EntradaDaComandaDoGanho {
  organizationId: string;
  leadId: string;
  /** O contato do negócio; `null` é legítimo (comanda sem cliente). */
  contactId: string | null;
  /** `crm_leads.value_cents` — bigint, que o PostgREST pode devolver como texto. */
  valorCents?: number | string | null;
  /**
   * A descrição do item, congelada na inclusão. NUNCA dado de pessoa: o
   * `crm_leads.title` costuma ser o nome ou o telefone do contato (a automação
   * cria o negócio com `nomeDoContato(contact) ?? phone_number`), e a cascata
   * de redact da LGPD (`fn_lgpd_cascade_redact_contact`) anonimiza o título do
   * negócio mas não alcança `sale_items` — o que fosse copiado para cá
   * sobreviveria ao pedido do titular. Quem chama passa o vocabulário do funil;
   * o negócio em si continua alcançável pelo vínculo.
   */
  descricao: string;
  /**
   * O atendente e o autor da comanda. No consumidor de `lead.won` é o
   * `owner_user_id` do negócio (o `event_log` não guarda ator), que pode ser
   * nulo — `sales.attendant_user_id` e `created_by_user_id` aceitam nulo, então
   * a comanda nasce sem atendente em vez de não nascer.
   */
  userId: string | null;
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
    const comandaVinculada = String((vinculo as { target_id: string }).target_id);

    // ─── Item 3 da #2475: o vínculo existe mas a comanda pode estar VAZIA ──────
    // O vínculo é gravado mesmo quando o insert do item falhou (de propósito:
    // duplicar dinheiro é pior que um item faltando). O preço daquela escolha
    // aparecia AQUI: a tentativa seguinte viaja o vínculo, o desfecho era
    // `ja_existia`, o handler devolvia `ok` e a comanda ficava com total 0 para
    // sempre — ninguém avisado. Agora a repetição COMPLETA o que faltou, que é
    // a única escrita que não duplica dinheiro (o item é um só por comanda).
    const { data: item, error: erroItemLeitura } = await supabase
      .from("sale_items")
      .select("id")
      .eq("organization_id", entrada.organizationId)
      .eq("sale_id", comandaVinculada)
      .limit(1)
      .maybeSingle();
    if (erroItemLeitura) {
      return { estado: "falhou", erro: `item (revisão): ${erroItemLeitura.message}` };
    }
    if (item) return { estado: "ja_existia", comandaId: comandaVinculada };

    // A comanda nasceu sem item: o insert de antes falhou. Reinsere com o mesmo
    // valor, e a numeração sai da própria comanda — nada aqui é chute.
    const { data: linhaDaComanda, error: erroComandaLeitura } = await supabase
      .from("sales")
      .select("number, status")
      .eq("organization_id", entrada.organizationId)
      .eq("id", comandaVinculada)
      .maybeSingle();
    if (erroComandaLeitura || !linhaDaComanda) {
      return {
        estado: "falhou",
        erro: `comanda (revisão): ${erroComandaLeitura?.message ?? "linha não devolvida"}`,
      };
    }
    // Só uma comanda ABERTA recebe o item. Se o operador já finalizou ou
    // cancelou aquela comanda vazia, foi decisão dele: pôr dinheiro numa comanda
    // fechada mudaria um registro que já saiu da mão de quem cobra.
    const { number: numeroDaLinha, status } = linhaDaComanda as { number: number; status: string };
    if (status !== "open") return { estado: "ja_existia", comandaId: comandaVinculada };
    const numeroRecuperado = Number(numeroDaLinha);

    const { error: erroItemRetentado } = await supabase
      .from("sale_items")
      .insert({
        organization_id: entrada.organizationId,
        sale_id: comandaVinculada,
        description: entrada.descricao,
        quantity: 1,
        unit_price_cents: valor,
        total_cents: valor,
        attendant_user_id: entrada.userId,
      })
      .select("id")
      .single();
    if (erroItemRetentado) {
      return { estado: "falhou", erro: `item (retry): ${erroItemRetentado.message}` };
    }
    return {
      estado: "criado",
      comandaId: comandaVinculada,
      numero: numeroRecuperado,
      valorCents: valor,
    };
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

  // ─── Item 2 da #2475: a trava vem ANTES do dinheiro ────────────────────────
  // O índice único parcial da migration 0582 fecha a corrida entre o worker e o
  // `drain-loop` (#2475, item 2): duas linhas `lead.won` do mesmo negócio em
  // instâncias diferentes passavam as duas pela trava de leitura, porque
  // `uniq_crm_lead_links_lead_target_link` inclui `target_id` e não segura duas
  // comandas. Com o índice novo, a segunda recebe 23505 aqui.
  //
  // E o vínculo vem ANTES do item de propósito: se a corrida acontecer, a
  // perdedora entrega uma comanda VAZIA (total derivado zero) em vez de uma
  // segunda comanda com o mesmo dinheiro — a ordem dos dois inserts é o que
  // decide o tamanho do estrago. A comanda vazia a própria perdedora cancela
  // (abaixo); duas comandas de mil viram um lançamento duplicado.
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
        // Sem o título do negócio: o vínculo já aponta para o lead, e uma cópia
        // aqui ficaria fora da cascata de redact (ver `descricao`).
      },
    })
    .select("id")
    .single();
  if (erroVinculo) {
    // 23505 = o índice novo pegou a corrida: outra instância venceu. Não é
    // falha — é a prova de que o "não duplica" valeu, então devolve a comanda
    // que existe em vez de girar no retry.
    if (erroVinculo.code === "23505") {
      // A comanda que ESTA instância acabou de abrir ficou sem vínculo e sem
      // item: deixá-la aberta seria uma conta a receber de R$ 0 sem origem na
      // tela de Comandas. `sales` cancela, nunca apaga — e o motivo fica na linha.
      const { error: erroCancelamento } = await supabase
        .from("sales")
        .update({
          status: "cancelled",
          cancelled_at: new Date().toISOString(),
          cancel_reason: MOTIVO_DO_CANCELAMENTO_NA_CORRIDA,
        })
        .eq("organization_id", entrada.organizationId)
        .eq("id", comandaId)
        .eq("status", "open");
      if (erroCancelamento) {
        // Devolver `falhou` registra o erro no desfecho; a repetição do dreno
        // acha o vínculo da vencedora e converge para `ja_existia`.
        return {
          estado: "falhou",
          erro: `corrida perdida; comanda vazia ${comandaId} não cancelada: ${erroCancelamento.message}`,
        };
      }
      const { data: vencedora } = await supabase
        .from("crm_lead_links")
        .select("target_id")
        .eq("organization_id", entrada.organizationId)
        .eq("lead_id", entrada.leadId)
        .eq("target_kind", ALVO_DE_VINCULO_DA_COMANDA)
        .eq("link_kind", VINCULO_DE_COMANDA_NO_GANHO)
        .limit(1)
        .maybeSingle();
      if (vencedora) {
        return { estado: "ja_existia", comandaId: String(vencedora.target_id) };
      }
    }
    return { estado: "falhou", erro: `vínculo: ${erroVinculo.message}` };
  }

  // O item leva o VALOR. Comanda aberta sem item tem total derivado zero e a
  // tela de Comandas mostraria R$ 0,00 para um negócio de mil — o número errado
  // que o operador acredita. `total_cents` é resolvido AQUI (doutrina da
  // `sale_items`: a finalização não recalcula).
  //
  // Se este insert falhar, o vínculo JÁ existe: é a comanda vazia que o bloco
  // acima descreve, e a próxima tentativa a completa (item 3, acima) — não abre
  // uma segunda.
  const { error: erroItem } = await supabase
    .from("sale_items")
    .insert({
      organization_id: entrada.organizationId,
      sale_id: comandaId,
      description: entrada.descricao,
      quantity: 1,
      unit_price_cents: valor,
      total_cents: valor,
      attendant_user_id: entrada.userId,
    })
    .select("id")
    .single();
  if (erroItem) {
    return { estado: "falhou", erro: `item: ${erroItem.message}` };
  }

  return { estado: "criado", comandaId, numero: numeroDaComanda, valorCents: valor };
}
