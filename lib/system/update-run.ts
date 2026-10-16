/**
 * Vocabulário e transições de uma atualização disparada pela UI.
 *
 * Os valores de RunStatus e RunStep são os MESMOS do CHECK em
 * `system_update_runs` (migration 0089). O invariante
 * `tests/invariants/vocabulario-banco-x-typescript.test.ts` compara os dois —
 * mudar um lado sem o outro fica vermelho.
 */

export type RunStatus = "dispatched" | "success" | "failed" | "failed_rolled_back";
export type RunStep = "backup" | "codigo" | "banco";

/**
 * Depois disso sem notícia, a UI trata o run como desfecho desconhecido.
 * 15 min é folgado: uma atualização real leva ~2 min, e o agente ainda tenta
 * reportar por ~2 min após o reinício do app.
 */
export const RUN_STALE_AFTER_MS = 15 * 60 * 1000;

const TERMINAL: readonly RunStatus[] = ["success", "failed", "failed_rolled_back"];

/**
 * Só existe uma transição legítima: de `dispatched` para um desfecho. Um run
 * que já terminou é imutável — se o agente reportar duas vezes (retry após o
 * reinício do app), a segunda é recusada em vez de reescrever a história.
 */
export function canTransition(from: RunStatus, to: RunStatus): boolean {
  return from === "dispatched" && TERMINAL.includes(to);
}

/**
 * `unknown` é DERIVADO na leitura, nunca gravado: um agente morto não consegue
 * anunciar a própria morte.
 */
export function isRunStale(dispatchedAt: string, now: Date): boolean {
  const started = Date.parse(dispatchedAt);
  if (Number.isNaN(started)) return true;
  return now.getTime() - started > RUN_STALE_AFTER_MS;
}

/**
 * O rollback deste run já foi superado por uma troca de app que não passou por
 * aqui?
 *
 * ## As duas situações, que o tempo sozinho NÃO separa
 *
 * **(a) Logo depois do rollback.** O agente do host roda `git describe` DEPOIS
 * do checkout, então ele reporta a versão NOVA — a que acabou de quebrar. Essa
 * batida chega segundos depois de o run terminar, e é a mentira que o run
 * existe para desfazer. Aqui o run tem de vencer.
 *
 * **(b) Oito dias e vários deploys depois.** O app trocou de versão por
 * caminhos que não criam run (`docker compose up -d`, deploy por CI,
 * `update.sh` no terminal). O run virou notícia velha e seguia nomeando a
 * versão no ar — medido em produção: o rodapé anunciou por oito dias uma versão
 * de 28 de agosto. Aqui o host tem de vencer.
 *
 * Nos DOIS o host reporta depois do run. A primeira versão desta função
 * comparava só as datas, e por isso consertava (b) quebrando (a) — pego pela
 * `tests/e2e/system-update.spec.ts`, que percorre exatamente o cenário (a).
 *
 * ## O que separa: a versão reportada, não o relógio
 *
 * Em (a) o host reporta `run.to_version` — a que o checkout instalou e que o
 * contêiner recusou. Em (b) ele reporta o que um outro caminho subiu, que é
 * outra coisa. Então o run só é superado quando o host reporta uma versão que
 * **o run não descreve** — nem a que tentou instalar, nem a que restaurou.
 *
 * Esta prova sozinha não alcança reinstalar À MÃO exatamente a versão que
 * falhou e dessa vez funcionar: ali o host volta a reportar `to_version`, que o
 * run descreve, e nada separa. Quem alcança é o segundo degrau,
 * `rollbackDesmentidoPeloApp`, que pergunta qual versão o processo que responde
 * está rodando (`APP_VERSION`, gravada dentro da imagem).
 *
 * Falso sempre que falta uma das datas — ausência de prova não é prova de
 * deploy, e o run continua sendo a informação mais específica sobre o que subiu.
 */
export function rollbackFoiSuperado(
  versionUpdatedAt: string | null | undefined,
  runFinishedAt: string | null | undefined,
  versaoReportadaPeloHost?: string | null | undefined,
  run?: { from_version?: string | null; to_version?: string | null } | null,
): boolean {
  if (!versionUpdatedAt || !runFinishedAt) return false;
  const gravado = Date.parse(versionUpdatedAt);
  const terminou = Date.parse(runFinishedAt);
  if (Number.isNaN(gravado) || Number.isNaN(terminou)) return false;
  if (gravado <= terminou) return false;

  // Sem saber o que o host reportou, fica valendo o run: é o degrau
  // conservador, e é o comportamento de antes desta função existir.
  if (!versaoReportadaPeloHost) return false;
  const descritasPeloRun = [run?.to_version, run?.from_version].filter(Boolean);
  return !descritasPeloRun.includes(versaoReportadaPeloHost);
}

