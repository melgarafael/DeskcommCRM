import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/skills/import
 *
 * Upload de pacote de skill instalável (.zip — Fase 2 do épico harness). Parseia
 * (Task 3, `parseSkillPackage` — erro de parse é erro de ENSINO, nunca throw) e importa
 * pro catálogo da org (Task 4, `importSkillPackage`): versão nova + assets no storage +
 * ponteiro movido.
 *
 * organization_id vem SEMPRE de requireRole — NUNCA do form (pacote adulterado não
 * consegue apontar pra outro tenant).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { parseSkillPackage } from "@/lib/ai/skills/package";
import { importSkillPackage } from "@/lib/ai/skills/install";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "ai_skills" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org } = authz;

  // Guard against large uploads before buffering into memory. `parseSkillPackage`'s
  // ≤5MB check is authoritative (defense in depth); this header check cheaply rejects
  // the obvious large-body case before `req.formData()` materializes it in RAM.
  const MAX_UPLOAD_BYTES = 6 * 1024 * 1024; // 6MB: teto do envelope multipart (5MB skill + overhead)
  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_UPLOAD_BYTES) {
    return fail("skill_upload_too_large", t("O arquivo enviado é grande demais (máx. 5 MB por skill)."), 413, { requestId });
  }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return fail("invalid_request", t("Falha ao processar multipart/form-data."), 400, { requestId });
  }

  const fileEntry = formData.get("file");
  if (!(fileEntry instanceof File)) {
    return fail("invalid_request", t("Campo 'file' ausente ou inválido."), 400, { requestId });
  }

  const zipBytes = new Uint8Array(await fileEntry.arrayBuffer());
  const parsed = parseSkillPackage(zipBytes);
  if (!parsed.ok) {
    return fail(parsed.error.code, parsed.error.message, 422, { requestId });
  }

  const admin = createAdminClient();
  const db = getSkillsPool();

  let result: { versionId: string; name: string };
  try {
    result = await importSkillPackage(
      { db, admin },
      { organizationId: org.orgId, pkg: parsed.pkg, createdBy: authUser.id },
    );
  } catch (err) {
    console.error("[skills-import] importSkillPackage falhou:", err);
    return fail("internal_error", "Erro ao importar o pacote de skill.", 500, { requestId });
  }

  await audit({
    action: "ai.skill_imported",
    actorUserId: authUser.id,
    organizationId: org.orgId,
    resourceType: "skill_versions",
    resourceId: result.versionId,
    requestId,
    metadata: { name: result.name },
  });

  return ok({ name: result.name, version_id: result.versionId }, { status: 201, requestId });
}
