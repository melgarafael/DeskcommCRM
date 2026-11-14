/**
 * "ADMIN CRIA A PESSOA COM SENHA" (#3876, fatia "senha definida pelo admin").
 *
 * ─── O que faltava ──────────────────────────────────────────────────────────
 *
 * Até aqui havia UM caminho para trazer gente: CONVIDAR. O convite assina um
 * token, manda e-mail e espera a pessoa clicar, definir a senha e aceitar —
 * só então nasce a membership (`fn_accept_team_invite`, via
 * `lib/auth/aplicar-convite.ts`). Em instalação sem SMTP o convite nasce e não
 * sai (`email_dispatched: false`), e quem foi convidado simplesmente não existe
 * para a operação. Este módulo é o outro caminho: quem administra define a
 * senha, e a pessoa nasce MEMBRO no mesmo ato.
 *
 * ─── Por que a membership é criada pela MESMA função do aceite ──────────────
 *
 * `fn_accept_team_invite` já faz o que "criar a pessoa" precisa: grava o
 * vínculo com papel e perfil de interface, carimba `accepted_at = now()` e
 * aplica a trava de assentos do plano (erro `PT402`). Escrever um segundo
 * INSERT aqui duplicaria as três regras — e o dia em que a função aprender
 * uma quarta (setor padrão, por exemplo) a criação ficaria para trás em
 * silêncio. Chamamos a sobrecarga de SETE parâmetros, com
 * `p_issued_at = p_invited_at = agora`: a de seis repassa
 * `{"preset":"completa"}` fixo e descartaria, calada, o perfil escolhido na
 * tela — foi a medição que a própria issue registrou.
 *
 * ─── NENHUM CONVITE PENDENTE NASCE AQUI ────────────────────────────────────
 *
 * Este caminho não escreve em `team_invites` e não chama `issueInvite`. Não é
 * esquecimento: convite pendente significa "esperando a pessoa aceitar", e
 * aqui não há o que esperar — o acesso está pronto no fim da função. Uma linha
 * em `team_invites` faria a aba Equipe listar como pendente alguém que já
 * entra, e o admin reenviaria um convite para quem já tem senha. O convite por
 * e-mail continua existindo, no caminho de sempre (`/api/v1/team/invite`).
 *
 * ─── A SENHA NUNCA SAI DAQUI ───────────────────────────────────────────────
 *
 * Ela é parâmetro de `auth.admin.createUser` e morre ali: não vai para
 * `audit()`, não vai para `logger`, não volta no retorno desta função e não é
 * incluída em mensagem de erro nenhuma. O retorno carrega identificadores; a
 * auditoria carrega QUEM criou QUEM e por qual caminho (`via`), que é a
 * pergunta que se faz depois — "quem entregou acesso a esta pessoa" — sem
 * guardar o segredo que dá esse acesso.
 *
 * ─── Por que a conta é APAGADA quando o vínculo falha ──────────────────────
 *
 * `createUser` e o RPC são duas escritas em dois sistemas. Se o vínculo for
 * recusado (plano cheio, erro do banco), uma conta de auth órfã ficaria para
 * trás: o e-mail já estaria "em uso" e a pessoa não pertenceria a organização
 * nenhuma — nem o admin conseguiria recriá-la sem suporte. A conta é removida
 * em melhor esforço, e uma remoção que também falha sai no log (é incidente,
 * não desfecho esperado).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { senhaDoAcesso } from "@/lib/auth/schemas";
import { logger } from "@/lib/logger";
import {
  INTERFACE_COMPLETA,
  interfaceSettingsSchema,
  type InterfaceSettings,
} from "@/lib/navigation/interface";
import type { Role } from "@/lib/schemas/team";

export type MotivoDaRecusa =
  | "senha_fraca"
  | "email_em_uso"
  | "limite_do_plano"
  | "internal_error";

export type ResultadoDaCriacao =
  | { ok: true; user_id: string; membership_id: string }
  /**
   * `motivo` é o vocabulário que a PORTA traduz em status HTTP. `detalhe`
   * carrega a frase da régua de senha quando existe — e nunca a senha.
   */
  | { ok: false; motivo: MotivoDaRecusa; detalhe?: string };

export interface CriarMembroInput {
  /** Service-role: a pessoa ainda não pertence a organização nenhuma. */
  admin: SupabaseClient;
  organizationId: string;
  email: string;
  password: string;
  role: Role;
  fullName?: string | null;
  interfaceSettings?: InterfaceSettings;
  /** Quem está criando — vai para a trilha como ATOR, nunca como autor anônimo. */
  actorId: string;
  requestId: string;
}

/**
 * O que o GoTrue diz quando o e-mail já tem conta.
 *
 * Não dá para decidir por `status` sozinho: o auth-js devolve 422 com
 * `code: "email_exists"` nas versões novas e só a mensagem nas antigas, e uma
 * instalação self-host fica presa na versão que subiu. Ler os dois é o que
 * mantém a recusa nomeada em vez de virar "erro interno" — que faria o admin
 * tentar de novo com o mesmo e-mail para sempre.
 */
function emailJaExiste(erro: { code?: string; message?: string }): boolean {
  if (erro.code === "email_exists" || erro.code === "user_already_exists") return true;
  return /already (been )?registered|already exists/i.test(erro.message ?? "");
}

