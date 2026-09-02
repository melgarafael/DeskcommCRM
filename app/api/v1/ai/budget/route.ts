/**
 * GET   /api/v1/ai/budget — o estado do orçamento da org ativa (manager+).
 * PATCH /api/v1/ai/budget — muda teto, limiar e MODO (admin).
 *
 * `organization_id` vem do JWT via `requireRole` — nunca do body. O PATCH usa
 * service role e filtra por `orgId` explicitamente (doutrina).
 *
 * ═══ A ESCADA, E POR QUE ELA É VALIDADA NO SERVIDOR ═══
 *
 * `off → avisar → bloquear`, um degrau por vez. O salto `off → bloquear` é 422,
 * mesmo vindo de chamada direta de API: a fase de aviso existe para que ninguém
 * descubra a parada pelo cliente reclamando no WhatsApp, e uma regra que só vive
 * no componente React não é regra — é sugestão. Afrouxar (`→ off`,
 * `bloquear → avisar`) é sempre livre e imediato, nos dois sentidos da doutrina:
 * falhar fechado na AÇÃO, aberto na INFORMAÇÃO.
 *
 * Armar `bloquear` grava `enforcement_effective_at = now() + 72h` — a carência.
 * `confirmar_imediato: true` renuncia a ela por escolha explícita de quem arma.
 *
 * ═══ O PISO ═══
 *
 * Sair de `off` — para `avisar` OU para `bloquear` — exige teto ≥ US$ 1,00,
 * resolvido sobre o estado PÓS-escrita
 * (`tetoDepois = payload ?? atual`) — senão "armado sem valor útil" renasce pela
 * porta da frente: mudar só o modo hoje e derrubar o teto para 0 amanhã. O CHECK
 * `ai_budgets_bloquear_precisa_de_teto` é o backstop, não a régua: quem bate nele
 * recebe 23514 → 500 genérico, sem saber qual campo ofendeu.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { getBudgetStatus, type BudgetStatus } from "@/lib/ai/budget/check";
import {
  PISO_DE_TETO_CENTS,
  normalizarModoDeOrcamento,
  type ModoDeOrcamento,
} from "@/lib/agent-engine/edge/llm/orcamento";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** Horas de carência entre armar a parada e ela passar a valer. */
const CARENCIA_HORAS = 72;

/**
 * O piso escrito como o leitor brasileiro o lê. `toFixed(2)` devolveria
 * "US$ 1.00" — ponto decimal numa frase em português, na única linha que o
 * usuário recebe quando o salvamento é recusado. Mesmo idioma de `emDolares`
 * em `run-model-call.ts`: dólar porque `cost_cents` é USD, vírgula porque a
 * frase é pt-BR.
 */
