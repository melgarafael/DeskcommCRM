/**
 * POST /api/v1/team/users — "o admin cria a pessoa com senha" (#3876).
 *
 * O OUTRO caminho para trazer gente, ao lado de `POST /api/v1/team/invite`:
 * aqui nasce conta E vínculo no mesmo ato, com a senha definida por quem
 * administra, e **nenhum convite pendente** (ver o cabeçalho de
 * `lib/auth/criar-membro.ts`). O convite por e-mail continua existindo e não
 * foi tocado: quem tem caixa postal e tempo segue convidando.
 *
 * ─── Por que a checagem de assentos é repetida aqui ────────────────────────
 *
 * A autoridade é do BANCO (`trg_trava_assentos_do_plano`, erro `PT402`), e o
 * `criarMembroComSenha` já traduz essa recusa. A leitura antecipada serve à
 * FRASE: "Seu plano permite N pessoas" com a saída (remover alguém ou trocar
 * de plano) é o que a tela mostra; o `PT402` cru só chegaria depois de criar a
 * conta e teria de ser desfeito. Lida a falha do limite, a criação SEGUE — a
 * trava continua no banco, exatamente como no convite.
 *
 * ─── A senha não volta ─────────────────────────────────────────────────────
 *
 * A resposta carrega `user_id` e `membership_id`, nunca o corpo do pedido. É o
 * contrato que o teste `tests/unit/usuario-criado-pelo-admin.test.ts` prende.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { isServiceRoleConfigured } from "@/lib/audit";
import { criarMembroComSenha } from "@/lib/auth/criar-membro";
import { requireRole } from "@/lib/auth/require-role";
import { lerLimiteDoPlano, mensagemDoLimite } from "@/lib/cobranca/limites";
import { logger } from "@/lib/logger";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { criarMembroSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;

  let input;
  try {
    input = await validateRequest(criarMembroSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  // Sem service-role não há como criar conta nem gravar vínculo fora de RLS.
  // Recusar AQUI, e não deixar o createUser estourar, mantém o vocabulário da
  // porta ("a instalação não está pronta") em vez de um 500 genérico.
  if (!isServiceRoleConfigured()) {
    return fail(
      "service_role_not_configured",
      "Esta instalação não tem a chave de serviço configurada: criar pessoa com senha exige o Admin API. Use o convite por e-mail.",
      503,
      { requestId },
    );
  }

  const admin = createAdminClient();

  // Mesma contagem do gatilho: quem está ATIVO e não é o provisório do
  // handover. Leitura que falha não impede a criação — a trava do banco fica.
  let limite: number | null = null;
  try {
    const { data: membros } = await admin
      .from("user_organizations")
      .select("user_id, provisional_until_handover")
      .eq("organization_id", activeOrg.orgId)
      .is("revoked_at", null);
    const ativos = (membros ?? []).filter((m) => !m.provisional_until_handover).length;
    limite = await lerLimiteDoPlano(admin, activeOrg.orgId, "assentos");
    if (limite !== null && ativos >= limite) {
      return fail(
        "plan_limit_reached",
        mensagemDoLimite("assentos", limite, authUser.idioma),
        409,
        { requestId, details: { recurso: "assentos", limite } },
      );
    }
  } catch (err) {
    logger.warn("team.create: limite do plano não pôde ser lido — a criação segue", {
      organization_id: activeOrg.orgId,
      request_id: requestId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }

  const resultado = await criarMembroComSenha({
    admin,
    organizationId: activeOrg.orgId,
    email: input.email,
    password: input.password,
    role: input.role,
    fullName: input.full_name ?? null,
    interfaceSettings: input.interface_settings,
    actorId: authUser.id,
    requestId,
  });

  if (!resultado.ok) {
    if (resultado.motivo === "senha_fraca") {
      // DEFESA EM PROFUNDIDADE: nesta rota a senha fraca morre antes, no schema
      // do corpo (`criarMembroSchema` → `senhaDoAcesso`, 422 `validation_error`
      // no campo `password`) — o teste da porta prende isso. Este ramo vale para
      // chamadores DIRETOS do módulo (uma server action futura) e mantém a
      // mesma frase, porque a régua é o mesmo objeto zod.
      return fail("invalid_password", resultado.detalhe ?? "Senha inválida", 422, {
        requestId,
        details: { campo: "password" },
      });
    }
    if (resultado.motivo === "email_em_uso") {
      // Não sobrescrevemos a senha de quem já tem conta: o caminho para essa
      // pessoa é o convite (ou o suporte). Deixar passar com "senha nova"
      // seria trocar o acesso de alguém que não pediu nada.
      return fail(
        "email_em_uso",
        "Este e-mail já tem conta nesta instalação. Use o convite por e-mail para adicionar esta pessoa a outra empresa.",
        409,
        { requestId, details: { campo: "email" } },
      );
    }
    if (resultado.motivo === "limite_do_plano") {
      // O banco recusou (PT402) e a leitura antecipada pode ter falhado: com o
      // número na mão a frase diz a saída; sem ele, a frase ainda diz o que
      // fazer, porque inventar "0 pessoas" seria mentira.
      return fail(
        "plan_limit_reached",
        limite !== null
          ? mensagemDoLimite("assentos", limite, authUser.idioma)
          : "Seu plano não permite mais pessoas. Remova alguém da equipe ou troque de plano.",
        409,
        { requestId, details: { recurso: "assentos", limite } },
      );
    }
    return fail("internal_error", "Não foi possível criar a pessoa agora.", 500, { requestId });
  }

  return ok(
    { user_id: resultado.user_id, membership_id: resultado.membership_id, email: input.email.trim().toLowerCase() },
    { status: 201, requestId },
  );
}
