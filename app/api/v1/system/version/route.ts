/**
 * GET /api/v1/system/version — estado da atualização para a tela.
 *
 * Responde 200 para qualquer sessão, mas só entrega o estado operacional a
 * quem é dono do servidor (`is_platform_admin`). Quem não pode agir vê apenas
 * a versão instalada: aviso sem ação disponível é só ansiedade.
 */
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { loadAuthUser } from "@/lib/auth/server";
import { semSmtpNaInstalacao } from "@/lib/email/estado";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  runtimeIdentity,
  runtimeConfirmationSchema,
  newerOfficialRelease,
  supportsForcedUpdate,
} from "@/lib/system/runtime-identity";
import { extractChangelogRange } from "@/lib/system/changelog";
import { retratoDoHostVelho } from "@/lib/system/retrato";
import {
  isRunStale,
  rodadaDoBancoDaLinha,
  rollbackDesmentidoPeloApp,
  rollbackFoiSuperado,
  sucessoJaInstalado,
  type RunStatus,
  type RunStep,
} from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

/** Sem notícia do agente por 24h, a tela ensina o caminho manual. */
const AGENT_OFFLINE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function GET(_req: NextRequest): Promise<Response> {
  const user = await loadAuthUser();
  // `unauthenticated` (não `unauthorized`): esse último é reservado ao segredo
  // interno das rotas host↔app (lib/api/errors.ts) — aqui falta é sessão.
  if (!user) return fail("unauthenticated", "Faça login para continuar.", 401);

  const db = createAdminClient();
  const { data: version, error: versionError } = await db
    .from("system_version")
    .select(
      "runtime_confirmation, current_version, latest_version, off_release, compare_failed, has_known_release, changelog_raw, agent_last_seen_at, updated_at",
    )
    .eq("id", 1)
    .maybeSingle();

  // Sem checar o erro, uma falha de leitura vira `current = ""` em silêncio —
  // e mais abaixo isso poderia se disfarçar de "sem atualização disponível".
  if (versionError) {
    logger.error("[system/version] leitura de system_version falhou", {
      error: versionError.message,
    });
    return fail("internal_error", "Não consegui ler o estado da atualização.", 500);
  }

  const now = new Date();
  const identity = runtimeIdentity(version?.runtime_confirmation, version?.agent_last_seen_at, now);
  const observation = runtimeConfirmationSchema.safeParse(version?.runtime_confirmation);
  const current =
    identity.status === "legacy" ? (version?.current_version ?? "") : (identity.base_version ?? "");

  // `from_version`/`to_version`/`log_tail` NÃO são enfeite: numa falha, a
  // versão do `system_version` é o `git describe` do HOST, e o checkout já
  // aconteceu — ela nomeia a versão que QUEBROU, não a que está no ar. Quem
  // sabe disso é o run (de onde saiu, para onde tentou ir). E o log é o único
  // diagnóstico que o dono tem sem abrir um terminal, que é justamente o que
  // esta feature existe para eliminar.
  //
  // Lido ANTES da bifurcação por papel de propósito: o rodapé da sidebar (que
  // todo mundo vê) e esta tela precisam falar da MESMA versão — a que está
  // rodando.
  const { data: run, error: runError } = await db
    .from("system_update_runs")
    .select(
      "id, status, last_step, dispatched_at, finished_at, from_version, to_version, log_tail, disputa_de_banco, retentativas_do_banco, passada_do_banco, requested_by",
    )
    .order("dispatched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (runError) {
    logger.error("[system/version] leitura do run mais recente falhou", {
      error: runError.message,
    });
    return fail("internal_error", "Não consegui ler o estado da atualização.", 500);
  }

  const lastSeen = version?.agent_last_seen_at ? Date.parse(version.agent_last_seen_at) : NaN;

  // Legacy heartbeats retain their temporal guard, explicitly unverified.
  // Modern observations require all applicable services, identity and freshness.
  const rollbackSuperado =
    identity.status === "legacy" &&
    rollbackFoiSuperado(version?.updated_at, run?.finished_at, current, run);
  const falhaDesmentidaPeloApp = rollbackDesmentidoPeloApp(run, process.env.APP_VERSION, identity);
  const falhaSuperada =
    (run?.status === "failed_rolled_back" || run?.status === "failed") &&
    (rollbackSuperado || falhaDesmentidaPeloApp);
  // O outro lado do mesmo silêncio: o run deu CERTO e o host ainda não bateu.
  // `current_version` segue nomeando a versão antiga por alguns minutos, e sem
  // isto `update_available` continua verdadeiro — a tela volta do reinício
  // oferecendo "Atualizar agora" para a versão que acabou de ser instalada.
  //
  // A janela NÃO promove a `to_version` a "versão no ar": quem afirma versão
  // instalada é a última que o HOST confirmou, e mais nada. Promover era o
  // defeito da issue 1101 — com o host calado desde a batida anterior, a tela
  // anunciava `1.32.0` por tempo indeterminado com o container rodando
  // `1.23.0`. Aqui a janela esconde o botão e DIZ que a confirmação não chegou;
  // depois dela, `sucessoJaInstalado` corta a assunção sozinho.
  const acabouDeInstalar = sucessoJaInstalado(version?.updated_at, run?.finished_at, run, now);

  // Quem pode AFIRMAR versão instalada é o host, e só ele — `current`. O único
  // run que sobrepõe isso é o rollback: ali o host reporta a versão que QUEBROU
  // e o run é a única testemunha de qual imagem voltou ao ar.
  //
  // O sucesso NÃO entra na lista. Promover o `to_version` de um run
  // bem-sucedido a "versão no ar" foi o defeito da issue 1101: o `update.sh`
  // termina bem, o app não sobe na imagem nova, o host nunca mais bate — e a
  // tela anuncia `1.32.0` indefinidamente com o container rodando `1.23.0`.
  // Janela de silêncio é uma coisa (`just_updated`, logo abaixo), afirmação de
  // versão é outra.
  const running =
    identity.status === "legacy" &&
    run?.status === "failed_rolled_back" &&
    run.from_version &&
    !rollbackSuperado &&
    !falhaDesmentidaPeloApp
      ? run.from_version
      : current;

  if (!user.is_platform_admin) {
    return ok({ current_version: running, is_owner: false, identity });
  }

  const latest = version?.latest_version ?? "";
  // A faixa INTEIRA entre o que está no ar e o que vai entrar, não só a seção
  // da versão-alvo. Mostrar só a alvo perdia aviso: quem pulava da 1.4.0 para a
  // 1.6.0 nunca lia a 1.4.1 nem a 1.5.0 — e a 1.4.1 existia para corrigir uma
  // instrução invertida que mandava apagar a conexão que estava funcionando.
  //
  // O limite inferior é `running`, NUNCA `current`: depois de um rollback,
  // `current` nomeia a versão que quebrou, e a faixa sairia vazia justamente
  // para quem mais precisa lê-la.
  const faixa = latest
    ? extractChangelogRange(version?.changelog_raw ?? "", latest, running)
    : null;

  // #2755 (item 3) — quem administra a instalação precisa VER que ela não envia
  // e-mail. Até aqui esse estado só existia no log do `update.sh`, e a tela de
  // atualização exibia só o log: o dono descobria o problema quando alguém
  // reclamava de não receber a recuperação de senha. Vem na resposta do DONO
  // (`is_platform_admin`) porque é ele quem configura o SMTP — para quem não
  // pode agir, aviso sem ação é só ansiedade.
  //
  // A leitura é a que já existe (`lerSmtp`, a mesma tela de /admin/email usa) e
  // a régua é a MESMA da ação que sofre com isso (`semSmtpNaInstalacao`): fora
  // do single-server o login tem e-mail próprio, e `true` ali é a resposta
  // honesta — não há o que avisar.
  const smtpConfigurado = !(await semSmtpNaInstalacao());

  return ok({
    current_version: running,
    identity,
    runtime_services: observation.success ? observation.data.services : null,
    official_latest_version: observation.success
      ? (observation.data.published_release ?? "")
      : (version?.latest_version ?? ""),
    manual_reconciliation_required: identity.customized === true,
    is_owner: true,
    force_update_supported: supportsForcedUpdate(
      version?.runtime_confirmation,
      version?.agent_last_seen_at,
      now,
    ),
    smtp_configured: smtpConfigurado,
    latest_version: latest,
    update_available:
      // `!acabouDeInstalar` é o degrau histórico: na janela logo após um
      // sucesso, o host ainda não bateu, `current` nomeia a versão antiga e a
      // tela reofereceria "Atualizar agora" para o que acabou de ser instalado.
      // O que mudou na 1101 é que a janela esconde o botão SEM promover o
      // `to_version` a versão instalada — a tela diz que o alvo foi pedido e a
      // versão confirmada é a antiga, em vez de afirmar a nova e não voltar
      // atrás nunca. `sucessoJaInstalado` fecha a janela sozinho passados
      // `RUN_STALE_AFTER_MS` do fim do run.
      Boolean(latest) &&
      !acabouDeInstalar &&
      (identity.status === "legacy"
        ? latest !== running
        : identity.status === "confirmed" && newerOfficialRelease(running, latest) === true),
    off_release:
      identity.status === "legacy" ? (version?.off_release ?? false) : identity.customized === true,
    // Sem isto, a tela lê "sem versão nova anunciada" como "você está em dia" —
    // e uma instalação atrasada cujo host não conseguiu comparar é informada de
    // que está atualizada, em silêncio.
    compare_failed:
      (version?.compare_failed ?? false) || !["legacy", "confirmed"].includes(identity.status),
    // Só importa quando `off_release` e sem `latest_version` — distingue "à
    // frente da última publicada" (existe release, já contida no HEAD) de
    // "este fork nunca teve release nenhuma". Default `true`: preserva "à
    // frente da publicada" para quem nunca gravou este campo (linha ainda
    // não tocada por nenhum heartbeat, coluna com o default da migration).
    has_known_release: version?.has_known_release ?? true,
    agent_online: !Number.isNaN(lastSeen) && now.getTime() - lastSeen < AGENT_OFFLINE_AFTER_MS,
    // A IDADE DO RETRATO (#3488). `agent_online` sozinho não alcança: com 24h
    // de paciência, o retrato fica quatro horas velho e a tela continua
    // afirmando "é a mais recente" com convicção total. Este campo é a mesma
    // informação com a régua da FRESCURA (`RETRATO_VELHO_APOS_MS`), que é a
    // pergunta que a frase final faz de verdade: "conferi isso agora?".
    //
    // Vem separado de `agent_online` de propósito — os dois respondem coisas
    // diferentes (24h = "posso atualizar sozinho?"; 30 min = "posso afirmar que
    // está em dia?"), e juntá-los faria a tela ensinar o caminho manual a quem
    // só precisava esperar a próxima batida.
    agent_stale: retratoDoHostVelho(version?.agent_last_seen_at, now),
    // Desde quando o retrato é o que é — a tela diz "sem notícias desde 14h45"
    // em vez de um "não sei" sem idade, que não ajuda ninguém a decidir se
    // espera mais cinco minutos ou chama quem cuida do servidor.
    agent_last_seen_at: version?.agent_last_seen_at ?? null,
    // A janela em que a atualização TERMINOU e o host ainda não contou. É o que
    // deixa a tela dizer que o pedido terminou, em vez de cair no texto
    // genérico de quem nunca atualizou nada — e ela se fecha sozinha na batida
    // seguinte do agente, ou no fim de validade de `sucessoJaInstalado`.
    //
    // NÃO promove `current_version`: o que esta janela permite dizer é "o
    // pedido terminou", nunca "você está na versão X" (issue 1101). A
    // versão-alvo viaja no `run`, para a tela nomeá-la como pedido.
    just_updated: acabouDeInstalar,
    notes:
      faixa && faixa.secoes.length > 0
        ? {
            // Consolidados no topo, cada um dizendo de que versão veio: numa
            // faixa de várias versões, "reconecte o número" sem dizer de qual
            // release não informa o operador — assusta.
            requires_attention: faixa.secoes
              .filter((s) => s.requiresAttention)
              .map((s) => ({ version: s.version, texto: s.requiresAttention ?? "" })),
            sections: faixa.secoes.map((s) => ({ version: s.version, body: s.body })),
            // `false` = o texto recebido não alcança a versão que está no ar, e
            // a última seção da lista pode estar cortada no meio da frase. A
            // tela precisa DIZER isso — corpo truncado é indistinguível de
            // corpo inteiro para quem lê.
            complete: faixa.completa,
          }
        : null,
    run: run
      ? {
          id: run.id,
          // A tela CONTA o tempo desde aqui. Sem esta data, o intervalo entre o
          // clique e o agente pegar o pedido é uma lista de quatro círculos
          // vazios, parada, sem nada que se mexa.
          dispatched_at: run.dispatched_at,
          // `unknown` é derivado aqui, não gravado: um agente morto não
          // consegue anunciar a própria morte.
          status:
            run.status === "dispatched" && isRunStale(run.dispatched_at, now)
              ? ("unknown" as const)
              : (run.status as RunStatus),
          last_step: (run.last_step as RunStep | null) ?? null,
          from_version: run.from_version ?? "",
          to_version: run.to_version ?? "",
          // Quando o run fechou — é a hora que o aviso da volta automática
          // mostra ("às 14h10"). Nulo enquanto o run ainda está em curso.
          finished_at: run.finished_at ?? null,
          // "Ninguém pediu isto": o run da volta automática nasce sem autor
          // (o `agent.sh` manda o fato, não um pedido). A tela usa isso para
          // dizer "voltou sozinho" em vez de "voltei" — a diferença importa
          // para quem lê, porque um houve clique e o outro não.
          // `requested_by` sozinho não basta: a FK é `on delete set null`, e
          // um run pedido por alguém que depois saiu também fica nulo. O run
          // da volta automática nasce já fechado (`dispatched_at` = `finished_at`,
          // gravados juntos pela rota do agente); um run pedido pela tela
          // nunca fecha no mesmo instante em que foi pedido.
          volta_automatica:
            run.requested_by === null &&
            run.finished_at != null &&
            run.finished_at === run.dispatched_at,
          log_tail: run.log_tail ?? "",
          superseded: falhaSuperada,
          // O que a rodada contou sobre o banco — disputa, retentativas e em
          // qual passada fechou. Ausente quando o kit não mediu (rodada que não
          // passou pelo banco): a tela fica calada em vez de afirmar zero.
          rodada_do_banco: rodadaDoBancoDaLinha(run),
        }
      : null,
  });
}
