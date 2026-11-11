import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * Épico Operação Visível (F1) — memória geral da org (spec harness, migration
 * 0067): documento versionado (versões imutáveis + ponteiro, mesmo padrão de
 * `ai_agents`/`ai_agent_versions`) e entradas de aprendizado (manual/flywheel).
 *
 * GET: estado completo para a tela — documento ativo, histórico de versões e
 * entradas não-propostas. POST: publica conteúdo novo como versão e move o
 * ponteiro (o clique É o gate humano — mesmo padrão de publish de agente).
 *
 * Aceita sessão de navegador OU Bearer `dsk_…` com escopo `config:read`/`config:write`
 * e papel admin (`tokenRole`). A organização vem da linha do token, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { createAdminClient } from "@/lib/supabase/admin";
import { publicarMemoriaDaOrg } from "@/lib/ai/memoria-da-org";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const postSchema = z.object({ content: z.string().min(1).max(50_000) });

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "org_memory_get",
    role: "agent",
    scope: "config:read",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const teto = await tetoDeEscritaDoToken(authz, "org_memory", requestId);
  if (teto) return teto;

  const supabase = createAdminClient();

  const { data: pointer, error: pointerErr } = await supabase
    .from("org_memory_pointers")
    .select("version_id")
    .eq("organization_id", authz.organizationId)
    .maybeSingle();
  // #4171 — o ponteiro é a única fonte de "existe versão ativa". Engolir o erro
  // devolvia `document: null` e a tela dizia "Nenhuma versão publicada ainda"
  // para um banco que não respondeu. Mesmo desenho das leituras abaixo.
  if (pointerErr) {
    return fail("internal_error", t("Erro ao carregar a memória."), 500, { requestId });
  }

  let document: {
    version_id: string;
    version_number: number;
    content: string;
    created_at: string;
  } | null = null;

  if (pointer?.version_id) {
    const { data: ver, error: verErr } = await supabase
      .from("org_memory_versions")
      .select("id, version_number, content, created_at")
      .eq("id", pointer.version_id as string)
      .eq("organization_id", authz.organizationId)
      .maybeSingle();
    if (verErr) {
      return fail(
        "internal_error",
        t("Erro ao carregar a versão ativa da memória."),
        500,
        { requestId },
      );
    }
    if (ver) {
      document = {
        version_id: ver.id as string,
        version_number: ver.version_number as number,
        content: ver.content as string,
        created_at: ver.created_at as string,
      };
    }
  }

  const { data: versions, error: versionsErr } = await supabase
    .from("org_memory_versions")
    .select("id, version_number, created_at")
    .eq("organization_id", authz.organizationId)
    .order("version_number", { ascending: false });
  if (versionsErr) {
    return fail("internal_error", t("Erro ao carregar versões da memória."), 500, { requestId });
  }

  const { data: entries, error: entriesErr } = await supabase
    .from("org_memory_entries")
    .select("id, title, body, source, status, created_at, valid_until")
    .eq("organization_id", authz.organizationId)
    .neq("status", "proposed")
    .order("created_at", { ascending: false });
  if (entriesErr) {
    return fail("internal_error", t("Erro ao carregar entradas da memória."), 500, { requestId });
  }

  return ok({ document, versions: versions ?? [], entries: entries ?? [] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "org_memory_publish",
    role: "admin",
    scope: "config:write",
    tokenRole: "admin",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? IDIOMA_PADRAO);
  const actorUserId = authz.actor.type === "user" ? authz.actor.id : null;
  const teto = await tetoDeEscritaDoToken(authz, "org_memory", requestId);
  if (teto) return teto;

  const body = await req.json().catch(() => null);
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", t("content é obrigatório."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = createAdminClient();

  const pub = await publicarMemoriaDaOrg(supabase, authz.organizationId, actorUserId, parsed.data.content);
  if (!pub.ok) {
    return fail(
      "internal_error",
      pub.erro === "versao"
        ? t("Erro ao publicar versão da memória.")
        : t("Erro ao ativar a versão da memória."),
      500,
      { requestId },
    );
  }
  const ver = { id: pub.versionId, version_number: pub.versionNumber };

  await audit({
    action: "ai.org_memory_published",
    actorUserId,
    actorApiTokenId: authz.apiTokenId,
    organizationId: authz.organizationId,
    resourceType: "org_memory_versions",
    resourceId: ver.id as string,
    requestId,
    metadata: { version_number: ver.version_number },
  });

  return ok({ version_id: ver.id, version_number: ver.version_number }, { requestId });
}
