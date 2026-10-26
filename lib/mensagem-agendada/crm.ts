/**
 * O lado CRM da mensagem agendada: os adaptadores de banco e as operações que a
 * rota REST, as ferramentas MCP e (depois) a tela compartilham.
 *
 * A REGRA mora em `./regras.ts` — limites, estados, quem pode cancelar, o
 * veredito do disparo. Aqui fica só o que só existe deste lado: client do
 * Supabase, resolução da conversa, gravação do pacote + partes + cron, e as
 * leituras que a tela e o MCP precisam.
 *
 * ⚠️ CLIENT SERVICE-ROLE BYPASSA RLS. Toda query filtra `organization_id`
 * explicitamente, e o id da organização vem de fonte confiável (JWT do humano
 * ou linha do token), nunca do corpo da requisição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";

import {
  MAXIMO_DE_TENTATIVAS,
  PISO_DO_AGENDAMENTO_MS,
  podeCancelar,
  podeEditar,
  validaAgendamento,
  type AgendamentoDeMensagem,
  type MotivoDeRecusa,
  type StatusDaParte,
  type StatusDoPacote,
} from "./regras";

export interface DepsDaMensagemAgendada {
  admin: SupabaseClient;
  orgId: string;
  actor: Actor;
  requestId: string;
  /** `inbox` (tela), `api` (token/rest) ou `mcp` (ferramenta de agente). */
  source?: "inbox" | "api" | "mcp";
  agora?: Date;
}

export interface ParteGravada {
  id: string;
  position: number;
  body: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
  media_size_bytes: number | null;
  status: StatusDaParte;
  internal_message_id: string;
  message_id: string | null;
  error_code: string | null;
  sent_at: string | null;
}

export interface PacoteGravado {
  id: string;
  conversation_id: string;
  contact_id: string;
  channel_session_id: string;
  scheduled_for: string;
  tz: string;
  status: StatusDoPacote;
  cancel_if_contact_replies: boolean;
  cancel_reason: string | null;
  cancelled_at: string | null;
  last_error: string | null;
  original_id: string | null;
  created_at: string;
  parts: ParteGravada[];
}

/** Códigos de recusa das operações deste adaptador. `404`/`409` na rota. */
export type RecusaDaOperacao =
  | MotivoDeRecusa
  | "conversa_nao_encontrada"
  | "pacote_nao_encontrado"
  | "ja_encerrado"
  | "parte_com_anexo_ausente"
  | "falha_ao_gravar";

export interface FalhaDaOperacao {
  ok: false;
  codigo: RecusaDaOperacao;
  mensagem: string;
}

const COLUNAS_DO_PACOTE =
  "id, conversation_id, contact_id, channel_session_id, scheduled_for, tz, status, cancel_if_contact_replies, cancel_reason, cancelled_at, last_error, original_id, created_at";

type LinhaDePacote = Omit<PacoteGravado, "parts"> & { organization_id?: string };

interface LinhaDaConversa {
  id: string;
  contact_id: string;
  channel_session_id: string;
}

function linhaParaPacote(linha: LinhaDePacote, partes: ParteGravada[]): PacoteGravado {
  const { organization_id: _ignorada, ...resto } = linha;
  return { ...resto, parts: partes };
}

async function resolveConversa(
  admin: SupabaseClient,
  orgId: string,
  conversaId: string | null,
  contatoId: string | null,
): Promise<{ ok: true; conversa: LinhaDaConversa } | FalhaDaOperacao> {
  const selecao = "id, contact_id, channel_session_id";
  if (conversaId !== null) {
    const { data, error } = await admin
      .from("conversations")
      .select(selecao)
      .eq("id", conversaId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) {
      return { ok: false, codigo: "falha_ao_gravar", mensagem: error.message };
    }
    if (!data) {
      return {
        ok: false,
        codigo: "conversa_nao_encontrada",
        mensagem: "Conversa não encontrada nesta organização.",
      };
    }
    return { ok: true, conversa: data as LinhaDaConversa };
  }

  if (contatoId === null) {
    return { ok: false, codigo: "sem_conversa", mensagem: "informe conversation_id ou contact_id." };
  }
  // Sem conversa explícita: a mais recente do contato. Agendar para um contato
  // com duas conversas vivas sem dizer QUAL é ambíguo de verdade — o envio sairia
  // no canal errado —, por isso a escolha é sempre a conversa mais recente e a
  // resposta devolve o id usado.
  const { data, error } = await admin
    .from("conversations")
    .select(selecao)
    .eq("organization_id", orgId)
    .eq("contact_id", contatoId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    return { ok: false, codigo: "falha_ao_gravar", mensagem: error.message };
  }
  if (!data) {
    return {
      ok: false,
      codigo: "conversa_nao_encontrada",
      mensagem: "O contato ainda não tem conversa nesta organização.",
    };
  }
  return { ok: true, conversa: data as LinhaDaConversa };
}

