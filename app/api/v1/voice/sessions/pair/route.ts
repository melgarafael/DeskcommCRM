/**
 * POST /api/v1/voice/sessions/pair — inicia (ou reinicia) o pareamento de
 * chamada de voz WhatsApp da organização.
 *
 * Segundo dispositivo vinculado no MESMO número WhatsApp da sessão de mensagens já
 * pareada — risco aceito, opt-in por org, decisão de produto §1.2 da spec
 * docs/specs/18-spec-voice-calls-wacalls.md. Admin only, igual a
 * channel-sessions/[id]/reconnect.
 *
 * O QR não volta nesta resposta: o WaCalls empurra por SSE (`session-qr`),
 * relayado pra tela via `GET /api/v1/voice/events` (fora de escopo desta
 * rota). Aqui só garante a linha em `channel_sessions` e dispara o pareamento.
 */
import { randomUUID } from "node:crypto";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { exigirVozLigada } from "@/lib/voice/guarda";
import { getWacallsClient, wacallsFriendlyError } from "@/lib/wacalls/client";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  // Acompanhamento administrativo somente-leitura não liga, não atende, não
  // desliga e não pareia: o efeito é do tenant, não de quem observa.
  const suporteNegado = await requireSupportWrite();
  if (suporteNegado) return suporteNegado;

  const requestId = randomUUID();

  const authz = await requireRole("admin", {
    requestId,
    resource: "channel_sessions",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const { user, org: activeOrg } = authz;

  const wacalls = getWacallsClient();
  if (!wacalls) {
    return fail(
      "wacalls_not_configured",
      "Chamada de voz não está configurada neste ambiente: falta WACALLS_API_BASE_URL.",
      503,
      { requestId },
    );
  }

  const supabase = await createClient();

  // ⚠️ O CONSENTIMENTO É EXIGIDO AQUI, e este é o lugar certo: parear é o ato
  // que CRIA a exposição — a partir dele existe um segundo aparelho vinculado
  // ao número da empresa, com o risco de o WhatsApp bloquear a CONTA inteira.
  //
  // Sem esta linha, o interruptor de Configurações › Segurança era decorativo
  // pelo caminho de entrada: a tela pedia "eu li o aviso e aceito o risco",
  // e quem fosse direto a Conexões pareava sem passar por ela. Desligar
  // continuava real (o PUT do opt-in despareia de verdade), mas LIGAR nunca foi
  // necessário — e um consentimento que dá para pular não é consentimento.
  //
  // O que NÃO ganha esta guarda, de propósito: `DELETE /sessions` (desparear),
  // `reject` e `hangup`. A porta de saída nunca depende do interruptor — é a
  // mesma razão escrita no cabeçalho da rota de DELETE.
  // `instalacaoOferece: true` porque o `getWacallsClient()` acima já provou
  // o fato e já devolveu 503 se fosse falso — a guarda não o relê pelo env.
  const vozDesligada = await exigirVozLigada(supabase, activeOrg.orgId, {
    requestId,
    instalacaoOferece: true,
  });
  if (vozDesligada) return vozDesligada;

  const { data: existingRaw } = await supabase
    .from("channel_sessions")
    .select("id, wacalls_session_id")
    .eq("organization_id", activeOrg.orgId)
    .eq("provider", "wacalls")
    .is("archived_at", null)
    .maybeSingle();
  const existing = existingRaw as { id: string; wacalls_session_id: string | null } | null;

  try {
    let channelSessionId = existing?.id ?? null;
    let wacallsSessionId = existing?.wacalls_session_id ?? null;

    if (!wacallsSessionId) {
      const created = await wacalls.createSession(`org_${activeOrg.orgId.slice(0, 8)}`);
      wacallsSessionId = created.id;

      if (channelSessionId) {
        await supabase
          .from("channel_sessions")
          .update({ wacalls_session_id: wacallsSessionId })
          .eq("id", channelSessionId);
      } else {
        // webhook_path_token/webhook_secret_encrypted são NOT NULL na tabela
        // mas não fazem sentido pra este provider — o WaCalls empurra estado
        // por SSE (§4.2 da spec), não webhook HMAC. Mesmo placeholder que
        // onboarding/whatsapp/session/route.ts usa quando o fluxo não assina:
        // path_token cai no DEFAULT do banco, secret é 1 byte zero (bytea).
        //
        // `engine` NÃO entra: `channel_sessions_engine_check` só aceita
        // NOWEB/WEBJS (vocabulário do transporte principal) — omitido, cai no DEFAULT
        // 'NOWEB' da coluna, que não significa nada pra este provider mas
        // satisfaz o CHECK. Mesmo padrão do canal oficial/parceiro, que
        // também não grava `engine`.
        const { data: inserted, error: insertErr } = await supabase
          .from("channel_sessions")
          .insert({
            organization_id: activeOrg.orgId,
            provider: "wacalls",
            wacalls_session_id: wacallsSessionId,
            status: "STARTING",
            webhook_secret_encrypted: Buffer.from([0]),
          })
          .select("id")
          .single();
        if (insertErr || !inserted) throw new Error(`channel_sessions insert: ${insertErr?.message}`);
        channelSessionId = (inserted as { id: string }).id;
      }
    }

    await wacalls.pairSession(wacallsSessionId);

    void audit({
      action: "voice.session_pair_started",
      actorUserId: user.id,
      organizationId: activeOrg.orgId,
      resourceType: "channel_session",
      resourceId: channelSessionId ?? null,
      requestId,
      metadata: { wacalls_session_id: wacallsSessionId },
    });

    return ok({ channelSessionId, wacallsSessionId }, { requestId });
  } catch (err) {
    logger.error("wacalls: pareamento falhou", {
      request_id: requestId,
      organization_id: activeOrg.orgId,
      error: err instanceof Error ? err.message : String(err),
    });
    return fail("wacalls_error", wacallsFriendlyError(err), 502, { requestId });
  }
}
