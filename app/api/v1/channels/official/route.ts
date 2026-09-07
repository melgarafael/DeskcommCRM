import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/channels/official — estado da conexão oficial + o que colar na Meta.
 * POST /api/v1/channels/official — VALIDA a credencial e só então grava.
 *
 * O `POST` valida contra a Graph API **antes** de persistir. Gravar primeiro e
 * descobrir depois é o que faz o operador achar que conectou e só entender que não na
 * primeira mensagem que não sai — com o lead do outro lado esperando.
 *
 * O `POST` é também o caminho de VOLTA: conectar por cima de um canal oficial que
 * foi excluído RESSUSCITA a linha (`lib/channels/reactivate.ts`). Sem isso o
 * update devolvia status/credencial/número e deixava `archived_at` no lugar — e o
 * canal "conectado" ficava invisível para o webhook, para o ingest, para os
 * seletores e para o envio, todos filtrados por essa coluna.
 *
 * Ressuscitar NÃO devolve a URL de webhook antiga: a exclusão rotacionou o
 * `webhook_path_token` de propósito (é o que corta a entrega da plataforma), e a
 * volta mantém a nova. É por isso que a tela mostra o que colar na Meta depois de
 * conectar — inclusive na reconexão, onde o endereço mudou.
 *
 * O token é cifrado pelas MESMAS RPCs do resto do repo (`lib/webhooks/secrets.ts`) e
 * **nunca volta** num GET: uma vez gravado, a tela mostra que existe, não qual é.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { CHANNEL_PROVIDER_META } from "@/lib/channels/capabilities";
import { validateMetaCredentials } from "@/lib/channels/meta/validate-credentials";
import { reactivateChannelSession } from "@/lib/channels/reactivate";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { metadataInicialDoCanal } from "@/lib/ai/elegibilidade/pre-go-live";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const conectarSchema = z.object({
  phone_number_id: z.string().min(5),
  waba_id: z.string().min(5),
  token: z.string().min(20),
});

/**
 * Base pública desta instalação — é o que o operador cola no dashboard da Meta.
 *
 * `env.*` e NÃO `process.env.NEXT_PUBLIC_APP_URL` direto: variáveis
 * `NEXT_PUBLIC_` são substituídas no BUILD, e a imagem genérica do self-host é
 * construída com `https://placeholder.invalid` (Dockerfile). Lendo direto do
 * `process.env`, a tela mostrava essa URL — e quem a colasse no dashboard
 * apontaria o webhook para o nada, sem erro em lugar nenhum.
 */