function autorDaGravacao(actor: Actor): { created_by: string | null; created_by_token: string | null } {
  return {
    created_by: actor.type === "user" ? actor.id : null,
    // Só a variante `api_token` tem id de linha de `api_tokens`. O `ai_agent`
    // carrega id de RUN em `id` — gravá-lo aqui romperia a FK.
    created_by_token: actor.type === "api_token" ? actor.id : null,
  };
}

async function carregaPacote(
  admin: SupabaseClient,
  orgId: string,
  pacoteId: string,
): Promise<PacoteGravado | null> {
  const { data, error } = await admin
    .from("scheduled_messages")
    .select(COLUNAS_DO_PACOTE)
    .eq("id", pacoteId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (error) throw new Error(`falha ao ler scheduled_messages: ${error.message}`);
  if (!data) return null;

  const { data: partes, error: erroDasPartes } = await admin
    .from("scheduled_message_parts")
    .select(
      "id, position, body, media_storage_path, media_mime, media_size_bytes, status, internal_message_id, message_id, error_code, sent_at",
    )
    .eq("scheduled_message_id", pacoteId)
    .order("position", { ascending: true });
  if (erroDasPartes) {
    throw new Error(`falha ao ler scheduled_message_parts: ${erroDasPartes.message}`);
  }
  return linhaParaPacote(data as LinhaDePacote, (partes ?? []) as ParteGravada[]);
}

/**
 * O cron que dispara o pacote.
 *
 * ⚠️ NADA de `scheduleCronJob` daqui: ele aplica o stagger determinístico, e
 * para hora marcada o stagger é atraso silencioso. `next_run_at` é EXATAMENTE
 * `scheduled_for`.
 */
async function agendaOCron(
  admin: SupabaseClient,
  orgId: string,
  contatoId: string,
  pacoteId: string,
  quando: Date,
): Promise<{ ok: true; cronId: string } | FalhaDaOperacao> {
  const { data, error } = await admin
    .from("cron_jobs")
    .insert({
      organization_id: orgId,
      contact_id: contatoId,
      kind: "at",
      job_kind: "scheduled_message",
      payload: { scheduled_message_id: pacoteId },
      next_run_at: quando.toISOString(),
      enabled: true,
      max_attempts: MAXIMO_DE_TENTATIVAS,
    })
    .select("id")
    .single();
  if (error || !data) {
    return {
      ok: false,
      codigo: "falha_ao_gravar",
      mensagem: `não foi possível agendar o disparo: ${error?.message ?? "sem linha"}`,
    };
  }
  return { ok: true, cronId: (data as { id: string }).id };
}

/**
 * Cria o pacote, as partes e o cron.
 *
 * A ordem importa: pacote e partes primeiro (é o que a tela mostra), cron
 * depois. Se o cron falhar, o pacote é APAGADO — pacote sem disparo é promessa
 * que nunca acontece, o pior estado possível para quem agendou.
 */
export async function agendaMensagemNoCrm(
  deps: DepsDaMensagemAgendada,
  input: AgendamentoDeMensagem,
): Promise<{ ok: true; pacote: PacoteGravado } | FalhaDaOperacao> {
  const agora = deps.agora ?? new Date();
  const validado = validaAgendamento(input, agora);
  if (!validado.ok) return validado;

  const conversa = await resolveConversa(
    deps.admin,
    deps.orgId,
    validado.conversaId,
    validado.contatoId,
  );
  if (!conversa.ok) return conversa;

  const { data: pacote, error: erroDoPacote } = await deps.admin
    .from("scheduled_messages")
    .insert({
      organization_id: deps.orgId,
      conversation_id: conversa.conversa.id,
      contact_id: conversa.conversa.contact_id,
      channel_session_id: conversa.conversa.channel_session_id,
      scheduled_for: validado.quando.toISOString(),
      tz: validado.tz,
      status: "scheduled",
      source: deps.source ?? "api",
      cancel_if_contact_replies: validado.cancelarSeResponder,
      ...autorDaGravacao(deps.actor),
    })
    .select(COLUNAS_DO_PACOTE)
    .single();
  if (erroDoPacote || !pacote) {
    return {
      ok: false,
      codigo: "falha_ao_gravar",
      mensagem: `não foi possível gravar o agendamento: ${erroDoPacote?.message ?? "sem linha"}`,
    };
  }
  const pacoteId = (pacote as LinhaDePacote).id;

  const { data: partes, error: erroDasPartes } = await deps.admin
    .from("scheduled_message_parts")
    .insert(
      validado.partes.map((parte) => ({
        scheduled_message_id: pacoteId,
        position: parte.position,
        body: parte.body,
        media_storage_path: parte.media_storage_path,
        media_mime: parte.media_mime,
        media_size_bytes: parte.media_size_bytes,
      })),
    )
    .select(
      "id, position, body, media_storage_path, media_mime, media_size_bytes, status, internal_message_id, message_id, error_code, sent_at",
    );
  if (erroDasPartes || !partes) {
    await deps.admin.from("scheduled_messages").delete().eq("id", pacoteId).eq("organization_id", deps.orgId);
    return {
      ok: false,
      codigo: "falha_ao_gravar",
      mensagem: `não foi possível gravar as partes: ${erroDasPartes?.message ?? "sem linha"}`,
    };
  }

  const cron = await agendaOCron(
    deps.admin,
    deps.orgId,
    conversa.conversa.contact_id,
    pacoteId,
    validado.quando,
  );
  if (!cron.ok) {
    await deps.admin.from("scheduled_messages").delete().eq("id", pacoteId).eq("organization_id", deps.orgId);
    return cron;
  }

  return {
    ok: true,
    pacote: linhaParaPacote(
      pacote as LinhaDePacote,
      (partes as ParteGravada[]).sort((a, b) => a.position - b.position),
    ),
  };
}

export async function leMensagemAgendadaNoCrm(
  deps: Pick<DepsDaMensagemAgendada, "admin" | "orgId">,
  pacoteId: string,
): Promise<{ ok: true; pacote: PacoteGravado } | FalhaDaOperacao> {
  const pacote = await carregaPacote(deps.admin, deps.orgId, pacoteId);
  if (!pacote) {
    return { ok: false, codigo: "pacote_nao_encontrado", mensagem: "Agendamento não encontrado." };
  }
  return { ok: true, pacote };
}

/**
 * Cancela o pacote e desliga o cron dele.
 *
 * O UPDATE condicional (`status = 'scheduled'`) é a trava real: entre a leitura
 * e a escrita o cron pode ter disparado, e perder essa corrida é `ja_encerrado`
 * — não erro interno. Mesmo que o cron dispare no meio, a reserva do handler
 * (`scheduled → sending`) falha e nada sai: as duas portas leem o mesmo estado.
 */
export async function cancelaMensagemAgendadaNoCrm(
  deps: DepsDaMensagemAgendada,
  pacoteId: string,
  motivo: string,
): Promise<{ ok: true; pacote: PacoteGravado } | FalhaDaOperacao> {
  const atual = await carregaPacote(deps.admin, deps.orgId, pacoteId);
  if (!atual) {
    return { ok: false, codigo: "pacote_nao_encontrado", mensagem: "Agendamento não encontrado." };
  }
  if (!podeCancelar(atual.status)) {
    return {
      ok: false,
      codigo: "ja_encerrado",
      mensagem: `O agendamento já está em "${atual.status}" e não pode ser cancelado.`,
    };
  }

  const agora = (deps.agora ?? new Date()).toISOString();
  const { data, error } = await deps.admin
    .from("scheduled_messages")
    .update({ status: "cancelled", cancelled_at: agora, cancel_reason: motivo, updated_at: agora })
    .eq("id", pacoteId)
    .eq("organization_id", deps.orgId)
    .eq("status", "scheduled")
    .select(COLUNAS_DO_PACOTE);
  if (error) {
    return { ok: false, codigo: "falha_ao_gravar", mensagem: error.message };
  }
  if (!data || data.length === 0) {
    return {
      ok: false,
      codigo: "ja_encerrado",
      mensagem: "O agendamento começou a sair antes do cancelamento.",
    };
  }

  // Best-effort e idempotente: se o cron já disparou, a reserva do handler é
  // quem barra o envio. Falhar aqui não desfaz o cancelamento.
  await deps.admin
    .from("cron_jobs")
    .update({ enabled: false, cancelled_at: agora, cancel_reason: motivo, updated_at: agora })
    .eq("organization_id", deps.orgId)
    .eq("enabled", true)
    .eq("job_kind", "scheduled_message")
    .eq("payload->>scheduled_message_id", pacoteId);

  const pacote = await carregaPacote(deps.admin, deps.orgId, pacoteId);
  return { ok: true, pacote: pacote ?? { ...atual, status: "cancelled", cancelled_at: agora } };
}

/**
 * Edita hora/fuso/partes de um pacote ainda `scheduled`.
 *
 * Revalida o pacote INTEIRO depois de mesclar o patch: um PATCH que só muda a
 * hora não pode passar por cima do limite de partes nem de um corpo longo que
 * já estavam lá.
 */
export interface PatchDaMensagemAgendada {
  scheduled_for?: string;
  tz?: string | null;
  parts?: AgendamentoDeMensagem["parts"];
  cancel_if_contact_replies?: boolean;
}

export async function editaMensagemAgendadaNoCrm(
  deps: DepsDaMensagemAgendada,
  pacoteId: string,
  patch: PatchDaMensagemAgendada,
): Promise<{ ok: true; pacote: PacoteGravado } | FalhaDaOperacao> {
  const atual = await carregaPacote(deps.admin, deps.orgId, pacoteId);
  if (!atual) {
    return { ok: false, codigo: "pacote_nao_encontrado", mensagem: "Agendamento não encontrado." };
  }
  if (!podeEditar(atual.status)) {
    return {
      ok: false,
      codigo: "ja_encerrado",
      mensagem: `O agendamento já está em "${atual.status}" e não pode ser editado.`,
    };
  }

  const merged: AgendamentoDeMensagem = {
    conversation_id: atual.conversation_id,
    contact_id: atual.contact_id,
    scheduled_for: patch.scheduled_for ?? atual.scheduled_for,
    tz: patch.tz ?? atual.tz,
    cancel_if_contact_replies: patch.cancel_if_contact_replies ?? atual.cancel_if_contact_replies,
    parts:
      patch.parts ??
      atual.parts.map((parte) => ({
        body: parte.body,
        media_storage_path: parte.media_storage_path,
        media_mime: parte.media_mime,
        media_size_bytes: parte.media_size_bytes,
      })),
  };
  const validado = validaAgendamento(merged, deps.agora ?? new Date());
  if (!validado.ok) return validado;

  const agora = (deps.agora ?? new Date()).toISOString();
  const { error: erroDoPacote } = await deps.admin
    .from("scheduled_messages")
    .update({
      scheduled_for: validado.quando.toISOString(),
      tz: validado.tz,
      cancel_if_contact_replies: validado.cancelarSeResponder,
      updated_at: agora,
    })
    .eq("id", pacoteId)
    .eq("organization_id", deps.orgId)
    .eq("status", "scheduled");
  if (erroDoPacote) {
    return { ok: false, codigo: "falha_ao_gravar", mensagem: erroDoPacote.message };
  }

  if (patch.parts !== undefined) {
    const { error: erroDoApagar } = await deps.admin
      .from("scheduled_message_parts")
      .delete()
      .eq("scheduled_message_id", pacoteId)
      .eq("status", "pending");
    if (erroDoApagar) {
      return { ok: false, codigo: "falha_ao_gravar", mensagem: erroDoApagar.message };
    }
    const { error: erroDeInserir } = await deps.admin.from("scheduled_message_parts").insert(
      validado.partes.map((parte) => ({
        scheduled_message_id: pacoteId,
        position: parte.position,
        body: parte.body,
        media_storage_path: parte.media_storage_path,
        media_mime: parte.media_mime,
        media_size_bytes: parte.media_size_bytes,
      })),
    );
    if (erroDeInserir) {
      return { ok: false, codigo: "falha_ao_gravar", mensagem: erroDeInserir.message };
    }
  }

  await deps.admin
    .from("cron_jobs")
    .update({ next_run_at: validado.quando.toISOString(), updated_at: agora })
    .eq("organization_id", deps.orgId)
    .eq("enabled", true)
    .eq("job_kind", "scheduled_message")
    .eq("payload->>scheduled_message_id", pacoteId);

  const pacote = await carregaPacote(deps.admin, deps.orgId, pacoteId);
  if (!pacote) {
    return { ok: false, codigo: "pacote_nao_encontrado", mensagem: "Agendamento sumiu durante a edição." };
  }
  return { ok: true, pacote };
}

export interface FiltroDaLista {
  conversation_id?: string | null;
  contact_id?: string | null;
  status?: StatusDoPacote | null;
  limite?: number;
}

export async function listaMensagensAgendadasNoCrm(
  deps: DepsDaMensagemAgendada,
  filtro: FiltroDaLista = {},
): Promise<{ ok: true; pacotes: PacoteGravado[] } | FalhaDaOperacao> {
  let query = deps.admin
    .from("scheduled_messages")
    .select(COLUNAS_DO_PACOTE)
    .eq("organization_id", deps.orgId)
    .order("scheduled_for", { ascending: true })
    .limit(Math.min(Math.max(filtro.limite ?? 50, 1), 100));

  if (filtro.conversation_id) query = query.eq("conversation_id", filtro.conversation_id);
  if (filtro.contact_id) query = query.eq("contact_id", filtro.contact_id);
  if (filtro.status) query = query.eq("status", filtro.status);

  const { data, error } = await query;
  if (error) return { ok: false, codigo: "falha_ao_gravar", mensagem: error.message };

  const pacotes: PacoteGravado[] = [];
  for (const linha of (data ?? []) as LinhaDePacote[]) {
    const completo = await carregaPacote(deps.admin, deps.orgId, linha.id);
    if (completo) pacotes.push(completo);
  }
  return { ok: true, pacotes };
}

/**
 * "Reenviar o que faltou": um pacote NOVO, só com as partes `failed`/`skipped`
 * do original, e com `internal_message_id` NOVOS (default da coluna) — é um
 * envio novo, decidido por alguém. Reusar os ids antigos faria o handler reler a
 * mensagem que falhou e "não reenviar", que é o oposto do pedido.
 */
export async function reenviaOQueFaltouNoCrm(
  deps: DepsDaMensagemAgendada,
  pacoteId: string,
): Promise<{ ok: true; pacote: PacoteGravado } | FalhaDaOperacao> {
  const original = await carregaPacote(deps.admin, deps.orgId, pacoteId);
  if (!original) {
    return { ok: false, codigo: "pacote_nao_encontrado", mensagem: "Agendamento não encontrado." };
  }
  if (original.status !== "partial" && original.status !== "failed") {
    return {
      ok: false,
      codigo: "ja_encerrado",
      mensagem: "Só pacote parcial ou falho tem o que reenviar.",
    };
  }
  const restantes = original.parts
    .filter((parte) => parte.status === "failed" || parte.status === "skipped")
    .sort((a, b) => a.position - b.position);
  if (restantes.length === 0) {
    return { ok: false, codigo: "ja_encerrado", mensagem: "Não há parte pendente para reenviar." };
  }

  const agora = deps.agora ?? new Date();
  const quando = new Date(agora.getTime() + PISO_DO_AGENDAMENTO_MS);
  const criado = await agendaMensagemNoCrm(deps, {
    conversation_id: original.conversation_id,
    contact_id: original.contact_id,
    scheduled_for: quando.toISOString(),
    tz: original.tz,
    cancel_if_contact_replies: original.cancel_if_contact_replies,
    parts: restantes.map((parte) => ({
      body: parte.body,
      media_storage_path: parte.media_storage_path,
      media_mime: parte.media_mime,
      media_size_bytes: parte.media_size_bytes,
    })),
  });
  if (!criado.ok) return criado;

  const { error } = await deps.admin
    .from("scheduled_messages")
    .update({ original_id: original.id })
    .eq("id", criado.pacote.id)
    .eq("organization_id", deps.orgId);
  if (error) {
    return { ok: false, codigo: "falha_ao_gravar", mensagem: error.message };
  }
  return { ok: true, pacote: { ...criado.pacote, original_id: original.id } };
}
