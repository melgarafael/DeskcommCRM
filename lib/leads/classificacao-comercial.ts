/**
 * CLASSIFICAR O NEGÓCIO COMO NÃO COMERCIAL (#4191) — a escrita, num lugar só.
 *
 * A regra está em `lib/leads/elegibilidade-comercial.ts` (puro). Aqui só se
 * executa: lê a linha, decide, grava as três colunas, deixa a linha na timeline
 * e o registro no audit. Extraído da rota pelo mesmo motivo de
 * `lib/leads/encerramento.ts`: a rota humana e o teste precisam da MESMA
 * operação, e uma segunda cópia da regra divergiria no primeiro ajuste.
 *
 * ─── O que a escrita NÃO faz (e é o ponto da issue) ─────────────────────────
 *
 *  - não muda `status`: nada vira ganho nem perda, então nenhuma métrica de
 *    desfecho se move;
 *  - não muda etapa, `closed_at`, `lost_reason` nem toca `contacts` e
 *    `conversations`: contato, conversa, mensagens, anexos e atividades ficam
 *    onde estão;
 *  - não apaga nada. Reverter é gravar `null` nas três colunas.
 *
 * ─── Falha da timeline é BAIXO, a classificação é ALTO ──────────────────────
 *
 * Se a gravação da classificação falhar, a operação falha (o humano precisa
 * saber). Se só a atividade falhar, a classificação fica de pé e o erro vai
 * para `registraFalhaDeAtividade` — a mesma régua do encerramento, e pelo mesmo
 * motivo: a timeline é o lastro, não a operação.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { emitLeadActivity } from "@/lib/leads/activity-emitter";
import { registraFalhaDeAtividade } from "@/lib/leads/activity-write-failure";
import {
  COLUNAS_DA_CLASSIFICACAO,
  decidirClassificacao,
  decidirReversao,
  ehNaoComercial,
  motivoParaATimeline,
  recusaDoMotivoDoNaoComercial,
  type EstadoDaClassificacao,
} from "@/lib/leads/elegibilidade-comercial";

const COLUNAS_LIDAS = ["id", "organization_id", "contact_id", "status", ...COLUNAS_DA_CLASSIFICACAO].join(
  ", ",
);

interface LinhaLida {
  id: string;
  organization_id: string;
  contact_id: string | null;
  status: string;
  nao_comercial_em: string | null;
  nao_comercial_motivo: string | null;
  nao_comercial_por: string | null;
}

export interface ClassificacaoOk {
  ok: true;
  /** `true` quando a operação já estava feita e nada foi escrito. */
  jaEstava: boolean;
  lead: Record<string, unknown>;
}

export interface ClassificacaoErr {
  ok: false;
  codigo: string;
  mensagem: string;
  httpStatus: number;
}

export type ResultadoDaClassificacao = ClassificacaoOk | ClassificacaoErr;

export interface ClassificarInput {
  organizationId: string;
  leadId: string;
  /** O motivo declarado pela equipe. Obrigatório na classificação. */
  motivo?: unknown;
  actorUserId: string;
  requestId: string;
}

export interface ReverterInput {
  organizationId: string;
  leadId: string;
  actorUserId: string;
  requestId: string;
}

const naoEncontrado: ClassificacaoErr = {
  ok: false,
  codigo: "not_found",
  mensagem: "Negócio não encontrado.",
  httpStatus: 404,
};

async function lerLead(
  supabase: SupabaseClient,
  organizationId: string,
  leadId: string,
): Promise<{ linha: LinhaLida | null; erro: string | null }> {
  const { data, error } = await supabase
    .from("crm_leads")
    .select(COLUNAS_LIDAS)
    .eq("organization_id", organizationId)
    .eq("id", leadId)
    .maybeSingle();
  if (error) return { linha: null, erro: error.message };
  return { linha: (data ?? null) as LinhaLida | null, erro: null };
}

function estadoDa(linha: LinhaLida): EstadoDaClassificacao {
  return {
    status: linha.status,
    nao_comercial_em: linha.nao_comercial_em,
    nao_comercial_motivo: linha.nao_comercial_motivo,
  };
}

