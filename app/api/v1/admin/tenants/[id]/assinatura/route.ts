/**
 * /api/v1/admin/tenants/[id]/assinatura — o dono da instalação decide se esta
 * empresa paga, e por qual plano (spec da cobrança do revendedor §7g).
 *
 *  - POST {plano_id}: empresa sem linha (isenta) passa a pagar → linha `trial`
 *    com os dias do plano. Linha existente → 409 `state_conflict`.
 *  - PATCH {plano_id}: troca de plano pelas regras de §7e. Nesta versão (PR 2)
 *    nenhuma assinatura tem provedor, e a única troca possível é a do TESTE
 *    GRÁTIS, que vale na hora (D-13). Teste vencido sem pagamento, ou estado
 *    em dívida → 409 `pagamento_pendente`. Linha com provedor → 409 e nada
 *    muda: a troca agendada para a virada paga (`trocarPlano`) chega com o provedor.
 *  - DELETE: torna isenta. Linha SEM provedor → apagada (o filtro está no
 *    próprio DELETE: um checkout concorrente não é apagado por baixo). Linha
 *    COM provedor → 409: sem `lerSituacao`, que nasce com o provedor, não há
 *    como saber se ele ainda cobra, e apagar deixaria uma cobrança viva sem
 *    dono aqui. A suspensão por cobrança sai junto, por `fn_reativar_organizacao`.
 *
 * Nenhuma grava `vencida_desde`, e só o POST grava `estado`/`trial_ate` (no
 * nascimento): quem os escreve depois é `sincronizar` e a régua (§3.2).
 * Todas: escrita de platform admin, 404 com a chave desligada, audit;
 * `organization_id` só do PATH.
 */
import { type NextRequest, type NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok, type ApiError } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { lerOrgDoTenant, lerPlano, reativarSeSuspensaPorCobranca } from "@/lib/cobranca/dono";
import { excedenteDoPlano, lerUsoDaOrganizacao } from "@/lib/cobranca/uso";
import type { EstadoDaAssinatura } from "@/lib/cobranca/vocabulario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.strictObject({ plano_id: z.string().uuid() });
const DIA_MS = 86_400_000;
const NASCE_EM: EstadoDaAssinatura = "trial";
const EM_DIVIDA: readonly EstadoDaAssinatura[] = ["em_atraso", "cancelada"];
const COLUNAS = "organization_id, plano_id, plano_agendado_id, estado, trial_ate, provedor, prazo_extra_ate";

interface AssinaturaLida {
  organization_id: string;
  plano_id: string;
  estado: EstadoDaAssinatura;
  trial_ate: string | null;
  provedor: string | null;
}
type Rota = { params: Promise<{ id: string }> };
type Aberta = { admin: SupabaseClient; ator: string; tenantId: string; requestId: string };

/**
 * O portão das três: acompanhamento, escrita de platform admin, chave, id.
 * Mora NESTE arquivo para a cerca `admin-escrita-exige-scope-full` ver a chamada.
 */
async function abrir({ params }: Rota): Promise<Aberta | { resposta: NextResponse<ApiError> }> {
  const { id: tenantId } = await params;
  const supportDenied = await requireSupportWrite(tenantId);
  if (supportDenied) return { resposta: supportDenied };
  const requestId = randomUUID();
  let adminCtx: PlatformAdminContext;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return { resposta: falhaDaEscritaDePlatformAdmin(err, requestId) };
  }
  const admin = createAdminClient();
  if (!(await moduloLigado(admin, "cobranca")) || !z.string().uuid().safeParse(tenantId).success) {
    return { resposta: fail("not_found", "Not found", 404, { requestId }) };
  }
  return { admin, ator: adminCtx.user.id, tenantId, requestId };
}

function auditar(a: Aberta, action: "cobranca.plano_trocado" | "cobranca.isencao_definida", metadata: Record<string, unknown>) {
  void audit({
    action,
    actorUserId: a.ator,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: a.tenantId,
    resourceType: "cobranca_assinatura",
    resourceId: a.tenantId,
    requestId: a.requestId,
    metadata,
  });
}

export async function POST(req: NextRequest, rota: Rota) {
  const a = await abrir(rota);
  if ("resposta" in a) return a.resposta;
  const { admin, tenantId, requestId } = a;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Informe o plano", 400, { requestId, details: corpo.error.flatten() });
  }
  const org = await lerOrgDoTenant(admin, tenantId);
  if (org === "erro") return fail("internal_error", "Não foi possível ler a empresa", 500, { requestId });
  if (!org) return fail("not_found", "Tenant not found", 404, { requestId });
  const plano = await lerPlano(admin, corpo.data.plano_id);
  if (plano === "erro") return fail("internal_error", "Não foi possível ler o plano", 500, { requestId });
  if (!plano || plano.arquivado_em !== null) {
    return fail("plano_invalido", "Plano não encontrado ou arquivado.", 422, { requestId });
  }

  const { data: linha, error } = await admin
    .from("cobranca_assinaturas")
    .insert({
      organization_id: tenantId,
      plano_id: plano.id,
      estado: NASCE_EM,
      trial_ate: new Date(Date.now() + plano.trial_dias * DIA_MS).toISOString(),
    })
    .select(COLUNAS)
    .single();
  if (error?.code === "23505") {
    return fail("state_conflict", "Esta empresa já tem assinatura. Use Trocar plano.", 409, { requestId });
  }
  if (error || !linha) return fail("internal_error", "Não foi possível atribuir o plano", 500, { requestId });

  auditar(a, "cobranca.plano_trocado", { de: null, para: plano.id, quando: "atribuido" });
  return ok(linha, { status: 201, requestId });
}

