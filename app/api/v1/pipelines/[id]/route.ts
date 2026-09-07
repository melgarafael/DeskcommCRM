import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH/DELETE /api/v1/pipelines/[id] — renomear, descrever, reordenar, eleger
 * padrão, arquivar e (só no caso limpo) excluir um funil.
 *
 * ⚠️ DELETE ARQUIVA POR PADRÃO. Três dependências cobram isso, e só uma delas o
 * banco defende sozinho: `crm_leads_pipeline_id_fkey` é `ON DELETE RESTRICT` (o
 * Postgres recusa funil com negócio), mas `webhook_sources.default_pipeline_id` é
 * `ON DELETE CASCADE` — apagar o funil apagaria a fonte de webhook do cliente EM
 * SILÊNCIO — e `automation_rules.actions` cita `pipeline_id` dentro de jsonb, sem
 * FK nenhuma. `?definitivo=1` só passa pelo caso honesto do "criei sem querer":
 * funil sem negócio, sem formulário e sem automação apontando para ele.
 *
 * Auth: sessão por cookie, papel manager+. `organization_id` sai do JWT — nunca
 * do body nem da URL. As regras vivem em `lib/pipelines/pipeline-editing.ts`
 * (puras, testadas); aqui só há transporte e a ORDEM das escritas, que é o que o
 * índice único de padrão cobra.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  podeExcluirDeVez,
  posicaoEntre,
  updatesDePadrao,
  validarArquivamento,
  validarNomeDeFunil,
  type FunilEditavel,
} from "@/lib/pipelines/pipeline-editing";
import { createClient } from "@/lib/supabase/server";

import { conflitoDoBanco, corpo, lerDependencias, lerFunis } from "../_funis";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

/**
 * `depois_de` é o vizinho DE CIMA (`null` = primeiro da lista), não um número de
 * posição: quem clica na seta sabe onde o funil vai parar, não qual fração de
 * `position` isso vira. Mandar o número da tela duplicaria a conta que
 * `posicaoEntre` já faz — e as duas divergiriam no primeiro ajuste.
 */
const bodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    description: z.string().max(280).nullable().optional(),
    is_default: z.boolean().optional(),
    depois_de: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nada para alterar." });

