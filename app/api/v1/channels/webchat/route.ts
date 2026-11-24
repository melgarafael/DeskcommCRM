import { randomUUID } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  configuracaoDoChatSchema,
  instalacaoEmLoopback,
  origensPermitidasSchema,
  type ConfiguracaoDoChat,
} from "@/lib/channels/webchat/config";
import {
  acharConexaoDoChat,
  NOME_DA_CONEXAO_DO_CHAT,
  novaChaveDoChat,
} from "@/lib/channels/webchat/conexao";
import { chatNoSiteLigado } from "@/lib/channels/webchat/modulo";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * GET   /api/v1/channels/webchat — estado da conexão do chat no site.
 * POST  /api/v1/channels/webchat — cria a conexão (uma por organização), com a chave `wck_`.
 * PATCH /api/v1/channels/webchat — muda a lista de domínios e a configuração (aparência, textos, coleta,
 *   pausa). Pausar é `config.pausado: true`; a mudança de valor emite `channel.webchat_paused` além do `updated`.
 *
 * O giro da chave é `POST .../girar`. Molde: `app/api/v1/channels/bot/route.ts`.
 *
 * Desligado o módulo `canal_webchat` (`lib/channels/webchat/modulo.ts`), as três respondem 404
 * antes de ler o corpo. Quem administra é `requireRole("admin")`; todo efeito vem depois de
 * `requireSupportWrite(`. A organização vem da sessão, nunca do corpo.
 *
 * A chave nunca vai para log nem para audit: a auditoria guarda só o id da conexão.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MENSAGEM_DE_CORPO_INVALIDO = "Confira os domínios e a configuração do chat.";

function criacaoSchema(emLoopback: boolean) {
  return z.object({ allowed_origins: origensPermitidasSchema(emLoopback).optional() }).strict();
}

function atualizacaoSchema(emLoopback: boolean) {
  return z
    .object({
      allowed_origins: origensPermitidasSchema(emLoopback).optional(),
      config: configuracaoDoChatSchema.optional(),
    })
    .strict()
    .refine((corpo) => corpo.allowed_origins !== undefined || corpo.config !== undefined, {
      message: "nada para mudar",
    });
}

export async function GET(_req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_webchat" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  if (!(await chatNoSiteLigado(admin, orgId))) return fail("not_found", "Not found", 404, { requestId });

  let conexao;
  try {
    conexao = await acharConexaoDoChat(admin, orgId);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "lookup_failed", 500, { requestId });
  }
  if (!conexao) {
    return ok(
      { connected: false, id: null, display_name: null, status: null, public_key: null, allowed_origins: [], config: {} },
      { requestId },
    );
  }
  return ok(
    {
      connected: true,
      id: conexao.id,
      display_name: conexao.displayName,
      status: conexao.status,
      public_key: conexao.publicKey,
      allowed_origins: conexao.allowedOrigins,
      config: conexao.config,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  // Abrir o chat no site põe a empresa para conversar com visitantes: decisão de dono.
  const authz = await requireRole("admin", { requestId, resource: "channels_webchat" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  if (!(await chatNoSiteLigado(admin, orgId))) return fail("not_found", "Not found", 404, { requestId });

  const parsed = criacaoSchema(instalacaoEmLoopback()).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid_request", MENSAGEM_DE_CORPO_INVALIDO, 422, { requestId });

  let existente;
  try {
    existente = await acharConexaoDoChat(admin, orgId);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "lookup_failed", 500, { requestId });
  }
  if (existente) {
    return fail("state_conflict", "A organização já tem o chat no site conectado.", 409, { requestId });
  }

  const chave = novaChaveDoChat();
  const origens = parsed.data.allowed_origins ?? [];
  const { data, error } = await admin
    .from("channel_sessions")
    .insert({
      organization_id: orgId,
      provider: "webchat",
      webchat_public_key: chave,
      webchat_allowed_origins: origens,
      // Este canal não recebe webhook de terceiro, então não há segredo a guardar. A coluna é
      // NOT NULL e as conexões de número gravam um byte de enfeite (`\x00`): é o precedente.
      // A chave não entra aqui.
      webhook_secret_encrypted: "\\x00",
      display_name: NOME_DA_CONEXAO_DO_CHAT,
      status: "WORKING",
      metadata: {},
    })
    .select("id")
    .single();
  if (error || !data) {
    if (error?.code === "23505") {
      return fail("state_conflict", "A organização já tem o chat no site conectado.", 409, { requestId });
    }
    return fail("internal_error", error?.message ?? "insert_failed", 500, { requestId });
  }

  const id = (data as { id: string }).id;
  void audit({
    action: "channel.webchat_created",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: id,
    requestId,
    metadata: { canal: "webchat" },
  });

  return ok({ id, public_key: chave, allowed_origins: origens }, { requestId, status: 201 });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_webchat" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const orgId = authz.org.orgId;
  if (!(await chatNoSiteLigado(admin, orgId))) return fail("not_found", "Not found", 404, { requestId });

  const parsed = atualizacaoSchema(instalacaoEmLoopback()).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return fail("invalid_request", MENSAGEM_DE_CORPO_INVALIDO, 422, { requestId });

  let conexao;
  try {
    conexao = await acharConexaoDoChat(admin, orgId);
  } catch (err) {
    return fail("internal_error", err instanceof Error ? err.message : "lookup_failed", 500, { requestId });
  }
  if (!conexao) return fail("not_found", "Not found", 404, { requestId });

  // A configuração MESCLA com a atual: quem manda só o título não apaga a cor nem a coleta.
  const configDepois: ConfiguracaoDoChat = { ...conexao.config, ...parsed.data.config };
  const patch: Record<string, unknown> = {};
  if (parsed.data.allowed_origins !== undefined) patch.webchat_allowed_origins = parsed.data.allowed_origins;
  if (parsed.data.config !== undefined) {
    patch.metadata = { ...conexao.metadata, webchat: configDepois };
  }

  const { error } = await admin
    .from("channel_sessions")
    .update(patch)
    .eq("id", conexao.id)
    .eq("organization_id", orgId)
    .is("archived_at", null)
    .select("id")
    .single();
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "channel.webchat_updated",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "channel_session",
    resourceId: conexao.id,
    requestId,
    // Os NOMES dos campos mudados, nunca a chave: a lista de domínios fica no registro da conexão.
    metadata: { canal: "webchat", campos: Object.keys(parsed.data) },
  });

  // Pausa (Task 7): audit próprio só quando o valor MUDA. Repetir o valor atual não é evento.
  const pausadoNovo = parsed.data.config?.pausado;
  if (pausadoNovo !== undefined && pausadoNovo !== (conexao.config.pausado === true)) {
    void audit({
      action: "channel.webchat_paused",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "channel_session",
      resourceId: conexao.id,
      requestId,
      metadata: { canal: "webchat", pausado: pausadoNovo },
    });
  }

  return ok(
    {
      id: conexao.id,
      allowed_origins: parsed.data.allowed_origins ?? conexao.allowedOrigins,
      config: parsed.data.config !== undefined ? configDepois : conexao.config,
    },
    { requestId },
  );
}
