// app/api/v1/messages/[id]/media/route.ts
/**
 * GET /api/v1/messages/[id]/media — acesso autenticado à mídia da mensagem.
 * Persistida → 302 pra signed URL (TTL 1h) do bucket whatsapp-media.
 * Ainda não persistida (janela até o worker rodar) → proxy dos bytes do WAHA.
 * A URL desta rota é usada diretamente como src de <img>/<video>/<audio>
 * (cookie de sessão vai junto por ser same-origin; RLS decide o acesso).
 *
 * `?formato=aac` (F2 da ADR-0006): áudio ogg/webm/opus convertido NA HORA para
 * AAC em MP4, para o aparelho que não toca opus (Safari do iPhone antes do
 * 18.4). Os bytes vão direto na resposta, `no-store`, e o aparelho toca em
 * memória: nada é guardado no Storage nem no aparelho.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { orgAtivaDaApi } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { VALIDADE_DO_LINK_DE_MIDIA_S } from "@/lib/messaging/media/link-temporario";
import { ConversorOcupado, TETO_REPRODUCAO_BYTES, paraReproducaoAac } from "@/lib/messaging/media/voice-transcode";
import {
  CHANNEL_SESSION_REF_COLUMNS,
  DEFAULT_CHANNEL_PROVIDER,
  getAdapter,
  resolveSessionRef,
  type ChannelProvider,
  type ChannelSessionRef,
} from "@/lib/channels";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const Consulta = z.object({ formato: z.enum(["aac"]).optional() });

/**
 * Teto da conversão para tocar: cada pedido é ffmpeg na CPU da VPS. O da
 * pessoa vem primeiro — quem martela o play esgota o próprio minuto, não o dos
 * colegas —, e o da organização segura a soma.
 */
const TETO_CONVERSAO_POR_USUARIO = 30;
const TETO_CONVERSAO_POR_ORGANIZACAO = 120;
const JANELA_CONVERSAO_S = 60;
/** Conversor do processo cheio: uma conversão leva poucos segundos. */
const ESPERA_CONVERSOR_OCUPADO_S = 5;

/** O que o Safari antigo não toca e o ffmpeg sabe abrir. O resto já toca. */
const AUDIO_CONVERTIVEL = new Set(["audio/ogg", "audio/webm", "audio/opus"]);

type Linha = {
  media_url: string | null;
  media_mime: string | null;
  channel_session_id: string | null;
};

/**
 * Os bytes que o worker ainda não persistiu, pelo ADAPTER do canal — nunca por
 * uma função fixa de um provedor. `null` = canal sem mídia de entrada, que é
 * estado normal e não defeito.
 */
