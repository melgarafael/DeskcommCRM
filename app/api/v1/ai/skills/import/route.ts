import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/skills/import
 *
 * Upload de pacote de skill instalável (.zip — Fase 2 do épico harness). Parseia
 * (Task 3, `parseSkillPackage` — erro de parse é erro de ENSINO, nunca throw) e importa
 * pro catálogo da org (Task 4, `importSkillPackage`): versão nova + assets no storage +
 * ponteiro movido.
 *
 * Aceita sessão de navegador OU Bearer `dsk_…` (`config:write`, papel admin via `tokenRole`).
 * organization_id vem SEMPRE do portão (sessão ou linha do token) — NUNCA do form (pacote
 * adulterado não consegue apontar pra outro tenant). O storage leva o prefixo da
 * organização (`<org>/<skill>/<versão>/…`, em `importSkillPackage`). No token não há
 * pessoa: `createdBy` é null.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { lerCorpoComTeto } from "@/lib/api/corpo-com-teto";
import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";
import { getSkillsPool } from "@/lib/ai/skills/db";
import { parseSkillPackage } from "@/lib/ai/skills/package";
import { importSkillPackage } from "@/lib/ai/skills/install";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "ai_skills",
    role: "manager",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const orgId = authz.organizationId;
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;
  const teto = await tetoDeEscritaDoToken(authz, "ai_skills", requestId);
  if (teto) return teto;

  // `parseSkillPackage`'s ≤5MB check is authoritative (defense in depth); this
  // keeps the body itself under the multipart envelope, with or without Content-Length.
  const MAX_UPLOAD_BYTES = 6 * 1024 * 1024; // 6MB: teto do envelope multipart (5MB skill + overhead)
  const corpo = await lerCorpoComTeto(req, MAX_UPLOAD_BYTES, {
    requestId,
    idioma: authz.idioma,
    codigo: "skill_upload_too_large",
    acimaDoTeto: t("O arquivo enviado é grande demais (máx. 5 MB por skill)."),
  });
  if (!corpo.ok) return corpo.response;

  let formData: FormData;
  try {
    formData = await corpo.corpo.formData();
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
      { organizationId: orgId, pkg: parsed.pkg, createdBy: actorUserId },
    );
  } catch (err) {
    console.error("[skills-import] importSkillPackage falhou:", err);
    return fail("internal_error", "Erro ao importar o pacote de skill.", 500, { requestId });
  }

  await audit({
    action: "ai.skill_imported",
    actorUserId,
    actorApiTokenId: authz.apiTokenId ?? null,
    organizationId: orgId,
    resourceType: "skill_versions",
    resourceId: result.versionId,
    requestId,
    metadata: { name: result.name },
  });

  return ok({ name: result.name, version_id: result.versionId }, { status: 201, requestId });
}
