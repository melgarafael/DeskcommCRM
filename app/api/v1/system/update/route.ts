import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/system/update — o clique do dono.
 *
 * Não executa nada: cria o run em `dispatched` e marca o pedido. Quem executa é
 * o agente do host, no próximo heartbeat. O app escreve APENAS esta transição —
 * é o único instante em que ele sabe com certeza que a ordem saiu.
 *
 * ## O corpo: `{ force: true }` (#2756)
 *
 * O botão "Forçar atualização" da tela manda a INTENÇÃO, nunca um comando. O
 * `--to` e o `--force` são derivados AQUI, a partir do MESMO run de falha que a
 * tela leu para montar o comando que ela mostra ao lado do botão: a tela chama
 * `comandoDeVolta(run.from_version)`, este arquivo chama o espelho logo abaixo,
 * e os dois testes costuram as pontas com a mesma frase literal. Cliente com
 * poder de comando é a superfície que a opção (B) da issue abria; aqui é uma
 * chave só.
 *
 * A força é também o ÚNICO caminho — junto com a volta — que atravessa o 409
 * "você já está na versão mais recente": depois de uma falha o `git checkout`
 * já tinha dado certo, o host passa a reportar a versão ALVO e `current`
 * coincide com `latest`. Sem `--force` o próprio `update.sh` responderia a
 * mesma coisa e sairia com 0 — o falso sucesso que mantinha o botão desligado.
 */
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  runtimeIdentity,
  newerOfficialRelease,
  supportsForcedUpdate,
} from "@/lib/system/runtime-identity";
import { ehVersaoPublicada, isRunStale } from "@/lib/system/update-run";

export const dynamic = "force-dynamic";

const RUN_IN_PROGRESS_MESSAGE = "Já existe uma atualização em andamento.";
const SEM_FALHA_PARA_DESFAZER = "Não há nenhuma atualização com falha para desfazer agora.";
const SEM_FALHA_PARA_FORCAR = "Não há nenhuma atualização com falha para forçar agora.";

/**
 * O corpo é lido com folga de propósito: o clique antigo da própria tela manda
 * `{}` (e uma versão ainda mais antiga nem corpo manda). Recusar corpo
 * malformado aqui quebraria o "Atualizar agora" para consertar o "Voltar" — as
 * únicas perguntas que este corpo faz são se o pedido é uma VOLTA ou uma FORÇA.
 */