async function buscarNoCanal(orgId: string, msg: Linha) {
  const admin = createAdminClient();
  const { data: sessao } = await admin
    .from("channel_sessions")
    .select(`provider, ${CHANNEL_SESSION_REF_COLUMNS}`)
    .eq("organization_id", orgId)
    .eq("id", msg.channel_session_id)
    .maybeSingle();

  const adapter = getAdapter(
    ((sessao?.provider as string) ?? DEFAULT_CHANNEL_PROVIDER) as ChannelProvider,
  );
  const sessionRef = sessao ? resolveSessionRef(sessao as unknown as ChannelSessionRef) : null;
  if (!adapter.fetchInboundMedia || !sessionRef || !msg.media_url) return null;

  return adapter.fetchInboundMedia({
    organizationId: orgId,
    sessionRef,
    url: msg.media_url,
    hintMime: msg.media_mime,
  });
}

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const { id: messageId } = await ctx.params;
  const supabase = await createClient();

  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();
  if (authErr || !user) {
    return fail("unauthenticated", "Auth required.", 401, { requestId });
  }
  const authUser = await loadAuthUser();
  const t = (texto: string) => traduzir(texto, authUser?.idioma ?? "pt-BR");
  const ativa = await orgAtivaDaApi(authUser, requestId);
  if (!ativa.ok) return ativa.response;
  const activeOrg = ativa.org;
  if (!activeOrg) {
    return fail("no_active_org", t("No active organization."), 403, { requestId });
  }

  // Validação DEPOIS da autorização: quem não está logado recebe 401, não 422.
  const consulta = Consulta.safeParse({
    formato: new URL(req.url).searchParams.get("formato") ?? undefined,
  });
  if (!consulta.success) {
    return fail("validation_failed", t("Formato não suportado: use ?formato=aac."), 422, { requestId });
  }
  const paraTocar = consulta.data.formato === "aac";
  if (paraTocar) {
    const porUsuario = await checkRateLimit(
      `midia-aac:${user.id}`,
      TETO_CONVERSAO_POR_USUARIO,
      JANELA_CONVERSAO_S,
    );
    const barrou = porUsuario.allowed
      ? await checkRateLimit(
          `midia-aac-org:${activeOrg.orgId}`,
          TETO_CONVERSAO_POR_ORGANIZACAO,
          JANELA_CONVERSAO_S,
        )
      : porUsuario;
    if (!barrou.allowed) {
      return fail("rate_limited", t("Muitas conversões de áudio seguidas. Tente em um minuto."), 429, {
        requestId,
        headers: {
          "Retry-After": String(JANELA_CONVERSAO_S),
          "X-RateLimit-Limit": String(barrou.limit),
          "X-RateLimit-Remaining": String(Math.max(0, barrou.limit - barrou.count)),
        },
      });
    }
  }

  // Client de sessão: RLS garante que a mensagem pertence a uma org do usuário.
  // Filtro explícito de organization_id por doutrina (defense-in-depth).
  const { data: msg, error } = await supabase
    .from("messages")
    .select("id, media_url, media_mime, media_size_bytes, media_storage_path, metadata, channel_session_id")
    .eq("id", messageId)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (error) {
    return fail("internal_error", t("Erro ao buscar mensagem."), 500, { requestId });
  }
  if (!msg) {
    return fail("not_found", t("Mensagem sem mídia."), 404, { requestId });
  }
  if (!msg.media_storage_path && !msg.media_url) {
    // A mídia foi podada pela retenção (o marcador `expired` da migration 0557 é
    // a prova escrita). 404 seria "não há o que servir" e deixaria a tela cair
    // no aviso genérico; 410 diz a verdade — o recurso EXISTIU e foi retirado
    // por política. O aceite do #1534 manda a rota NÃO buscar de novo do
    // provedor o que expirou: aqui nem um nem outro caminho roda, porque não há
    // `media_url` para o fallback seguir.
    const meta = (msg.metadata ?? {}) as Record<string, unknown>;
    const expirada = meta.media_status === "expired";
    const dias = typeof meta.media_retention_days === "number" ? meta.media_retention_days : null;
    return fail(
      expirada ? "media_expired" : "not_found",
      !expirada
        ? t("Mensagem sem mídia.")
        : dias !== null
          ? t("Mídia apagada pela política de retenção ({n} dias)").replace("{n}", String(dias))
          : t("Mídia apagada pela política de retenção."),
      expirada ? 410 : 404,
      { requestId },
    );
  }

  if (paraTocar) return converterParaTocar(activeOrg.orgId, msg, requestId, t);

  if (msg.media_storage_path) {
    const admin = createAdminClient();
    const { data: signed, error: signErr } = await admin.storage
      .from("whatsapp-media")
      .createSignedUrl(msg.media_storage_path, VALIDADE_DO_LINK_DE_MIDIA_S);
    if (!signErr && signed?.signedUrl) {
      const response = NextResponse.redirect(signed.signedUrl, 302);
      response.headers.set("X-Request-Id", requestId);
      return response;
    }
    if (signErr) {
      logger.error("messages.media.sign_failed", {
        message_id: messageId,
        erro: signErr.message,
      });
    }
  }

  // ── Fallback: o worker ainda não persistiu ──────────────────────────────────
  //
  // O drain é cron de minuto a minuto, então esta janela é diária: quem abre a
  // conversa antes da persistência cai aqui. O browser não alcança o transporte
  // nem tem a credencial, por isso o proxy é server-side.
  //
  // Pelo ADAPTER, não por uma função fixa. Esta era literalmente a linha que o
  // conserto do worker removeu de lá e esqueceu aqui: com `fetchWahaMedia` em
  // duro, o path de um anexo do canal intermediado era procurado dentro do
  // contêiner do canal por QR — 404, e a tela dizia "mídia indisponível".
  if (msg.media_url) {
    try {
      const media = await buscarNoCanal(activeOrg.orgId, msg);
      if (!media) {
        // Canal sem mídia de entrada não é defeito: é estado normal. 404 diz a
        // verdade ("não há o que servir"); 502 acusaria uma falha inexistente.
        return fail("not_found", t("Mensagem sem mídia."), 404, { requestId });
      }
      return new Response(new Uint8Array(media.buffer), {
        status: 200,
        headers: {
          "Content-Type": media.mime,
          "Cache-Control": "private, max-age=60",
          "X-Request-Id": requestId,
        },
      });
    } catch {
      return fail("bad_gateway", t("Mídia indisponível no momento."), 502, { requestId });
    }
  }

  return fail("not_found", t("Mensagem sem mídia."), 404, { requestId });
}

