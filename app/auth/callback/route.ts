import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser, vinculoAtivo } from "@/lib/auth/provision";
import { acessoFoiRevogado } from "@/lib/auth/vinculo-revogado";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { safeNext } from "@/lib/auth/safe-next";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";

/**
 * GET /auth/callback — a VOLTA da entrada com Google (issue #1388).
 *
 * O GoTrue devolve o navegador aqui com `?code=…` depois de o Google confirmar
 * a identidade. Aqui o `code` vira SESSÃO, no servidor, na mesma requisição que
 * gravou o cookie do verificador de PKCE — que é a razão de a metade de ida
 * (`signInWithGoogle`) existir no servidor e de o cookie dela ser `Lax`
 * (`createClientDeEntradaComGoogle`).
 *
 * ─── Por que a troca não passa `flowId` para o auth-js ──────────────────────
 *
 * O auth-js 2.116.0 grava o verificador em DOIS lugares: um slot por fluxo
 * (`…-flow-<id>-code-verifier`) e a chave fixa de sempre (`…-code-verifier`),
 * esta última de propósito — está escrito no `storePKCEVerifier` que a escrita
 * dupla cobre "trocas que não conseguem identificar o próprio fluxo (SDKs
 * antigos, redirects sem o parâmetro de fluxo)". O servidor é exatamente esse
 * caso: sem `window`, o `_exchangeCodeForSession` não lê o parâmetro da URL, e
 * com `flowId` explícito ele passaria a ler SÓ o slot. Sem ele, cai na chave
 * fixa — que existe. Limite conhecido: dois consentimentos abertos em paralelo
 * no mesmo navegador disputam a chave fixa; o mais novo ganha.
 *
 * ─── O que a volta decide ───────────────────────────────────────────────────
 *
 * Este é o ÚNICO ponto em que "entrar" e "criar conta" chegam juntos, sem o
 * e-mail no meio para dizer qual dos dois é. A bifurcação é o VÍNCULO
 * (`user_organizations`), não uma heurística de data:
 *
 * - quem JÁ tem vínculo está ENTRANDO — vai para o destino pedido, e as travas
 *   de cadastro não o alcançam (numa instalação `so_convite`, barrar aqui
 *   trancaria do lado de fora todo mundo que já usa o sistema);
 * - quem NÃO tem vínculo está CRIANDO CONTA — e aí valem as mesmas travas do
 *   `/auth/confirm`: convite, política de cadastro e provisionamento.
 *
 * Tudo o mais é cópia deliberada do miolo de `app/auth/confirm/route.ts`. Não
 * foi extraído para um módulo comum porque os dois caminhos não são o mesmo
 * caminho: lá já se sabe que houve confirmação de e-mail (e todo mundo entra no
 * onboarding), aqui há duas populações. O que os dois compartilham de verdade —
 * `decidirConviteDoSignup`, `aplicarConvite`, `ensureTenantForUser` — já está
 * compartilhado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  const convite = url.searchParams.get("convite");
  const requestId = request.headers.get("x-request-id");

  // NUNCA usar url.origin aqui: é derivado do header Host, que o proxy/container
  // pode entregar como o bind interno (ex.: 0.0.0.0:3000) em vez do domínio
  // público — o link de recovery quebra silenciosamente para o usuário final.
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  // O Google devolve `error=access_denied` quando a pessoa fecha a tela de
  // consentimento. Não é falha do sistema, e tratar como falha manda a pessoa
  // procurar defeito onde não há — mas também não é sucesso: sem esta linha, a
  // tela de login ficaria em branco, sem dizer nada.
  //
  // SEM linha de auditoria aqui — nem no ramo abaixo. Estes dois ramos são o
  // ponto mais exposto da rota: ela está em `PUBLIC_PATHS` (ancorada) e o `error`
  // é texto cru de quem chama. Medido na revisão: `?error=<4000 caracteres>`
  // grava 4.045 bytes em `metadata.reason` (teto de 14.000), e um GET por
  // requisição de qualquer anônimo grava 1 linha em `api_audit_log` — tabela
  // append-only com piso de expurgo de 90 dias. A doutrina do irmão desta rota
  // (`app/api/v1/agenda/google/callback/route.ts`, o comentário antes do audit)
  // é a mesma e vale aqui: auditoria só DEPOIS do gate, quando quem chama já
  // provou ser o dono do verificador de PKCE. Quem chega sem `code` não provou
  // nada; a tela de login diz o que aconteceu, e o rastro não recebe a escrita
  // ilimitada.
  const erroDoProvedor = url.searchParams.get("error");
  if (erroDoProvedor) {
    return redirectTo("/login?error=entrada_com_google_cancelada");
  }

  if (!code) {
    return redirectTo("/login?error=entrada_com_google");
  }

  // O cliente de sempre (jar Strict): o verificador já viajou até aqui, e é este
  // que grava o cookie de SESSÃO.
  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.user) {
    await audit({
      action: "auth.google_signin_failed",
      metadata: {
        motivo: "troca_do_code_falhou",
        // Texto de terceiro indo para uma tabela append-only: teto explícito, em
        // vez de confiar no tamanho que o provedor decidir mandar.
        reason: (error?.message ?? "no_user").slice(0, 200),
      },
      requestId,
    });
    return redirectTo("/login?error=entrada_com_google");
  }

  const usuario = data.user;

  // O Google autentica com dois fatores (e a conta pode tê-los). O login por
  // senha NÃO deixa passar quem tem TOTP verificado sem o segundo fator
  // (`signInWithPassword.ts:88`), e a entrada com Google tem de ter a mesma
  // força — senão vira a porta mais fraca do produto, e o fator que a pessoa
  // cadastrou deixa de valer em qualquer navegador novo.
  const { data: fatores } = await supabase.auth.mfa.listFactors();
  const totpVerificado = fatores?.totp?.find((f) => f.status === "verified");
  if (totpVerificado) {
    const params = new URLSearchParams({ factor: totpVerificado.id, next: safeNext(next, "/app") });
    return redirectTo(`/login/mfa?${params}`);
  }

  // ENTRADA: já existe vínculo. Provisionar ou reaplicar convite aqui seria
  // refazer trabalho que já está feito — e recusar pelo modo de cadastro
  // trancaria do lado de fora quem já é de casa.
  //
  // FALHA FECHADA: `vinculoAtivo` lança quando não conseguiu LER, e `null`
  // continua querendo dizer só "não há vínculo". Sem este catch, um tropeço de
  // leitura cai no mesmo `null` do primeiro acesso e o resto da rota provisiona
  // organização nova para quem já tinha uma. A sessão já está firme aqui, então
  // a saída é a tela de login com o motivo — não um 500.
  let organizacaoId: string | null;
  try {
    organizacaoId = await vinculoAtivo(usuario.id);
  } catch (e) {
    await audit({
      action: "auth.google_signin_failed",
      actorUserId: usuario.id,
      metadata: {
        motivo: "leitura_do_vinculo_falhou",
        reason: e instanceof Error ? e.message.slice(0, 200) : "erro_desconhecido",
      },
      requestId,
    });
    return redirectTo("/login?error=entrada_com_google");
  }

  if (organizacaoId) {
    await audit({
      action: "auth.login_success",
      actorUserId: usuario.id,
      metadata: { provider: "google" },
      requestId,
    });
    return redirectTo(safeNext(next, "/app"));
  }

  // TERCEIRA população, e ela não estava no desenho: quem TEVE organização e
  // perdeu o acesso. `vinculoAtivo` só enxerga vínculo vivo (`.is("revoked_at",
  // null)`), então uma revogação chega aqui parecendo primeiro acesso — e numa
  // instalação aberta sairia com ORGANIZAÇÃO NOVA, `role: "admin"`, virando um
  // jeito de a revogação criar tenant em vez de encerrá-lo. A revogação não
  // apaga o auth user (o `revoke` só carimba `revoked_at`), então este é o único
  // ponto onde a porta nova pode ser fechada.
  //
  // A guarda já existe no repo e estava sendo esquecida só nesta porta: a MESMA
  // chamada, na MESMA posição do `recoverOrganization.ts:86` — depois de saber
  // que não há vínculo vivo e ANTES de decidir o convite. A posição é parte do
  // conserto: fora desta ordem o motivo auditado sairia como `convite_invalido`,
  // que não é a verdade sobre o que aconteceu com quem foi revogado.
  if (await acessoFoiRevogado(usuario.id)) {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: "acesso_revogado", provider: "google" },
      requestId,
    });
    return redirectTo("/login?error=acesso_revogado");
  }

  // CADASTRO: sem vínculo, este é um primeiro acesso. Daqui para baixo é o
  // mesmo miolo do `/auth/confirm`, e pelas mesmas razões — o comentário de lá
  // explica cada trava.
  const decisao = decidirConviteDoSignup(usuario, convite);

  if (decisao.tipo === "recusar") {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: decisao.motivo, provider: "google" },
      requestId,
    });
    return redirectTo("/login?error=convite_invalido");
  }

  if (decisao.tipo === "convite") {
    const aceite = await aplicarConvite({
      userId: usuario.id,
      payload: decisao.payload,
      requestId,
    });
    if (aceite.ok) return redirectTo("/app");

    // Convite revogado, ou banco fora: a tela de aceite continua existindo e
    // sabe explicar cada caso.
    return redirectTo(`/team/accept-invite/${decisao.token}`);
  }

  // A trava da política de cadastro, depois de `decidirConviteDoSignup` de
  // propósito: quem tem convite válido já saiu acima, então esta guarda só
  // alcança quem chegou sem convite nenhum.
  const modo = await modoDeCadastro();
  if (modo === "so_convite") {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: "somente_convite", provider: "google" },
      requestId,
    });
    return redirectTo("/login?error=cadastro_por_convite");
  }

  // COM APROVAÇÃO (migration 0383): a empresa NÃO nasce aqui. O pedido é
  // enviado em `/get-started`, que é onde já chega quem ficou sem empresa por
  // qualquer outro caminho — uma porta só, e a trava mora na action dela
  // (`recoverOrganization`), não nesta rota.
  if (modo === "com_aprovacao") return redirectTo("/get-started");

  try {
    await ensureTenantForUser(usuario, { source: "signup" });
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: usuario.id,
      metadata: { reason: e instanceof Error ? e.message : String(e), provider: "google" },
      requestId,
    });
    // A sessão JÁ está firmada. Mandar para `/login` deixava a pessoa logada e
    // sem organização, sem caminho de volta — ver `recoverOrganization.ts`.
    return redirectTo("/get-started");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: usuario.id,
    metadata: { provider: "google" },
    requestId,
  });

  return redirectTo("/onboarding/welcome");
}
