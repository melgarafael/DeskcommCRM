import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { SOCIAL_LABEL, SOCIAL_PROVIDER, socialNetworkSchema } from "@/lib/channels/social/contract";
import { SocialClient, SocialApiError } from "@/lib/channels/social/client";
import {
  connection,
  seal,
  unseal,
  syncChannels,
  processSocialEvent,
} from "@/lib/channels/social/service";

export const runtime = "nodejs";
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), api_key: z.string().trim().min(16).max(500) }),
  z.object({ action: z.literal("connect"), network: socialNetworkSchema }),
  z.object({ action: z.literal("sync") }),
  z.object({ action: z.literal("webhook") }),
  z.object({ action: z.literal("test") }),
  z.object({ action: z.literal("disconnect"), channel_session_id: z.uuid() }),
  z.object({
    action: z.literal("recover"),
    since: z.iso.datetime(),
    before: z.string().max(200).optional(),
  }),
]);

export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channels_social" });
  if (!auth.ok) return auth.response;
  try {
    const db = createAdminClient();
    const row = await connection(db, auth.org.orgId);
    const { data, error } = await db
      .from("channel_sessions")
      .select("id,display_name,status,social_network,metadata")
      .eq("organization_id", auth.org.orgId)
      .eq("provider", SOCIAL_PROVIDER)
      .is("archived_at", null);
    if (error) throw error;
    return ok(
      {
        label: SOCIAL_LABEL,
        configured: !!row,
        webhook_ready: !!row?.webhook_id,
        webhook_url: row?.webhook_url ?? null,
        last_event_at: row?.last_event_at ?? null,
        last_test_at: row?.last_test_at ?? null,
        channels: data ?? [],
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Não foi possível consultar as conexões sociais.", 500, {
      requestId,
    });
  }
}