/**
 * O run terminou BEM e o host ainda não teve chance de contar?
 *
 * ## O silêncio de até 5 minutos depois de dar certo
 *
 * `run_result` com `status: "success"` escreve só em `system_update_runs` — ele
 * **não toca** `system_version.current_version`. Quem escreve essa coluna é o
 * heartbeat do `agent.sh`, e ele roda de 5 em 5 minutos — o cabeçalho do
 * próprio `agent.sh` diz "a cada 5 minutos", e a linha de cron que o instalador
 * escreve está em `hostgator-setup-kit/test-validators.sh`.
 *
 * Então, na janela entre o fim da atualização e a batida seguinte,
 * `current_version` ainda nomeia a versão ANTIGA — e `update_available`
 * (`latest !== current`) continua verdadeiro. A tela volta do reinício
 * oferecendo o botão "Atualizar agora" para a versão que **acabou de ser
 * instalada**. Quem clicou faz tudo de novo, ou conclui que não funcionou.
 *
 * ## Por que a assunção do `to_version` é defensável
 *
 * `success` é o agente do host dizendo que o `update.sh` foi até o fim — a
 * troca de imagem incluída. Diferente do caso de rollback (onde o host reporta
 * a versão que QUEBROU e o run precisa contradizê-lo), aqui os dois concordam;
 * o host só ainda não falou. É por isso que a janela NÃO volta a oferecer
 * "Atualizar agora" para a versão que acabou de ser instalada.
 *
 * E é auto-corrigível por construção: assim que a batida chega,
 * `system_version.updated_at` passa a ser posterior ao `finished_at` e esta
 * função devolve `false` — o host volta a mandar, sem exceção nenhuma. É o
 * mesmo desempate temporal de `rollbackFoiSuperado`, na direção contrária.
 *
 * ## O que a assunção NÃO pode fazer: durar para sempre
 *
 * A auto-correção acima depende de a batida CHEGAR. Se o agente do host parou
 * (serviço morto, cron removido, token vencido) ela nunca chega, e a assunção
 * deixa de ser uma aposta de minutos para virar AFIRMAÇÃO eterna: medido em
 * produção, a tela anunciava `1.32.0` com o container rodando `1.23.0` — o
 * `update.sh` trocou o código, o app não subiu na imagem nova, e nada nunca
 * mais desmentiu o run.
 *
 * Por isso a assunção tem FIM DE VALIDADE, com um relógio só e o mesmo de
 * `isRunStale`: passados `RUN_STALE_AFTER_MS` do `finished_at` sem confirmação
 * do host, o run para de falar. Quem volta a mandar é a última versão que o
 * host CONFIRMOU — não a que o run pediu. O erro que sobra cai para o lado que
 * empurra para atualizar (a tela volta a oferecer a versão do run, que pode já
 * estar no ar): é o lado que a issue do defeito prefere, e o outro é o defeito
 * — prometer instalação que ninguém confirmou, por tempo indeterminado.
 *
 * A ORDEM importa: o corte de validade vem ANTES do degrau "host nunca
 * reportou nada" (`!versionUpdatedAt` → `true`). Invertida, a instalação que
 * nunca reportou nada seria justamente a única a afirmar para sempre.
 *
 * Sem `finished_at` (run antigo, agente velho) devolve `false`: sem a data não
 * há como saber se o host já falou depois, nem validade a medir — o degrau
 * conservador é o de antes.
 *
 * `true` quer dizer UMA coisa: "não reofereça a atualização agora". NÃO quer
 * dizer "a `to_version` está no ar" — quem nomeia versão na tela é a última que
 * o host confirmou (`current_version`), e é assim que a rota usa este campo.
 */