const corpoDoPedido = z.object({ rollback: z.boolean().optional(), force: z.boolean().optional() });

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const user = await loadAuthUser();
  // `unauthenticated` (não `unauthorized`): esse último é reservado ao segredo
  // interno das rotas host↔app (lib/api/errors.ts) — aqui falta é sessão.
  if (!user) return fail("unauthenticated", "Faça login para continuar.", 401);
  // Atualizar o servidor é ESCRITA da instalação: support_readonly e sessão com
  // dívida de MFA não disparam. O 401 acima fica: sem sessão é `unauthenticated`.
  try {
    await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(
      err,
      undefined,
      "Só o dono do servidor pode atualizar o sistema.",
    );
  }

  const db = createAdminClient();
  const { data: version, error: versionError } = await db
    .from("system_version")
    .select(
      "current_version, latest_version, runtime_confirmation, agent_last_seen_at, compare_failed",
    )
    .eq("id", 1)
    .maybeSingle();

  // Sem checar o erro, uma falha de leitura (outage, rede) vira `current`/
  // `latest` vazios — e cai direto no 409 "você já está em dia" abaixo. É a
  // pior mensagem possível bem na hora de uma falha de infraestrutura.
  if (versionError) {
    logger.error("[system/update] leitura de system_version falhou", {
      error: versionError.message,
    });
    return fail("internal_error", "Não consegui ler o estado da atualização.", 500);
  }

  const identity = runtimeIdentity(version?.runtime_confirmation, version?.agent_last_seen_at);
  const current =
    identity.status === "legacy" ? (version?.current_version ?? "") : (identity.base_version ?? "");
  const latest = version?.latest_version ?? "";

  const corpo = corpoDoPedido.safeParse(await req.json().catch(() => ({})));
  // Força e volta são dois pedidos distintos sobre o MESMO run de falha; um
  // corpo só traz as duas por engano, e aí a força vence — ela é o
  // superconjunto: faz o mesmo alvo quando a versão de origem é publicada, e
  // ainda passa quando ela não é (aí a volta recusa com 409).
  const querForcar = corpo.success && corpo.data.force === true;
  const querVoltar = corpo.success && corpo.data.rollback === true && !querForcar;

  // A customized image must be reconciled, including on rollback: replacing
  // it with a public tag would silently remove patches. Old kits remain
  // compatible; modern incomplete observations cannot authorize deployment.
  if (identity.customized === true) {
    return fail(
      "state_conflict",
      "Esta instalação é personalizada. Concilie as alterações antes de trocar as imagens.",
      409,
    );
  }
  if (identity.status !== "legacy" && identity.status !== "confirmed") {
    return fail(
      "state_conflict",
      "A execução dos serviços ainda não foi confirmada. Aguarde a próxima verificação do servidor.",
      409,
    );
  }
  if (
    !querVoltar &&
    !querForcar &&
    (version?.compare_failed ||
      (identity.status === "confirmed" && newerOfficialRelease(current, latest) !== true))
  ) {
    return fail(
      "state_conflict",
      "Não há atualização posterior confirmada para esta instalação.",
      409,
    );
  }

  if (
    querForcar &&
    !supportsForcedUpdate(version?.runtime_confirmation, version?.agent_last_seen_at)
  ) {
    return fail(
      "state_conflict",
      "O agente do servidor ainda não confirmou suporte para refazer a atualização pela tela.",
      409,
    );
  }

  // ── A volta para a versão anterior (#2757) ──────────────────────────────
  //
  // O pedido de VOLTAR não é uma atualização qualquer: o alvo é a versão de
  // onde a última tentativa SAIU (`from_version`), nunca a última publicada —
  // instalar a publicada seria reinstalar a release que acabou de quebrar. O
  // `--to … --force` que a tela mostra é este mesmo run, executado pelo
  // agente do host; aqui só se registra a ordem, como em todo pedido.
  //
  // O alvo sai do ÚLTIMO run, e ele tem de ser uma FALHA: run de sucesso não
  // tem o que desfazer, e pegar o `from_version` de um run velho qualquer
  // devolveria o sistema para uma versão que ninguém acabou de sair.
  let alvoDaVolta = "";
  // A frase que o botão de força executa e o `--to` que sai dela — derivados do
  // MESMO run de falha, como `comandoDeVolta` faz na tela. `comandoDaForca` é o
  // que vai para o log: é ele que prova, sem SSH, qual comando o clique pediu.
  let alvoDaForca = "";
  let comandoDaForca = "";
  let runAnteriorDaForca = "";
  if (querVoltar) {
    const { data: ultimaTentativa, error: leituraFalha } = await db
      .from("system_update_runs")
      .select("id, status, from_version")
      .order("dispatched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (leituraFalha) {
      logger.error("[system/update] leitura do run da volta falhou", {
        error: leituraFalha.message,
      });
      return fail("internal_error", "Não consegui ler a última atualização.", 500);
    }

    const falhou =
      ultimaTentativa?.status === "failed" || ultimaTentativa?.status === "failed_rolled_back";
    const de = (ultimaTentativa?.from_version ?? "").trim();
    if (!falhou || !de) return fail("state_conflict", SEM_FALHA_PARA_DESFAZER, 409);

    // O MESMO critério do `comandoDeVolta` da tela: só há volta com NOME
    // quando a versão de onde se saiu é uma versão publicada. Fora dela
    // (instalação numa marca de desenvolvimento) não existe imagem publicada
    // para trás — e a saída continua sendo o comando de refazer, que a tela
    // mantém à vista.
    if (!ehVersaoPublicada(de)) {
      return fail(
        "state_conflict",
        "Não sei para qual versão voltar: a última atualização saiu de uma instalação sem versão publicada. Quem tem acesso ao servidor pode rodar o comando que a tela mostra.",
        409,
      );
    }
    // O agente faz `update.sh --to <isto>`, e as tags do repositório levam o
    // "v" — `git describe` devolve com ele, mas nem toda fonte guarda assim.
    alvoDaVolta = /^v/i.test(de) ? de : `v${de}`;
  }

  // ── A força na tela (#2756) ──────────────────────────────────────────────
  //
  // O MESMO run de falha da volta, e a MESMA conta que a tela faz em
  // `comandoDeVolta`: `from_version` publicada → `--to v<anterior> --force`;
  // fora de release (instalação seguindo o repositório) não existe imagem
  // publicada com esse nome para puxar, e aí o alvo fica VAZIO e o pedido é
  // `--force` puro, com o próprio `update.sh` resolvendo para onde ir.
  //
  // O que a força tem de diferente da volta: ela não exige versão publicada.
  // É justamente o buraco que a volta deixa — numa instalação fora de release
  // o único escape era o comando de copiar, e é o botão que fecha isso.
  if (querForcar) {
    const { data: ultimaTentativa, error: leituraFalha } = await db
      .from("system_update_runs")
      .select("id, status, from_version")
      .order("dispatched_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (leituraFalha) {
      // Silêncio aqui mudaria a AÇÃO: o botão executaria `--force` sem `--to`
      // enquanto a tela ao lado prometia o retorno para a versão anterior.
      logger.error("[system/update] leitura do run da força falhou", {
        error: leituraFalha.message,
      });
      return fail("internal_error", "Não consegui montar o pedido de força.", 500);
    }

    const falhou =
      ultimaTentativa?.status === "failed" || ultimaTentativa?.status === "failed_rolled_back";
    // Sucesso não tem o que forçar: a tela só abre o botão num estado de
    // falha, e um clique velho (ou cliente desatualizado) cai aqui.
    if (!falhou) return fail("state_conflict", SEM_FALHA_PARA_FORCAR, 409);

    // Espelho literal de `UpdatePanel.comandoDeVolta`, incluída a SEM normalizar
    // mais do que ela normaliza: se os dois lados divergirem por uma vírgula,
    // o botão passa a fazer uma coisa enquanto a tela promete outra.
    const anterior = (ultimaTentativa?.from_version ?? "").replace(/^v/i, "");
    const publicada = ehVersaoPublicada(anterior);
    comandoDaForca = publicada
      ? `bash hostgator-setup-kit/update.sh --to v${anterior} --force`
      : "bash hostgator-setup-kit/update.sh --force";
    alvoDaForca = publicada ? `v${anterior}` : "";
    runAnteriorDaForca = ultimaTentativa?.id ?? "";
  }

  // Só a força (e a volta) passa por aqui: `latest === current` é exatamente o
  // estado de falha que o botão existe para sair — o checkout já deu certo, o
  // host reporta a versão ALVO e ela é a mais recente.
  if (!querVoltar && !querForcar && (!latest || latest === current)) {
    return fail("state_conflict", "Você já está na versão mais recente.", 409);
  }

  const { data: running } = await db
    .from("system_update_runs")
    .select("id, status, dispatched_at")
    .eq("status", "dispatched")
    .order("dispatched_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (running) {
    if (!isRunStale(running.dispatched_at, new Date())) {
      return fail("state_conflict", RUN_IN_PROGRESS_MESSAGE, 409);
    }
    // Run "dispatched" vencido (>15min, RUN_STALE_AFTER_MS): o agente do host
    // morreu no meio (crash, VPS reiniciada, bug) sem nunca reportar o
    // desfecho. Sem isto, o índice único parcial (migration 0090) + o 409
    // acima travariam QUALQUER novo pedido pra sempre — o botão morreria em
    // silêncio até alguém abrir o banco à mão. Fechamos como `failed` (não é
    // o agente reportando via run_result; é o PRÓPRIO app declarando
    // inconclusivo) e seguimos com o pedido novo. `.eq("status","dispatched")`
    // faz a escrita só valer se ainda estiver "dispatched" nesse instante —
    // se o agente reportar o desfecho real bem nesse meio-tempo, esta escrita
    // não pega nada e o run real prevalece.
    const { error: staleError } = await db
      .from("system_update_runs")
      .update({
        status: "failed",
        finished_at: new Date().toISOString(),
        log_tail:
          "Run abandonado: o agente do host não reportou o desfecho a tempo (agente parado ou travado).",
      })
      .eq("id", running.id)
      .eq("status", "dispatched");
    if (staleError) {
      logger.error("[system/update] não consegui expirar o run travado", {
        error: staleError.message,
        runId: running.id,
      });
      return fail("internal_error", "Não consegui liberar a atualização travada.", 500);
    }
  }

  // O alvo do run: a força pedida (#2756), a volta pedida (#2757) ou — no
  // caminho de sempre — a última release publicada. `to_version` é o que viaja
  // para o agente no próximo heartbeat, e é por isso que os três caminhos
  // fecham na MESMA coluna: uma ordem só, com um alvo só. Força sem alvo
  // derivado (instalação fora de release) cai no `latest`, que é o que o
  // `update.sh --force` sem `--to` resolveria sozinho.
  const alvo = alvoDaForca || alvoDaVolta || latest;

  const { data: run, error } = await db
    .from("system_update_runs")
    .insert({
      from_version: current,
      to_version: alvo,
      status: "dispatched",
      force_requested: querForcar,
      requested_by: user.id,
    })
    .select()
    .single();

  if (error) {
    // A preparação de extensão e a atualização dividem a mesma cerca no
    // banco (migration 0271). A recusa tem uma saída pela gestão, não é uma pane.
    if (error.code === "P0001" && error.message === "extension_preparation_in_progress") {
      return fail(
        "state_conflict",
        "Há uma extensão em preparação. Abra Extensões: em Atividade recente, quem pediu pode retomar o pedido, e qualquer responsável pela instalação pode cancelá-lo antes de atualizar o sistema.",
        409,
      );
    }
    // O índice único parcial `uniq_system_update_runs_dispatched` (migration
    // 0090) é a garantia de banco contra dois cliques quase simultâneos: o
    // check acima (`running`) é só otimização, não exclusão mútua — sob
    // corrida, os dois requests podem passar por ele e só o segundo INSERT
    // bate na constraint. Isso é o MESMO estado de negócio do check acima
    // (já existe um run em andamento), não uma falha de infraestrutura.
    if (error.code === "23505") {
      return fail("state_conflict", RUN_IN_PROGRESS_MESSAGE, 409);
    }
    logger.error("[system/update] insert do run falhou", { error: error.message });
    return fail("internal_error", "Não consegui registrar o pedido de atualização.", 500);
  }

  if (!run) {
    return fail("internal_error", "Não consegui registrar o pedido de atualização.", 500);
  }

  // O run criado acima é a ordem — e é a ÚNICA. Havia aqui um segundo write
  // (`update_requested_at/by` em `system_version`) que respondia à mesma
  // pergunta sem transação e sem checar erro: falhando ele, a rota respondia
  // 200, a tela mostrava a barra de passos e o agente nunca pegava o pedido.
  // Quem pediu e quando já vive no próprio run (`requested_by`,
  // `dispatched_at`) e no audit log abaixo.

  // A prova de que o clique virou comando (#2756): a frase derivada aqui é a
  // MESMA que a tela mostra ao lado do botão, e este log é o que diz, sem SSH,
  // qual dos dois `update.sh` o pedido pediu. Sai DEPOIS do INSERT de propósito
  // — logar antes seria registrar como despachado um pedido que a cerca de run
  // em andamento ainda vai recusar.
  if (querForcar) {
    logger.info("[system/update] força pedida", {
      comando: comandoDaForca,
      alvo,
      run_anterior: runAnteriorDaForca,
    });
  }

  await audit({
    action: "system.update_requested",
    actorUserId: user.id,
    resourceType: "system_update_run",
    resourceId: run.id,
    // `rollback` distingue o pedido de voltar do de atualizar: são a MESMA
    // ação no banco e no agente, e a auditoria é o lugar onde os dois ficam
    // separados para sempre. `force` (+ `comando`) faz o mesmo para o terceiro
    // pedido desta rota — o que a força DERIVOU, não o que o cliente mandou.
    metadata: {
      from_version: current,
      to_version: alvo,
      rollback: querVoltar,
      ...(querForcar ? { force: true, comando: comandoDaForca } : {}),
    },
    actingAsPlatformAdmin: true,
  });

  return ok({ run_id: run.id, to_version: alvo });
}
