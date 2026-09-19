import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import {
  SOCIAL_NETWORKS,
  SOCIAL_PROVIDER_LABEL,
  inboxSupported,
} from "@/lib/channels/social/catalog";
import { listSocialAccounts, socialRequest, SocialError } from "@/lib/channels/social/client";
import {
  readSocialIntegration,
  configureSocialIntegration,
  socialChannels,
  connectSocialInbox,
} from "@/lib/channels/social/store";

export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "no-store" };
const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("profiles"), api_key: z.string().min(8).max(500) }).strict(),
  z
    .object({
      action: z.literal("configure"),
      api_key: z.string().min(8).max(500),
      profile_id: z.string().regex(/^[a-f0-9]{24}$/),
    })
    .strict(),
  z
    .object({
      action: z.literal("authorize"),
      platform: z.string().refine((p) => SOCIAL_NETWORKS.some((n) => n.id === p)),
    })
    .strict(),
  z.object({ action: z.literal("inbox"), account_id: z.string().regex(/^[a-f0-9]{24}$/) }).strict(),
  z
    .object({ action: z.literal("health"), account_id: z.string().regex(/^[a-f0-9]{24}$/) })
    .strict(),
]);
function publicBase(): string {
  const url = new URL(env.NEXT_PUBLIC_APP_URL);
  if (url.protocol !== "https:" || url.hostname === "placeholder.invalid")
    throw new SocialError("Configure o endereço público da instalação.", 422);
  return url.origin;
}
function failure(error: unknown, requestId: string) {
  return fail(
    "social_unavailable",
    error instanceof SocialError
      ? error.message
      : "Não foi possível concluir a operação nas redes sociais. Tente novamente.",
    error instanceof SocialError ? error.status : 502,
    { requestId, headers },
  );
}
export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  try {
    const db = createAdminClient();
    const config = await readSocialIntegration(db, auth.org.orgId);
    const channels = await socialChannels(db, auth.org.orgId);
    const accounts = config ? await listSocialAccounts(config.key, config.profileId) : [];
    return ok(
      {
        label: SOCIAL_PROVIDER_LABEL,
        configured: !!config,
        profile_id: config?.profileId ?? null,
        networks: SOCIAL_NETWORKS,
        accounts: accounts
          .filter((a) => SOCIAL_NETWORKS.some((n) => n.id === a.platform))
          .map((a) => ({
            id: a._id,
            platform: a.platform,
            username: a.username ?? a.displayName ?? a._id,
            display_name: a.displayName,
            active: a.isActive,
            inbox_supported: inboxSupported(a.platform),
            channel: channels.find((c) => c.accountId === a._id) ?? null,
          })),
      },
      { requestId, headers },
    );
  } catch (error) {
    return failure(error, requestId);
  }
}
export async function POST(req: Request) {
  const requestId = randomUUID();
  const support = await requireSupportWrite();
  if (support) return support;
  const auth = await requireRole("admin", { requestId, resource: "social_connections" });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida())
    return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, {
      requestId,
      headers,
    });
  const parsed = inputSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_error", "Confira os dados da conexão.", 400, { requestId, headers });
  const limit = await checkRateLimit(`social-connect:${auth.org.orgId}`, 20, 60);
  if (!limit.allowed)
    return fail("rate_limited", "Aguarde um minuto antes de tentar novamente.", 429, {
      requestId,
      headers: { ...headers, "Retry-After": "60" },
    });
  const body = parsed.data;
  const db = createAdminClient();
  try {
    let result: unknown;
    if (body.action === "profiles") {
      const profiles = z
        .object({ profiles: z.array(z.object({ _id: z.string(), name: z.string() })) })
        .parse(await socialRequest(body.api_key, "profiles"));
      return ok(
        { profiles: profiles.profiles.map((p) => ({ id: p._id, name: p.name })) },
        { requestId, headers },
      );
    } else if (body.action === "configure") {
      await configureSocialIntegration(db, auth.org.orgId, body.api_key, body.profile_id);
      result = { configured: true };
    } else if (body.action === "inbox") {
      result = await connectSocialInbox(db, auth.org.orgId, body.account_id, publicBase());
    } else {
      const config = await readSocialIntegration(db, auth.org.orgId);
      if (!config) throw new SocialError("Configure a integração primeiro.", 422);
      if (body.action === "health") {
        const accounts = await listSocialAccounts(config.key, config.profileId);
        if (!accounts.some((a) => a._id === body.account_id))
          throw new SocialError("Conta não encontrada neste perfil.", 404);
        const health = z
          .object({
            status: z.string(),
            permissions: z
              .object({
                canPost: z.boolean().optional(),
                missingRequired: z.array(z.string()).optional(),
              })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .parse(await socialRequest(config.key, `accounts/${body.account_id}/health`));
        return ok(
          {
            status: health.status,
            can_post: health.permissions?.canPost ?? null,
            missing_permissions: health.permissions?.missingRequired ?? [],
          },
          { requestId, headers },
        );
      }
      const query = new URLSearchParams({
        profileId: config.profileId,
        redirect_url: `${publicBase()}/app/connections?aba=sociais`,
      });
      const connection = z
        .object({ authUrl: z.url() })
        .parse(await socialRequest(config.key, `connect/${body.platform}?${query}`));
      const url = new URL(connection.authUrl);
      if (url.protocol !== "https:" || url.username || url.password)
        throw new SocialError("Endereço de autorização inválido.");
      result = { auth_url: url.toString() };
    }
    void audit({
      action: "channel.social_configured",
      organizationId: auth.org.orgId,
      actorUserId: auth.user.id,
      resourceType: "social_connections",
      requestId,
      metadata: { operation: body.action },
    });
    return ok(result, { requestId, headers });
  } catch (error) {
    return failure(error, requestId);
  }
}
