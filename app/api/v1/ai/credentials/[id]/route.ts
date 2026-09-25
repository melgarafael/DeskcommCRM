import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/ai/credentials/:id (admin) — rotaciona a chave NO LUGAR
 * DELETE /api/v1/ai/credentials/:id (admin)
 *
 * ─── Por que o PATCH existe ─────────────────────────────────────────────────
 *
 * A credencial é referenciada por `ai_agent_versions.credential_id` com FK
 * `ON DELETE RESTRICT`. Enquanto a única saída para trocar uma chave era
 * "excluir e recriar", o operador de um agente publicado ficava num beco: o
 * DELETE recusa, e a mensagem antiga mandava remover versões — o que apaga o
 * agente. O PATCH troca a chave da MESMA credencial (o id não muda), então o
 * vínculo das versões continua válido e o próximo turno já usa a chave nova.
 *
 * ─── E por que o DELETE fala de REPONTAR, e quando para de falar ────────────
 *
 * Quando a exclusão é bloqueada, a resposta conta quantas versões usam a chave
 * e quais agentes — e ensina a saída que EXISTE. As versões estão presas por
 * mais duas FKs (`ai_agent_runs.agent_version_id` RESTRICT e
 * `ai_reply_drafts.agent_version_id` NO ACTION); "remover as versões" era uma
 * instrução impossível de seguir que destruiria o agente se fosse seguida.
 *
 * Repontar a versão para outra credencial (o `AgentForm` já troca o
 * `credential_id`) só é possível enquanto a versão é `draft`: o trigger
 * `fn_ai_agent_version_content_immutable` recusa trocar `credential_id` de
 * versão publicada/superseded. Para quem só tem histórico na chave, ensinar
 * repontar é mandar fazer o impossível — e era o beco da #1142. Nesse caso a
 * frase diz que a exclusão está bloqueada enquanto o histórico existir e aponta
 * a saída real: o `PATCH` desta rota, que edita a credencial NO LUGAR (o id não
 * muda, os vínculos seguem válidos).
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import type { ProvedorComChave } from "@/lib/ai/pontos/provedores";
import { rotacionarCredencial } from "@/lib/ai/credenciais/guardar";
import { gravarConfigDoJev, lerConfigDoJev } from "@/lib/ai/decisao/config";
import { credencialEmUsoPeloJev, PROVEDOR_DO_JEV } from "@/lib/ai/decisao/credencial";
import { logger } from "@/lib/logger";
import {
  versoesCongeladas,
  versoesQueBloqueiam,
  type VersaoQueBloqueia,
  type VersaoVinculada,
} from "@/lib/ai/credenciais/uso";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const SAFE_COLUMNS =
  "id, organization_id, provider, label, api_key_last4, validated_at, validation_error, models_available, is_active, created_by, created_at, updated_at";

// O mesmo formato do POST: provider NÃO entra — trocar de provedor não é girar a
// chave, é outra credencial (a tela agrupa por provedor). Ao menos um campo.
const patchSchema = z
  .object({
    api_key: z.string().trim().min(8).max(2048).optional(),
    label: z.string().trim().min(1).max(80).optional(),
  })
  .refine((v) => v.api_key !== undefined || v.label !== undefined, {
    message: "Informe a chave nova ou o rótulo.",
  });

/** Quantos nomes cabem na frase antes de virar "e mais N". */
const LIMITE_DE_NOMES = 5;

function nomeDaVersao(v: VersaoQueBloqueia): string {
  if (!v.agentName) return `versão ${v.versionNumber ?? "sem número"}`;
  return v.versionNumber != null ? `${v.agentName} v${v.versionNumber}` : v.agentName;
}

/**
 * A frase da recusa. Diz ONDE está o uso (agente + versão) e qual é a saída
 * QUE EXISTE — não a que seria boa que existisse.
 *
 * Rascunho aceita repontar; versão congelada (publicada/superseded) não: o banco
 * recusa trocar a chave dela. Mandar repontar uma congelada é mandar fazer o
 * impossível — era o beco de quem só tinha histórico na chave. Para essas, a
 * saída é editar a credencial NO LUGAR (o `PATCH` desta rota): a chave nova ou o
 * rótulo entram na MESMA credencial, o vínculo das versões continua válido.
 */