export async function PATCH(req: NextRequest, rota: Rota) {
  const a = await abrir(rota);
  if ("resposta" in a) return a.resposta;
  const { admin, tenantId, requestId } = a;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Informe o plano", 400, { requestId, details: corpo.error.flatten() });
  }
  const { data: lida, error: erroDeLeitura } = await admin
    .from("cobranca_assinaturas")
    .select(COLUNAS)
    .eq("organization_id", tenantId)
    .maybeSingle();
  if (erroDeLeitura) return fail("internal_error", "Não foi possível ler a assinatura", 500, { requestId });
  const atual = lida as AssinaturaLida | null;
  if (!atual) {
    return fail("not_found", "Esta empresa não tem assinatura (é isenta). Use Atribuir plano.", 404, { requestId });
  }
  if (atual.plano_id === corpo.data.plano_id) return ok({ changed: false, plano_id: atual.plano_id }, { requestId });
  if (EM_DIVIDA.includes(atual.estado)) {
    return fail("pagamento_pendente", "Regularize o pagamento antes de trocar de plano.", 409, { requestId });
  }
  if (atual.provedor !== null) {
    return fail(
      "state_conflict",
      "Esta assinatura já é cobrada pelo provedor; a troca para a próxima cobrança chega numa próxima versão.",
      409,
      { requestId },
    );
  }
  const emTeste = atual.trial_ate !== null && Date.parse(atual.trial_ate) > Date.now();
  if (!emTeste) {
    return fail(
      "pagamento_pendente",
      "O teste grátis acabou e não há pagamento. A troca de plano vale depois da assinatura.",
      409,
      { requestId },
    );
  }

  const [novo, antigo] = await Promise.all([lerPlano(admin, corpo.data.plano_id), lerPlano(admin, atual.plano_id)]);
  if (novo === "erro" || antigo === "erro") return fail("internal_error", "Não foi possível ler o plano", 500, { requestId });
  if (!novo || novo.arquivado_em !== null || !antigo || novo.intervalo !== antigo.intervalo) {
    return fail("plano_invalido", "Escolha um plano ativo com o mesmo intervalo de cobrança.", 422, { requestId });
  }

  // D-4: trocar para um plano menor que o uso é recusado com a lista do que remover.
  const uso = await lerUsoDaOrganizacao(admin, tenantId);
  if (!uso) return fail("internal_error", "Não foi possível medir o uso da empresa", 500, { requestId });
  const excedente = excedenteDoPlano(uso, novo);
  if (Object.keys(excedente).length > 0) {
    return fail("plan_limit_reached", "O uso atual não cabe no plano escolhido.", 409, { requestId, details: { excedente } });
  }

  // Compare-and-set: só troca se o plano e a ausência de provedor são os que foram lidos.
  const { data: trocada, error } = await admin
    .from("cobranca_assinaturas")
    .update({ plano_id: novo.id, plano_agendado_id: null, updated_at: new Date().toISOString() })
    .eq("organization_id", tenantId)
    .eq("plano_id", atual.plano_id)
    .is("provedor", null)
    .select("organization_id, plano_id")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível trocar o plano", 500, { requestId });
  if (!trocada) {
    return fail("state_conflict", "A assinatura mudou enquanto você trocava o plano. Recarregue e tente de novo.", 409, { requestId });
  }

  auditar(a, "cobranca.plano_trocado", { de: atual.plano_id, para: novo.id, quando: "imediato" });
  return ok({ changed: true, plano_id: novo.id }, { requestId });
}

export async function DELETE(_req: NextRequest, rota: Rota) {
  const a = await abrir(rota);
  if ("resposta" in a) return a.resposta;
  const { admin, ator, tenantId, requestId } = a;

  const org = await lerOrgDoTenant(admin, tenantId);
  if (org === "erro") return fail("internal_error", "Não foi possível ler a empresa", 500, { requestId });
  if (!org) return fail("not_found", "Tenant not found", 404, { requestId });

  const { data: apagada, error } = await admin
    .from("cobranca_assinaturas")
    .delete()
    .eq("organization_id", tenantId)
    .is("provedor", null)
    .select("plano_id")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível tornar a empresa isenta", 500, { requestId });
  if (!apagada) {
    const { data: resta, error: erroDaSobra } = await admin
      .from("cobranca_assinaturas")
      .select("provedor")
      .eq("organization_id", tenantId)
      .maybeSingle();
    if (erroDaSobra) return fail("internal_error", "Não foi possível ler a assinatura", 500, { requestId });
    if (resta) {
      return fail(
        "state_conflict",
        "Esta assinatura tem cobrança no provedor de pagamento. Isentar essa empresa chega numa próxima versão; até lá, cancele no painel do provedor.",
        409,
        { requestId },
      );
    }
  }

  // Roda mesmo sem linha: cura a empresa que ficou suspensa por cobrança quando
  // uma tentativa anterior apagou a linha e caiu antes de reativar.
  const reativacao = await reativarSeSuspensaPorCobranca(admin, org, ator);
  if (!reativacao) {
    // A linha já foi apagada: a remoção é mutação bem-sucedida e audita aqui,
    // senão o plano que a empresa tinha se perde (na nova tentativa apagada = null).
    if (apagada) {
      auditar(a, "cobranca.isencao_definida", { plano_id: (apagada as { plano_id: string }).plano_id, reativada: false });
    }
    return fail("internal_error", "A reativação da empresa falhou. Tente de novo.", 500, { requestId });
  }
  const changed = !!apagada || reativacao.reativada;
  if (changed) {
    auditar(a, "cobranca.isencao_definida", {
      plano_id: (apagada as { plano_id: string } | null)?.plano_id ?? null,
      reativada: reativacao.reativada,
    });
  }
  return ok({ changed, reativada: reativacao.reativada }, { requestId });
}
