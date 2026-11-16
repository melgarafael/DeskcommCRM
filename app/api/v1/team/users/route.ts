import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

/**
 * POST /api/v1/team/users — cria a pessoa SEM convite, com senha provisória
 * gerada pelo servidor e troca obrigatória no primeiro acesso (#3876; decisão
 * do dono do produto, doc 310 alternativa A).
 *
 * ─── O buraco que isto fecha ────────────────────────────────────────────────
 *
 * Até aqui o produto só sabia CONVIDAR (`app/api/v1/team/invite/route.ts`): o
 * e-mail sai por SMTP, o convidado abre a caixa, clica no link e é ele quem
 * define a senha. Instalação sem SMTP, caixa inexistente ou convidado que não
 * recebe o link ficavam sem caminho nenhum — não havia como "criar a pessoa".
 *
 * ─── O que esta rota faz ────────────────────────────────────────────────────
 *
 * 0. Alcance (`podeCriarPessoaComSenha`): só o dono da instalação, ou o admin
 *    da empresa numa instalação de UMA empresa. Com várias empresas, o admin
 *    de empresa continua com o convite — a conta criada aqui é da instalação
 *    inteira. Limite de tentativas por organização antes de qualquer escrita.
 * 1. `admin.auth.admin.createUser` com a senha que o SERVIDOR gerou
 *    (`gerarSenhaProvisoria`), `email_confirm: true`
 *    (a conta nasce confirmada: quem provou quem é foi o administrador, e não
 *    há e-mail para confirmar) e `user_metadata.full_name`.
 * 2. Insere o vínculo em `user_organizations` com `senha_provisoria = true`.
 *    É essa coluna (migration 9380) que obriga a troca no primeiro acesso: o
 *    gate vive no servidor — `requireRole` recusa `/api/v1` e o layout de
 *    `/app` redireciona para `/trocar-senha`.
 * 3. Audita `member.created` (nunca com a senha) e devolve a senha UMA vez,
 *    com `Cache-Control: no-store`. Ela não fica guardada em lugar nenhum.
 *
 * ─── O que esta rota NÃO faz, de propósito ──────────────────────────────────
 *
 * - **Não envia e-mail.** É o ponto inteiro: nenhuma dependência de SMTP nem
 *   de caixa postal. Não há convite, `team_invites` não é tocada e o caminho de
 *   convite continua exatamente como está.
 * - **Não mexe em sessão.** Cria com service-role; a sessão de quem administra
 *   continua a mesma, e não existe caminho para a senha digitada virar login
 *   deste navegador. Refazer o login do admin com a senha do usuário novo
 *   falha, porque a senha pertence a outra conta.
 * - **Não reaproveita conta.** Trocar a senha de uma conta que já existe por
 *   esta porta seria tomar a conta de outra pessoa. Toda recusa da criação tem
 *   a MESMA resposta, qualquer que seja o motivo (`FALHA_AO_CRIAR`); o motivo
 *   real vai para o log e para a auditoria do dono da instalação. Para quem já
 *   usa a instalação, o caminho é o convite.
 *
 * ─── A senha em repouso e no log ────────────────────────────────────────────
 *
 * A senha nasce aqui, vai para o GoTrue e para a resposta desta requisição — e
 * só: não é logada, não entra em audit (metadata leva e-mail e papel, nunca a
 * senha). A troca no primeiro acesso é o que a tira de circulação.
 */
import { ok, fail } from "@/lib/api/wrappers";
import { ApiError } from "@/lib/api/types";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { gerarSenhaProvisoria, podeCriarPessoaComSenha } from "@/lib/auth/criar-pessoa-com-senha";
import { requireRole } from "@/lib/auth/require-role";
import {
  lerLimiteDoPlano,
  mensagemDoLimite,
  traduzirLimiteDoPlano,
} from "@/lib/cobranca/limites";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createTeamUserSchema, validateRequest } from "@/lib/schemas";
import { createAdminClient } from "@/lib/supabase/admin";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Limite de tentativas POR ORGANIZAÇÃO: criar gente é raro, e o teto tira o
 * custo zero de quem usaria a rota para varrer e-mails. Conta a tentativa, não
 * o sucesso — a recusa genérica também consome.
 */
