import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET /api/v1/channel-sessions/[id] — health check AO VIVO de um canal.
 *
 * Consulta o status real no WAHA, grava `last_health_check_at` (+ sincroniza
 * `status`) no DB e devolve o estado atual. É a fonte de verdade quando o
 * usuário abre a Central de Conexões ou está aguardando o QR ser escaneado.
 *
 * O health check ao vivo é do canal pareado por QR: o canal oficial não tem
 * sessão no transporte para consultar (`waha_session_name` é NULL nele, por
 * construção da união do `channel_sessions_provider_ref_check`), e perguntar
 * assim mesmo pediria `/api/sessions/null` ao WAHA.
 *
 * `?impact=1` acrescenta `deletion_impact` — o PREFLIGHT da exclusão. Vive num
 * parâmetro e não no corpo padrão porque esta rota é POLLADA enquanto o usuário
 * espera o QR, e o preflight custa seis contagens; quem precisa dele é o diálogo
 * de exclusão, uma vez, ao abrir. Contrato em `ChannelDeletionImpact`.
 *
 * Qualquer membro da org pode consultar. organization_id vem da sessão.
 */
import { assertWahaConnectionIdle, ChannelConnectionError } from "@/lib/channels/connect-waha";
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_PROVIDER_WAHA } from "@/lib/channels/capabilities";
import { numeroObservadoDaSessao } from "@/lib/channels/numero-observado";
import { isChannelStatus } from "@/lib/schemas/channels";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { getWahaClient, wahaFriendlyError } from "@/lib/waha/client";

export const dynamic = "force-dynamic";

/**
 * O que a exclusão deste canal vai fazer, e ao custo de quê — para o diálogo
 * poder dizer a verdade ANTES do clique.
 *
 * `outcome` é a decisão real da rota DELETE, calculada pela mesma função: se as
 * duas discordassem, a tela prometeria uma coisa e o servidor faria outra.
 */
export interface ChannelDeletionImpact {
  /** `delete` apaga a linha; `archive` esconde o canal e preserva tudo abaixo. */
  outcome: "delete" | "archive";
  /**
   * Referências com ON DELETE RESTRICT: o Postgres RECUSA apagar a linha
   * enquanto elas existirem. É o que torna o arquivamento obrigatório, não uma
   * preferência.
   */
  history: { conversations: number; messages: number; agent_versions: number };
  /**
   * Referências com ON DELETE CASCADE que NÃO são estado de runtime: sumiriam em
   * silêncio junto com a linha. `ai_routers` leva os `ai_router_members` dele
   * atrás; `channel_knobs` é o ajuste anti-ban que o operador calibrou;
   * `before_send_traces` é auditoria durável de decisão de envio.
   *
   * Warm-up, saúde, pacing e cópias recentes também cascateiam e NÃO entram aqui
   * de propósito: são contadores derivados, que se regeneram sozinhos.
   */
  configuration: { ai_routers: number; channel_knobs: number; before_send_traces: number };
}

/** Tabelas que apontam para `channel_sessions` e cujo conteúdo decide o desfecho. */
type DependentTable =
  | "conversations"
  | "messages"
  | "ai_agent_versions"
  | "ai_routers"
  | "channel_knobs"
  | "before_send_traces";

/**
 * Conta tudo que está pendurado no canal, com o CLIENTE ADMIN e filtro explícito
 * de organização.
 *
 * O cliente do usuário não serve aqui: `ai_routers`, `channel_knobs` e
 * `before_send_traces` nasceram no apêndice do baseline e não têm policy de RLS
 * para o papel `authenticated`. Uma contagem que volta zero por falta de
 * permissão é indistinguível de "não há nada" — e o zero silencioso reabriria
 * exatamente o defeito que esta função existe para fechar. Com o admin, o filtro
 * de tenancy é responsabilidade nossa e vem de `orgId`, resolvido da sessão.
 */