export async function classificaNegocioComoNaoComercial(
  supabase: SupabaseClient,
  input: ClassificarInput,
): Promise<ResultadoDaClassificacao> {
  // Motivo inválido é recusado ANTES da leitura: corpo errado não depende do
  // negócio, e um pedido com motivo em branco não precisa custar consulta.
  const recusa = recusaDoMotivoDoNaoComercial(input.motivo);
  if (recusa !== null) {
    return { ok: false, codigo: recusa.codigo, mensagem: recusa.mensagem, httpStatus: 422 };
  }

  const { linha, erro } = await lerLead(supabase, input.organizationId, input.leadId);
  if (erro) return { ok: false, codigo: "internal_error", mensagem: erro, httpStatus: 500 };
  if (linha === null) return naoEncontrado;

  const decisao = decidirClassificacao(estadoDa(linha), input.motivo);
  if (decisao.acao === "recusar") {
    return {
      ok: false,
      codigo: decisao.codigo,
      mensagem: decisao.mensagem,
      httpStatus: decisao.httpStatus,
    };
  }
  if (decisao.acao === "nada") {
    return { ok: true, jaEstava: true, lead: linha as unknown as Record<string, unknown> };
  }

  const agora = new Date().toISOString();
  // `.is("nao_comercial_em", null)` é a trava da corrida: duas pessoas
  // classificando ao mesmo tempo, a segunda não sobrescreve a primeira — o
  // filtro devolve zero linhas e o conflito é relatado. Sem ele, o UPDATE por
  // id faria a última gravação ganhar em silêncio, que é o que a issue proíbe.
  const { data: atualizado, error: updErr } = await supabase
    .from("crm_leads")
    .update({
      nao_comercial_em: agora,
      nao_comercial_motivo: decisao.motivo,
      nao_comercial_por: input.actorUserId,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.leadId)
    .is("nao_comercial_em", null)
    .select(COLUNAS_LIDAS)
    .maybeSingle();

  if (updErr) {
    return { ok: false, codigo: "internal_error", mensagem: updErr.message, httpStatus: 500 };
  }
  if (atualizado === null) {
    // Corrida perdida: alguém classificou entre a leitura e a escrita.
    return {
      ok: false,
      codigo: "classificacao_conflitante",
      mensagem:
        "Este negócio foi classificado por outra pessoa enquanto você decidia. Reveja antes de mudar a classificação.",
      httpStatus: 409,
    };
  }

  await registrarNaTimeline(supabase, {
    organizationId: input.organizationId,
    leadId: input.leadId,
    contactId: linha.contact_id,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    motivo: decisao.motivo,
    desfecho: "nao_comercial",
  });

  return { ok: true, jaEstava: false, lead: atualizado as unknown as Record<string, unknown> };
}

export async function reverteClassificacaoNaoComercial(
  supabase: SupabaseClient,
  input: ReverterInput,
): Promise<ResultadoDaClassificacao> {
  const { linha, erro } = await lerLead(supabase, input.organizationId, input.leadId);
  if (erro) return { ok: false, codigo: "internal_error", mensagem: erro, httpStatus: 500 };
  if (linha === null) return naoEncontrado;

  if (decidirReversao(linha).acao === "nada") {
    return { ok: true, jaEstava: true, lead: linha as unknown as Record<string, unknown> };
  }

  const motivoAnterior = motivoParaATimeline(linha.nao_comercial_motivo);
  // A trava é o INVERSO da classificação: só reverte quem ainda está
  // classificado. Assim uma reversão atrasada não apaga uma classificação mais
  // nova que chegou no meio.
  const { data: atualizado, error: updErr } = await supabase
    .from("crm_leads")
    .update({
      nao_comercial_em: null,
      nao_comercial_motivo: null,
      nao_comercial_por: null,
    })
    .eq("organization_id", input.organizationId)
    .eq("id", input.leadId)
    .not("nao_comercial_em", "is", null)
    .select(COLUNAS_LIDAS)
    .maybeSingle();

  if (updErr) {
    return { ok: false, codigo: "internal_error", mensagem: updErr.message, httpStatus: 500 };
  }
  if (atualizado === null) {
    return { ok: true, jaEstava: true, lead: linha as unknown as Record<string, unknown> };
  }

  await registrarNaTimeline(supabase, {
    organizationId: input.organizationId,
    leadId: input.leadId,
    contactId: linha.contact_id,
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    motivo: motivoAnterior,
    desfecho: "comercial",
  });

  return { ok: true, jaEstava: false, lead: atualizado as unknown as Record<string, unknown> };
}

/**
 * Uma linha na timeline e uma no audit, pelo MESMO caminho nos dois sentidos.
 * `reason` é canônico em português (quem traduz é a leitura) e leva o motivo
 * declarado: é o que muda a decisão de quem lê depois — "golpe" e "spam" pedem
 * coisas diferentes de quem for reabrir o caso.
 */
async function registrarNaTimeline(
  supabase: SupabaseClient,
  args: {
    organizationId: string;
    leadId: string;
    contactId: string | null;
    actorUserId: string;
    requestId: string;
    motivo: string;
    desfecho: "nao_comercial" | "comercial";
  },
): Promise<void> {
  const atividade = await emitLeadActivity(supabase, {
    organizationId: args.organizationId,
    leadId: args.leadId,
    contactId: args.contactId,
    type: "demand_classified",
    sourceModule: "crm",
    sourceId: args.leadId,
    actor: { type: "user", id: args.actorUserId },
    reason:
      args.desfecho === "nao_comercial"
        ? `Classificado como não comercial: ${args.motivo}`
        : `Voltou a ser comercial: ${args.motivo}`,
    payload: { desfecho: args.desfecho, motivo: args.motivo },
  });
  if (!atividade.ok) {
    await registraFalhaDeAtividade(supabase, {
      organizationId: args.organizationId,
      leadId: args.leadId,
      tipo: "demand_classified",
      origem: "lib/leads/classificacao-comercial",
      erro: atividade.error,
      requestId: args.requestId,
    });
  }

  await audit({
    action: args.desfecho === "nao_comercial" ? "lead.non_commercial" : "lead.non_commercial_reverted",
    actorUserId: args.actorUserId,
    organizationId: args.organizationId,
    resourceType: "crm_lead",
    resourceId: args.leadId,
    requestId: args.requestId,
    metadata: { motivo: args.motivo },
  });
}

/** Reexportado para quem lê o negócio já classificado sem importar duas fontes. */
export { ehNaoComercial };