const TETO_POR_ORG = 10;
const JANELA_SEGUNDOS = 3600;

/** A ÚNICA resposta de recusa da criação: mesma frase e mesmo status para qualquer motivo. */
const FALHA_AO_CRIAR =
  "Não foi possível criar a conta. Se a pessoa já usa esta instalação, convide-a por e-mail.";

/** O GoTrue responde este texto quando o e-mail já tem conta. */
function jaExisteConta(message: string | undefined): boolean {
  return /already\s+(been\s+)?registered|already\s+exists|email\s+exists/i.test(message ?? "");
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "team" });
  if (!authz.ok) return authz.response;
  const { user: authUser, org: activeOrg } = authz;
  const t = (texto: string) => traduzir(texto, authUser.idioma);

  if (!isServiceRoleConfigured()) {
    return fail("internal_error", t("Serviço indisponível no momento."), 503, { requestId });
  }
  const admin = createAdminClient();

  if (!(await podeCriarPessoaComSenha(authUser, admin))) {
    return fail(
      "invite_required",
      t("Nesta instalação, pessoas novas entram por convite. Use Convidar membros."),
      403,
      { requestId },
    );
  }

  const teto = await checkRateLimit(`equipe:criar-com-senha:${activeOrg.orgId}`, TETO_POR_ORG, JANELA_SEGUNDOS);
  if (!teto.allowed) {
    return fail("rate_limited", t("Muitas contas criadas em pouco tempo. Tente de novo mais tarde."), 429, {
      requestId,
      headers: {
        "Retry-After": String(JANELA_SEGUNDOS),
        "X-RateLimit-Limit": String(teto.limit),
        "X-RateLimit-Remaining": String(Math.max(0, teto.limit - teto.count)),
      },
    });
  }

  let input;
  try {
    input = await validateRequest(createTeamUserSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const email = input.email.trim().toLowerCase();

  // Criar a própria conta de novo é sempre engano — e o e-mail é o de quem pede.
  if (email === authUser.email.trim().toLowerCase()) {
    return fail("email_already_registered", t("Este e-mail já é a sua conta."), 409, {
      requestId,
    });
  }

  /**
   * Plano cheio: RECUSA antes de criar a conta — mesma régua e mesma frase do
   * convite (spec cobrança §5, D-10). A trava definitiva continua no gatilho de
   * assentos, que roda no INSERT do vínculo; esta leitura existe para não
   * deixar uma conta de auth órfã quando a recusa é previsível.
   */
  const { data: members, error: membrosErr } = await admin
    .from("user_organizations")
    .select("user_id, provisional_until_handover")
    .eq("organization_id", activeOrg.orgId)
    .is("revoked_at", null);
  if (membrosErr) {
    return fail("internal_error", membrosErr.message, 500, { requestId });
  }
  const ativos = (members ?? []).filter((m) => !m.provisional_until_handover).length;
  try {
    const limite = await lerLimiteDoPlano(admin, activeOrg.orgId, "assentos");
    if (limite !== null && ativos >= limite) {
      return fail("plan_limit_reached", mensagemDoLimite("assentos", limite, authUser.idioma), 409, {
        requestId,
        details: { recurso: "assentos", limite },
      });
    }
  } catch (err) {
    // Falhou a informação, não a trava: o gatilho do banco continua decidindo.
    logger.warn("team.users: limite do plano não pôde ser lido — a criação segue", {
      organization_id: activeOrg.orgId,
      request_id: requestId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }

  const senha = gerarSenhaProvisoria();
  const { data: criado, error: criaErr } = await admin.auth.admin.createUser({
    email,
    password: senha,
    // Quem prova que a pessoa é quem diz ser é quem administra a empresa. Sem
    // isto a conta nasceria pendente de um e-mail que, por definição, não vai
    // sair — e o login recusaria "e-mail não confirmado".
    email_confirm: true,
    user_metadata: { full_name: input.full_name },
  });

  if (criaErr || !criado?.user) {
    const motivo = jaExisteConta(criaErr?.message) ? "email_ja_tem_conta" : "gotrue_recusou";
    // A mensagem do GoTrue pode citar a requisição — e ela tem a senha. Só o
    // status/código entram no log.
    logger.warn("team.users: createUser recusou", {
      organization_id: activeOrg.orgId,
      request_id: requestId,
      motivo,
      status: criaErr?.status,
      code: criaErr?.code,
    });
    // Sem `organizationId` de propósito: a linha fica na auditoria do dono da
    // instalação, junto com o motivo real.
    await audit({
      action: "member.create_refused",
      actorUserId: authUser.id,
      organizationId: null,
      resourceType: "membership",
      requestId,
      metadata: { organization_id: activeOrg.orgId, email, motivo },
    });
    return fail("user_not_created", t(FALHA_AO_CRIAR), 422, { requestId });
  }

  const userId = criado.user.id;

  const { data: vinculo, error: vinculoErr } = await admin
    .from("user_organizations")
    .insert({
      organization_id: activeOrg.orgId,
      user_id: userId,
      role: input.role,
      interface_settings: input.interface_settings ?? undefined,
      invited_by: authUser.id,
      invited_at: new Date().toISOString(),
      accepted_at: new Date().toISOString(),
      // O sinal do primeiro acesso. Só service-role escreve esta coluna.
      senha_provisoria: true,
    })
    .select("id")
    .single();

  if (vinculoErr) {
    /**
     * COMPENSAÇÃO. A conta de auth já existe; sem o vínculo ela seria um login
     * válido para um CRM onde a pessoa não é membro de nada — e ninguém
     * conseguiria recriá-la (o e-mail passa a "já registrado"). Apagar é o que
     * devolve a operação ao estado anterior. Falha do delete é registrada, não
     * engole a resposta: o cliente precisa saber que NÃO deu certo.
     */
    const { error: desfazErr } = await admin.auth.admin.deleteUser(userId);
    if (desfazErr) {
      logger.error("team.users: vínculo falhou e a conta não pôde ser removida", {
        organization_id: activeOrg.orgId,
        request_id: requestId,
        user_id: userId,
        causa: desfazErr.message,
      });
    }
    const limite = traduzirLimiteDoPlano(vinculoErr, authUser.idioma);
    if (limite) return fail(limite.code, limite.message, 409, { requestId, details: limite.details });
    logger.error("team.users: vínculo recusado", {
      organization_id: activeOrg.orgId,
      request_id: requestId,
      code: vinculoErr.code,
    });
    return fail("internal_error", t("Não foi possível incluir a pessoa na equipe."), 500, {
      requestId,
    });
  }

  // O snapshot de permissões desta pessoa pode ter sido montado antes do
  // vínculo existir (o mesmo cuidado do aceite de convite, #3696).
  invalidarUsuario(userId);

  await audit({
    action: "member.created",
    actorUserId: authUser.id,
    organizationId: activeOrg.orgId,
    resourceType: "membership",
    resourceId: vinculo.id,
    requestId,
    metadata: {
      target_user_id: userId,
      email,
      role: input.role,
      // A senha NUNCA entra aqui: a trilha responde "quem criou quem", não
      // guarda credencial.
      senha_provisoria: true,
    },
  });

  return ok(
    {
      user_id: userId,
      email,
      role: input.role,
      deve_trocar_senha: true,
      // A ÚNICA vez em que a senha sai do servidor. Não é guardada: perdeu,
      // o caminho é a recuperação de senha ou apagar e criar de novo.
      senha_provisoria: senha,
    },
    { status: 201, requestId, headers: { "Cache-Control": "no-store" } },
  );
}
