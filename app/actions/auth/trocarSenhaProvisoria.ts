"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { resetPasswordSchema, type ResetPasswordInput } from "@/lib/auth/schemas";
import { invalidarUsuario } from "@/lib/auth/cache-curto";
import { loadAuthUser } from "@/lib/auth/server";
import { organizacoesComSenhaProvisoria } from "@/lib/auth/senha-provisoria";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";

export type TrocaSenhaProvisoriaResult = {
  ok: false;
  error: "validation_error" | "session_expired" | "not_required" | "same_password" | "update_failed";
  details?: Record<string, unknown>;
};

/**
 * A troca OBRIGATÓRIA do primeiro acesso (#3876).
 *
 * ─── Por que uma action própria, e não `updatePassword` ────────────────────
 *
 * `app/actions/auth/updatePassword.ts` é o fim do fluxo de RECUPERAÇÃO: ele
 * encerra a sessão e manda a pessoa para `/login?reset=success`, porque ali a
 * senha nova precisa ser provada num login limpo. Aqui é o contrário — a
 * pessoa acabou de entrar com a senha provisória e deve continuar dentro do
 * produto, agora com a senha dela. O que os dois compartilham é a RÉGUA da
 * senha (`resetPasswordSchema`), importada, não reescrita.
 *
 * ─── O gate que isto destrava ──────────────────────────────────────────────
 *
 * Enquanto `user_organizations.senha_provisoria` for `true`, o servidor recusa
 * `/api/v1` (`requireRole`) e o layout de `/app` redireciona para cá. A troca
 * bem-sucedida APAGA a marca — é o único lugar do app que escreve nessa coluna
 * depois da criação — e derruba o snapshot de permissões da pessoa, senão o
 * cache curto (30 s) continuaria dizendo "deve trocar" com a senha já trocada.
 *
 * ─── A senha, em repouso e no log ──────────────────────────────────────────
 *
 * Ela vai do corpo para o GoTrue e não é escrita em lugar nenhum: nem audit
 * (metadata leva só as organizações destravadas), nem log, nem resposta. O
 * `error.message` do GoTrue NÃO é devolvido nem registrado cru — ele pode citar
 * o corpo da requisição.
 */
export async function trocarSenhaProvisoria(
  input: ResetPasswordInput,
): Promise<TrocaSenhaProvisoriaResult> {
  const parsed = resetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: "validation_error",
      details: parsed.error.flatten().fieldErrors,
    };
  }

  // `loadAuthUser` (e não `supabase.auth.getUser()` direto): a marca vive na
  // lista de vínculos que ele já resolve, com a MESMA leitura que o gate usa.
  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "session_expired" };

  const orgs = organizacoesComSenhaProvisoria(user);
  // Já trocou (dois cliques, ou aba velha): não é erro, e não reescreve a
  // senha de novo — a segunda gravação com o mesmo valor falharia no GoTrue.
  if (orgs.length === 0) return { ok: false, error: "not_required" };

  const hdrs = await headers();
  const requestId = hdrs.get("x-request-id");
  const ip = ipDoCliente(hdrs);
  const userAgent = hdrs.get("user-agent") ?? null;

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    if (/different from the old password/i.test(error.message)) {
      return { ok: false, error: "same_password" };
    }
    await audit({
      action: "auth.password_change_failed",
      actorUserId: user.id,
      metadata: { reason: error.code ?? "update_failed" },
      requestId,
      ip,
      userAgent,
    });
    return { ok: false, error: "update_failed" };
  }

  // Quem escreve é o service-role: a coluna não tem caminho de escrita para o
  // usuário comum (ver o cabeçalho de `lib/auth/senha-provisoria.ts`). O filtro
  // é por `user_id` E pelas organizações que a PRÓPRIA SESSÃO declarou
  // pendentes — os dois vêm de `loadAuthUser`, nunca do corpo da requisição. O
  // `organization_id` explícito não muda o resultado (só esses vínculos estão
  // pendentes) e mantém a escrita de service-role dentro do escopo que a cerca
  // de tenant exige de toda cadeia privilegiada.
  const admin = createAdminClient();
  const { error: limpaErr } = await admin
    .from("user_organizations")
    .update({ senha_provisoria: false })
    .in("organization_id", orgs)
    .eq("user_id", user.id)
    .eq("senha_provisoria", true);

  if (limpaErr) {
    // A senha nova JÁ valeu. Deixar a marca de pé tranca a pessoa num laço
    // (login → troca → mesma senha recusada), então a falha é declarada e
    // registrada; a próxima tentativa com uma senha diferente repete os dois
    // passos e fecha o estado.
    logger.error("trocar-senha: senha trocada, mas a marca do primeiro acesso não caiu", {
      user_id: user.id,
      request_id: requestId,
      code: limpaErr.code,
    });
    return { ok: false, error: "update_failed" };
  }

  await audit({
    action: "auth.password_change_completed",
    actorUserId: user.id,
    // Sem organização no evento de propósito: a troca destrava TODOS os
    // vínculos provisórios da pessoa, e escolher um só contaria meia verdade.
    metadata: { organizacoes: orgs },
    requestId,
    ip,
    userAgent,
  });

  // O snapshot tem 30 s de validade; sem isto a pessoa volta para a tela de
  // troca na navegação seguinte.
  invalidarUsuario(user.id);

  redirect("/app");
}
