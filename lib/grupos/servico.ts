/**
 * Grupos de WhatsApp na inbox: qual grupo de cada número entra no CRM.
 * Spec: docs/superpowers/specs/2026-09-23-grupos-na-inbox-design.md
 *
 * O filtro do WhatsApp é tudo ou nada por número: com pelo menos um grupo ligado ele recebe
 * todos (e a entrada descarta os não escolhidos); desligar o ÚLTIMO volta a ignorar. A troca
 * do filtro precisa ser CONFIRMADA antes de gravar "ligado": nunca fica ligado sem estar.
 *
 * O filtro se AUTOCORRIGE: todo "ligar" confere o filtro (não só o primeiro), e a conexão e a
 * reconexão do número o ressincronizam a partir de `channel_session_groups`
 * (`sincronizarRecebimentoDeGrupos`, em `sincronizar-filtro.ts`). A conferência é barata porque o transporte lê antes
 * e só escreve quando o valor difere — sem escrita e sem reinício de sessão quando já está certo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { audit as auditReal } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { capabilitiesOf, getAdapter } from "@/lib/channels";
import { resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS, type ChannelSessionRef } from "@/lib/channels/session-ref";
import type { ChannelGroup, ChannelProvider } from "@/lib/channels/types";
import { logger } from "@/lib/logger";

export class GrupoError extends Error {
  constructor(public readonly code: "sessao_nao_encontrada" | "canal_sem_grupos" | "filtro_nao_confirmado") {
    super(code);
    this.name = "GrupoError";
  }
}

// Aceita o formato atual (`<digitos>@g.us`) e o legado medido no servidor real
// (`<digitos>-<digitos>@g.us`) — a régua não é a forma nova, é a que o WhatsApp
// de verdade envia hoje.
const chatIdDeGrupo = z.string().regex(/^[\d-]+@g\.us$/);

export interface GrupoDoNumero {
  chatId: string;
  subject: string | null;
  enabled: boolean;
  enabledAt: string | null;
  /**
   * O WhatsApp devolveu este grupo agora? `false` = ligado no banco mas o
   * número já saiu dele (ou o grupo sumiu) — um ÓRFÃO. Sem carregar isto na
   * lista, o grupo desaparece da tela assim que `listGroups` para de
   * devolvê-lo, e o botão "desligar" só existe para quem a tela mostra: o
   * grupo fica preso ligado para sempre.
   */
  presente: boolean;
}

interface LinhaDeGrupo {
  group_chat_id: string;
  subject: string | null;
  enabled: boolean;
  enabled_at: string | null;
}

export interface GruposDb {
  lerSessao(
    org: string,
    sessionId: string,
  ): Promise<{ provider: ChannelProvider; sessionRef: string; groupsCapability: "full" | "limited" | "none" } | null>;
  listarLinhas(org: string, sessionId: string): Promise<LinhaDeGrupo[]>;
  contarLigados(org: string, sessionId: string): Promise<number>;
  gravarLinha(org: string, sessionId: string, row: LinhaDeGrupo & { enabled_by_user_id: string | null }): Promise<{ id: string }>;
}