function descreverBloqueio(versoes: VersaoQueBloqueia[]): string {
  const n = versoes.length;
  const nomes = versoes.slice(0, LIMITE_DE_NOMES).map(nomeDaVersao);
  const restantes = n - nomes.length;
  const lista = restantes > 0 ? `${nomes.join(", ")} e mais ${restantes}` : nomes.join(", ");
  const sujeito = n === 1 ? "1 versão de agente" : `${n} versões de agente`;
  const abertura = `Esta chave está em uso por ${sujeito} (${lista}).`;

  const congeladas = versoesCongeladas(versoes);

  if (congeladas.length === 0) {
    const acao =
      n === 1 ? "Aponte essa versão para outra chave" : "Aponte essas versões para outra chave";
    const dano =
      n === 1
        ? "apagar a versão destruiria o agente e o histórico dele"
        : "apagar as versões destruiria os agentes e o histórico deles";
    return `${abertura} ${acao} antes de excluir — ${dano}.`;
  }

  const quais = congeladas.slice(0, LIMITE_DE_NOMES).map(nomeDaVersao);
  const mais = congeladas.length - quais.length;
  const onde = mais > 0 ? `${quais.join(", ")} e mais ${mais}` : quais.join(", ");
  const quantas =
    congeladas.length === 1
      ? n === 1
        ? "Ela já saiu do rascunho"
        : "1 delas já saiu do rascunho"
      : `${congeladas.length} delas já saíram do rascunho`;
  const recorte = congeladas.length < n ? ` (${onde})` : "";

  return (
    `${abertura} ${quantas}${recorte}: versão fora de rascunho é congelada — o banco recusa ` +
    `até trocar a chave dela (trigger de imutabilidade), então não há como repontá-la nem ` +
    `apagá-la sem perder o histórico. Esta credencial não pode ser excluída enquanto esse ` +
    (congeladas.length < n ? "histórico existir. Repontar a versão em rascunho não desbloqueia a exclusão. " : "histórico existir. ") +
    `A saída é "Editar credencial": a chave nova (ou só o rótulo) entra na MESMA credencial, ` +
    `o vínculo das versões continua válido e o próximo atendimento já usa a chave nova. ` +
    `Se a chave vazou, revogue-a no painel do provedor.`
  );
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  let rawBody: unknown;
  try {
    rawBody = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }

  const parsed = patchSchema.safeParse(rawBody);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const input = parsed.data;

  const admin = createAdminClient();

  // A org vem do cookie/role (`requireRole`), nunca do body — e o filtro no
  // fetch confirma que o id pertence a ela antes de qualquer escrita.
  const { data: cred, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select("id, organization_id, provider, label, api_key_last4")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", "Erro ao consultar credential.", 500, { requestId });
  }
  if (!cred || cred.organization_id !== activeOrg.orgId) {
    return fail("not_found", t("Credential não encontrada."), 404, { requestId });
  }

  const resultado = await rotacionarCredencial({
    admin,
    orgId: activeOrg.orgId,
    userId: authUser.id,
    credentialId: id,
    provider: cred.provider as ProvedorComChave,
    ...(input.api_key !== undefined ? { apiKey: input.api_key } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    requestId,
  });

  if (!resultado.ok) {
    if (resultado.motivo === "label_em_uso") {
      return fail(
        "label_already_used",
        t("Já existe uma chave deste provedor com este nome. Dê outro nome a ela."),
        409,
        { requestId },
      );
    }
    if (resultado.motivo === "nao_encontrada") {
      return fail("not_found", t("Credential não encontrada."), 404, { requestId });
    }
    return fail("internal_error", "Erro ao atualizar credential.", 500, { requestId });
  }

  // Como no POST: a resposta sai da view segura, que nunca expõe campo cifrado.
  const { data: updated } = await admin
    .from("ai_provider_credentials_safe")
    .select(SAFE_COLUMNS)
    .eq("id", id)
    .single();

  return ok(updated, { requestId });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("admin", { requestId, resource: "ai_credentials" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user: authUser, org: activeOrg } = authz;

  const admin = createAdminClient();

  const { data: cred, error: fetchErr } = await admin
    .from("ai_provider_credentials")
    .select("id, organization_id, provider, label, api_key_last4")
    .eq("id", id)
    .maybeSingle();

  if (fetchErr) {
    return fail("internal_error", "Erro ao consultar credential.", 500, { requestId });
  }
  if (!cred || cred.organization_id !== activeOrg.orgId) {
    return fail("not_found", t("Credential não encontrada."), 404, { requestId });
  }

  // O que a FK `ON DELETE RESTRICT` enxerga: QUALQUER versão que aponte para a
  // credencial — rascunho, superseded, de agente arquivado. A régua antiga
  // contava só a publicada e deixava o operador com "Em uso por 0" numa chave
  // que o banco recusava excluir.
  const { data: linked, error: linkErr } = await admin
    .from("ai_agent_versions")
    .select(
      "id, credential_id, version_number, status, ai_agents!ai_agent_versions_agent_id_fkey!inner(id, name, archived_at, published_version_id)",
    )
    .eq("credential_id", id)
    .eq("organization_id", activeOrg.orgId);

  if (linkErr) {
    return fail("internal_error", "Erro ao verificar uso da credential.", 500, { requestId });
  }

  const bloqueiam = versoesQueBloqueiam((linked ?? []) as unknown as VersaoVinculada[])[id] ?? [];

  if (bloqueiam.length > 0) {
    return fail("credential_in_use", t(descreverBloqueio(bloqueiam)), 409, {
      requestId,
      details: {
        count: bloqueiam.length,
        // Quantas NÃO aceitam mais repontar (publicada/superseded): é o que
        // decide se a exclusão está travada pelo histórico ou se ainda dá para
        // repontar o rascunho.
        immutable_count: versoesCongeladas(bloqueiam).length,
        versions: bloqueiam.map((v) => ({
          version_id: v.versionId,
          version_number: v.versionNumber,
          status: v.status,
          agent_name: v.agentName,
        })),
      },
    });
  }

  const { error: delErr } = await admin
    .from("ai_provider_credentials")
    .delete()
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId);

  if (delErr) {
    if (delErr.code === "23503") {
      // Corrida: uma versão passou a usar a chave entre a checagem e o delete.
      // Não manda mais "remover versões" — repete o caminho certo.
      return fail(
        "credential_in_use",
        t(
          "Uma versão de agente passou a usar esta chave agora. Recarregue a página e tente de novo — se o uso for de propósito, a saída é Editar credencial, que mantém válidas as versões que já usam esta chave.",
        ),
        409,
        { requestId },
      );
    }
    return fail("internal_error", "Erro ao deletar credential.", 500, { requestId });
  }

  await audit({
    action: "ai.credential_deleted",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_provider_credential",
    resourceId: id,
    requestId,
    metadata: { provider: cred.provider, label: cred.label, last4: cred.api_key_last4 },
  });

  const jevDesligado =
    cred.provider === PROVEDOR_DO_JEV
      ? await desligarOJevSeFicouSemChave({
          admin,
          orgId: activeOrg.orgId,
          actorUserId: authUser.id,
          requestId,
        })
      : false;

  return ok({ id, deleted: true, jev_desligado: jevDesligado }, { requestId });
}

/**
 * A chave do Jev não trava a exclusão (nenhuma versão de agente aponta para
 * ela), mas sem chave apta o Jev não mede nada. Se a excluída era a última e ele
 * estava ligado, desliga aqui, com a própria linha de auditoria: o cartão não
 * fica dizendo "ligado" sem chave, e o clima volta para a IA de sempre. O aceite
 * de LGPD fica gravado, então religar com chave nova não pede de novo.
 *
 * Falha aqui não desfaz a exclusão, que já aconteceu. Ligado e sem chave, o Jev
 * não chama ninguém (`chaveDaOrganizacao` devolve null e o worker segue sem
 * ele); o que sobra é o cartão desatualizado, com rastro no log e
 * `jev_desligado: false` na resposta.
 */
async function desligarOJevSeFicouSemChave(p: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  actorUserId: string;
  requestId: string;
}): Promise<boolean> {
  const [orgRes, credsRes] = await Promise.all([
    p.admin.from("organizations").select("settings").eq("id", p.orgId).maybeSingle(),
    p.admin
      .from("ai_provider_credentials")
      .select("provider, is_active, validated_at, created_at")
      .eq("organization_id", p.orgId)
      .eq("provider", PROVEDOR_DO_JEV)
      .eq("is_active", true),
  ]);
  if (orgRes.error || credsRes.error) {
    logger.warn("jev: não deu para conferir se a chave excluída era a última", {
      requestId: p.requestId,
      organizationId: p.orgId,
    });
    return false;
  }
  if (!lerConfigDoJev(orgRes.data?.settings).ligado) return false;
  if (credencialEmUsoPeloJev(credsRes.data ?? []) !== null) return false;

  const gravado = await gravarConfigDoJev({
    admin: p.admin,
    orgId: p.orgId,
    actorUserId: p.actorUserId,
    mudanca: { ligado: false },
  });
  if (!gravado.ok) {
    logger.warn("jev: a última chave foi excluída e o interruptor não foi desligado", {
      requestId: p.requestId,
      organizationId: p.orgId,
      motivo: gravado.motivo,
    });
    return false;
  }

  await audit({
    action: "ai.jev.desligado",
    organizationId: p.orgId,
    actorUserId: p.actorUserId,
    resourceType: "organization",
    resourceId: p.orgId,
    requestId: p.requestId,
    metadata: { modo: gravado.config.modo, motivo: "chave_excluida" },
  });
  return true;
}
