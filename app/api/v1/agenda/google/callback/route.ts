/**
 * GET /api/v1/agenda/google/callback — a volta do consentimento do Google.
 *
 * Confere o `state`, troca o código por tokens, descobre de quem é a agenda,
 * cifra e grava a conexão. É retorno de NAVEGADOR: todo desfecho — inclusive
 * cada falha — volta para `/app/agenda` com `?erro=<código>` ou `?ok=1`, nunca
 * JSON. É o mesmo contrato do callback da Nuvemshop, que é o precedente da casa.
 *
 * ─── Onde este arquivo se AFASTA do molde da Nuvemshop, de propósito ──────
 *
 * O callback da Nuvemshop chama `admin.rpc("fn_encrypt_oauth")` DIRETO, e no
 * erro devolve `?error=encrypt_failed`, que a tela traduz citando o nome de uma
 * variável de um produto de e-commerce. Aqui a cifra passa por
 * `encryptWebhookSecret`, que devolve `null` em vez de propagar a exceção do
 * Postgres, e o `null` vira uma recusa em português que não nomeia parceiro
 * nenhum. Copiar o molde ao pé da letra reproduziria o defeito que outras quatro
 * rotas acabaram de deixar de ter.
 *
 * ─── A ORDEM DOS PASSOS É CONTRATO, e cada um tem um motivo ──────────────
 *
 * Esta lista existe porque nenhum destes passos PARECE depender de ordem — e
 * quem reordenar por estética desfaz uma propriedade sem receber erro nenhum.
 *
 * 1. `error` na query ANTES de tudo: quem clicou "Cancelar" na tela do Google
 *    volta por aqui, e isso não é falha — é uma pessoa desistindo. Tratar como
 *    erro encheria o log e assustaria quem só mudou de ideia.
 * 2. `state` ANTES do `code`: sem saber de quem é o retorno não há org para
 *    auditar, e auditar sem org é linha órfã.
 * 3. SESSÃO logo depois do `state`, e antes de qualquer efeito: a assinatura
 *    prova que o `state` é nosso, não prova que quem volta é quem o pediu. São
 *    portas diferentes, e esta abre com um único uso.
 * 4. QUEIMA DO NONCE antes de trocar o código, e este é o passo cuja ordem mais
 *    parece indiferente. Queimar DEPOIS gastaria o `code` do Google — que é de
 *    uso único — antes de descobrir que o `state` era repetido, e quem
 *    apresentasse o legítimo receberia "código já usado": um erro que manda o
 *    diagnóstico para o Google em vez de para nós. Não é só falhar fechado; é
 *    falhar de forma que quem investiga chegue no lugar CERTO.
 * 5. escopo DEPOIS da troca e ANTES de gravar: a tela do Google deixa desmarcar
 *    escopo por escopo, e uma conexão gravada como saudável sem
 *    `calendar.events` só falharia no primeiro agendamento — longe daqui, com
 *    uma mensagem que culpa o calendário.
 * 6. cifra ANTES do upsert: gravar o token em claro por um instante é gravá-lo
 *    em claro.
 */