async function loadDeletionImpact(
  orgId: string,
  channelSessionId: string,
): Promise<ChannelDeletionImpact> {
  const admin = createAdminClient();
  // `select("*")` com `head` não devolve linha nenhuma — só o contador. Pedir uma
  // coluna concreta quebraria em `channel_knobs`, cuja chave é (org, sessão): ela
  // não tem `id`.
  const count = async (table: DependentTable): Promise<number> => {
    const { count: n } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .eq("channel_session_id", channelSessionId);
    return n ?? 0;
  };

  const [conversations, messages, agentVersions, routers, knobs, traces] = await Promise.all([
    count("conversations"),
    count("messages"),
    count("ai_agent_versions"),
    count("ai_routers"),
    count("channel_knobs"),
    count("before_send_traces"),
  ]);

  const history = { conversations, messages, agent_versions: agentVersions };
  const configuration = {
    ai_routers: routers,
    channel_knobs: knobs,
    before_send_traces: traces,
  };
  const nada =
    Object.values(history).every((n) => n === 0) &&
    Object.values(configuration).every((n) => n === 0);

  return { outcome: nada ? "delete" : "archive", history, configuration };
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await params;

  const user = await loadAuthUser();
  if (!user) return fail("unauthenticated", "Auth required.", 401, { requestId });
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) return fail("forbidden_tenant", "Nenhuma organização ativa.", 403, { requestId });

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("channel_sessions")
    .select("id, provider, waha_session_name, display_name, phone_number, status")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const impact =
    req.nextUrl.searchParams.get("impact") === "1"
      ? await loadDeletionImpact(activeOrg.orgId, id)
      : null;
  const comImpacto = <T extends object>(corpo: T): T & { deletion_impact?: ChannelDeletionImpact } =>
    impact ? { ...corpo, deletion_impact: impact } : corpo;

  if (user.support?.access_mode === "support_readonly") return ok(comImpacto({ ...session, waha_configured: false }), { requestId });
  const waha = getWahaClient();
  // Canal oficial não tem sessão no transporte para consultar — `waha_session_name`
  // é NULL nele por CHECK, e perguntar assim mesmo pediria `/api/sessions/null`.
  const nomeSessao =
    session.provider === CHANNEL_PROVIDER_WAHA ? session.waha_session_name : null;
  if (!waha || !nomeSessao) {
    // Nada a checar ao vivo (transporte fora do ar, ou canal que não vive nele):
    // devolve o que está no DB, sinalizando que o estado não foi confirmado agora.
    return ok(comImpacto({ ...session, waha_configured: false }), { requestId });
  }

  let liveStatus = session.status as string;
  let phoneNumber = session.phone_number as string | null;
  try {
    const remote = await waha.getVerifiedSession(nomeSessao);
    liveStatus = remote?.status ?? "STOPPED";
    // O número vem do JID (`<phone>@c.us`), e a regra de quando ele VALE mora
    // em `numeroObservadoDaSessao` — inclusive por que não basta gravar sempre.
    // O que havia aqui só preenchia a coluna VAZIA, então um re-pareamento com
    // outro aparelho deixava o banco mentindo para sempre.
    phoneNumber = numeroObservadoDaSessao({
      jid: typeof remote?.me?.id === "string" ? remote.me.id : null,
      statusAoVivo: liveStatus,
      gravado: phoneNumber,
    });
  } catch {
    return fail("connection_status_failed", "Não foi possível conferir a conexão. Tente novamente.", 502, { requestId });
  }

  // Sincroniza o DB: sempre carimba o health check; atualiza status/telefone só se válido.
  const checkedAt = new Date().toISOString();
  const patch: Record<string, unknown> = { last_health_check_at: checkedAt };
  if (isChannelStatus(liveStatus) && liveStatus !== session.status) {
    patch.status = liveStatus;
    patch.last_status_change_at = checkedAt;
  }
  if (phoneNumber && phoneNumber !== session.phone_number) patch.phone_number = phoneNumber;

  const gravar = (corpo: Record<string, unknown>) =>
    supabase
      .from("channel_sessions")
      .update(corpo)
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);

  let phoneConflict = false;
  const { error: syncErr } = await gravar(patch);
  if (syncErr) {
    // 23505 aqui só pode ser a trava de número único (0106): ESTE número já está
    // ligado em OUTRO canal ativo da org. Descartar o erro — o que esta rota
    // fazia — deixava o canal para sempre sem telefone, sem nada na tela dizendo
    // por quê. Regrava sem o telefone (o carimbo de saúde não pode ser refém do
    // conflito) e devolve o conflito nomeado.
    if (syncErr.code !== "23505") {
      return fail("internal_error", syncErr.message, 500, { requestId });
    }
    phoneConflict = true;
    phoneNumber = session.phone_number as string | null;
    const { phone_number: _descartado, ...semTelefone } = patch;
    const { error: retryErr } = await gravar(semTelefone);
    if (retryErr) return fail("internal_error", retryErr.message, 500, { requestId });
  }

  return ok(
    comImpacto({
      id: session.id,
      waha_session_name: session.waha_session_name,
      display_name: session.display_name,
      phone_number: phoneNumber,
      status: liveStatus,
      last_health_check_at: checkedAt,
      waha_configured: true,
      /** Verdadeiro = o número lido no canal já pertence a outro canal ativo desta org. */
      phone_number_conflict: phoneConflict,
    }),
    { requestId },
  );
}

