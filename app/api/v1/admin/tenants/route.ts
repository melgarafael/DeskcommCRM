import { type NextRequest } from "next/server";
import { z } from "zod";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { isBillingEnabled } from "@/lib/asaas/config";
import { ensureAsaasCustomer } from "@/lib/asaas/customers";
import { createOrganizationSubscription } from "@/lib/asaas/subscriptions";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/resend";
import { marcaDaSaida } from "@/lib/branding/saida";
import { logger } from "@/lib/logger";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const querySchema = z.object({
  q: z.string().optional(),
  status: z.enum(["active", "suspended", "onboarding", "redacted"]).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

const createSchema = z.object({
  display_name: z.string().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  legal_name: z.string().min(2).max(255).optional(),
  cnpj: z.string().optional(),
  plan: z.enum(["standard", "pro", "enterprise"]).default("standard"),
  owner_email: z.string().email(),
  /**
   * Plano de billing REAL (billing_plans.id) — opcional e SEPARADO do `plan`
   * acima (rótulo livre, pré-existente, sem cobrança). Só tem efeito quando
   * BILLING_MODE=asaas: cria customer+assinatura Asaas para o tenant. Em
   * self-host (billing desligado) é ignorado silenciosamente — nenhum clone
   * quebra por mandar ou não mandar este campo.
   */
  plan_id: z.string().uuid().optional(),
});

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

interface CursorPayload {
  created_at: string;
  id: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    return JSON.parse(Buffer.from(cursor, "base64url").toString("utf-8")) as CursorPayload;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GET /api/v1/admin/tenants
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const parsed = querySchema.safeParse(
    Object.fromEntries(req.nextUrl.searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_error", "Invalid query params", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { q, status, cursor, limit } = parsed.data;
  const admin = createAdminClient();
  const cursorPayload = cursor ? decodeCursor(cursor) : null;

  let query = admin
    .from("organizations")
    .select(
      `
      id,
      slug,
      display_name,
      legal_name,
      cnpj,
      status,
      onboarded_at,
      suspended_at,
      created_at,
      user_count:user_organizations(count),
      conversations_count:conversations(count)
    `,
    )
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (status === "onboarding") {
    // Estado derivado: ativo no banco, onboarding ainda não concluído.
    query = query.eq("status", "active").is("onboarded_at", null);
  } else if (status) {
    query = query.eq("status", status);
  }

  if (q) {
    query = query.or(
      `display_name.ilike.%${q}%,slug::text.ilike.%${q}%,cnpj.ilike.%${q}%`,
    );
  }

  if (cursorPayload) {
    query = query.or(
      `created_at.lt.${cursorPayload.created_at},and(created_at.eq.${cursorPayload.created_at},id.lt.${cursorPayload.id})`,
    );
  }

  const { data, error } = await query;

  if (error) {
    return fail("internal_error", "Query failed", 500, {
      requestId,
      details: error.message,
    });
  }

  const rows = data ?? [];
  const has_more = rows.length > limit;
  const page = has_more ? rows.slice(0, limit) : rows;

  const lastRow = page.at(-1);
  const nextCursor =
    has_more && lastRow
      ? encodeCursor({
          created_at: (lastRow as { created_at: string }).created_at,
          id: lastRow.id,
        })
      : null;

  void audit({
    action: "platform_admin.tenants_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: {
      filters: { status: status ?? null, has_q: !!q },
      result_count: page.length,
    },
  });

  return ok(page, {
    requestId,
    meta: { has_more, cursor: nextCursor },
  });
}

// ---------------------------------------------------------------------------
// POST /api/v1/admin/tenants
// ---------------------------------------------------------------------------

export async function POST(req: NextRequest) {
  const requestId = randomUUID();

  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "Invalid JSON body", 400, { requestId });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Invalid request body", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { display_name, slug, legal_name, cnpj, plan, owner_email, plan_id } = parsed.data;
  const admin = createAdminClient();

  // Billing real exige CNPJ (a Asaas cadastra customer por CPF/CNPJ) — falha
  // ANTES de criar a org, não depois: criar o tenant e só então descobrir que
  // não dá para cobrar deixaria uma organização órfã de assinatura sem aviso
  // nenhum na tela de quem está cadastrando.
  if (plan_id && isBillingEnabled() && !cnpj) {
    return fail(
      "validation_error",
      "CNPJ é obrigatório para vincular um plano de billing",
      400,
      { requestId },
    );
  }

  const { data: org, error: insertError } = await admin
    .from("organizations")
    .insert({
      display_name,
      slug,
      legal_name: legal_name ?? null,
      cnpj: cnpj ?? null,
      // A check constraint de organizations.status não tem 'onboarding' — o
      // marcador de onboarding é onboarded_at null (mesmo modelo do signup).
      status: "active",
      settings: { plan },
      created_by: adminCtx.user.id,
    })
    .select("id, slug, display_name")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return fail("conflict", "Slug already exists", 409, { requestId });
    }
    return fail("internal_error", "Failed to create tenant", 500, {
      requestId,
      details: insertError.message,
    });
  }

  void audit({
    action: "tenant.created_by_platform_admin",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: org.id,
    resourceType: "organization",
    resourceId: org.id,
    requestId,
    metadata: {
      slug: org.slug,
      display_name: org.display_name,
      plan,
      owner_email_hash: owner_email
        ? Buffer.from(owner_email.trim().toLowerCase())
            .toString("hex")
            .slice(0, 12) + "..."
        : null,
    },
  });

  // ─── Convite do proprietário ────────────────────────────────────────────
  //
  // `owner_email` era coletado no formulário e só entrava no hash do audit —
  // nenhum convite saía, e o tenant nascia sem ninguém capaz de logar nele. A
  // plataforma (não um membro da org, que ainda não existe) assina o convite:
  // mesmos primitivos de app/api/v1/team/invite (signInviteToken +
  // buildInviteEmail + sendEmail), sem exigir um "convidador" já membro.
  let ownerInviteDispatched = false;
  let ownerInviteError: string | null = null;
  try {
    const exp = Math.floor(Date.now() / 1000) + INVITE_TTL_SECONDS;
    const token = signInviteToken({
      invite_id: randomUUID(),
      email: owner_email.trim().toLowerCase(),
      organization_id: org.id,
      role: "admin",
      exp,
    });
    const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;
    const marca = await marcaDaSaida(org.id);
    const { subject, html, text } = buildInviteEmail({
      inviterName: "Genesisia Contabilidade",
      orgName: org.display_name,
      acceptUrl,
      role: "admin",
      expiresAt: new Date(exp * 1000),
      marca,
    });
    const result = await sendEmail({
      to: owner_email,
      subject,
      html,
      text,
      fromName: marca.nome,
      tags: [
        { name: "kind", value: "tenant_owner_invite" },
        { name: "org", value: org.id },
      ],
    });
    ownerInviteDispatched = result.ok;
    ownerInviteError = result.ok ? null : (result.error ?? "unknown");
  } catch (err) {
    // Convite falho NUNCA desfaz o tenant já criado — falha aberta e
    // VISÍVEL (retorno + audit), não silenciosa. Um platform admin lendo a
    // resposta sabe que precisa reenviar o convite manualmente.
    ownerInviteError = (err as Error).message;
  }

  void audit({
    action: "member.invited",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: org.id,
    resourceType: "membership",
    resourceId: org.id,
    requestId,
    metadata: {
      email: owner_email,
      role: "admin",
      email_dispatched: ownerInviteDispatched,
      email_error: ownerInviteError,
      via: "tenant_creation",
    },
  });

  // ─── Assinatura de billing (só quando plan_id foi escolhido E a instância
  // roda BILLING_MODE=asaas — self-host nunca entra aqui) ──────────────────
  let billingError: string | null = null;
  if (plan_id && isBillingEnabled()) {
    try {
      const { data: planRow } = await admin
        .from("billing_plans")
        .select("id, price_cents, billing_interval")
        .eq("id", plan_id)
        .eq("is_active", true)
        .maybeSingle();

      if (!planRow) {
        billingError = "plano não encontrado ou inativo";
      } else {
        const asaasCustomerId = await ensureAsaasCustomer({
          organizationId: org.id,
          legalName: legal_name ?? display_name,
          email: owner_email,
          cnpj: cnpj!,
        });
        await createOrganizationSubscription({
          organizationId: org.id,
          planId: planRow.id,
          asaasCustomerId,
          priceCents: planRow.price_cents,
          billingInterval: planRow.billing_interval as "monthly" | "yearly",
        });
      }
    } catch (err) {
      // Mesmo raciocínio do convite: a org já existe e fica ATIVA mesmo se a
      // Asaas falhar agora — um platform admin lê `billing_error` na resposta
      // e tenta de novo pela tela de billing do tenant, sem tenant órfão.
      billingError = (err as Error).message;
      logger.error("[admin.tenants] falha ao criar assinatura Asaas", {
        request_id: requestId,
        organization_id: org.id,
        error: billingError,
      });
    }
  }

  return ok(
    {
      id: org.id,
      slug: org.slug,
      display_name: org.display_name,
      owner_invite_dispatched: ownerInviteDispatched,
      owner_invite_error: ownerInviteError,
      billing_error: billingError,
    },
    { status: 201, requestId },
  );
}
