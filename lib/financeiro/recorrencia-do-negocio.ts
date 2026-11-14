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
 * negócio.
 *
 * Doc 312 = A: o ganho só cria quando a empresa ligou
 * `settings.financeiro.recorrencia_no_ganho` (desligada de fábrica); o molde
 * para no último mês de `crm_leads.recurring_months` (`ends_on`, migration
 * 9371); e o re-ganho depois de uma perda reativa o MESMO molde. A perda
 * desativa mesmo com a opção desligada: desligar não pode deixar cobrança
 * ativa sem dono.
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
 * (migration 9316): dois arrastos simultâneos passam pela mesma leitura, um
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
import { recorrenciaNoGanhoLigada } from "@/lib/schemas/settings";

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
  /** `crm_leads.recurring_months` — duração do contrato; nulo = sem prazo. */
  meses?: number | null;
}

export type DesfechoDaRecorrenciaDoNegocio =
  | { estado: "criado"; recorrenciaId: string; valorCents: number; diaDoMes: number }
  | { estado: "ja_existia"; recorrenciaId: string | null }
  | { estado: "reativado"; recorrenciaId: string }
  | {
      estado: "ignorado";
      motivo:
        | "sem_valor_valido"
        | "opcao_desligada"
        | "modulo_financeiro_nao_instalado"
        | "sem_conta_financeira";
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
 * A última competência do contrato de `meses` meses que começa no mês de
 * `agora` (UTC), no dia do molde — mesma régua de `competenciaDoMes` do cron:
 * o dia que o mês não tem cai no último dia dele. Nulo = sem prazo (inclusive
 * duração ilegível, que o CHECK de `crm_leads` já recusa na escrita).
 */
export function fimDaRecorrencia(
  meses: number | null | undefined,
  diaDoMes: number,
  agora: Date = new Date(),
): string | null {
  if (typeof meses !== "number" || !Number.isInteger(meses) || meses < 1) return null;
  // `Date.UTC` com mês estourado vira o ano seguinte sozinho.
  const alvo = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() + meses - 1, 1));
  const ano = alvo.getUTCFullYear();
  const mes = alvo.getUTCMonth() + 1;
  const dia = Math.min(diaDoMes, new Date(Date.UTC(ano, mes, 0)).getUTCDate());
  return `${ano}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
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

  // Doc 312 = A: a opção da empresa, desligada de fábrica. Lida antes de
  // qualquer escrita; banco que não respondeu conta como desligada.
  const { data: org } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", entrada.organizationId)
    .maybeSingle();
  if (!recorrenciaNoGanhoLigada((org as { settings?: unknown } | null)?.settings)) {
    return { estado: "ignorado", motivo: "opcao_desligada" };
  }

  // `recurring_entries` é tabela do módulo financeiro (ADR-0002, #1907): sem o
  // módulo instalado, a tela que mostraria o molde não existe, e gravá-lo
  // criaria receita que ninguém enxerga.
  if (!(await moduloLigado(supabase, "financeiro"))) {
    return { estado: "ignorado", motivo: "modulo_financeiro_nao_instalado" };
  }

  const diaDoMes = diaDoMesDoNegocio(entrada.criadoEm);
  const fim = fimDaRecorrencia(entrada.meses, diaDoMes);

  // A leitura antes da escrita: fechar, reabrir e fechar de novo é fluxo normal
  // do funil, e o segundo fecho não pode criar um segundo molde.
  const { data: existente, error: erroLeitura } = await supabase
    .from("recurring_entries")
    .select("id, is_active")
    .eq("organization_id", entrada.organizationId)
    .eq("crm_lead_id", entrada.leadId)
    .limit(1)
    .maybeSingle();
  if (erroLeitura) return { estado: "falhou", erro: `molde: ${erroLeitura.message}` };
  if (existente) {
    const molde = existente as { id: string; is_active?: boolean };
    if (molde.is_active !== false) return { estado: "ja_existia", recorrenciaId: String(molde.id) };
    // Re-ganho depois de uma perda (doc 312): o MESMO molde volta a valer, com o
    // valor e o prazo deste ganho — nunca uma segunda linha.
    const { error: erroReativa } = await supabase
      .from("recurring_entries")
      .update({
        is_active: true,
        amount_cents: valor,
        ends_on: fim,
        updated_at: new Date().toISOString(),
      })
      .eq("id", molde.id)
      .eq("organization_id", entrada.organizationId);
    if (erroReativa) return { estado: "falhou", erro: `molde: ${erroReativa.message}` };
    return { estado: "reativado", recorrenciaId: String(molde.id) };
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
      ends_on: fim,
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