export interface DepsDeGrupos {
  db: GruposDb;
  listGroups(provider: ChannelProvider, sessionRef: string): Promise<ChannelGroup[]>;
  /**
   * PODE LANÇAR (timeout/rede) mesmo declarando `Promise<boolean>` — o contrato
   * é "eu tento" e a exceção é um resultado, não um bug de tipo. Quem chama
   * (`alternarGrupo`) trata a exceção exatamente como `false`: nada fica ligado
   * sem estar confirmado.
   */
  setGroupIntake(provider: ChannelProvider, sessionRef: string, receive: boolean): Promise<boolean>;
  audit(entry: {
    action: string;
    organizationId: string;
    actorUserId: string;
    resourceId: string;
    requestId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
  agora(): Date;
}

async function sessaoComGrupos(deps: DepsDeGrupos, org: string, sessionId: string) {
  const s = await deps.db.lerSessao(org, sessionId);
  if (!s) throw new GrupoError("sessao_nao_encontrada");
  if (s.groupsCapability === "none") throw new GrupoError("canal_sem_grupos");
  return s;
}

export async function listarGruposDoNumero(
  deps: DepsDeGrupos,
  e: { organizationId: string; channelSessionId: string },
): Promise<GrupoDoNumero[]> {
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);
  const [doCanal, gravados] = await Promise.all([
    deps.listGroups(s.provider, s.sessionRef),
    deps.db.listarLinhas(e.organizationId, e.channelSessionId),
  ]);
  const porId = new Map(gravados.map((l) => [l.group_chat_id, l]));
  const daLista = doCanal.map((g) => {
    const l = porId.get(g.chatId);
    porId.delete(g.chatId); // o que sobrar no Map depois disto é órfão.
    return {
      chatId: g.chatId,
      subject: g.subject ?? l?.subject ?? null,
      enabled: l?.enabled ?? false,
      enabledAt: l?.enabled_at ?? null,
      presente: true,
    };
  });
  // Órfãos: LIGADOS no banco, mas o WhatsApp não devolveu mais (o número saiu
  // do grupo, ou o grupo deixou de existir). Uma linha desligada que sumiu não
  // precisa aparecer — não há nada para desligar; uma linha LIGADA que sumiu
  // precisa, senão ela nunca mais pode ser desligada pela tela.
  const orfaos = [...porId.values()]
    .filter((l) => l.enabled)
    .map((l) => ({
      chatId: l.group_chat_id,
      subject: l.subject,
      enabled: l.enabled,
      enabledAt: l.enabled_at,
      presente: false,
    }));
  return [...daLista, ...orfaos];
}

/**
 * Concorrência: dois gestores trocando o MESMO número ao mesmo tempo não têm
 * trava (não há transação através do PostgREST). Não precisa: todo LIGAR
 * reconfere o filtro (idempotente no transporte — lê antes, escreve só se
 * difere), e o DESLIGAR decide pelo que já está gravado. Um intercalamento
 * ruim é corrigido pelo próximo ligar ou pela próxima (re)conexão do número.
 */
export async function alternarGrupo(
  deps: DepsDeGrupos,
  e: {
    organizationId: string;
    channelSessionId: string;
    groupChatId: string;
    subject: string | null;
    ligar: boolean;
    actorUserId: string;
    requestId: string;
  },
): Promise<{ enabled: boolean }> {
  chatIdDeGrupo.parse(e.groupChatId);
  const s = await sessaoComGrupos(deps, e.organizationId, e.channelSessionId);

  if (e.ligar) return ligarGrupo(deps, s, e);
  return desligarGrupo(deps, s, e);
}

type SessaoComGrupos = Awaited<ReturnType<typeof sessaoComGrupos>>;
interface AlternarInput {
  organizationId: string;
  channelSessionId: string;
  groupChatId: string;
  subject: string | null;
  actorUserId: string;
  requestId: string;
}

/**
 * LIGAR: confirma o filtro ANTES de gravar — nunca fica "ligado" no banco sem
 * estar ligado de verdade no WhatsApp (invariante do serviço).
 *
 * O filtro é conferido em TODO ligar, não só no primeiro. Antes, com outro
 * grupo já ligado o filtro não era tocado — e um filtro que derivou (sessão
 * recriada depois de arquivar, volume do provedor perdido) nunca mais se curava:
 * o banco dizia "ligado" e nenhuma mensagem de grupo chegava. A conferência
 * não custa reinício de sessão: o transporte só escreve quando o valor
 * atual difere.
 */
async function ligarGrupo(deps: DepsDeGrupos, s: SessaoComGrupos, e: AlternarInput): Promise<{ enabled: boolean }> {
  // `setGroupIntake` pode LANÇAR (timeout, rede) em vez de resolver `false` —
  // as duas coisas significam a mesma coisa aqui: sem confirmação, nada liga.
  let confirmou: boolean;
  try {
    confirmou = await deps.setGroupIntake(s.provider, s.sessionRef, true);
  } catch {
    confirmou = false;
  }
  if (!confirmou) throw new GrupoError("filtro_nao_confirmado");
  const agora = deps.agora().toISOString();
  const row = await deps.db.gravarLinha(e.organizationId, e.channelSessionId, {
    group_chat_id: e.groupChatId,
    subject: e.subject,
    enabled: true,
    enabled_at: agora,
    enabled_by_user_id: e.actorUserId,
  });
  await deps.audit({
    action: "channel.group_enabled",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: row.id,
    requestId: e.requestId,
    metadata: { channel_session_id: e.channelSessionId, group_chat_id: e.groupChatId, filtro_confirmado: true },
  });
  return { enabled: true };
}

/**
 * DESLIGAR: grava a linha PRIMEIRO, e só DEPOIS decide o filtro pela
 * contagem já gravada (I1). Duas razões, uma escrita:
 *
 *  - Escrita antes: se `gravarLinha` falhar, o erro sobe puro e o WhatsApp
 *    nunca foi tocado — não existe mais o caminho em que o filtro desliga e a
 *    linha fica presa "ligada" porque a escrita quebrou depois.
 *  - Recontar DEPOIS da escrita (em vez de excluir o alvo da contagem ANTES)
 *    resolve o bug de C1 de graça: desligar um grupo que já estava desligado
 *    é idempotente na escrita, e a recontagem seguinte reflete o estado REAL
 *    (outro grupo ainda ligado não some da conta) — sem precisar perguntar
 *    "o alvo já estava ligado?" à parte.
 *
 * Se a recontagem apontar zero ligados, tenta desligar o filtro. Uma falha
 * AQUI (recusa ou exceção) NÃO sobe para quem chamou: a linha já está
 * correta (o grupo está desligado no banco), e deixar o filtro ligado é a
 * direção segura — o ingest descarta mensagem de grupo não escolhido de
 * qualquer forma, então o pior efeito é barulho a mais, nunca vazamento. A
 * falha vira log estruturado e entra no metadata da auditoria, para dar para
 * achar depois.
 */
async function desligarGrupo(deps: DepsDeGrupos, s: SessaoComGrupos, e: AlternarInput): Promise<{ enabled: boolean }> {
  const row = await deps.db.gravarLinha(e.organizationId, e.channelSessionId, {
    group_chat_id: e.groupChatId,
    subject: e.subject,
    enabled: false,
    enabled_at: null,
    enabled_by_user_id: null,
  });
  const restantes = await deps.db.contarLigados(e.organizationId, e.channelSessionId);
  const precisaDesligarFiltro = restantes === 0;
  let filtroDesligado: boolean | null = null;
  let motivoFalhaDoFiltro: string | null = null;
  if (precisaDesligarFiltro) {
    try {
      filtroDesligado = await deps.setGroupIntake(s.provider, s.sessionRef, false);
      if (!filtroDesligado) motivoFalhaDoFiltro = "recusado_pelo_whatsapp";
    } catch (err) {
      filtroDesligado = false;
      motivoFalhaDoFiltro = err instanceof Error ? err.message : String(err);
    }
    if (!filtroDesligado) {
      logger.warn("grupos: não deu para desligar o filtro de recebimento depois de desligar o último grupo", {
        organizationId: e.organizationId,
        channelSessionId: e.channelSessionId,
        groupChatId: e.groupChatId,
        causa: motivoFalhaDoFiltro,
      });
    }
  }
  await deps.audit({
    action: "channel.group_disabled",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: row.id,
    requestId: e.requestId,
    metadata: {
      channel_session_id: e.channelSessionId,
      group_chat_id: e.groupChatId,
      filtro_trocado: precisaDesligarFiltro,
      filtro_desligado: filtroDesligado,
      motivo_falha_do_filtro: motivoFalhaDoFiltro,
    },
  });
  return { enabled: false };
}

/** Dependências reais. `admin` é service role: TODA consulta filtra `organization_id`. */
export function criarDepsDeGrupos(admin: SupabaseClient): DepsDeGrupos {
  return {
    db: {
      async lerSessao(org, sessionId) {
        const { data } = await admin
          .from("channel_sessions")
          .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
          .eq("organization_id", org)
          .eq("id", sessionId)
          .maybeSingle();
        if (!data) return null;
        const ref = data as unknown as ChannelSessionRef & { provider: ChannelProvider };
        return { provider: ref.provider, sessionRef: resolveSessionRef(ref), groupsCapability: capabilitiesOf(ref.provider).groups };
      },
      async listarLinhas(org, sessionId) {
        const { data } = await admin
          .from("channel_session_groups")
          .select("group_chat_id, subject, enabled, enabled_at")
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId);
        return (data ?? []) as LinhaDeGrupo[];
      },
      async contarLigados(org, sessionId) {
        const { count } = await admin
          .from("channel_session_groups")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", org)
          .eq("channel_session_id", sessionId)
          .eq("enabled", true);
        return count ?? 0;
      },
      async gravarLinha(org, sessionId, row) {
        const { data, error } = await admin
          .from("channel_session_groups")
          .upsert({ organization_id: org, channel_session_id: sessionId, ...row }, { onConflict: "organization_id,channel_session_id,group_chat_id" })
          .select("id")
          .single();
        if (error) throw error;
        return data as { id: string };
      },
    },
    async listGroups(provider, sessionRef) {
      const adapter = getAdapter(provider);
      if (!adapter.listGroups) throw new GrupoError("canal_sem_grupos");
      return adapter.listGroups({ sessionRef });
    },
    async setGroupIntake(provider, sessionRef, receive) {
      const adapter = getAdapter(provider);
      return adapter.setGroupIntake ? adapter.setGroupIntake({ sessionRef, receive }) : false;
    },
    async audit(entry) {
      await auditReal({
        action: entry.action as AuditAction,
        organizationId: entry.organizationId,
        actorUserId: entry.actorUserId,
        resourceType: "channel_session_group",
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      });
    },
    agora: () => new Date(),
  };
}
