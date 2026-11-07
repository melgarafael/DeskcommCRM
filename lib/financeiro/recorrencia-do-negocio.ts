/**
 * A RECORRÊNCIA DO NEGÓCIO — #3602, fatias 3 e 4.
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * `recurring_entries` descreve o que deve nascer todo mês, e o cron da rota
 * `app/api/v1/cron/recurring-entries` transforma o molde em conta a receber.
 * Até aqui o molde só nascia digitado à mão: quem vendia "setup + mensalidade"
 * ganhava o negócio no funil e a receita recorrente ficava só no número do
 * card (`crm_leads.recurring_value_cents`, fatia 1) — o financeiro não sabia
 * que ela existia.
 *
 * Esta função é o elo: no GANHO, com `recurring_value_cents` declarado, cria
 * UM molde ativo ligado ao negócio; na PERDA, desativa o molde DAQUELE
 * negócio. Nada mais — flag por funil e tela própria são decisão de produto e
 * ficaram fora desta onda (declarado no PR).
 *
 * ─── Por que molde, e não lançamento ───────────────────────────────────────
 *
 * Um `financial_entries` exige `account_id` e uma competência; o ganho não
 * sabe se a primeira mensalidade já venceu nem em que conta o dinheiro cai.
 * O molde é o mesmo caminho que a tela do financeiro usa: o cron decide a
 * competência, nasce PENDENTE, e quem confirma o pagamento é uma pessoa.
 *
 * ─── A conta: a primeira ativa da organização ──────────────────────────────
 *
 * `recurring_entries.account_id` é NOT NULL e `financial_accounts` não tem
 * conceito de "conta padrão" — decisão de produto em aberto (#3602). Enquanto
 * ela não existe, vale a PRIMEIRA conta ativa da organização (ordem de
 * criação): é determinística, cai na conta que todo mundo cria primeiro e, se
 * a organização não tem conta nenhuma, o ganho NÃO cria molde nenhum em vez
 * de inventar uma conta — sem conta não há onde o dinheiro cair.
 *
 * ─── Idempotência: a leitura some sozinha numa corrida ─────────────────────
 *
 * Antes de escrever, a função procura o molde do negócio. A garantia de
 * verdade é o índice único parcial `recurring_entries_org_lead_uidx`
 * (migration 9246): dois arrastos simultâneos passam pela mesma leitura, um
 * grava e o outro recebe `23505` — tratado como `ja_existia`, o mesmo desfecho
 * do cron quando o índice de competência pega.
 *
 * ─── O que esta função NUNCA faz ───────────────────────────────────────────
 *
 * Derrubar o movimento do negócio: toda falha vira `falhou` no retorno, nunca
 * exceção. O card já moveu, e o financeiro atrasado é melhor do que um arrasto
 * que não acontece.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { moedaDaOrganizacao } from "@/lib/catalogo/moeda-da-org";
import { moduloLigado } from "@/lib/instalacao/modulos";

/** A direção do molde: a recorrência do negócio é receita. */
export const DIRECAO_DA_RECORRENCIA_DO_NEGOCIO = "in" as const;

export interface EntradaDaRecorrenciaDoNegocio {
  organizationId: string;
  leadId: string;
  /** `crm_leads.pipeline_id` — o nome do funil entra na descrição do molde. */
  pipelineId: string | null;
  /** `crm_leads.recurring_value_cents` — bigint, que o PostgREST pode devolver como texto. */
  valorCents?: number | string | null;
  /** `crm_leads.created_at` — a origem do `day_of_month`. */
  criadoEm: string | null;
  /** `crm_leads.owner_user_id`: autor do molde, pode ser nulo (a IA move sem dono). */
  userId: string | null;
}

export type DesfechoDaRecorrenciaDoNegocio =
  | { estado: "criado"; recorrenciaId: string; valorCents: number; diaDoMes: number }
  | { estado: "ja_existia"; recorrenciaId: string | null }
  | {
      estado: "ignorado";
      motivo: "sem_valor_valido" | "modulo_financeiro_nao_instalado" | "sem_conta_financeira";
    }
  | { estado: "falhou"; erro: string };

export type DesfechoDaDesativacao =
  | { estado: "desativado"; recorrenciaId: string }
  | { estado: "nada_a_desativar" }
  | { estado: "falhou"; erro: string };

/**
 * `value_cents` é bigint. Aceito número inteiro positivo OU texto só com
 * dígitos (a forma que o PostgREST devolve bigint em algumas configurações);
 * qualquer outra coisa — `null`, zero, negativo, casa decimal — não é dinheiro
 * lançável e vira `ignorado`. A regra é a MESMA de `valorLancavel` em
 * `comanda-do-ganho.ts`: dois caminhos do ganho não podem discordar sobre o
 * que é um valor.
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
 * O dia do mês do molde, a partir do `created_at` do negócio.
 *
 * Em UTC porque `created_at` é um INSTANTE e `day_of_month` é um dia civil: usar
 * o fuso do servidor faria o mesmo negócio nascer dia 4 numa instalação e dia 5
 * em outra. Dia válido por construção (1..31) — o clamp existe para data
 * ilegível não derrubar o ganho, e cai no dia 1 como qualquer default de
 * coluna.
 */
