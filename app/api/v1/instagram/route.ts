import { randomUUID } from "node:crypto";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { companyContext, companyLogo } from "@/lib/instagram/brand";
import { createSchema } from "@/lib/instagram/schema";
import { listItems } from "@/lib/instagram/store";
import { createImage, createCaption, research, StudioError } from "@/lib/instagram/ai";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const headers = { "Cache-Control": "no-store" };
export async function GET() {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId });
  if (!auth.ok) return auth.response;
  try {
    return ok(
      { items: await listItems(auth.org.orgId), can_create: auth.org.role !== "viewer" },
      { requestId, headers },
    );
  } catch {
    return fail(
      "instagram_unavailable",
      "Não foi possível carregar suas criações. Tente novamente.",
      503,
      { requestId, headers },
    );
  }
}
export async function POST(req: Request) {
  const requestId = randomUUID();
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const auth = await requireRole("agent", { requestId });
  if (!auth.ok) return auth.response;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Confira seu nicho, o pedido e o formato.", 400, {
      requestId,
    });
  const input = parsed.data;
  const org = auth.org.orgId;
  const db = getRequestPool();
  let inserted = false;
  try {
    const existing = await listItems(org, input.id);
    if (existing[0]) {
      if (JSON.stringify(createSchema.parse(existing[0].input)) !== JSON.stringify(input))
        return fail("idempotency_conflict", "Este pedido já existe com outro conteúdo.", 409, {
          requestId,
        });
      return ok(existing[0], { requestId, headers });
    }
    const limit = await checkRateLimit(`instagram:${org}`, 20, 86400);
    if (!limit.allowed)
      return fail(
        "rate_limited",
        "O limite de 20 pedidos por dia foi atingido. Suas criações continuam na biblioteca.",
        429,
        { requestId },
      );
    const result = await db.query(
      "insert into instagram_studio_items(id,organization_id,kind,status,input,caption) values($1,$2,$3,$4,$5::jsonb,$6) on conflict(id) do nothing returning id",
      [
        input.id,
        org,
        input.kind,
        input.kind === "reference" ? "ready" : "generating",
        JSON.stringify(input),
        input.kind === "post" ? input.caption : "",
      ],
    );
    if (!result.rowCount)
      return fail(
        "state_conflict",
        "Este pedido já está em andamento. Consulte a biblioteca.",
        409,
        { requestId },
      );
    inserted = true;
    await audit({
      action: "instagram.created",
      actorUserId: auth.user.id,
      organizationId: org,
      resourceType: "instagram_studio_item",
      resourceId: input.id,
      requestId,
      metadata: { kind: input.kind },
    });
    if (input.kind === "post") {
      const company = await companyContext(org);
      let logo;
      try {
        logo = input.use_logo ? await companyLogo(org, company) : null;
      } catch (error) {
        throw new StudioError(
          error instanceof Error ? error.message : "Não foi possível carregar o logo.",
          422,
        );
      }
      const caption = await createCaption(org, input, company);
      const image = await createImage(org, input, company, logo);
      const path = `${org}/instagram/${input.id}.png`;
      const uploaded = await createAdminClient()
        .storage.from("whatsapp-media")
        .upload(path, image, { contentType: "image/png", upsert: false });
      if (uploaded.error)
        throw new StudioError(
          "A imagem foi gerada, mas não pôde ser salva. Fale com a equipe antes de gerar novamente.",
        );
      await db.query(
        "update instagram_studio_items set status='ready',asset_path=$3,caption=$4,updated_at=now() where organization_id=$1 and id=$2",
        [org, input.id, path, caption],
      );
    } else if (input.kind === "research") {
      const result = await research(org, input);
      await db.query(
        "update instagram_studio_items set status='ready',answer=$3,sources=$4::jsonb,updated_at=now() where organization_id=$1 and id=$2",
        [org, input.id, result.answer, JSON.stringify(result.sources)],
      );
    }
    await audit({
      action: "instagram.completed",
      actorUserId: auth.user.id,
      organizationId: org,
      resourceType: "instagram_studio_item",
      resourceId: input.id,
      requestId,
    });
    return ok((await listItems(org, input.id))[0], { requestId, headers });
  } catch (error) {
    const message =
      error instanceof StudioError
        ? error.message
        : "Não foi possível concluir. Seu pedido foi preservado; confira a biblioteca antes de tentar novamente.";
    if (inserted) {
      await db
        .query(
          "update instagram_studio_items set status='failed',error=$3,updated_at=now() where organization_id=$1 and id=$2",
          [org, input.id, message],
        )
        .catch(() => undefined);
      await audit({
        action: "instagram.failed",
        actorUserId: auth.user.id,
        organizationId: org,
        resourceType: "instagram_studio_item",
        resourceId: input.id,
        requestId,
      });
    }
    return fail(
      "instagram_unavailable",
      message,
      error instanceof StudioError ? error.status : 503,
      { requestId, headers },
    );
  }
}
