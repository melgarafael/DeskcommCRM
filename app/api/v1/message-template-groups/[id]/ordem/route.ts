import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/message-template-groups/[id]/ordem — a REORDENAÇÃO dos grupos
 * (#3245): põe o grupo `id` logo DEPOIS do vizinho que a tela manda.
 *
 * O contrato é o MESMO da resposta rápida (`[id]/ordem` da #3244) e da etapa do
 * funil: o corpo carrega `{ depois_de: <id> | null }` — o VIZINHO, não o número.
 * `null` é a primeira posição. Quem arrasta (ou clica na seta) sabe em que grupo
 * soltou; a fração de `ordem` que isso vira é conta do servidor
 * (`lib/templates/ordem.ts`), para as duas contas não divergirem no primeiro
 * ajuste.
 *
 * A posse é simples aqui: grupo é estrutura da organização e esta rota já exige
 * `manager+`. O `depois_de` tem de estar na MESMA lista visível — um id de fora
 * daria ao grupo uma posição calculada contra vizinhas que quem pediu não
 * enxerga.
 *
 * Quando a média não existe (empate entre as vizinhas, ou precisão do `double`
 * esgotada), a lista visível inteira é renumerada com passos largos — gravar
 * `NaN` ordenaria o grupo como "sempre no fim" e o movimento não teria efeito.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { moverGrupoSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { ordemDaRenumeracao, posicaoEntre } from "@/lib/templates/ordem";

export const dynamic = "force-dynamic";
const COLS = "id, organization_id, name, ordem, created_at, updated_at";

interface RouteParams {
  params: Promise<{ id: string }>;
}

interface Linha {
  id: string;
  ordem: number;
}

export async function PUT(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const parsed = moverGrupoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { depois_de } = parsed.data;

  const supabase = await createClient();
  const { data: lista, error: erroLista } = await supabase
    .from("message_template_groups")
    .select("id, ordem")
    .eq("organization_id", org.orgId)
    .order("ordem", { ascending: true })
    .order("name", { ascending: true })
    .order("id", { ascending: true });
  if (erroLista) {
    logger.error("[message-template-groups/ordem] falha ao listar", {
      detalhe: erroLista.message,
      requestId,
    });
    return fail("internal_error", "Erro ao reordenar o grupo.", 500, { requestId });
  }
  const atual = (lista ?? []) as Linha[];

  if (!atual.some((linha) => linha.id === id)) {
    return fail("not_found", t("Grupo não encontrado."), 404, { requestId });
  }
  if (depois_de !== null && !atual.some((linha) => linha.id === depois_de)) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: { depois_de: [t("Grupo que não pertence a esta organização.")] },
    });
  }

  // As vizinhas são contadas SEM o grupo arrastado: se ele mesmo se contasse,
  // soltar sobre si deslocaria o índice em um.
  const semAlvo = atual.filter((linha) => linha.id !== id);
  let anterior: number | null;
  let proxima: number | null;
  let indice: number;
  if (depois_de === null) {
    anterior = null;
    proxima = semAlvo[0]?.ordem ?? null;
    indice = 0;
  } else {
    const i = semAlvo.findIndex((linha) => linha.id === depois_de);
    anterior = semAlvo[i]!.ordem;
    proxima = semAlvo[i + 1]?.ordem ?? null;
    indice = i + 1;
  }

  const nova = posicaoEntre(anterior, proxima);

  if (nova !== null) {
    const { data, error } = await supabase
      .from("message_template_groups")
      .update({ ordem: nova })
      .eq("id", id)
      .eq("organization_id", org.orgId)
      .select(COLS)
      .maybeSingle();
    if (error || !data) {
      logger.error("[message-template-groups/ordem] falha ao gravar a ordem", {
        detalhe: error?.message,
        requestId,
      });
      return fail("internal_error", "Erro ao reordenar o grupo.", 500, { requestId });
    }
    return finalizar(data, false);
  }

  // Sem posição representável: renumera a lista visível na ordem pedida. Aqui
  // não há a conferência de posse da resposta rápida — grupo é da organização e
  // o papel já é manager+.
  const ids = semAlvo.map((linha) => linha.id);
  ids.splice(indice, 0, id);
  let atualizado: Record<string, unknown> | null = null;
  for (let i = 0; i < ids.length; i++) {
    const { data, error } = await supabase
      .from("message_template_groups")
      .update({ ordem: ordemDaRenumeracao(i) })
      .eq("id", ids[i]!)
      .eq("organization_id", org.orgId)
      .select(COLS)
      .maybeSingle();
    if (error || !data) {
      logger.error("[message-template-groups/ordem] falha ao renumerar", {
        detalhe: error?.message,
        requestId,
      });
      return fail("internal_error", "Erro ao reordenar o grupo.", 500, { requestId });
    }
    if (ids[i] === id) atualizado = data as Record<string, unknown>;
  }
  if (!atualizado) return fail("not_found", t("Grupo não encontrado."), 404, { requestId });
  return finalizar(atualizado, true);

  /** Registra o efeito e devolve o grupo já na posição final. */
  function finalizar(grupo: Record<string, unknown>, renumerada: boolean): Response {
    void audit({
      action: "template_group.reordered",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "message_template_group",
      resourceId: id,
      requestId,
      metadata: { depois_de, ordem: grupo.ordem, renumerada },
    });
    return ok(grupo, { requestId });
  }
}