/**
 * `?formato=aac`: os bytes do áudio, convertidos para AAC em MP4.
 *
 * O tamanho é conferido ANTES de baixar (quando já se sabe) e depois: o
 * `media_size_bytes` do que o worker ainda não persistiu pode faltar.
 */
async function converterParaTocar(
  orgId: string,
  msg: Linha & { media_storage_path: string | null; media_size_bytes: number | null },
  requestId: string,
  t: (texto: string) => string,
): Promise<Response> {
  const base = (msg.media_mime ?? "").split(";")[0]!.trim().toLowerCase();
  if (!AUDIO_CONVERTIVEL.has(base)) {
    return fail("unsupported_media_type", t("Formato de áudio não suportado."), 415, { requestId });
  }
  const grandeDemais = () =>
    fail("payload_too_large", t("Não foi possível preparar o áudio para este aparelho."), 413, { requestId });
  if ((msg.media_size_bytes ?? 0) > TETO_REPRODUCAO_BYTES) return grandeDemais();

  let bytes: Buffer;
  try {
    if (msg.media_storage_path) {
      const { data, error } = await createAdminClient()
        .storage.from("whatsapp-media")
        .download(msg.media_storage_path);
      if (error || !data) throw new Error(error?.message ?? "download_vazio");
      bytes = Buffer.from(await data.arrayBuffer());
    } else {
      const media = await buscarNoCanal(orgId, msg);
      if (!media) return fail("not_found", t("Mensagem sem mídia."), 404, { requestId });
      bytes = Buffer.from(media.buffer);
    }
  } catch {
    return fail("bad_gateway", t("Mídia indisponível no momento."), 502, { requestId });
  }
  if (bytes.length > TETO_REPRODUCAO_BYTES) return grandeDemais();

  let aac: Buffer;
  try {
    aac = await paraReproducaoAac(bytes, orgId);
  } catch (err) {
    if (err instanceof ConversorOcupado) {
      return fail("conversor_ocupado", t("Muitos áudios sendo preparados agora. Tente em alguns segundos."), 503, {
        requestId,
        headers: { "Retry-After": String(ESPERA_CONVERSOR_OCUPADO_S) },
      });
    }
    logger.error("messages.media.conversao_aac_falhou", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return fail("conversao_indisponivel", t("Não foi possível preparar o áudio para este aparelho."), 502, {
      requestId,
    });
  }
  return new Response(new Uint8Array(aac), {
    status: 200,
    headers: {
      "Content-Type": "audio/mp4",
      // `no-store`: nem o navegador nem um proxy guardam o áudio (D4 da ADR-0006).
      "Cache-Control": "private, no-store",
      "X-Request-Id": requestId,
    },
  });
}