/**
 * Cria a conta de auth e o vínculo com a organização, na mesma chamada.
 *
 * Não recebe sessão de quem cria: quem já validou o papel de admin é a porta
 * (`requireRole("admin")`), e este módulo é a escrita — a mesma divisão de
 * `lib/auth/issue-invite.ts`, que também confia no chamador para a autorização.
 */
export async function criarMembroComSenha(
  input: CriarMembroInput,
): Promise<ResultadoDaCriacao> {
  // Régua de senha ANTES de qualquer escrita: recusar depois de criar a conta
  // deixaria um usuário sem vínculo para trás. O primeiro erro já é a frase que
  // a pessoa lê na tela — a mesma do fluxo de redefinição, porque é o mesmo
  // schema (`senhaDoAcesso`).
  const senha = senhaDoAcesso.safeParse(input.password);
  if (!senha.success) {
    return { ok: false, motivo: "senha_fraca", detalhe: senha.error.issues[0]?.message };
  }

  const interfaceSettings = interfaceSettingsSchema.parse(
    input.interfaceSettings ?? INTERFACE_COMPLETA,
  );
  const email = input.email.trim().toLowerCase();
  const fullName = (input.fullName ?? "").trim();

  // `email_confirm: true` é o que faz o acesso funcionar SEM e-mail: a pessoa
  // entra com a senha que o admin entregou, e não fica esperando um link de
  // confirmação que, numa instalação sem SMTP, nunca chegaria.
  const { data: criado, error: erroDaConta } = await input.admin.auth.admin.createUser({
    email,
    password: input.password,
    email_confirm: true,
    ...(fullName.length > 0 ? { user_metadata: { full_name: fullName } } : {}),
  });

  if (erroDaConta || !criado?.user?.id) {
    if (erroDaConta && emailJaExiste(erroDaConta)) {
      return { ok: false, motivo: "email_em_uso" };
    }
    // Só o CÓDIGO vai para o log. A mensagem do provedor pode ecoar o corpo do
    // pedido, e o corpo tem a senha — o caminho inteiro existe para ela não
    // sair daqui.
    logger.error("team.create: a conta não pôde ser criada", {
      organization_id: input.organizationId,
      request_id: input.requestId,
      codigo: erroDaConta?.code ?? null,
      status: erroDaConta?.status ?? null,
    });
    return { ok: false, motivo: "internal_error" };
  }

  const userId = criado.user.id;
  const agora = new Date().toISOString();

  // A MESMA função do aceite de convite (ver o cabeçalho): papel, perfil de
  // interface, `accepted_at` e a trava de assentos do plano.
  const { data: vinculo, error: erroDoVinculo } = await input.admin.rpc(
    "fn_accept_team_invite",
    {
      p_interface_settings: interfaceSettings,
      p_user: userId,
      p_org: input.organizationId,
      p_role: input.role,
      p_invited_by: input.actorId,
      p_issued_at: agora,
      p_invited_at: agora,
    },
  );

  if (erroDoVinculo) {
    await desfazerConta(input.admin, userId, input);
    return {
      ok: false,
      motivo: erroDoVinculo.code === "PT402" ? "limite_do_plano" : "internal_error",
    };
  }

  // O RPC devolve a linha do vínculo; sem ela não há o que auditar nem o que
  // devolver. `id` ausente é o mesmo caso: "não sei" não vira sucesso.
  const membershipId =
    typeof (vinculo as { id?: unknown } | null)?.id === "string"
      ? (vinculo as { id: string }).id
      : null;

  if (!membershipId) {
    // O RPC respondeu sem erro e sem linha: não é "criou", é "não sei". A conta
    // sai pelo mesmo motivo do erro — um usuário sem vínculo não entra em lugar
    // nenhum, e ocuparia o e-mail.
    await desfazerConta(input.admin, userId, input);
    return { ok: false, motivo: "internal_error" };
  }

  await audit({
    action: "member.created",
    actorUserId: input.actorId,
    organizationId: input.organizationId,
    resourceType: "membership",
    resourceId: membershipId,
    requestId: input.requestId,
    metadata: {
      email,
      role: input.role,
      // De ONDE veio o acesso. Sem isto, quem lê a trilha não distingue "esta
      // pessoa foi convidada e aceitou" de "esta pessoa foi criada com senha
      // entregue de mão" — e só a segunda tem senha definida por outra pessoa,
      // que é o que interessa numa investigação.
      via: "senha_do_administrador",
    },
  });

  // #3696: o cache curto desta identidade pode ter sido preenchido com "sem
  // vínculo" momentos antes (a porta conferiu o papel, o roster já a listou).
  invalidarUsuario(userId);

  return {
    ok: true,
    user_id: userId,
    membership_id: membershipId,
  };
}

/**
 * Remove a conta recém-criada quando o vínculo não foi gravado.
 *
 * Melhor esforço, como o resto do arquivo: se a remoção falhar, o incidente
 * sai no log e a resposta já é de falha — insistir aqui trocaria um erro por
 * outro. Sem a senha, sempre.
 */
async function desfazerConta(
  admin: SupabaseClient,
  userId: string,
  input: Pick<CriarMembroInput, "organizationId" | "requestId">,
): Promise<void> {
  try {
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) throw error;
  } catch (err) {
    logger.error("team.create: a conta criada não pôde ser removida depois da falha do vínculo", {
      organization_id: input.organizationId,
      request_id: input.requestId,
      user_id: userId,
      causa: err instanceof Error ? err.message : String(err),
    });
  }
}
