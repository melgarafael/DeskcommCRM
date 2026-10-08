/**
 * /api/v1/admin/tenants/[id]/assinatura — o dono da instalação decide se esta
 * empresa paga, e por qual plano (spec da cobrança do revendedor §7g).
 *
 *  - POST {plano_id}: empresa sem linha (isenta) passa a pagar → linha `trial`
 *    com os dias do plano. Linha existente → 409 `state_conflict`.
 *  - PATCH {plano_id}: troca de plano pelo MESMO caminho da empresa
 *    (`lib/cobranca/troca.ts`, §7e): em teste grátis vale na hora; depois do
 *    teste, com provedor, fica agendada para a próxima cobrança paga.
 *  - DELETE: torna isenta. Linha SEM provedor → apagada. Linha COM provedor →
 *    só depois de `lerSituacao` mostrar zero assinaturas vivas (senão 409
 *    `assinatura_viva_no_provedor`; leitura que falha → 503, nada apagado). O
 *    filtro do DELETE repete o que foi lido: um checkout concorrente não é
 *    apagado por baixo. A suspensão por cobrança sai junto.
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
import { adaptador } from "@/lib/cobranca/provedores";
import { trocarPlanoDaOrg } from "@/lib/cobranca/troca";
import type { EstadoDaAssinatura, ProvedorDeCobranca } from "@/lib/cobranca/vocabulario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const corpoSchema = z.strictObject({ plano_id: z.string().uuid() });
const DIA_MS = 86_400_000;
const NASCE_EM: EstadoDaAssinatura = "trial";
const COLUNAS = "organization_id, plano_id, plano_agendado_id, estado, trial_ate, provedor, prazo_extra_ate";

type Rota = { params: Promise<{ id: string }> };
type Aberta = { admin: SupabaseClient; ator: string; tenantId: string; requestId: string };

/**
 * O portão das três depois do acompanhamento: escrita de platform admin, chave,
 * id. Mora NESTE arquivo para a cerca `admin-escrita-exige-scope-full` ver a
 * chamada. O `requireSupportWrite` fica no corpo de cada handler, antes deste
 * portão: a cerca `suporte-cobertura-de-efeitos` lê o corpo do handler, não o
 * de quem ele chama.
 */
async function abrir({ params }: Rota): Promise<Aberta | { resposta: NextResponse<ApiError> }> {
  const { id: tenantId } = await params;
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
  const supportDenied = await requireSupportWrite((await rota.params).id);
  if (supportDenied) return supportDenied;
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
  const supportDenied = await requireSupportWrite((await rota.params).id);
  if (supportDenied) return supportDenied;
  const a = await abrir(rota);
  if ("resposta" in a) return a.resposta;
  const { admin, tenantId, requestId } = a;

  const corpo = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!corpo.success) {
    return fail("validation_failed", "Informe o plano", 400, { requestId, details: corpo.error.flatten() });
  }
  const r = await trocarPlanoDaOrg(admin, tenantId, corpo.data.plano_id, { origem: "dono" });
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId, ...(r.details === undefined ? {} : { details: r.details }) });
  if (r.changed) auditar(a, "cobranca.plano_trocado", { de: r.de, para: corpo.data.plano_id, quando: r.quando });
  return ok(
    r.quando === "agendado"
      ? { changed: r.changed, plano_id: r.planoId, plano_agendado_id: r.planoAgendadoId, vale_a_partir_de: r.valeAPartirDe }
      : { changed: r.changed, plano_id: r.planoId },
    { requestId },
  );
}

export async function DELETE(_req: NextRequest, rota: Rota) {
  const supportDenied = await requireSupportWrite((await rota.params).id);
  if (supportDenied) return supportDenied;
  const a = await abrir(rota);
  if ("resposta" in a) return a.resposta;
  const { admin, ator, tenantId, requestId } = a;

  const org = await lerOrgDoTenant(admin, tenantId);
  if (org === "erro") return fail("internal_error", "Não foi possível ler a empresa", 500, { requestId });
  if (!org) return fail("not_found", "Tenant not found", 404, { requestId });

  const { data: lida, error: erroDeLeitura } = await admin
    .from("cobranca_assinaturas")
    .select("plano_id, provedor, provedor_cliente_id")
    .eq("organization_id", tenantId)
    .maybeSingle();
  if (erroDeLeitura) return fail("internal_error", "Não foi possível ler a assinatura", 500, { requestId });
  const linha = lida as { plano_id: string; provedor: ProvedorDeCobranca | null; provedor_cliente_id: string | null } | null;

  let apagada: { plano_id: string } | null = null;
  if (linha) {
    // O DELETE só é montado depois da leitura do provedor: recusa não deixa pedido pendurado.
    let alvo: { provedor: ProvedorDeCobranca; clienteId: string } | null = null; // null = linha sem provedor
    if (linha.provedor && linha.provedor_cliente_id) {
      let vivas: number;
      try {
        vivas = (await adaptador(linha.provedor).lerSituacao({ clienteRef: linha.provedor_cliente_id })).assinaturasVivas;
      } catch (e) {
        logger.warn("cobranca.isencao_sem_leitura", { organization_id: tenantId, erro: e instanceof Error ? e.message : "desconhecido" });
        return fail(
          "provedor_indisponivel",
          "Não foi possível confirmar com o provedor de pagamento se ainda há cobrança. Nada foi apagado; tente de novo.",
          503,
          { requestId },
        );
      }
      if (vivas > 0) {
        return fail(
          "assinatura_viva_no_provedor",
          "Esta empresa ainda tem assinatura ativa no provedor de pagamento. Cancele lá antes de isentar.",
          409,
          { requestId },
        );
      }
      alvo = { provedor: linha.provedor, clienteId: linha.provedor_cliente_id };
    }
    const base = admin.from("cobranca_assinaturas").delete().eq("organization_id", tenantId);
    const { data, error } = await (alvo ? base.eq("provedor", alvo.provedor).eq("provedor_cliente_id", alvo.clienteId) : base.is("provedor", null))
      .select("plano_id")
      .maybeSingle();
    if (error) return fail("internal_error", "Não foi possível tornar a empresa isenta", 500, { requestId });
    if (!data) {
      return fail("state_conflict", "A assinatura mudou enquanto você isentava. Recarregue e tente de novo.", 409, { requestId });
    }
    apagada = data as { plano_id: string };
  }

  // Roda mesmo sem linha: cura a empresa que ficou suspensa por cobrança quando
  // uma tentativa anterior apagou a linha e caiu antes de reativar.
  const reativacao = await reativarSeSuspensaPorCobranca(admin, org, ator);
  if (!reativacao) {
    // Como no PR 2: a linha já foi apagada, a remoção é mutação bem-sucedida e
    // audita aqui, senão o plano que a empresa tinha se perde na nova tentativa.
    if (apagada) auditar(a, "cobranca.isencao_definida", { plano_id: apagada.plano_id, reativada: false });
    return fail("internal_error", "A reativação da empresa falhou. Tente de novo.", 500, { requestId });
  }
  const changed = !!apagada || reativacao.reativada;
  if (changed) {
    auditar(a, "cobranca.isencao_definida", { plano_id: apagada?.plano_id ?? null, reativada: reativacao.reativada });
  }
  return ok({ changed, reativada: reativacao.reativada }, { requestId });
}