export function diaDoMesDoNegocio(criadoEm: string | null): number {
  if (!criadoEm) return 1;
  const data = new Date(criadoEm);
  const dia = data.getUTCDate();
  return Number.isFinite(dia) && dia >= 1 && dia <= 31 ? dia : 1;
}

/**
 * Cria o molde recorrente do negócio ganho. Idempotente; nunca lança exceção
 * para quem chamou.
 */
export async function recorrenciaDoNegocio(
  supabase: SupabaseClient,
  entrada: EntradaDaRecorrenciaDoNegocio,
): Promise<DesfechoDaRecorrenciaDoNegocio> {
  const valor = valorLancavel(entrada.valorCents);
  if (valor === null) return { estado: "ignorado", motivo: "sem_valor_valido" };

  // `recurring_entries` é tabela do módulo financeiro (ADR-0002, #1907): sem o
  // módulo instalado, a tela que mostraria o molde não existe, e gravá-lo
  // criaria receita que ninguém enxerga.
  if (!(await moduloLigado(supabase, "financeiro"))) {
    return { estado: "ignorado", motivo: "modulo_financeiro_nao_instalado" };
  }

  // A leitura antes da escrita: fechar, reabrir e fechar de novo é fluxo normal
  // do funil, e o segundo fecho não pode criar um segundo molde.
  const { data: existente, error: erroLeitura } = await supabase
    .from("recurring_entries")
    .select("id")
    .eq("organization_id", entrada.organizationId)
    .eq("crm_lead_id", entrada.leadId)
    .limit(1)
    .maybeSingle();
  if (erroLeitura) return { estado: "falhou", erro: `molde: ${erroLeitura.message}` };
  if (existente) {
    return { estado: "ja_existia", recorrenciaId: String((existente as { id: string }).id) };
  }

  const { data: conta, error: erroConta } = await supabase
    .from("financial_accounts")
    .select("id")
    .eq("organization_id", entrada.organizationId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (erroConta) return { estado: "falhou", erro: `conta: ${erroConta.message}` };
  if (!conta) return { estado: "ignorado", motivo: "sem_conta_financeira" };

  // A descrição vem do FUNIL, nunca do `crm_leads.title` (que costuma ser o
  // nome ou o telefone do contato e fica fora da cascata de redact da LGPD):
  // o molde sobrevive ao negócio e ao pedido do titular.
  const { data: funil } = await supabase
    .from("crm_pipelines")
    .select("name")
    .eq("id", entrada.pipelineId ?? "")
    .eq("organization_id", entrada.organizationId)
    .maybeSingle();
  const nomeDoFunil = (funil as { name?: unknown } | null)?.name;
  const descricao =
    typeof nomeDoFunil === "string" && nomeDoFunil.trim()
      ? `Recorrência · ${nomeDoFunil.trim()}`
      : "Recorrência do negócio";

  const diaDoMes = diaDoMesDoNegocio(entrada.criadoEm);
  const { data: criado, error: erroInsert } = await supabase
    .from("recurring_entries")
    .insert({
      organization_id: entrada.organizationId,
      crm_lead_id: entrada.leadId,
      name: descricao,
      account_id: (conta as { id: string }).id,
      direction: DIRECAO_DA_RECORRENCIA_DO_NEGOCIO,
      amount_cents: valor,
      currency: await moedaDaOrganizacao(supabase, entrada.organizationId),
      day_of_month: diaDoMes,
      is_active: true,
      created_by_user_id: entrada.userId,
    })
    .select("id")
    .maybeSingle();

  if (erroInsert) {
    // 23505 = o índice único pegou: outra requisição criou o molde entre a
    // leitura e o insert. É o desfecho correto, não erro.
    if (erroInsert.code === "23505") return { estado: "ja_existia", recorrenciaId: null };
    return { estado: "falhou", erro: `molde: ${erroInsert.message}` };
  }
  if (!criado) return { estado: "falhou", erro: "molde: insert sem retorno" };

  return {
    estado: "criado",
    recorrenciaId: String((criado as { id: string }).id),
    valorCents: valor,
    diaDoMes,
  };
}

/**
 * Desativa o molde do negócio perdido — só o DELE, e só na organização dele.
 *
 * `is_active = false` e não `delete`: o molde explica lançamentos que já foram
 * gerados e pagos, e apagá-lo deixaria as contas a receber sem a origem. A
 * condição `is_active = true` no UPDATE torna a segunda perda um no-op.
 */
export async function desativaRecorrenciaDoNegocio(
  supabase: SupabaseClient,
  entrada: { organizationId: string; leadId: string },
): Promise<DesfechoDaDesativacao> {
  const { data: desativados, error } = await supabase
    .from("recurring_entries")
    .update({ is_active: false, updated_at: new Date().toISOString() })
    .eq("organization_id", entrada.organizationId)
    .eq("crm_lead_id", entrada.leadId)
    .eq("is_active", true)
    .select("id");

  if (error) return { estado: "falhou", erro: `molde: ${error.message}` };
  const [primeira] = (desativados ?? []) as Array<{ id: string }>;
  if (!primeira) return { estado: "nada_a_desativar" };
  return { estado: "desativado", recorrenciaId: String(primeira.id) };
}