import { NextResponse, type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { PROVEDOR_GOOGLE } from "@/lib/agenda/tipos";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";
import { CAMINHO_DO_CALLBACK, configuracaoDoGoogle } from "@/lib/agenda/google/config";
import { verificarEstado } from "@/lib/agenda/google/estado";
import { NOME_DO_VINCULO, vinculoConfere } from "@/lib/agenda/google/vinculo";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { escoposFaltando } from "@/lib/agenda/google/oauth";
import { trocarCodigoPorToken } from "@/lib/agenda/google/token";
import { contaDaAgendaPrimaria } from "@/lib/agenda/google/calendarios";
import { classificarErroDoGoogle } from "@/lib/agenda/google/erros";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

/**
 * A volta para a Agenda — por PÁGINA-PONTE, e não por redirect.
 *
 * ⚠️ ISTO ERA UM `NextResponse.redirect`, E É O QUE DESLOGAVA A PESSOA.
 *
 * O relato do dono do produto na v1.9.0: "clico em Conectar Google, seleciono
 * minha conta, e ELE DESLOGA DA MINHA CONTA". A sessão nunca foi tocada — não há
 * `signOut` em caminho nenhum desta rota, e o cookie de sessão tem 400 dias.
 *
 * O que acontecia é o SEGUNDO SALTO: um 307 daqui para `/app/agenda` ainda
 * pertence à cadeia de navegação iniciada em `accounts.google.com`. O cookie de
 * sessão é `SameSite=Strict` e não viaja com initiator cross-site, então o
 * `proxy.ts` não enxergava usuário e mandava para `/login`.
 *
 * MEDIDO EM NAVEGADOR (`tests/e2e/agenda-google-volta-nao-desloga.spec.ts`), com
 * o usuário comprovadamente logado um passo antes: ele parava em
 * `/login?next=%2Fapp%2Fagenda%3Ferro%3D...`. Era dedução no briefing; agora é
 * observação, em Chromium.
 *
 * A ponte resolve porque muda QUEM INICIA a navegação: o HTML volta com 200 no
 * nosso próprio origin, e o `location.replace` seguinte é disparado por um
 * documento nosso. Initiator same-site ⇒ o cookie Strict viaja.
 *
 * Por que não as alternativas:
 *   - baixar o cookie para `lax`: `Strict` é o que impede que qualquer site de
 *     terceiros dispare navegação top-level GET AUTENTICADA contra o CRM.
 *     Trocar a superfície do produto inteiro para consertar uma tela;
 *   - rota pública intermediária: quebra no mesmo ponto e cobra entrada nova em
 *     `PUBLIC_PATHS` — superfície pública nova para o que a rota já pública
 *     resolve;
 *   - tratar no proxy: não bastaria. `app/app/agenda/page.tsx` chama
 *     `requireAuth()`, que redireciona por conta própria — seria furar dois.
 *
 * As 14 saídas herdam de graça, porque todas passam por aqui.
 */
function voltar(parametro: string): NextResponse {
  const base = env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  const destino = new URL(`/app/agenda?${parametro}`, base).toString();
  // Escapado mesmo o valor vindo de literais nossos: a ponte é genérica, e o
  // dia em que alguém passar algo de fora por aqui não deve ser o dia em que
  // isto vira injeção.
  const seguro = destino
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const resposta = new NextResponse(
    `<!doctype html><html lang="pt-br"><head><meta charset="utf-8">` +
      `<meta name="robots" content="noindex">` +
      `<noscript><meta http-equiv="refresh" content="0;url=${seguro}"></noscript>` +
      `<title>Voltando…</title></head><body>` +
      `<p>Voltando para a sua agenda…</p>` +
      `<script>location.replace(${JSON.stringify(destino)})</script>` +
      `<noscript><p><a href="${seguro}">Continuar</a></p></noscript>` +
      `</body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
  );
  // A LIMPEZA MORA AQUI, e não em cada saída, porque esta rota tem catorze delas
  // e uma que esquecesse deixaria um vínculo vivo até o TTL. Toda volta passa
  // por esta função — sucesso e erro —, então o cookie morre com o fluxo.
  //
  // `Set-Cookie` funciona igual num 200: a limpeza não dependia do redirect.
  resposta.cookies.set(NOME_DO_VINCULO, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: cookieSecure(),
    path: CAMINHO_DO_CALLBACK,
    maxAge: 0,
  });
  return resposta;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const recusa = url.searchParams.get("error");
  const code = url.searchParams.get("code");
  const stateBruto = url.searchParams.get("state");

  // 1. A pessoa desistiu. Não é falha: é alguém clicando "Cancelar".
  if (recusa) return voltar("erro=conexao_cancelada");

  // 2. Quem está voltando? Sem isto não há org para auditar.
  // ⚠️ SOB `try`, e a razão mudou com esta rota: ela agora é alcançável sem
  // sessão (está em `PUBLIC_PATHS`). `verificarEstado` LANÇA quando o
  // `INTERNAL_SECRET` é curto demais, e um throw aqui viraria 500 com stack no
  // log, arrancável por qualquer anônimo em laço. Falha fechada com mensagem,
  // nunca 500 anônimo — é a mesma proteção que a rota de IDA já tinha.
  let estado: ReturnType<typeof verificarEstado> = null;
  try {
    estado = verificarEstado(stateBruto, { segredo: env.INTERNAL_SECRET, agora: new Date() });
  } catch {
    return voltar("erro=retorno_nao_verificavel");
  }
  if (!estado) {
    // Um motivo só para assinatura inválida, prazo vencido e formato estranho:
    // distinguir na URL entregaria a um atacante a diferença que ele precisa
    // para calibrar. O detalhe fica no audit, que é do servidor.
    await audit({
      action: "agenda.google.conexao_falhou",
      metadata: { reason: "state_invalido" },
    });
    return voltar("erro=retorno_nao_verificavel");
  }
  const { organizationId, userId } = estado;

  // ⚠️ QUEM VOLTOU É QUEM SAIU — e esta verificação vem ANTES da queima do nonce.
  //
  // A ORDEM É LOAD-BEARING. Enquanto o `proxy` barrava todo mundo, tanto fazia:
  // ninguém anônimo chegava aqui. Agora que a rota é pública, queimar o nonce
  // antes de conferir o vínculo daria a quem tem um `state` vazado um botão de
  // NEGAÇÃO DE SERVIÇO: ele queima, e o dono legítimo, ao voltar do Google
  // trinta segundos depois, recebe `state_reutilizado`. Quem reordenar isto
  // reabre a porta — e os dois ramos falham com a MESMA mensagem, então o
  // erro não apareceria em teste que só olhe o desfecho.
  //
  // A verificação que estava aqui era `loadAuthUser()` comparado ao `userId` do
  // `state`, e ela REPROVAVA SEMPRE: `loadAuthUser` lê o cookie de sessão, que é
  // `sameSite: "strict"` e não viaja na volta de `accounts.google.com`. Medido
  // em produção na v1.8.0: a conexão com o Google nunca completou em instalação
  // nenhuma. O que ela prometia — e o que o vínculo entrega no lugar — está
  // escrito no cabeçalho de `vinculo.ts`, inclusive o caso que fica de fora.
  const vinculo = req.cookies.get(NOME_DO_VINCULO)?.value;
  if (!vinculoConfere(vinculo, estado.nonce, env.INTERNAL_SECRET)) {
    // AUDITAR SÓ AQUI, depois de o vínculo falhar por um `state` que ao menos
    // tinha assinatura válida. Auditar antes daria a qualquer anônimo uma
    // escrita ilimitada em `api_audit_log` — tabela append-only, retenção de
    // cinco anos, numa VPS com cota de disco.
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: { reason: "vinculo_ausente_ou_nao_confere", user_id: userId },
    });
    // Um destino só: distinguir "sem vínculo" de "vínculo de outra pessoa"
    // contaria a quem ataca se o `state` que ele tem pertence a alguém.
    return voltar("erro=retorno_nao_verificavel");
  }

  if (!code) {
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: { reason: "sem_codigo", user_id: userId },
    });
    return voltar("erro=retorno_incompleto");
  }

  const app = await configuracaoDoGoogle();
  if (!app) return voltar("erro=google_nao_configurado");

  // ⚠️ QUEIMA DO NONCE — e ela vem ANTES de trocar o código, não depois.
  //
  // O `state` é assinado e tem prazo de dez minutos; dentro dele valia quantas
  // vezes fosse apresentado. A chave primária da tabela é o próprio nonce
  // (migration 0190): a segunda tentativa viola a unicidade, e é assim que o
  // replay é recusado.
  //
  // A ORDEM É A PARTE FÁCIL DE PERDER. Queimar DEPOIS da troca gastaria o
  // `code` do Google — que é de uso único — antes de descobrir que o `state`
  // era repetido, e quem apresentasse o legítimo receberia "código já usado",
  // um erro que aponta para o Google e não para o replay.
  const admin = createAdminClient();
  const { error: erroDoNonce } = await admin.from("calendar_oauth_nonces").insert({
    nonce: estado.nonce,
    organization_id: organizationId,
    user_id: userId,
    expira_em: new Date(estado.expiraEmMs).toISOString(),
  });
  if (erroDoNonce) {
    // `23505` é unicidade: o nonce já foi usado. Qualquer outro erro também
    // recusa — não dá para garantir uso único sem conseguir gravar, e seguir
    // seria abrir a porta justamente quando o guarda está indisponível.
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: {
        reason: erroDoNonce.code === "23505" ? "state_reutilizado" : "nonce_indisponivel",
        user_id: userId,
      },
    });
    return voltar("erro=retorno_nao_verificavel");
  }

  // 3. Troca o código pelos tokens.
  const leitura = await trocarCodigoPorToken(app, code, { agora: new Date() });
  if (!leitura.ok) {
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: { reason: leitura.motivo, detalhe: leitura.detalhe, user_id: userId },
    });
    return voltar("erro=troca_de_codigo_falhou");
  }
  const token = leitura.token;

  // 4. A pessoa desmarcou algum escopo obrigatório?
  const faltando = escoposFaltando(token.scope);
  if (faltando.length > 0) {
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: { reason: "scope_missing", faltando, user_id: userId },
    });
    return voltar("erro=permissao_incompleta");
  }

  // 5. De quem é a agenda, e em que fuso ela vive.
  const conta = await contaDaAgendaPrimaria(token.access_token);
  if (!conta.ok) {
    // ─── O MOTIVO do Google era jogado fora, e a tela mandava tentar de novo ──
    //
    // Medido em produção em 2026-09-01: três tentativas seguidas, todas
    // `{"reason":"conta_indisponivel","detalhe":"HTTP 403"}`. O corpo do Google
    // — que diz `accessNotConfigured`, `PERMISSION_DENIED` ou o que for — já
    // vinha em `conta.erro` e morria aqui: nem auditoria, nem log.
    //
    // O custo não é só diagnóstico. 403 por API desligada NÃO passa com o
    // tempo, e a tela dizia "Tente de novo" — mandando a pessoa repetir para
    // sempre um caminho que não tem como funcionar. Um conselho errado é pior
    // que nenhum, porque ocupa o lugar do certo.
    //
    // `classificarErroDoGoogle` já sabia ler esse corpo e já era usada no resto
    // do módulo. Este era o único ponto que não a chamava.
    const classificacao = classificarErroDoGoogle(conta.erro, "listar");
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: {
        reason: "conta_indisponivel",
        detalhe: conta.detalhe,
        // O que faltava para diagnosticar sem adivinhar.
        motivo_do_google: classificacao.motivo,
        mensagem_do_google: classificacao.mensagem,
        user_id: userId,
      },
    });
    // `sem_permissao` é o 403 que NÃO é cota — o classificador já separa os
    // dois. Ele merece tela própria porque a ação é do dono da instalação, no
    // Google Cloud, e não da pessoa que clicou.
    if (classificacao.desfecho === "sem_permissao") {
      return voltar("erro=google_recusou_o_acesso");
    }
    return voltar("erro=conta_indisponivel");
  }

  // 6. Cifra ANTES de gravar. `encryptWebhookSecret` devolve `null` quando a
  //    chave de cifra da instalação não está ativa — e aqui isso vira uma
  //    recusa em português, não a exceção do Postgres que nomeia um parceiro.
  // ⚠️ SEM `refresh_token` A CONEXÃO NASCE MORTA, e o pior é que ela nasce
  // parecendo viva. Todo o argumento do `prompt=consent` na rota de ida existe
  // para garantir que ele venha; se ainda assim não vier, gravar `healthy` faz a
  // agenda funcionar por uma hora e parar calada — o relato chega no dia
  // seguinte como "minha agenda parou de sincronizar", longe daqui.
  //
  // Reconexão é o caso legítimo em que ele pode faltar: quem já tem uma chave
  // guardada para ESTA conta não precisa de outra. Por isso a decisão depende do
  // que já existe, e não só do que veio agora.
  let refreshJaGuardado = false;
  if (!token.refresh_token) {
    const { data: existente } = await admin
      .from("calendar_connections")
      .select("oauth_refresh_token_encrypted")
      .eq("organization_id", organizationId)
      .eq("user_id", userId)
      .eq("provider", PROVEDOR_GOOGLE)
      .eq("account_email", conta.conta.email)
      .maybeSingle();
    refreshJaGuardado = Boolean(existente?.oauth_refresh_token_encrypted);

    if (!refreshJaGuardado) {
      await audit({
        action: "agenda.google.conexao_falhou",
        organizationId,
        metadata: { reason: "sem_token_de_renovacao", user_id: userId },
      });
      return voltar("erro=sem_token_de_renovacao");
    }
  }

  const accessCifrado = await encryptWebhookSecret(admin, token.access_token);
  const refreshCifrado = token.refresh_token ? await encryptWebhookSecret(admin, token.refresh_token) : null;
  if (!accessCifrado || (token.refresh_token && !refreshCifrado)) {
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: { reason: "cifra_indisponivel", user_id: userId },
    });
    return voltar("erro=cifra_indisponivel");
  }

  // 7. Grava. `organization_id` e `user_id` vêm do `state` ASSINADO, nunca da
  //    query — service role bypassa RLS, então a fonte confiável é obrigatória.
  const { data: conexaoGravada, error: erroAoGravar } = await admin.from("calendar_connections").upsert(
    {
      organization_id: organizationId,
      user_id: userId,
      // A CONSTANTE também aqui, embora o literal estivesse CERTO: enquanto o
      // único lugar que escreve o valor certo o escreve à mão, o símbolo
      // canônico segue órfão — e foi a orfandade que deixou três leituras
      // divergirem sem nada acusar.
      provider: PROVEDOR_GOOGLE,
      account_email: conta.conta.email,
      oauth_access_token_encrypted: accessCifrado,
      // Quando o Google não reenviou a chave e já havia uma guardada, a coluna
      // fica FORA do upsert: `on conflict do update` só toca o que recebe, então
      // omitir preserva. Mandar `null` aqui apagaria a chave que faz a conexão
      // sobreviver à primeira hora — é a mesma armadilha de `fundirTokens`, um
      // andar acima.
      ...(refreshCifrado ? { oauth_refresh_token_encrypted: refreshCifrado } : {}),
      token_expires_at: token.expira_em,
      scopes: token.scope,
      status: "healthy",
      last_sync_error: null,
    },
    { onConflict: "organization_id,user_id,provider,account_email" },
  )
    .select("id")
    .single();

  if (erroAoGravar) {
    await audit({
      action: "agenda.google.conexao_falhou",
      organizationId,
      metadata: { reason: "upsert_falhou", detalhe: erroAoGravar.message, user_id: userId },
    });
    return voltar("erro=nao_consegui_guardar");
  }

  // 8. REGISTRA O CALENDÁRIO PRIMÁRIO. Sem esta linha a conexão existe e não sincroniza
  //    nada: o cron lê `calendar_connection_calendars` com `.eq("counts_for_conflicts",
  //    true)` e, com a tabela vazia, itera ZERO calendários para sempre. Medido: até aqui
  //    não havia UM insert nessa tabela em todo o código de produção — só em dois arquivos
  //    de teste, que por isso passavam enquanto o produto não sincronizava nada.
  //
  //    Tudo o que ela pede já está na mão aqui: `external_calendar_id` é o próprio e-mail
  //    (o comentário de `ContaDaAgenda` diz que o id do calendário primário É o e-mail), e
  //    `counts_for_conflicts` nasce `true` — exatamente o filtro do cron.
  //
  //    ⚠️ SÓ O PRIMÁRIO, e é DECISÃO e não limitação: uma conta Google pode ter vários
  //    calendários, e `contaDaAgendaPrimaria` lê um. Registrar só ele evita que a agenda de
  //    aniversários e as assinadas de terceiros passem a ocupar horário da pessoa sem que
  //    ela tenha escolhido. Escolher entre vários é tela, não callback — e enquanto essa
  //    tela não existe, o palpite seguro é o calendário que é da pessoa.
  if (conexaoGravada?.id) {
    const { error: erroDoCalendario } = await admin.from("calendar_connection_calendars").upsert(
      {
        organization_id: organizationId,
        connection_id: conexaoGravada.id,
        external_calendar_id: conta.conta.email,
        name: conta.conta.email,
        is_primary: true,
        // O fuso que até aqui só ia para o audit. `null` quando o Google não mandou: quem
        // lê trata ausência como "não sei" e cai no fuso da organização — nunca em UTC,
        // que é ausência disfarçada de escolha.
        time_zone: conta.conta.fuso,
      },
      { onConflict: "organization_id,connection_id,external_calendar_id" },
    );
    if (erroDoCalendario) {
      // Não derruba a conexão: ela está gravada e é o que o usuário pediu. Mas sem o
      // calendário o sync fica mudo, então isto precisa ser VISÍVEL.
      await audit({
        action: "agenda.google.conexao_falhou",
        organizationId,
        metadata: { reason: "calendario_primario_nao_registrado", detalhe: erroDoCalendario.message, user_id: userId },
      });
    }
  }

  await audit({
    action: "agenda.google.conexao_concluida",
    organizationId,
    metadata: { user_id: userId, account_email: conta.conta.email, fuso: conta.conta.fuso },
  });

  return voltar("ok=agenda_conectada");
}