export function sucessoJaInstalado(
  versionUpdatedAt: string | null | undefined,
  runFinishedAt: string | null | undefined,
  run?: { status?: string | null; to_version?: string | null } | null,
  now?: Date,
): boolean {
  if (run?.status !== "success" || !run.to_version) return false;
  if (!runFinishedAt) return false;
  const terminou = Date.parse(runFinishedAt);
  if (Number.isNaN(terminou)) return false;
  const agora = now ?? new Date();
  if (agora.getTime() - terminou > RUN_STALE_AFTER_MS) return false;
  if (!versionUpdatedAt) return true;
  const gravado = Date.parse(versionUpdatedAt);
  if (Number.isNaN(gravado)) return true;
  // Empate conta como "o host ainda não falou": a escrita do `run_result` e a
  // do heartbeat são de relógios diferentes, e na janela de um segundo o degrau
  // seguro é o que NÃO volta a oferecer a versão já instalada.
  return gravado <= terminou;
}

/**
 * O que aconteceu com o banco na rodada de atualização — o pedaço que até
 * agora só existia no log do servidor. Quando o baseline é reaplicado com o
 * sistema no ar, a primeira passada pode não fechar e o kit tenta de novo; sem
 * estes três números, uma rodada que precisou de três passadas fica idêntica a
 * uma que fechou de primeira, e quem operou não sabe que o banco estava em uso.
 */
export type RodadaDoBanco = {
  /** Houve disputa de lock com o sistema no ar em alguma passada. */
  disputa: boolean;
  /** Quantas retentativas a rodada gastou depois da primeira passada. */
  retentativas: number;
  /** Em qual passada a rodada fechou (1 = primeira). */
  passada: number;
};

/**
 * Lê a rodada de banco da linha de `system_update_runs`. Devolve `null` quando
 * ela não foi medida por inteiro — coluna nula é "não medido", e nulo é o que
 * a tela precisa para ficar calada em vez de inventar um zero.
 */
export function rodadaDoBancoDaLinha(
  linha:
    | {
        disputa_de_banco?: boolean | null;
        retentativas_do_banco?: number | null;
        passada_do_banco?: number | null;
      }
    | null
    | undefined,
): RodadaDoBanco | null {
  if (!linha) return null;
  if (typeof linha.disputa_de_banco !== "boolean") return null;
  if (typeof linha.retentativas_do_banco !== "number") return null;
  if (typeof linha.passada_do_banco !== "number") return null;
  return {
    disputa: linha.disputa_de_banco,
    retentativas: linha.retentativas_do_banco,
    passada: linha.passada_do_banco,
  };
}

function passadasPorExtenso(passada: number): string {
  return passada === 2 ? "duas passadas" : `${passada} passadas`;
}

function retentativasPorExtenso(retentativas: number): string {
  return retentativas === 1 ? "uma retentativa" : `${retentativas} retentativas`;
}

/**
 * Conta o que aconteceu com o banco quando a atualização terminou — em
 * português de gente, para a tela de atualização mostrar. Devolve `null` quando
 * não há o que contar (ninguém mediu, ou os números não fazem sentido): a tela
 * fica silenciosa em vez de afirmar uma passada que não aconteceu.
 */
export function textoDaRodadaDoBanco(
  rodada: RodadaDoBanco | null | undefined,
): string | null {
  if (!rodada) return null;

  const { disputa, retentativas, passada } = rodada;
  if (typeof disputa !== "boolean") return null;
  if (!Number.isInteger(retentativas) || retentativas < 0) return null;
  if (!Number.isInteger(passada) || passada < 1) return null;
  // Uma passada por tentativa: sem isto, { retentativas: 5, passada: 2 } viraria
  // uma frase que contradiz a si mesma.
  if (passada < retentativas + 1) return null;

  if (retentativas === 0) {
    return disputa
      ? "Houve disputa com o sistema usando o banco, mas a primeira passada fechou."
      : "O banco atualizou de uma vez, na primeira passada, sem disputa com o sistema no ar.";
  }

  if (disputa) {
    return `O banco estava em disputa com o sistema no ar: foram ${passadasPorExtenso(
      passada,
    )} e ${retentativasPorExtenso(retentativas)} até a atualização do banco fechar.`;
  }

  // `retentativas >= 1` com `disputa: false` é um estado que NINGUÉM produz: quem
  // grava tira os dois do MESMO contador de passadas (`disputa = passadas > 1`,
  // `retentativas = passadas - 1`), então retentativa implica disputa por
  // construção. A frase que existia aqui dava à tela a impressão de cobrir um
  // caso que não existe — e o caso de teste, a de que estava coberto. Silêncio é
  // o degrau certo, o mesmo de todo número impossível.
  return null;
}