export async function POST(req: NextRequest) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channels_social" });
  if (!auth.ok) return auth.response;
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("invalid_request", "Confira os dados da conexão.", 422, { requestId });
  const org = auth.org.orgId;
  const db = createAdminClient();
  try {
    const action = parsed.data;
    let row = await connection(db, org);
    if (action.action === "save") {
      const me = await new SocialClient(action.api_key).identity();
      if (row && row.account_id !== me.account.id)
        return fail("invalid_request", "Esta empresa já está vinculada a outra subconta.", 409, {
          requestId,
        });
      const created = await db
        .from("social_connections")
        .upsert(
          { organization_id: org, account_id: me.account.id, credential: seal(action.api_key) },
          { onConflict: "organization_id", ignoreDuplicates: true },
        );
      if (created.error) throw new Error("social_credential_save_failed");
      const saved = await db
        .from("social_connections")
        .update({ credential: seal(action.api_key) })
        .eq("organization_id", org)
        .eq("account_id", me.account.id)
        .select("id")
        .maybeSingle();
      if (saved.error || !saved.data) throw new Error("social_credential_save_failed");
      row = await connection(db, org);
    }
    if (!row)
      return fail("invalid_request", "Cadastre a chave de subconta primeiro.", 422, { requestId });
    const client = new SocialClient(unseal(row.credential));
    let result: Record<string, unknown> = {};
    if (action.action === "webhook") {
      const base = new URL(env.NEXT_PUBLIC_APP_URL);
      if (base.protocol !== "https:" || base.hostname === "placeholder.invalid")
        return fail(
          "invalid_request",
          "O recebimento exige um endereço HTTPS público para esta instalação. Configure o endereço da aplicação antes de ativar.",
          422,
          { requestId },
        );
      const url = `${base.origin}/api/v1/webhooks/social/${row.webhook_token}`;
      const lease = randomUUID();
      const reserved = await db
        .from("social_connections")
        .update({
          webhook_setup_token: lease,
          webhook_setup_until: new Date(Date.now() + 120_000).toISOString(),
        })
        .eq("organization_id", org)
        .eq("id", row.id)
        .or(`webhook_setup_until.is.null,webhook_setup_until.lt.${new Date().toISOString()}`)
        .select("id")
        .maybeSingle();
      if (reserved.error) throw new Error("social_webhook_reservation_failed");
      if (!reserved.data)
        return fail(
          "invalid_request",
          "Configuração em andamento. Atualize a tela e tente novamente.",
          409,
          { requestId },
        );
      try {
        // Relê após reservar: outra aba pode ter acabado de registrar a assinatura.
        const current = await connection(db, org);
        if (!current) throw new Error("social_connection_missing");
        if (current.webhook_id) {
          await client.request(`/v1/webhooks/${encodeURIComponent(current.webhook_id)}`, "PATCH", {
            url,
            active: true,
          });
          const saved = await db
            .from("social_connections")
            .update({ webhook_url: url })
            .eq("organization_id", org)
            .eq("id", row.id)
            .eq("webhook_setup_token", lease);
          if (saved.error) throw new Error("social_webhook_save_failed");
        } else {
          const hook = await client.subscribe(url);
          const saved = await db
            .from("social_connections")
            .update({ webhook_id: hook.id, webhook_secret: seal(hook.secret), webhook_url: url })
            .eq("organization_id", org)
            .eq("id", row.id)
            .eq("webhook_setup_token", lease)
            .select("id")
            .maybeSingle();
          if (saved.error || !saved.data) {
            await client.request(`/v1/webhooks/${encodeURIComponent(hook.id)}`, "DELETE");
            throw new Error("social_webhook_save_failed");
          }
        }
      } finally {
        await db
          .from("social_connections")
          .update({ webhook_setup_token: null, webhook_setup_until: null })
          .eq("organization_id", org)
          .eq("id", row.id)
          .eq("webhook_setup_token", lease);
      }
      result = { webhook_url: url };
    } else if (action.action === "connect") {
      if (!row.webhook_id)
        return fail("invalid_request", "Ative o recebimento antes de conectar a conta.", 422, {
          requestId,
        });
      result = await client.connect(
        action.network,
        `${new URL(env.NEXT_PUBLIC_APP_URL).origin}/app/connections?aba=sociais`,
      );
    } else if (action.action === "test") {
      if (!row.webhook_id)
        return fail("invalid_request", "Ative o recebimento primeiro.", 422, { requestId });
      await client.request(`/v1/webhooks/${encodeURIComponent(row.webhook_id)}/test`, "POST");
      result = { requested: true };
    } else if (action.action === "disconnect") {
      const { data: channel } = await db
        .from("channel_sessions")
        .select("social_channel_id")
        .eq("organization_id", org)
        .eq("id", action.channel_session_id)
        .eq("provider", SOCIAL_PROVIDER)
        .eq("social_connection_id", row.id)
        .is("archived_at", null)
        .single();
      if (!channel?.social_channel_id)
        return fail("not_found", "Conexão não encontrada.", 404, { requestId });
      await client.request(
        `/v1/channels/${encodeURIComponent(channel.social_channel_id)}`,
        "DELETE",
      );
      await syncChannels(db, org);
    } else if (action.action === "recover") {
      const events = await client.recover(action.since, action.before);
      let recovered = 0;
      for (const event of [...events.data].reverse()) {
        if (event.expired || !event.data) continue;
        await processSocialEvent(db, org, event.id, event.event, event.data);
        recovered++;
      }
      result = { recovered, has_more: events.has_more, next_before: events.next_before };
    } else {
      await syncChannels(db, org);
    }
    await audit({
      action: "channel.connection_updated",
      actorUserId: auth.user.id,
      organizationId: org,
      resourceType: "social_connection",
      resourceId: row.id,
      requestId,
      metadata: { operation: action.action },
    });
    return ok(result, { requestId });
  } catch (error) {
    const message =
      error instanceof SocialApiError
        ? `O provedor recusou a operação (${error.code}). Confira a credencial, a conexão e tente novamente.`
        : "Não foi possível concluir. Use uma chave de subconta ativa e confira a configuração do servidor.";
    return fail("invalid_request", message, 422, { requestId });
  }
}