const PISO_LEGIVEL = `US$ ${(PISO_DE_TETO_CENTS / 100).toLocaleString("pt-PT", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

/** A escada. Comparação por posição — nunca por igualdade de string espalhada. */
const DEGRAU: Record<ModoDeOrcamento, number> = { off: 0, avisar: 1, bloquear: 2 };

const patchSchema = z
  .object({
    monthly_limit_cents: z.number().int().min(0).optional(),
    // 50..99 casa o CHECK `ai_budgets_alarm_threshold_pct_check` do banco. O Zod
    // aceitava 1..100: 30 ou 100 passavam aqui, batiam no 23514 e viravam
    // "Erro ao atualizar orçamento." 500 — sem dizer qual campo ofendeu, e com o
    // rollback otimista do hook desfazendo a mudança na tela, o que se lê como
    // "o app engoliu meu clique". Não relaxo o CHECK: a régua mais estrita é a
    // certa; a errada era a visível.
    alarm_threshold_pct: z.number().int().min(50).max(99).optional(),
    enforcement_mode: z.enum(["off", "avisar", "bloquear"]).optional(),
    /** Renuncia à carência ao armar. Sozinho não é mutação — ver o refine. */
    confirmar_imediato: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.monthly_limit_cents !== undefined ||
      v.alarm_threshold_pct !== undefined ||
      v.enforcement_mode !== undefined,
    { message: "Informe ao menos um campo: teto, limiar ou modo." },
  );

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_budget" });
  if (!authz.ok) return authz.response;
  const { org: activeOrg } = authz;

  const status = await getBudgetStatus(activeOrg.orgId);
  return ok(status, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_budget" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", "JSON inválido.", 422, { requestId });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Payload inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();

  const { data: existing, error: readErr } = await admin
    .from("ai_budgets")
    .select("monthly_limit_cents, alarm_threshold_pct, enforcement_mode, enforcement_effective_at")
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (readErr) {
    logger.error("ai-budget: leitura do estado atual falhou", {
      organization_id: activeOrg.orgId,
      request_id: requestId,
      causa: readErr.message,
    });
    return fail("internal_error", "Erro ao ler o orçamento.", 500, { requestId });
  }

  const modoAntes = normalizarModoDeOrcamento(existing?.enforcement_mode ?? null);
  // Sem linha, o teto de ANTES é 0 ("sem teto") e não o `DEFAULT 5000` da
  // coluna: 5000 é o valor que ninguém escolheu, e tratá-lo como escolha aqui
  // recriaria, na porta de escrita, exatamente a confusão que a 0159 desfez.
  const tetoAntes = Number(existing?.monthly_limit_cents ?? 0);
  const limiarAntes = Number(existing?.alarm_threshold_pct ?? 80);

  const modoDepois = parsed.data.enforcement_mode ?? modoAntes;
  const tetoDepois = parsed.data.monthly_limit_cents ?? tetoAntes;
  const limiarDepois = parsed.data.alarm_threshold_pct ?? limiarAntes;

  const armando = modoDepois === "bloquear" && modoAntes !== "bloquear";

  if (armando && modoAntes === "off") {
    // ⚠️ A REGRA É DE ESTADO, NÃO DE TEMPO — e o texto já afirmou o contrário.
    // Ele dizia "deixe-a um tempo em Me avisar", mas o servidor só exige que o
    // modo atual não seja `off`: salvar "Me avisar", reabrir o diálogo e salvar
    // "Parar a IA" leva ~15 segundos, e com "Começar a valer agora" marcado a
    // parada é imediata. Rótulo visível é contrato; prometer uma janela que o
    // código não garante é a classe de defeito que esta entrega existe para
    // matar. Quem garante o tempo é a CARÊNCIA de 72h, e é dela que a frase fala.
    return fail(
      "invalid_state_transition",
      'Antes de fazer a IA parar no limite, salve "Me avisar" — assim o aviso já ' +
        "está de pé quando a parada começar a valer, 72 horas depois de você armá-la.",
      422,
      { requestId, details: { de: modoAntes, para: modoDepois, degrau_faltante: "avisar" } },
    );
  }

  // ⚠️ O PISO GUARDA `avisar` TAMBÉM, e não só `bloquear`. Quando ele guardava
  // só a parada, `avisar` com teto 0 era alcançável pela tela e pela API — e o
  // efeito não era inofensivo: a CTE `avisa` de `SQL_ORCAMENTO` dispara com
  // `gasto >= teto * limiar / 100`, que com teto 0 é `gasto >= 0`, SEMPRE
  // verdadeiro já na primeira chamada, e a CTE `retrata` exigia `gasto < 0` para
  // fechar. Aviso permanente e falso na Central, no caminho de primeira impressão
  // (organização nova cai em `monthly_limit_cents: 0`, o campo pré-preenche
  // "0.00", e o radio "Me avisar" nasce habilitado). O tell estava no próprio
  // título da opção: "Me avisar ao passar de 80% de US$ 0,00" — avisar de quê?
  // Quem quer acompanhar sem limite escolhe "Só acompanhar" (`off`), que é o
  // estado que existe exatamente para isso.
  if (modoDepois !== "off" && tetoDepois < PISO_DE_TETO_CENTS) {
    return fail(
      "unprocessable_entity",
      `Para avisar ou parar no limite, o limite precisa ser de pelo menos ${PISO_LEGIVEL} por mês. ` +
        'Se você só quer acompanhar o gasto sem limite, escolha "Só acompanhar".',
      422,
      {
        requestId,
        details: { piso_cents: PISO_DE_TETO_CENTS, teto_cents: tetoDepois, modo: modoDepois },
      },
    );
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (parsed.data.monthly_limit_cents !== undefined) {
    patch.monthly_limit_cents = parsed.data.monthly_limit_cents;
  }
  if (parsed.data.alarm_threshold_pct !== undefined) {
    patch.alarm_threshold_pct = parsed.data.alarm_threshold_pct;
  }
  if (parsed.data.enforcement_mode !== undefined) {
    patch.enforcement_mode = parsed.data.enforcement_mode;
  }
  // `enforcement_effective_at` só é escrito na TRANSIÇÃO para `bloquear`. Rearmar
  // devolve a carência inteira (afrouxa, direção certa); mexer no teto de quem já
  // está armado não a devolve — senão bastaria salvar o diálogo para adiar por
  // mais 72h uma parada que já vale.
  const efetivoEm = armando
    ? new Date(
        Date.now() + (parsed.data.confirmar_imediato ? 0 : CARENCIA_HORAS * 60 * 60 * 1000),
      ).toISOString()
    : null;
  const desarmando = modoAntes === "bloquear" && modoDepois !== "bloquear";
  if (armando) patch.enforcement_effective_at = efetivoEm;
  // ⚠️ DESARMAR ZERA A DATA. Sem esta linha, uma organização que armou (efetivo
  // em T) e voltou para `off`/`avisar` ficava com um `enforcement_effective_at`
  // NO PASSADO e o modo desarmado: a carência ficava PRÉ-GASTA, e qualquer
  // escritor que pusesse `enforcement_mode='bloquear'` sem tocar na data armaria
  // um bloqueio válido NO ATO, sem as 72h. O comentário da própria coluna diz
  // que `null` é o estado de repouso de uma linha desarmada — a partir do
  // primeiro desarme isso deixava de valer, e nada restaurava o invariante.
  if (desarmando) patch.enforcement_effective_at = null;

  if (existing) {
    const { error: updErr } = await admin
      .from("ai_budgets")
      .update(patch)
      .eq("organization_id", activeOrg.orgId);
    if (updErr) {
      logger.error("ai-budget: update falhou", {
        organization_id: activeOrg.orgId,
        request_id: requestId,
        causa: updErr.message,
      });
      return fail("internal_error", "Erro ao atualizar orçamento.", 500, { requestId });
    }
  } else {
    const { error: insErr } = await admin.from("ai_budgets").insert({
      organization_id: activeOrg.orgId,
      // Explícito, e nunca o `DEFAULT 5000` da coluna: a linha nasce aqui de uma
      // decisão humana, e "não disse teto" significa SEM teto, não US$ 50.
      monthly_limit_cents: tetoDepois,
      ...patch,
    });
    if (insErr) {
      logger.error("ai-budget: insert falhou", {
        organization_id: activeOrg.orgId,
        request_id: requestId,
        causa: insErr.message,
      });
      return fail("internal_error", "Erro ao criar orçamento.", 500, { requestId });
    }
  }

  void audit({
    // Uma mutação = uma linha. A transição para/de `bloquear` escolhe o código
    // (é a pergunta que alguém vai querer filtrar sozinha: "quem armou/desarmou
    // a parada?"); todo o resto cai em `limit_changed`, e o metadata carrega
    // antes/depois dos três campos em qualquer um dos casos.
    action: armando
      ? "ai.budget_enforcement_armed"
      : desarmando
        ? "ai.budget_enforcement_disarmed"
        : "ai.budget_limit_changed",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_budgets",
    resourceId: activeOrg.orgId,
    requestId,
    metadata: {
      enforcement_mode: { antes: modoAntes, depois: modoDepois },
      monthly_limit_cents: { antes: tetoAntes, depois: tetoDepois },
      alarm_threshold_pct: { antes: limiarAntes, depois: limiarDepois },
      ...(armando
        ? {
            enforcement_effective_at: efetivoEm,
            confirmar_imediato: parsed.data.confirmar_imediato === true,
          }
        : {}),
    },
  });

  const status = await getBudgetStatus(activeOrg.orgId);
  const retratados = await retratarAvisos({
    admin,
    orgId: activeOrg.orgId,
    requestId,
    afrouxou:
      DEGRAU[modoDepois] < DEGRAU[modoAntes] ||
      status.current_month_consumed_cents < limiarDeAlerta(status),
  });

  // Fechar aqui e devolver `blocked_now: true` faria a tela contradizer o clique
  // que o usuário acabou de dar.
  return ok(retratados ? { ...status, blocked_now: false } : status, { requestId });
}

/** O gasto a partir do qual o aviso abre. Sem teto ⇒ não há limiar a cruzar. */
function limiarDeAlerta(status: BudgetStatus): number {
  if (status.monthly_limit_cents <= 0) return Number.POSITIVE_INFINITY;
  return (status.monthly_limit_cents * status.alarm_threshold_pct) / 100;
}

/**
 * O LAÇO DE RETORNO (invariante 7) do lado da tela.
 *
 * O gate se retrata sozinho na chamada seguinte (a CTE `retrata` de
 * `SQL_ORCAMENTO`) — mas "a chamada seguinte" pode não existir justamente
 * quando ela mais importa: se a IA está parada, ninguém a chama, e o alerta
 * crítico ficaria aceso para sempre. Quem afrouxa pela tela fecha os itens na
 * hora, sem cron e sem esperar tráfego.
 *
 * Falhar aqui não desfaz o afrouxamento: o teto já mudou no banco, e devolver
 * erro por causa de um aviso não fechado faria a pessoa clicar de novo achando
 * que nada aconteceu.
 */
async function retratarAvisos(d: {
  admin: ReturnType<typeof createAdminClient>;
  orgId: string;
  requestId: string;
  afrouxou: boolean;
}): Promise<boolean> {
  if (!d.afrouxou) return false;
  const { data, error } = await d.admin
    .from("agent_inbox_items")
    .update({ status: "resolved" })
    .eq("organization_id", d.orgId)
    .in("kind", ["budget_exceeded", "budget_warning"])
    .eq("status", "open")
    .select("id");
  if (error) {
    logger.warn("ai-budget: avisos de orçamento não puderam ser retratados", {
      organization_id: d.orgId,
      request_id: d.requestId,
      causa: error.message,
    });
    return false;
  }
  return (data?.length ?? 0) > 0;
}