type PatchDoFunil = { name?: string; description?: string | null; position?: number; is_default?: boolean };

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { id: pipelineId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que mudar neste funil."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const pedido = parsed.data;

  const supabase = await createClient();

  let funis: FunilEditavel[];
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  // Funil de outra org morre AQUI, antes de qualquer escrita: `lerFunis` filtra
  // por `organization_id`, então ele simplesmente não está nesta lista — e a
  // resposta é a mesma de um funil inexistente (dizer "existe, mas não é seu" já
  // vaza a existência).
  const alvo = funis.find((f) => f.id === pipelineId);
  if (!alvo) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  // ⚠️ ARQUIVADO NÃO SE EDITA. `uniq_crm_pipelines_org_default` é PARCIAL
  // (`where is_archived = false`): marcar um funil arquivado como padrão passa
  // pelo índice, libera o padrão de verdade e deixa a organização com o padrão
  // numa linha que sumiu da lista. Alcançável sem má-fé: uma aba aberta antes de
  // o funil ser arquivado.
  if (alvo.is_archived) {
    return fail(
      "state_conflict",
      `O funil «${alvo.name}» foi arquivado e não está mais na sua lista. Recarregue a página.`,
      409,
      { requestId },
    );
  }

  if (pedido.name !== undefined) {
    const veredito = validarNomeDeFunil(pedido.name, funis, pipelineId);
    if (!veredito.ok) return fail("unprocessable_entity", veredito.erro, 422, { requestId });
  }

  // ⚠️ O PADRÃO SE MUDA, NÃO SE APAGA — mesma regra da marcação de ganho nas
  // etapas. Sem funil padrão, todo lead criado sem funil escolhido fica sem
  // destino; e o índice único não impede a organização de ficar com ZERO.
  if (pedido.is_default === false) {
    return fail(
      "unprocessable_entity",
      `«${alvo.name}» é o funil padrão e a organização precisa de um. Marque OUTRO funil como padrão — ` +
        `o padrão se muda, não se apaga.`,
      422,
      { requestId },
    );
  }

  const patchDoAlvo: PatchDoFunil = {};
  if (pedido.name !== undefined) patchDoAlvo.name = pedido.name.trim();
  if (pedido.description !== undefined) {
    patchDoAlvo.description = pedido.description?.trim() || null;
  }

  if (pedido.depois_de !== undefined) {
    // Só os ativos compõem a régua: arquivado não ocupa lugar na lista.
    const ativos = funis.filter((f) => !f.is_archived && f.id !== pipelineId);
    const i = pedido.depois_de === null ? -1 : ativos.findIndex((f) => f.id === pedido.depois_de);
    if (pedido.depois_de !== null && i < 0) {
      return fail(
        "unprocessable_entity",
        t("O funil que você escolheu como vizinho não está mais na lista. Recarregue a página."),
        422,
        { requestId },
      );
    }
    const posicao = posicaoEntre(ativos[i]?.position ?? null, ativos[i + 1]?.position ?? null);
    // `posicaoEntre` devolve NaN com vizinhos de MESMA posição (lista que precisa
    // de rebalanceamento). NaN vira `null` no JSON e a coluna é NOT NULL: seria um
    // 23502 cru. Recusar aqui é a diferença entre "tente de novo" e "null value in
    // column position violates not-null constraint".
    if (!Number.isFinite(posicao)) {
      return fail(
        "state_conflict",
        t("Os funis desta lista estão empatados na ordenação. Recarregue a página e mova o funil para outro lugar."),
        409,
        { requestId },
      );
    }
    patchDoAlvo.position = posicao;
  }

  // Eleger padrão pode exigir DOIS updates (liberar o antigo, ocupar o lugar);
  // nome, descrição e posição viajam junto com o update do alvo, nunca num terceiro.
  // O tipo é o mais LARGO dos dois de propósito: `UpdateDePadrao` (só `is_default`)
  // cabe aqui dentro, e declarar assim evita o cast que esconderia um erro real
  // se o formato do patch de padrão mudasse.
  const updates: Array<{ pipelineId: string; patch: PatchDoFunil }> =
    pedido.is_default === true ? updatesDePadrao(funis, pipelineId) : [];
  if (Object.keys(patchDoAlvo).length > 0) {
    const i = updates.findIndex((u) => u.pipelineId === pipelineId);
    if (i >= 0) updates[i] = { pipelineId, patch: { ...updates[i]!.patch, ...patchDoAlvo } };
    else updates.push({ pipelineId, patch: patchDoAlvo });
  }

  // ⚠️ EM SEQUÊNCIA, NA ORDEM QUE `updatesDePadrao` DEVOLVE.
  // `uniq_crm_pipelines_org_default` é imediato (não deferível): marcar o novo
  // antes de liberar o antigo é 23505 na cara do usuário. Disparar em paralelo
  // desfaz exatamente essa proteção.
  for (const u of updates) {
    const { error } = await supabase
      .from("crm_pipelines")
      .update(u.patch)
      .eq("id", u.pipelineId)
      .eq("organization_id", orgId);
    if (!error) continue;

    const nome = funis.find((f) => f.id === u.pipelineId)?.name ?? alvo.name;
    const conflito = conflitoDoBanco(error as { code?: string }, nome, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }

  if (updates.length > 0) {
    void audit({
      action: "pipeline.updated",
      actorUserId: authz.user.id,
      organizationId: orgId,
      resourceType: "crm_pipeline",
      resourceId: pipelineId,
      requestId,
      metadata: { pedido, updates },
    });
  }

  try {
    return ok(corpo(await lerFunis(supabase, orgId)), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipelines" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;

  const { id: pipelineId } = await ctx.params;
  const definitivo = req.nextUrl.searchParams.get("definitivo") === "1";

  const supabase = await createClient();

  let funis: FunilEditavel[];
  try {
    funis = await lerFunis(supabase, orgId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
  const alvo = funis.find((f) => f.id === pipelineId);
  if (!alvo) return fail("not_found", t("Funil não encontrado."), 404, { requestId });

  let deps;
  try {
    deps = await lerDependencias(supabase, orgId, pipelineId);
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }

  const veredito = definitivo
    ? podeExcluirDeVez(funis, pipelineId, deps)
    : validarArquivamento(funis, pipelineId, deps);
  if (!veredito.ok) {
    // A CONTAGEM VAI EM `details`, não só dentro da frase: a tela mostra "este
    // funil tem N negócios" sem precisar extrair o número da mensagem com regex —
    // segunda régua que quebraria na primeira vez que alguém melhorasse o texto.
    return fail("unprocessable_entity", veredito.erro, 422, {
      requestId,
      details: {
        negocios: deps.negocios,
        fontes_de_webhook: deps.fontesDeWebhook,
        automacoes: deps.regrasAtivas,
      },
    });
  }

  const { error } = definitivo
    ? await supabase.from("crm_pipelines").delete().eq("id", pipelineId).eq("organization_id", orgId)
    : await supabase
        .from("crm_pipelines")
        .update({ is_archived: true })
        .eq("id", pipelineId)
        .eq("organization_id", orgId);

  if (error) {
    const conflito = conflitoDoBanco(error as { code?: string }, alvo.name, requestId);
    if (conflito) return conflito;
    return fail("internal_error", error.message, 500, { requestId });
  }

  void audit({
    action: definitivo ? "pipeline.deleted" : "pipeline.archived",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "crm_pipeline",
    resourceId: pipelineId,
    requestId,
    metadata: { name: alvo.name, slug: alvo.slug, negocios: deps.negocios },
  });

  try {
    return ok(corpo(await lerFunis(supabase, orgId)), { requestId });
  } catch (err) {
    return fail("internal_error", (err as Error).message, 500, { requestId });
  }
}