/**
 * DELETE /api/v1/channel-sessions/[id] — remove um canal da Central de Conexões.
 *
 * Duas saídas, escolhidas pelo banco e não por parâmetro:
 *
 *  - Canal com NADA pendurado: apaga a linha de verdade. O que some junto por
 *    CASCADE é estado de runtime (warm-up, saúde, pacing, cópias recentes), que
 *    se regenera.
 *  - Canal com HISTÓRICO ou CONFIGURAÇÃO: arquiva (`archived_at`). conversations,
 *    messages e ai_agent_versions referenciam channel_sessions com ON DELETE
 *    RESTRICT — o Postgres recusaria o DELETE, e forçá-lo significaria destruir o
 *    histórico de atendimento junto. Arquivar tira o canal da UI preservando tudo.
 *
 * ⚠️ CASCADE **não** é sinônimo de descartável, e a régua das "três FKs RESTRICT"
 * errava por causa disso: `ai_routers` (com os `ai_router_members` atrás),
 * `channel_knobs` e `before_send_traces` também apontam para cá em CASCADE, e são
 * configuração do usuário e auditoria. Um canal sem uma única conversa mas com um
 * roteador de IA montado passava por "virgem", e o DELETE levava o roteador junto
 * sem uma palavra. Por isso a pergunta é "há algo pendurado?", respondida por
 * `loadDeletionImpact` — a MESMA função que alimenta o preflight do `GET
 * ?impact=1`, para a tela não prometer um desfecho e o servidor executar outro.
 *
 * A revogação no provider acontece ANTES de mexer no DB (se falhar, a linha
 * continua íntegra e dá para tentar de novo) e é diferente por canal:
 *
 *  - Canal pareado por QR: logout + delete da sessão no WAHA. **Sem WAHA
 *    configurado a rota falha fechado (503)**, como as rotas irmãs deste módulo:
 *    devolver 200 sem revogar era prometer uma desconexão que não aconteceu e
 *    deixar a sessão órfã ativa, recebendo webhook de um canal que a UI já não
 *    mostra.
 *  - Canal oficial: não há sessão a deslogar — o que dá acesso é a CREDENCIAL
 *    gravada e a URL de webhook. As duas são invalidadas no mesmo patch do
 *    arquivamento (token apagado, `webhook_path_token` rotacionado). Sem isso a
 *    plataforma continuava entregando mensagem num canal "excluído": o webhook
 *    resolvia a sessão pelo token antigo e criava contato, conversa e mensagem
 *    num inbox onde o operador nem consegue responder (o arquivamento grava
 *    STOPPED).
 *
 * Admin only. organization_id vem da sessão — nunca do path/body.
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });

  const supabase = await createClient();
  const { data: session } = await supabase
    .from("channel_sessions")
    .select("id, provider, waha_session_name, display_name, phone_number")
    .eq("organization_id", activeOrg.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!session) return fail("not_found", "Canal não encontrado.", 404, { requestId });

  const impact = await loadDeletionImpact(activeOrg.orgId, id);
  const arquivar = impact.outcome === "archive";

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    archived_at: now,
    status: "STOPPED",
    last_status_change_at: now,
  };

  if (session.provider === CHANNEL_PROVIDER_WAHA) {
    const waha = getWahaClient();
    if (!waha) {
      return fail(
        "waha_not_configured",
        "O WhatsApp (WAHA) não está configurado neste ambiente (faltam WAHA_API_BASE_URL e/ou WAHA_API_KEY) — sem ele o número não pode ser desconectado do aparelho.",
        503,
        { requestId },
      );
    }
    try {
      await assertWahaConnectionIdle(createAdminClient(), activeOrg.orgId, id);
      await waha.logoutSession(session.waha_session_name as string);
      await waha.deleteSession(session.waha_session_name as string);
    } catch (err) {
      if (err instanceof ChannelConnectionError) return fail(err.code, "Uma conexão está em andamento. Aguarde e tente novamente.", err.status, { requestId });
      await supabase.from("channel_sessions").update({ status: "FAILED", status_reason: "connection_repair_required", last_status_change_at: now })
        .eq("organization_id", activeOrg.orgId).eq("id", id);
      return fail("waha_error", wahaFriendlyError(err), 502, { requestId });
    }
  } else {
    // Revogação do canal oficial: a credencial some e a URL do webhook muda, então
    // o que a plataforma tem configurado do outro lado deixa de valer. Só faz
    // sentido no ramo que PRESERVA a linha — no hard delete ela some inteira.
    patch.meta_token_encrypted = null;
    patch.webhook_path_token = randomUUID().replace(/-/g, "");
  }

  if (arquivar) {
    const { error: archErr } = await supabase
      .from("channel_sessions")
      .update(patch)
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);
    if (archErr) return fail("internal_error", archErr.message, 500, { requestId });
  } else {
    const { error: delErr } = await supabase
      .from("channel_sessions")
      .delete()
      .eq("organization_id", activeOrg.orgId)
      .eq("id", id);
    if (delErr) return fail("internal_error", delErr.message, 500, { requestId });
  }

  void audit({
    action: arquivar ? "channel.archived" : "channel.deleted",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: {
      waha_session_name: session.waha_session_name,
      phone_number: session.phone_number,
      provider: session.provider,
      ...impact.history,
      ...impact.configuration,
    },
  });

  return ok({ id, archived: arquivar, impact }, { requestId });
}