function publicBase(req: NextRequest): string {
  const configurada = env.NEXT_PUBLIC_APP_URL;
  const usavel = configurada && !configurada.includes("placeholder.invalid") ? configurada : null;
  return (
    usavel ?? req.headers.get("origin") ?? `${req.nextUrl.protocol}//${req.nextUrl.host}`
  );
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const orgId = authz.org.orgId;

  const admin = createAdminClient();
  // Canal ARQUIVADO não conta como conectado. A linha sobrevive à exclusão como
  // âncora das FKs, e sem este filtro a tela dizia "conectado" (com a URL de
  // webhook já rotacionada, portanto morta) para um canal que o operador acabou
  // de excluir — e oferecia "Trocar credencial" onde deveria oferecer "Conectar".
  // O POST, ao contrário, PRECISA enxergar a linha arquivada: é ela que ele
  // ressuscita.
  const consultar = () =>
    admin
      .from("channel_sessions")
      .select("id, meta_phone_number_id, meta_waba_id, meta_token_encrypted, phone_number, display_name, webhook_path_token, status")
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META);
  const { data } = await queryTolerantToMissingArchived(
    () => consultar().is(ARCHIVED_AT, null).maybeSingle(),
    () => consultar().maybeSingle(),
  );

  const base = publicBase(req);
  return ok({
    connected: Boolean(data),
    channel_session_id: data?.id ?? null,
    // `hasToken` em vez do token: uma vez gravado, a tela mostra que EXISTE, nunca
    // qual é. Devolver o segredo para preencher o campo seria vazá-lo a cada render.
    hasToken: Boolean(data?.meta_token_encrypted),
    phoneNumberId: data?.meta_phone_number_id ?? null,
    wabaId: data?.meta_waba_id ?? null,
    displayName: data?.display_name ?? null,
    phoneNumber: data?.phone_number ?? null,
    status: data?.status ?? null,
    /** O que o operador precisa colar do NOSSO lado no dashboard da Meta. */
    webhook: data
      ? {
          callbackUrl: `${base}/api/v1/webhooks/meta/${data.webhook_path_token}`,
          verifyToken: process.env.META_WEBHOOK_VERIFY_TOKEN ?? null,
          fields: ["messages", "message_template_status_update"],
        }
      : null,
  });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_official" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const userId = authz.user.id;

  const parsed = conectarSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_request", t("phone_number_id, waba_id e token são obrigatórios"), 422, {
      requestId,
    });
  }
  const { phone_number_id, waba_id, token } = parsed.data;

  // VALIDA ANTES DE GRAVAR — a rota não sabe com quem fala; ela pergunta se a
  // credencial presta e o canal responde.
  const validacao = await validateMetaCredentials({ phoneNumberId: phone_number_id, token });
  if (!validacao.ok) {
    return fail("invalid_request", validacao.motivo, 422, { requestId });
  }

  const admin = createAdminClient();
  const cifrado = await encryptWebhookSecret(admin, token);
  if (!cifrado) {
    // Sem a GUC de cifra configurada, gravar o token em claro seria pior que
    // recusar. O operador precisa saber que falta uma configuração de servidor.
    return fail(
      "invalid_request",
      t("cifra indisponível nesta instalação (GUC app.nuvemshop_oauth_key ausente) — o token não foi gravado"),
      422,
      { requestId },
    );
  }

  // A busca NÃO filtra `archived_at`: um canal oficial excluído é exatamente o
  // que este POST precisa achar para trazer de volta. Ignorá-lo criaria uma
  // SEGUNDA linha oficial na org — e a linha velha continuaria segurando o par
  // (org, número) na trava da 0106.
  const buscarExistente = (colunas: string) =>
    admin
      .from("channel_sessions")
      .select(colunas)
      .eq("organization_id", orgId)
      .eq("provider", CHANNEL_PROVIDER_META)
      .maybeSingle();
  const { data: existenteRaw } = await queryTolerantToMissingArchived(
    () => buscarExistente(`id, ${ARCHIVED_AT}`),
    () => buscarExistente("id"),
  );
  const existente = existenteRaw as { id: string; archived_at?: string | null } | null;

  const linha = {
    organization_id: orgId,
    provider: CHANNEL_PROVIDER_META,
    meta_phone_number_id: phone_number_id,
    meta_waba_id: waba_id,
    meta_token_encrypted: cifrado,
    phone_number: validacao.displayPhoneNumber ? `+${validacao.displayPhoneNumber.replace(/\D/g, "")}` : null,
    display_name: validacao.verifiedName ?? "Canal oficial",
    status: "WORKING",
  };

  // `update` quando já existe em vez de upsert: a trava única de (org,
  // phone_number) não serve de árbitro de `ON CONFLICT` aqui. Era DEFERRABLE
  // (medido ao criar a sessão de teste da Fase 3b, e o Postgres recusa
  // constraint deferível na inferência); a migration 0107 a trocou por um índice
  // único PARCIAL (`where archived_at is null`), que só seria inferível se a
  // cláusula repetisse o predicado — e o cliente do PostgREST não expõe isso.
  // Mudou a razão, não a escolha.
  //
  // O update passa por `reactivateChannelSession` porque reconectar é
  // ressuscitar: o mesmo patch que devolve status, credencial e número tem que
  // devolver a linha à vida, ou o canal fica "conectado" na tela e excluído para
  // todo o resto do sistema. Para o canal que já estava ativo é um no-op — e a
  // auditoria de volta sai de lá, junto da ressurreição, não daqui.
  const { error } = existente
    ? await reactivateChannelSession(
        admin,
        {
          organizationId: orgId,
          channelSessionId: existente.id,
          archivedAt: existente.archived_at ?? null,
        },
        linha,
        {
          userId: userId,
          requestId,
          metadata: { provider: CHANNEL_PROVIDER_META, phone_number: linha.phone_number },
        },
      )
    : await admin.from("channel_sessions").insert({
        ...linha,
        webhook_secret_encrypted: cifrado,
        metadata: metadataInicialDoCanal(),
      });

  if (error) {
    return fail("internal_error", error.message ?? "channel_session_write_failed", 500, {
      requestId,
    });
  }

  return ok({
    connected: true,
    displayName: linha.display_name,
    phoneNumber: linha.phone_number,
  });
}
