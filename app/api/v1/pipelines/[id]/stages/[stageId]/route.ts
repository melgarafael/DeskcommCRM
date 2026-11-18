import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH/DELETE /api/v1/pipelines/[id]/stages/[stageId] — renomear, marcar
 * ganho/perda, reordenar e arquivar uma etapa.
 *
 * ⚠️ DELETE ARQUIVA, NÃO APAGA. `crm_leads_stage_id_fkey` é `ON DELETE RESTRICT`:
 * etapa com negócio não pode ser apagada — e não deveria mesmo, porque o
 * histórico dos negócios aponta para ela. Por isso a operação é arquivar, e por
 * isso arquivar exige destino para os negócios (`?destino=<id>`).
 *
 * ⚠️ AQUI SÓ HÁ TRANSPORTE. As regras e a ORDEM das escritas (que é o que os
 * índices únicos imediatos cobram) vivem em `lib/leads/stage-operations.ts`,
 * compartilhadas com o agente de IA — BRIEFING §3, Decisão 4.
 *
 * Auth: sessão por cookie, papel manager+. `organization_id` sai do JWT — nunca
 * do body nem da URL.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { respostaDeRecusa } from "@/lib/api/recusa";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { arquivarEtapa, atualizarEtapa } from "@/lib/leads/stage-operations";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; stageId: string }>;
}

/**
 * `depois_de` é o vizinho da ESQUERDA (`null` = primeira coluna), não um número
 * de posição: quem arrasta a coluna sabe onde ela caiu, não qual fração de
 * `position` isso vira. Mandar o número da tela duplicaria a conta que
 * `posicaoEntre` já faz — e as duas divergiriam no primeiro ajuste.
 */
const bodySchema = z
  .object({
    name: z.string().min(1).max(80).optional(),
    is_won: z.boolean().optional(),
    is_lost: z.boolean().optional(),
    depois_de: z.string().min(1).nullable().optional(),
    /**
     * Probabilidade de ganho da etapa, 0–100 (migration 0426). `null` limpa a
     * calibração — e a previsão passa a reportar a etapa no balde "sem
     * probabilidade". O CHECK do banco é a rede de segurança; recusar aqui é
     * para a mensagem sair em português, antes de tocar no banco.
     */
    win_probability: z.number().int().min(0).max(100).nullable().optional(),
    /** Negócio que entra nesta etapa abre um aviso na Central (migration 0440). */
    avisar_na_central: z.boolean().optional(),
    /**
     * Janela de "esfriando" da etapa, em HORAS — a coluna
     * `crm_stages.expected_duration_hours`, que o radar já lê
     * (`resolveStageWindow`). `null` limpa e a etapa volta ao padrão de
     * 24 h/72 h.
     *
     * 1 a 8760 inteiro (uma hora a um ano). A issue propõe um migration com
     * `CHECK (between 1 and 8760)`, e ela é a parte 2 do escopo: a coluna hoje
     * é `numeric` sem CHECK, então este Zod é a rede de segurança — recusar
     * aqui é mandar a frase em português antes de tocar no banco.
     */
    expected_duration_hours: z.number().int().min(1).max(8760).nullable().optional(),
    /**
     * A cor da etapa, `#rrggbb` (`crm_stages.color`), ou `null` para voltar ao
     * padrão de hoje. O CHECK `crm_stages_color_format` já recusa outro formato,
     * mas com 23514 cru: aqui a recusa vira frase em português antes do banco.
     * Item 2 da #4802 — a escrita que faltava para o campo que o Kanban pinta.
     */
    color: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "A cor da etapa é um hex de seis dígitos, como #0091ff.")
      .nullable()
      .optional(),
    /**
     * O CRITÉRIO da etapa (`crm_stages.description`) — quando um negócio entra
     * nela, em texto livre. `null` limpa e a etapa volta a "sem critério" na
     * leitura do agente.
     *
     * ⚠️ SEM `.max()` AQUI, e é de propósito: o teto e o `trim` vivem em
     * `validarDescricaoDeEtapa`/`normalizarDescricaoDeEtapa`
     * (`lib/leads/stage-editing.ts`), a MESMA função que a tela e o MCP usam. Um
     * `.max(500)` no Zod contaria ANTES do `trim`, então 500 caracteres com um
     * espaço na ponta passariam na tela (que recorta) e tomariam 422 aqui — duas
     * réguas para a mesma frase.
     */
    description: z.string().nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: "Nada para alterar." });

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const { id: pipelineId, stageId } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", t("Corpo não é JSON válido."), 400, { requestId });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", t("Não entendi o que mudar nesta etapa."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supabase = await createClient();
  try {
    const { funil } = await atualizarEtapa(
      {
        supabase,
        organizationId: authz.org.orgId,
        actor: { type: "user", id: authz.user.id, role: authz.org.role },
        requestId,
      },
      { pipelineId, stageId, pedido: parsed.data },
    );
    return ok(funil, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}

export async function DELETE(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_stages" });
  if (!authz.ok) return authz.response;

  const { id: pipelineId, stageId } = await ctx.params;
  const destinoId = req.nextUrl.searchParams.get("destino");

  const supabase = await createClient();
  try {
    const { funil } = await arquivarEtapa(
      {
        supabase,
        organizationId: authz.org.orgId,
        actor: { type: "user", id: authz.user.id, role: authz.org.role },
        requestId,
      },
      { pipelineId, stageId, destinoId },
    );
    return ok(funil, { requestId });
  } catch (err) {
    return respostaDeRecusa(err, requestId);
  }
}