/** `v1.33.0` e `1.33.0` são a mesma versão — a versão da imagem não leva o `v`. */
function semPrefixoV(versao: string): string {
  return versao.trim().replace(/^v/i, "");
}

/**
 * O nome aponta para uma VERSÃO PUBLICADA — `1.33.0` e `v1.33.0` valem; uma
 * marca de desenvolvimento (SHA, `dev-...`) não.
 *
 * É o critério do `--force` com alvo: só existe imagem publicada para uma
 * versão publicada, então só ela admite "voltar para a versão anterior" com
 * nome. Quem decide isso em duas pontas — a tela que oferece o botão de voltar
 * e a rota que registra o pedido (#2757) — usa ESTA função, para as duas
 * nunca discordarem sobre o que é uma versão.
 */
export function ehVersaoPublicada(versao: string | null | undefined): boolean {
  return /^\d+\.\d+\.\d+/.test(semPrefixoV(versao ?? ""));
}

/**
 * O app EM EXECUÇÃO desmente o rollback deste run?
 *
 * ## O caso que `rollbackFoiSuperado` não alcança, medido em produção
 *
 * Aquela função separa os dois mundos pela versão que o host REPORTA: o run só
 * é superado quando o host nomeia uma versão que o run não descreve. O caso que
 * sobra está escrito lá como falha conservadora: reinstalar À MÃO exatamente a
 * versão que falhou e dessa vez funcionar. O host volta a reportar
 * `to_version`, que é uma das duas do run, e o rollback segue de pé.
 *
 * Aconteceu numa VPS em 18/09, e não por acaso: a 1.33.0 falhou porque as
 * imagens ainda não estavam publicadas no registry (o `update.sh` avisa
 * `not found` e recua). Meia hora depois elas existiam, o mesmo `update.sh
 * --force` subiu a MESMA 1.33.0 e o app voltou saudável nela. A tela seguiu
 * anunciando a falha — e, sem botão, bloqueou a 1.35.0 que já havia saído.
 * "Falhou porque ainda não dava para instalar" é o modo de falha em que
 * reinstalar a mesma versão é a AÇÃO CORRETA, então o buraco não é raro.
 *
 * ## Por que a imagem decide, e decide sozinha
 *
 * No rollback de verdade, o contêiner volta para a imagem ANTERIOR: quem
 * responde é `from_version`. Se quem responde é `to_version`, a imagem nova
 * subiu — e ninguém precisa contar isso, porque é o próprio processo que está
 * respondendo. Não há relógio aqui, e é de propósito: a imagem não envelhece
 * como um heartbeat, então este degrau não precisa de fim de validade.
 *
 * ## A versão vem de DENTRO da imagem (`APP_VERSION`), nunca de `APP_IMAGE`
 *
 * `APP_VERSION` é gravada no build (`Dockerfile:97-102`) e viaja com a imagem;
 * é a mesma que o `/api/v1/health` informa. `APP_IMAGE` não serve, e o motivo é
 * a ORDEM do rollback: o `update.sh` grava `APP_IMAGE=…:<alvo>` no `.env`
 * ANTES de puxar e subir, e o `agent.sh` volta a imagem passando `APP_IMAGE`
 * só pelo SHELL (`agent.sh:313-316`), corrigindo o `.env` DEPOIS (`:323`).
 * Como o compose usa `env_file: .env` (`docker-compose.prod.yml:38`) e o valor
 * literal do arquivo vence o do shell, o contêiner revertido responde com
 * `APP_IMAGE` nomeando a versão que FALHOU — e ler dali daria o rollback por
 * desmentido justamente quando ele é real, escondendo o aviso e anunciando
 * como no ar a versão que quebrou.
 */
export function rollbackDesmentidoPeloApp(
  run: { status?: string | null; to_version?: string | null } | null | undefined,
  versaoEmExecucao: string | null | undefined,
): boolean {
  if (run?.status !== "failed_rolled_back" && run?.status !== "failed") return false;
  const alvo = run?.to_version;
  if (!alvo || !versaoEmExecucao) return false;
  return semPrefixoV(alvo) === semPrefixoV(versaoEmExecucao);
}
