"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { copyToClipboard } from "@/lib/clipboard";
import { useSystemVersion } from "@/hooks/system/useSystemVersion";
import { markdownParaTextoSimples } from "@/lib/system/changelog";
import { ehVersaoPublicada, textoDaRodadaDoBanco } from "@/lib/system/update-run";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

// Sem `cd <pasta>`: o instalador não fixa o nome da pasta do clone
// (REPO_DIR é configurável, default "deskcommcrm" minúsculo) — quem tem
// acesso ao servidor já sabe entrar na pasta onde instalou.
const COMANDO_MANUAL = "bash hostgator-setup-kit/update.sh";

/** Tira o "v" das versões: a tela fala "1.1.0", não "v1.1.0". */
function semV(versao: string | undefined): string {
  return (versao ?? "").replace(/^v/i, "");
}

/**
 * "14h10" — a hora da volta automática (#2757).
 *
 * No fuso de quem lê (o navegador), não em UTC: o dono do servidor está no
 * mesmo fuso da instalação, e "16h10 UTC" para quem está em Brasília é uma
 * conta que ninguém faz de cabeça. Devolve vazio com data inválida — a frase
 * então sai sem a hora, em vez de dizer "Invalid Date".
 */
function horaCurta(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * O um-clique que fecha o ciclo sem terminal (#2757).
 *
 * Ele não inventa um caminho novo: manda para a rota de atualização o MESMO
 * pedido que a tela já vinha fazendo em forma de comando (`comandoDeVolta`),
 * com o alvo vindo do run — a versão de onde a tentativa SAIU — e o agente do
 * host executa `update.sh --to <isso> --force` no servidor. O texto diz o
 * preço da ação (sai do ar ~2 min) antes do clique, porque depois do clique
 * não há mais tela para avisar — e, se a volta não for registrada, o erro
 * aparece aqui, sem depender de SSH.
 */
function BotaoVoltar({
  destino,
  mutate,
  isPending,
  erro,
}: {
  destino: string;
  mutate: () => void;
  isPending: boolean;
  erro: string | null;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={mutate} disabled={isPending}>
          {isPending ? t("Voltando…") : t("Voltar para a versão anterior")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t("O sistema sai do ar por cerca de 2 minutos e volta para a versão")}{" "}
          <strong>{destino}</strong>.
        </span>
      </div>
      <p className="mt-3 text-sm text-muted-foreground">
        {t(
          "Os seus dados seguem intactos: a cópia de segurança feita antes da tentativa continua guardada no servidor.",
        )}
      </p>
      {erro && <p className="mt-3 text-sm text-error-fg">{erro}</p>}
    </>
  );
}

/**
 * Só o comando, como plano B, depois do botão "Voltar para a versão anterior"
 * (#2757).
 *
 * O MESMO cálculo de antes, porque o alvo do botão é a mesma linha: voltar
 * para a versão que funcionava, não reinstalar a que acabou de quebrar. Só
 * aponta para trás quando sabe para onde — `from_version` pode ser uma marca
 * de desenvolvimento (instalação fora de release), e aí não existe imagem
 * publicada com esse nome para puxar, nesse caso só `--force`.
 *
 * O botão entrega este MESMO alvo ao agente do host, que roda o comando no
 * servidor — e este texto continua visível de propósito: é o caminho de quem
 * prefere terminal, e é o que resta quando o pedido nem chega a ser registrado
 * (sem versão publicada para voltar, banco fora de alcance, agente parado).
 */
function comandoDeVolta(fromVersion: string | undefined): string {
  const anterior = semV(fromVersion);
  return ehVersaoPublicada(anterior)
    ? `bash hostgator-setup-kit/update.sh --to v${anterior} --force`
    : "bash hostgator-setup-kit/update.sh --force";
}

const PASSOS = [
  { chave: "backup", texto: "Guardando uma cópia de segurança dos seus dados" },
  { chave: "codigo", texto: "Baixando a versão nova" },
  { chave: "banco", texto: "Atualizando o banco de dados" },
  { chave: "app", texto: "Reiniciando o sistema" },
] as const;

export function UpdatePanel() {
  const t = useT();
  const { data, isError } = useSystemVersion({ refetchInterval: 5_000 });
  const queryClient = useQueryClient();
  const [erro, setErro] = useState<string | null>(null);

  const atualizar = useMutation({
    mutationFn: async () => apiClient.post("/api/v1/system/update", {}),
    onSuccess: () => {
      setErro(null);
      queryClient.invalidateQueries({ queryKey: ["system-version"] });
    },
    onError: (err) => {
      // O código desta sessão venceu (ou nunca foi provado): "tente de novo"
      // não resolve, e entrar de novo não o pede a quem confiou no dispositivo.
      if (err instanceof ApiError && err.code === "mfa_required") return irAoDesafioDeMfa();
      // 409 é estado de negócio ("já tem um run rodando" / "já está em dia"),
      // não falha técnica — mostra a mensagem que a API já escreveu em
      // português em vez de um genérico "tente de novo".
      const mensagem =
        err instanceof ApiError && err.status === 409
          ? t(err.message)
          : t("Não consegui iniciar a atualização. Tente de novo em instantes.");
      setErro(mensagem);
    },
  });

  // O botão "Voltar para a versão anterior" (#2757) — o MESMO pedido que a
  // tela pedia em forma de comando, agora registrado como run.
  //
  // Por que é uma ação e não o comando: quem está com a tela em falha no
  // navegador raramente tem terminal aberto no servidor, e a saída de "clique
  // e esqueça" daqui é o agente do host executando `update.sh --to <a versão
  // de onde se saiu> --force` — o `--force` que o agente aplica sozinho quando
  // o git mostrar que o alvo pedido é mais antigo que o que já roda aqui (a
  // MESMA guarda do update.sh contra "versão anterior à instalada"). O alvo
  // NÃO é a última release: reinstalar a publicada seria reinstalar a release
  // que acabou de quebrar.
  const voltar = useMutation({
    mutationFn: async () => apiClient.post("/api/v1/system/update", { rollback: true }),
    onSuccess: () => {
      setErro(null);
      queryClient.invalidateQueries({ queryKey: ["system-version"] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "mfa_required") return irAoDesafioDeMfa();
      const mensagem =
        err instanceof ApiError && err.status === 409
          ? t(err.message)
          : t("Não consegui pedir a volta para a versão anterior. Tente de novo em instantes.");
      setErro(mensagem);
    },
  });

  // O atalho do estado de falha (#2756) — o MESMO endpoint de sempre, com um
  // corpo de UMA chave. O cliente manda a intenção e nunca um comando: quem
  // transforma `{ force: true }` no `--force` (e no `--to` da versão de onde a
  // tentativa saiu) é o servidor, a partir do mesmo run que a tela leu para
  // montar o comando visível logo abaixo do botão. O botão de ATUALIZAR segue
  // fora deste estado de propósito: sem força ele é o falso sucesso que o doc
  // de `Saida` descreve — este aqui não, porque o `--force` refaz backup, banco
  // e conferência de verdade.
  const forcar = useMutation({
    mutationFn: async () => apiClient.post("/api/v1/system/update", { force: true }),
    onSuccess: () => {
      setErro(null);
      queryClient.invalidateQueries({ queryKey: ["system-version"] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "mfa_required") return irAoDesafioDeMfa();
      const mensagem =
        err instanceof ApiError && err.status === 409
          ? t(err.message)
          : t("Não consegui iniciar a atualização. Tente de novo em instantes.");
      setErro(mensagem);
    },
  });

  // O app reinicia no meio da atualização: a requisição falhar aqui é
  // ESPERADA, não é erro. Só é erro de verdade se nunca houve run em curso.
  const rodando = data?.run?.status === "dispatched";

  /**
   * O AVISO DE "SEM SMTP" ATRAVESSA TODOS OS ESTADOS DESTA TELA.
   *
   * O estado existia desde sempre — só que apenas no log do `update.sh`, que o
   * dono de uma VPS não abre. Aqui ele passa a ser lido na tela, no caminho de
   * leitura que já existe (`GET /api/v1/system/version`, o mesmo que alimenta o
   * resto do painel) e com a mesma régua da ação que sofre com ele
   * (`semSmtpNaInstalacao`, em `lib/email/estado.ts`).
   *
   * A comparação é com `false`, e não `!data.smtp_configured`: o campo só vem
   * para o dono da instalação (`is_platform_admin`) e, fora do servidor único,
   * vem sempre `true`. Ausente é "não sei", e sobre o que não se sabe esta tela
   * não afirma nada.
   *
   * POR QUE AQUI, e não na lista de alertas do painel de administração: aquela
   * lista é por EMPRESA (uma linha por cliente, com link para o cadastro dele).
   * "Esta instalação não envia e-mail" é do SERVIDOR — não tem empresa dona nem
   * cadastro para abrir, e acomodá-lo lá exigiria inventar um tenant para o
   * aviso. O dono que precisa dele é justamente quem abre esta tela.
   */
  const semSmtp = data?.smtp_configured === false;

  if (isError && rodando) return <Reiniciando semSmtp={semSmtp} />;
  if (!data) {
    return (
      <Layout semSmtp={semSmtp}>
        <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>
      </Layout>
    );
  }

  const versao = semV(data.current_version);
  const nova = semV(data.latest_version);

  if (rodando) {
    /**
     * ESTE É O TRECHO EM QUE A TELA PARECIA TRAVADA.
     *
     * O `POST /update` não executa nada: ele registra o pedido e vai embora.
     * Quem executa é o `agent.sh` no host, e ele roda de 5 em 5 minutos — entre
     * o clique e o primeiro passo passam até 5 minutos. Nesse intervalo
     * `last_step` é nulo, os quatro círculos ficam todos vazios e nada se mexe.
     *
     * A pessoa que clicou não tem como distinguir isso de "quebrou". E a lista
     * de passos, mostrada antes de qualquer passo existir, afirma que o sistema
     * está trabalhando quando ele ainda nem recebeu a ordem.
     *
     * Então o estado de espera é SEU PRÓPRIO estado, com nome, com a razão da
     * demora e com um relógio que anda.
     */
    /**
     * O alvo do pedido EM CURSO vem do run (#2757): um "voltar" tem como alvo
     * a versão de onde se saiu, e não a última publicada — dizer "Atualizando
     * para a versão <última>" durante uma volta seria mentir justamente na
     * hora em que a pessoa mais está prestando atenção. `nova` fica como
     * plano B para run sem `to_version` (rota anterior a #2757).
     *
     * Fora do `if` de propósito: os DOIS estados de quem está esperando (sem
     * passo ainda e com passo rolando) dizem o mesmo destino.
     */
    const destinoDoPedido = semV(data.run?.to_version) || nova;

    if (!data.run?.last_step) {
      return (
        <AguardandoOServidor
          dispatchedAt={data.run?.dispatched_at}
          // O destino é o do RUN (#2757) — a mesma razão do título logo abaixo.
          destino={destinoDoPedido}
          semSmtp={semSmtp}
        />
      );
    }

    return (
      <Layout semSmtp={semSmtp} titulo={`${t("Atualizando para a versão")} ${destinoDoPedido}`}>
        <ol className="space-y-2 text-sm">
          {PASSOS.map((passo) => {
            const indice = PASSOS.findIndex((p) => p.chave === data.run?.last_step);
            const atual = PASSOS.findIndex((p) => p.chave === passo.chave);
            const feito = indice >= 0 && atual <= indice;
            return (
              <li key={passo.chave} className={feito ? "text-foreground" : "text-muted-foreground"}>
                {feito ? "✓" : "○"} {t(passo.texto)}
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-sm text-muted-foreground">
          {t(
            "O sistema sai do ar por alguns instantes e volta sozinho. Pode deixar esta página aberta.",
          )}
        </p>
      </Layout>
    );
  }

  /**
   * O OUTRO LADO DO MESMO SILÊNCIO — e este era pior que parecer travado.
   *
   * `run_result` com sucesso fecha o run e não toca `current_version`: quem
   * escreve essa coluna é o heartbeat do host, de 5 em 5 minutos. Nesse
   * intervalo `update_available` continuava verdadeiro, e a tela voltava do
   * reinício oferecendo "Atualizar agora" para a versão que ACABOU de ser
   * instalada — quem clicou fazia tudo de novo, ou concluía que não funcionou.
   *
   * `just_updated` é essa janela, e só ela: na batida seguinte o host confirma,
   * o campo vira `false` sozinho e a tela cai no texto normal de quem está em
   * dia. Não é um estado que alguém precise fechar.
   *
   * ## O que esta janela NÃO pode dizer: "você está na versão X"
   *
   * O run bem-sucedido é a notícia de que o `update.sh` foi até o fim — não de
   * que o app está RODANDO na imagem nova. Enquanto o host bate o heartbeat a
   * diferença some em minutos; quando ele não bate (agente morto, cron
   * removido, token vencido), ela vira afirmação eterna: medido em produção,
   * esta tela dizia `1.32.0` com o container rodando `1.23.0`.
   *
   * Então a tela nomeia a versão-alvo como PEDIDO — "a atualização para a
   * versão X terminou" — e diz, na mesma frase, qual é a última versão que o
   * host CONFIRMOU (`current_version`, a mesma que a tela usa em todos os
   * outros estados). Sem botão: o pedido já foi atendido, e reoferecê-lo era o
   * outro defeito desta janela.
   */
  // O que a rodada do banco contou de si mesma, em português de gente. Vale nos
  // dois desfechos em que o servidor mexeu no banco (deu certo / voltou atrás):
  // quem clicou tem o direito de saber que a base estava ocupada, quantas
  // retentativas custou e em qual passada fechou. Sem registro na rodada isto é
  // `null`, e a tela fica calada em vez de afirmar zero.
  const contaDoBanco = textoDaRodadaDoBanco(data.run?.rodada_do_banco);
  // O ponteiro para o `.update.log` vem junto do resumo, mas só quando a
  // rodada REGISTROU disputa — é aí que existe passada por passada para ler.
  // Rodada medida e limpa fica com o resumo só: endereço de log que ninguém
  // precisa abrir é linha a mais para ignorar, e quem ignora uma ignora a próxima.
  const detalheNoLog = data.run?.rodada_do_banco?.disputa === true;

  if (data.just_updated) {
    const pedida = semV(data.run?.to_version);
    return (
      <Layout
        semSmtp={semSmtp}
        titulo={`${t("A atualização para a versão")} ${pedida} ${t("terminou")}`}
      >
        <p className="text-sm">
          {t(
            "O servidor ainda não me confirmou em que versão ele voltou ao ar — a última versão que ele confirmou é a",
          )}{" "}
          <strong>{versao}</strong>.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          {t(
            "Assim que ele falar comigo, daqui a alguns minutos, esta tela se atualiza sozinha. Não ofereço atualizar de novo: o pedido já foi atendido.",
          )}
        </p>
        {contaDoBanco ? (
          <p className="mt-3 text-sm text-muted-foreground">{t(contaDoBanco)}</p>
        ) : null}
        {/* O resumo é a ponta; quem quer ver passada por passada precisa saber
            ONDE. Esse endereço até aqui só existia no log do servidor — quem
            apertou o botão não tinha como chegar lá sem SSH. Só quando HÁ o que
            procurar lá (disputa registrada): ponteiro em rodada limpa é ruído, e
            quem para de ler o ruído para de ler o aviso. */}
        {detalheNoLog ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {t(
              "O detalhe de cada passada está no arquivo .update.log, na pasta do projeto no servidor.",
            )}
          </p>
        ) : null}
      </Layout>
    );
  }

  // As versões de uma falha vêm do RUN, nunca de `current_version`: essa
  // última é o `git describe` do host, e a troca de código já tinha
  // acontecido quando o app quebrou — ela nomeia a versão que FALHOU. O run
  // sabe de onde saiu e para onde tentou ir.
  const alvo = semV(data.run?.to_version);
  const anterior = semV(data.run?.from_version);
  // Falha já superada por um deploy posterior não é mais o estado do servidor:
  // mostrar o aviso dela (sem botão) travaria a próxima atualização pela tela.
  const falhaVigente = !data.run?.superseded;
  const podeForcar =
    data.force_update_supported === true &&
    data.identity?.status === "confirmed" &&
    data.identity.customized === false &&
    !data.manual_reconciliation_required;
  const podeVoltar =
    data.identity?.status === "confirmed" &&
    !data.manual_reconciliation_required &&
    ehVersaoPublicada(data.run?.from_version) &&
    !(data.run?.status === "failed_rolled_back" && data.run.volta_automatica);

  if (
    falhaVigente &&
    data.identity &&
    data.identity.status !== "legacy" &&
    ["failed", "failed_rolled_back"].includes(data.run?.status ?? "")
  ) {
    return (
      <Layout
        semSmtp={semSmtp}
        titulo={`${t("A atualização para a versão")} ${alvo} ${t("não deu certo")}`}
      >
        <p className="text-sm">
          {t(
            "A última tentativa falhou. O estado instalado aparece na confirmação dos serviços acima.",
          )}
        </p>
        {data.run?.status === "failed_rolled_back" && data.run.volta_automatica ? (
          <AvisoVoltaAutomatica anterior={anterior} alvo={alvo} finishedAt={data.run.finished_at} />
        ) : null}
        <DetalhesTecnicos texto={data.run?.log_tail} />
        {podeVoltar ? (
          <BotaoVoltar
            destino={anterior}
            mutate={() => voltar.mutate()}
            isPending={voltar.isPending}
            erro={erro}
          />
        ) : (
          <p className="mt-3 text-sm">
            {t("Confira a execução e preserve as alterações próprias antes de trocar as imagens.")}
          </p>
        )}
        {podeForcar ? (
          <div className="mt-3">
            <BotaoForcar
              mutate={() => forcar.mutate()}
              isPending={forcar.isPending}
              erro={podeVoltar ? null : erro}
            />
            <Comando comando={comandoDeVolta(data.run?.from_version)} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            {t(
              "O agente do servidor ainda não confirmou suporte para refazer a atualização pela tela.",
            )}
          </p>
        )}
      </Layout>
    );
  }

  if (falhaVigente && data.run?.status === "failed_rolled_back") {
    return (
      <Layout
        semSmtp={semSmtp}
        titulo={`${t("A atualização para a versão")} ${alvo} ${t("não deu certo")}`}
      >
        {/* A VOLTA QUE NINGUÉM PEDIU (#2757).
            O agente do host devolve a versão sozinho quando o site não
            responde duas vezes seguidas logo depois da atualização — e até
            aqui isso só ficava no log da VPS: quem abria o painel via a versão
            mudar sem explicação, e quem não usa terminal nunca sabia o que
            houve. A frase é a mesma que o mantenedor pediu, com as quatro
            informações em linguagem de gente: para onde voltou, quando, e por
            quê (a versão que falhou vem junto porque situa o leitor).
            Só aparece quando NINGUÉM pediu o run — uma volta pedida pela tela
            continua dizendo "Voltei o sistema", que ali é verdade. */}
        {data.run.volta_automatica ? (
          <AvisoVoltaAutomatica anterior={anterior} alvo={alvo} finishedAt={data.run.finished_at} />
        ) : null}
        <p className={data.run.volta_automatica ? "mt-3 text-sm" : "text-sm"}>
          {t("Voltei o sistema para a versão")} {anterior},{" "}
          {t(
            "que é a que está no ar agora, e os seus dados estão intactos. O banco de dados já tinha sido atualizado e permanece assim — isso é seguro, a versão",
          )}{" "}
          {anterior}{" "}
          {t(
            "funciona com ele. A cópia de segurança feita antes da tentativa continua guardada no servidor, mas ela não volta por cima do banco em uso: só restaura num banco vazio. Se precisar desfazer também o banco, peça ajuda a quem cuida do servidor.",
          )}
        </p>
        {contaDoBanco ? (
          <p className="mt-3 text-sm text-muted-foreground">{t(contaDoBanco)}</p>
        ) : null}
        {detalheNoLog ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {t(
              "O detalhe de cada passada está no arquivo .update.log, na pasta do projeto no servidor.",
            )}
          </p>
        ) : null}
        <DetalhesTecnicos texto={data.run.log_tail} />
        <Saida
          botao={false}
          mutate={() => atualizar.mutate()}
          isPending={atualizar.isPending}
          erro={erro}
          texto={`${t("Para deixar o servidor inteiro de volta na versão")} ${anterior} ${t("— inclusive o código, que já foi trocado —, quem tem acesso pode rodar:")}`}
          comando={comandoDeVolta(data.run.from_version)}
          // O MESMO alvo do comando logo abaixo, entregue como run (#2757) —
          // e só quando ele existe de verdade: uma versão publicada para onde
          // voltar. `ehVersaoPublicada` é a régua das duas coisas.
          //
          // Na volta automática que TERMINOU o botão não entra (#3271): o alvo
          // dele é a versão que já está no ar, e clicar ali só derrubaria o
          // sistema por ~2 min para reinstalar o que já roda. Ele continua no
          // desfecho em que a volta NÃO terminou — que é outro ramo desta tela
          // (`failed`), porque a rota grava `failed` quando o `update.sh --to`
          // da volta sai com código diferente de zero. É por isso que os dois
          // desfechos não podem continuar chegando aqui como um só.
          voltar={
            !data.run.volta_automatica && ehVersaoPublicada(data.run.from_version)
              ? {
                  destino: anterior,
                  mutate: () => voltar.mutate(),
                  isPending: voltar.isPending,
                  erro,
                }
              : undefined
          }
          // O clique que executa o comando logo abaixo (#2756). Sem guarda de
          // versão publicada de propósito: é o único caminho de saída numa
          // instalação fora de release, onde o `voltar` acima recusa com 409 e
          // o `comandoDeVolta` devolve `--force` sem `--to`.
          forcar={
            podeForcar ? { mutate: () => forcar.mutate(), isPending: forcar.isPending } : undefined
          }
        />
      </Layout>
    );
  }

  if (falhaVigente && data.run?.status === "failed") {
    // Já houve aqui um texto próprio para "o host recusou antes de começar",
    // detectado por `last_step` nulo. Era sinal errado: `run_progress` não tem
    // retry e engole falha (o `run_result` insiste por ~2 min), então uma
    // atualização que mexeu em TUDO e falhou no fim chega aqui com `last_step`
    // nulo sempre que os POSTs de progresso não passaram — e a tela dizia "nada
    // mudou" e não oferecia saída nenhuma, justo quando o dono mais precisa do
    // comando de volta. A cópia alarmante erra para o lado de fazer conferir, e
    // o log logo abaixo explica em português quando foi só uma recusa.
    return (
      <Layout
        semSmtp={semSmtp}
        titulo={`${t("A atualização para a versão")} ${alvo} ${t("não deu certo")}`}
      >
        <p className="text-sm">
          {t("E eu")} <strong>{t("não consegui")}</strong> {t("voltar sozinho para a versão")}{" "}
          {anterior}: {t("o sistema pode estar rodando a versão")} {alvo}{" "}
          {t(
            "com defeito, ou fora do ar. Seus dados estão intactos e a cópia de segurança feita antes da tentativa continua guardada no servidor.",
          )}
        </p>
        <DetalhesTecnicos texto={data.run.log_tail} />
        <Saida
          botao={false}
          mutate={() => atualizar.mutate()}
          isPending={atualizar.isPending}
          erro={erro}
          texto={`${t("Para colocar o sistema de volta no ar na versão")} ${anterior}${t(", quem tem acesso ao servidor precisa rodar:")}`}
          comando={comandoDeVolta(data.run.from_version)}
          // Mesmo botão do estado anterior (#2757): o agente já devolveu os
          // SERVIÇOS em qualquer saída, mas esta versão não subiu — o clique
          // completa a volta no CÓDIGO, com o alvo de onde a tentativa saiu.
          voltar={
            ehVersaoPublicada(data.run.from_version)
              ? {
                  destino: anterior,
                  mutate: () => voltar.mutate(),
                  isPending: voltar.isPending,
                  erro,
                }
              : undefined
          }
          // Mesmo atalho do estado anterior (#2756): o comando logo abaixo é o
          // alvo, e é o SERVIDOR que o deriva — a tela só manda `{ force: true }`.
          forcar={
            podeForcar ? { mutate: () => forcar.mutate(), isPending: forcar.isPending } : undefined
          }
        />
      </Layout>
    );
  }

  if (data.run?.status === "unknown") {
    return (
      <Layout semSmtp={semSmtp} titulo={t("Não sei dizer como terminou")}>
        <p className="text-sm">
          {t("Comecei a atualização para a versão")} {alvo}{" "}
          {t(
            "mas perdi contato com o servidor antes do fim. Confira se o sistema está funcionando normalmente — se estiver, provavelmente deu certo.",
          )}
        </p>
        <DetalhesTecnicos texto={data.run.log_tail} />
        <Saida
          botao={Boolean(data.update_available)}
          mutate={() => atualizar.mutate()}
          isPending={atualizar.isPending}
          erro={erro}
          texto={t("Para conferir pelo servidor, quem tem acesso pode rodar:")}
          comando={COMANDO_MANUAL}
        />
      </Layout>
    );
  }

  if (data.identity && !["legacy", "confirmed"].includes(data.identity.status)) {
    return (
      <Layout semSmtp={semSmtp}>
        <p>
          {t(
            "A execução dos serviços ainda não foi confirmada. Aguarde a próxima verificação do servidor.",
          )}
        </p>
      </Layout>
    );
  }
  if (data.manual_reconciliation_required) {
    return (
      <Layout semSmtp={semSmtp}>
        <h2 className="font-semibold">{t("Instalação personalizada")}</h2>
        <p className="mt-2 text-sm">
          {t("Esta instalação preserva alterações próprias sobre a base oficial.")}
        </p>
        {data.update_available && (
          <p className="mt-2 text-sm">
            {t("Nova versão")} · {semV(data.latest_version)}
          </p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            "Concilie as alterações antes de trocar as imagens. A versão publicada não substitui automaticamente esta instalação.",
          )}
        </p>
      </Layout>
    );
  }
  if (!data.agent_online) {
    return (
      <Layout semSmtp={semSmtp} titulo={t("Atualização automática indisponível")}>
        <p className="text-sm">
          {t(
            "Não estou conseguindo falar com o servidor onde o sistema está instalado, então não posso atualizar sozinho. Quem tem acesso ao servidor pode entrar na pasta onde o sistema foi instalado e rodar este comando — se for a primeira vez, rode duas vezes: a primeira baixa o programa novo e a segunda liga o botão desta tela.",
          )}
        </p>
        <Comando comando={COMANDO_MANUAL} />
      </Layout>
    );
  }

  // O host disse, com todas as letras, que não conseguiu comparar. Recusar a
  // agir é defensável; afirmar "é a mais recente" sem ter conferido não é — a
  // conta disso é o cliente nunca receber a próxima correção de segurança.
  if (data.compare_failed) {
    return (
      <Layout semSmtp={semSmtp} titulo={t("Não consegui checar se há versão nova")}>
        <p className="text-sm">
          {t("O servidor não conseguiu comparar a sua versão (")}
          <strong>{versao}</strong>
          {t(
            ") com a última publicada — normalmente é internet instável ou falta de espaço em disco na hora da checagem.",
          )}{" "}
          <strong>{t("Não quer dizer que esteja desatualizado, nem que esteja em dia")}</strong>:{" "}
          {t("quer dizer que eu não sei.")}
        </p>
        <p className="mt-3 text-sm">
          {t(
            "Vou tentar de novo sozinho a cada poucos minutos. Se continuar assim, quem tem acesso ao servidor pode conferir na hora com:",
          )}
        </p>
        <Comando comando={COMANDO_MANUAL} />
      </Layout>
    );
  }

  // O RETRATO É VELHO DEMAIS PARA FALAR PELA INSTALAÇÃO (#3488).
  //
  // `agent_online` acima só abre às 24h — até lá, um retrato de horas atrás
  // respondia com convicção total. Foi o que aconteceu em produção: o DNS da
  // VPS caiu, o agente ficou 51 batidas sem postar, a v1.90.0 saiu no meio e a
  // tela anunciava "É a mais recente. Não há nada a fazer." com o retrato das
  // 11h45 (medido às 16h).
  //
  // A frase de baixo só é honesta DEPOIS de perguntar se a comparação foi feita
  // há pouco: `latest_version` vazio num retrato velho não significa "não há
  // nada publicado", significa "ninguém olhou há horas". É o mesmo princípio do
  // ramo de `compare_failed`, com o silêncio no lugar da falha declarada.
  //
  // `!data.update_available` no gate de propósito: quando o retrato velho
  // APONTA uma versão nova, a informação antiga ainda basta para agir — esconder
  // o botão ali tiraria a saída justamente de quem está atrasado. O que ele não
  // sustenta é a afirmação de que não há nada a fazer.
  if (data.agent_stale && !data.update_available) {
    return (
      <Layout semSmtp={semSmtp} titulo={t("Não sei se há versão nova")}>
        <p className="text-sm">
          {t("O servidor não fala comigo desde")}{" "}
          <strong>{horaCurta(data.agent_last_seen_at)}</strong>
          {t(
            ". É ele quem confere se saiu versão nova — então não posso afirmar que esta é a mais recente.",
          )}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          <strong>{t("Não quer dizer que esteja desatualizado, nem que esteja em dia")}</strong>:{" "}
          {t("quer dizer que eu não sei.")}
        </p>
        <p className="mt-3 text-sm">
          {t(
            "Assim que ele voltar a falar comigo, esta tela se atualiza sozinha. Se demorar, verifique a conexão do servidor com a internet ou peça ajuda a quem cuida dele.",
          )}
        </p>
      </Layout>
    );
  }

  if (!data.update_available && !data.off_release) {
    return (
      <Layout semSmtp={semSmtp} titulo={`${t("Você está na versão")} ${versao}`}>
        <p className="text-sm text-muted-foreground">
          {t("É a mais recente. Não há nada a fazer.")}
        </p>
      </Layout>
    );
  }

  // Sem nenhuma versão nova para oferecer numa instalação que não está numa
  // versão publicada, há duas explicações bem diferentes — e afirmar a
  // errada é a frase tranquilizadora sem base que este produto proíbe:
  //
  // 1. O servidor está À FRENTE da última publicada (existe release, e o
  //    HEAD já a contém). Não é defeito — veio da forma como foi instalado.
  // 2. Este fork NUNCA teve nenhuma release publicada. Dizer "à frente da
  //    publicada" aqui afirmaria a existência de algo que não existe.
  //
  // Sem distinguir os dois, a tela de baixo renderizava "Versão  disponível",
  // com o número vazio, e um botão que a API recusa com 409.
  if (!nova) {
    if (!data.has_known_release) {
      return (
        <Layout semSmtp={semSmtp} titulo={t("Ainda não há nenhuma versão publicada")}>
          <p className="text-sm">
            {t(
              "Este projeto ainda não tem nenhuma versão publicada para comparar com a sua instalação — normal em um fork novo ou recém-criado a partir do código-fonte.",
            )}{" "}
            <strong>{t("Não há nada a atualizar agora")}</strong>, {t("e isso não é um problema.")}
          </p>
          <p className="mt-3 text-sm">
            {t(
              "Quando sair a primeira versão publicada, ela aparece aqui sozinha. Quem tem acesso ao servidor pode conferir a qualquer momento com o comando abaixo — ele não muda nada sem avisar:",
            )}
          </p>
          <Comando comando={COMANDO_MANUAL} />
        </Layout>
      );
    }
    return (
      <Layout semSmtp={semSmtp} titulo={t("Você está à frente da versão publicada")}>
        <p className="text-sm">
          {t("Seu sistema roda uma versão mais nova do que a última publicada, então")}{" "}
          <strong>{t("não há nada a atualizar")}</strong>.{" "}
          {t(
            "É assim mesmo quando a instalação acompanha o desenvolvimento, e nada aqui está errado por causa disso — a marca da sua versão é",
          )}{" "}
          <strong>{versao}</strong>.
        </p>
        <p className="mt-3 text-sm">
          {t(
            "Quando sair uma versão publicada mais nova que a sua, ela aparece aqui sozinha. Quem tem acesso ao servidor pode conferir a qualquer momento com o comando abaixo — ele não muda nada sem avisar:",
          )}
        </p>
        <Comando comando={COMANDO_MANUAL} />
      </Layout>
    );
  }

  return (
    <Layout semSmtp={semSmtp} titulo={`${t("Versão")} ${nova} ${t("disponível")}`}>
      {data.off_release && (
        <p className="mb-4 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg">
          {t(
            "Sua instalação está numa versão de desenvolvimento. Atualizar vai levá-la para a versão publicada",
          )}{" "}
          {nova}.
        </p>
      )}

      {/* Os avisos de TODAS as versões da faixa, reunidos e sempre à vista.
          Nenhum deles entra em `<details>`: esconder o que exige ação manual é
          exatamente o defeito que esta tela passou a consertar. Cada um diz de
          que versão veio — num salto de várias, "reconecte o número" sem dizer
          de qual release não informa o operador, assusta. */}
      {data.notes?.requires_attention.length ? (
        <div className="mb-4 rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg">
          <p className="mb-1 font-medium">⚠️ {t("Requer atenção")}</p>
          {data.notes.requires_attention.map((aviso) => (
            <div key={aviso.version} className="mt-2">
              <p className="font-medium">
                {t("Da versão")} {aviso.version}:
              </p>
              <p className="whitespace-pre-line">{markdownParaTextoSimples(aviso.texto)}</p>
            </div>
          ))}
        </div>
      ) : null}

      {data.notes?.complete === false && data.notes.sections.length > 0 && (
        <p className="mb-4 text-sm text-muted-foreground">
          {t("Este histórico começa na versão")} {data.notes.sections.at(-1)?.version}{" "}
          {t("e pode não alcançar a que você tem instalada")} ({versao}) —{" "}
          {t(
            "a última parte pode estar cortada. O texto completo está no arquivo CHANGELOG.md do projeto.",
          )}
        </p>
      )}

      {/* O botão fica ANTES do changelog, não depois: com várias versões
          acumuladas ele descia para o fim de uma lista longa, e quem só
          queria clicar "Atualizar agora" precisava rolar por tudo. Os avisos
          que pesam na decisão (`off_release`, `requires_attention` e o de
          histórico incompleto) continuam antes DELE — só o "O que muda", que é
          consulta, não decisão, desceu para depois. O de histórico incompleto
          entra na lista porque, com `complete === false`, o "Requer atenção"
          só junta as versões presentes no texto: pode estar faltando aviso, e
          esse parágrafo é a única pista disso. */}
      <div className="mb-6">
        <BotaoAtualizar
          mutate={() => atualizar.mutate()}
          isPending={atualizar.isPending}
          erro={erro}
        />
      </div>

      {data.notes?.sections.length ? (
        <div className="mb-6">
          <p className="mb-2 text-sm font-medium">{t("O que muda")}</p>
          {data.notes.sections.map((secao, i) => (
            <div key={secao.version} className="mb-3">
              {/* A versão-alvo fica aberta; as do meio ficam recolhidas, para a
                  lista não virar um muro de texto num salto de várias versões.
                  Só o CORPO é recolhido — o aviso delas já está lá em cima. */}
              {i === 0 ? (
                <pre className="font-sans text-sm whitespace-pre-wrap text-muted-foreground">
                  {markdownParaTextoSimples(secao.body)}
                </pre>
              ) : (
                <details>
                  <summary className="cursor-pointer text-sm font-medium">
                    {t("Versão")} {secao.version}
                  </summary>
                  <pre className="mt-2 font-sans text-sm whitespace-pre-wrap text-muted-foreground">
                    {markdownParaTextoSimples(secao.body)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </Layout>
  );
}

/**
 * A ESPERA, com nome e com relógio.
 *
 * O pedido fica numa fila que o servidor lê de tempos em tempos — o `agent.sh`
 * roda de 5 em 5 minutos no host. Antes disto a tela já mostrava a lista dos
 * quatro passos, todos vazios, dizendo "Atualizando para a versão X": afirmava
 * trabalho que ainda não tinha começado, e ficava imóvel por até cinco minutos.
 *
 * Três coisas, e nenhuma é enfeite:
 *
 * 1. **O nome certo do estado.** "Pedido enviado" ≠ "atualizando".
 * 2. **A razão da demora**, dita antes de ela assustar. Quem sabe que o
 *    servidor confere a cada poucos minutos não lê a imobilidade como defeito.
 * 3. **Um relógio que anda.** É o que separa "esperando" de "travou" quando
 *    não há mais nada se mexendo na tela — e ele conta o tempo do SERVIDOR
 *    (`dispatched_at`), não o de quando a aba foi aberta: recarregar a página
 *    não zera a conta.
 */
function AguardandoOServidor({
  dispatchedAt,
  destino,
  semSmtp,
}: {
  dispatchedAt: string | undefined;
  destino: string;
  semSmtp?: boolean;
}) {
  const t = useT();
  // Um segundo, e não os 5s do poll: o poll traz dado do servidor, este tique
  // só faz o relógio andar. Sem ele o número saltaria de 5 em 5 segundos.
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setAgora(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  const inicio = dispatchedAt ? Date.parse(dispatchedAt) : NaN;
  const segundos = Number.isNaN(inicio) ? null : Math.max(0, Math.floor((agora - inicio) / 1000));

  return (
    <Layout semSmtp={semSmtp} titulo={t("Pedido enviado — esperando o servidor pegar")}>
      <p className="text-sm">
        {t("Anotei o pedido de atualizar para a versão")} <strong>{destino}</strong>.{" "}
        {t(
          "O servidor confere se há algo a fazer de poucos em poucos minutos, então a atualização pode levar até cerca de cinco minutos para começar.",
        )}
      </p>
      <p className="mt-3 text-sm">
        <strong>{t("Esta tela ficar parada nesse tempo é normal")}</strong>
        {t(" — ela se mexe sozinha assim que o servidor começar.")}
      </p>
      {segundos !== null && (
        <p
          className="mt-3 text-sm text-muted-foreground tabular-nums"
          data-testid="espera-decorrida"
        >
          {t("Esperando há")} {formataEspera(segundos)}.
        </p>
      )}
      <p className="mt-3 text-sm text-muted-foreground">
        {t("Pode fechar esta página: o pedido já está registrado e não se perde.")}
      </p>
    </Layout>
  );
}

/** "43 segundos" / "2 min 05 s" — sem biblioteca, e sem virar "0:5". */
function formataEspera(segundos: number): string {
  if (segundos < 60) return `${segundos} s`;
  const min = Math.floor(segundos / 60);
  return `${min} min ${String(segundos % 60).padStart(2, "0")} s`;
}

function BotaoAtualizar({
  mutate,
  isPending,
  erro,
}: {
  mutate: () => void;
  isPending: boolean;
  erro: string | null;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={mutate} disabled={isPending}>
          {isPending ? t("Iniciando…") : t("Atualizar agora")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t(
            "O sistema sai do ar por cerca de 2 minutos e volta sozinho. Faço uma cópia de segurança dos seus dados antes.",
          )}
        </span>
      </div>
      {erro && <p className="mt-3 text-sm text-error-fg">{erro}</p>}
    </>
  );
}

/**
 * A saída de um estado ruim — e ela nunca é só o botão.
 *
 * Depois de uma tentativa que falhou, o código do servidor já está na versão
 * nova (o `git checkout` deu certo; quem não subiu foi o container). Um novo
 * pedido pelo botão de ATUALIZAR faria o agente rodar `update.sh --to <mesma
 * tag>`, que responde "você já está na versão mais recente", sai com sucesso e
 * reportaria um desfecho BOM sem ter trocado imagem nenhuma. Por isso o botão
 * de atualizar fica desligado nos estados de falha: o que resolve ali é
 * `--force` com alvo na versão de onde se saiu — hoje, o botão "Voltar para a
 * versão anterior" (#2757), entregue como run quando há uma versão publicada
 * para onde voltar, e o "Forçar atualização" (#2756), que é o COMANDO logo
 * abaixo executado sem terminal, e passa também onde a volta recusa. O comando
 * continua sempre presente: é a transparência do que o botão faz, o plano B
 * dele e o caminho de quem prefere terminal.
 */
function Saida({
  botao,
  mutate,
  isPending,
  erro,
  texto,
  comando,
  voltar,
  forcar,
}: {
  botao: boolean;
  mutate: () => void;
  isPending: boolean;
  erro: string | null;
  texto: string;
  comando: string;
  /** O um-clique de voltar (#2757): só nos estados de falha, e só com alvo. */
  voltar?: {
    destino: string;
    mutate: () => void;
    isPending: boolean;
    erro: string | null;
  };
  /** O clique de força deste estado (#2756), ao lado do comando que ele executa. */
  forcar?: { mutate: () => void; isPending: boolean } | null;
}) {
  // O erro aparece UMA vez, e por quem estiver na tela: `BotaoAtualizar` e
  // `BotaoVoltar` já o renderizam dentro de si. Sem nenhum dos dois ele morreria
  // invisível — que é exatamente o caso do força sem volta (instalação fora de
  // release) — e com os DOIS ele viraria frase repetida.
  const erroDoForca = botao || voltar ? null : erro;
  return (
    <div className="mt-6 border-t pt-4">
      {botao && (
        <div className="mb-4">
          <BotaoAtualizar mutate={mutate} isPending={isPending} erro={erro} />
        </div>
      )}
      {voltar && (
        <div className="mb-4">
          <BotaoVoltar {...voltar} />
        </div>
      )}
      <p className="text-sm text-muted-foreground">{texto}</p>
      {forcar && (
        <div className="mt-3">
          <BotaoForcar mutate={forcar.mutate} isPending={forcar.isPending} erro={erroDoForca} />
        </div>
      )}
      <Comando comando={comando} />
    </div>
  );
}

/**
 * O atalho do comando que está logo abaixo (#2756).
 *
 * Dispara o MESMO `POST /system/update` do botão normal, com um corpo de uma
 * chave: `{ force: true }`. O alvo (`--force` e, quando existe, `--to` da
 * versão de onde a tentativa saiu) é resolvido no SERVIDOR, a partir do mesmo
 * run que a tela leu — a tela não passa caminho nenhum, nem por aqui. Diferente
 * do "Voltar para a versão anterior" (#2757), não pede versão publicada para
 * trás: ele executa o `comandoDeVolta` que está embaixo, cuja outra metade é
 * justamente o `--force` sem `--to` de uma instalação fora de release.
 */
function BotaoForcar({
  mutate,
  isPending,
  erro,
}: {
  mutate: () => void;
  isPending: boolean;
  erro: string | null;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={mutate} disabled={isPending}>
          {isPending ? t("Forçando…") : t("Forçar atualização")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {t(
            "Rodo o comando de baixo por você, sem precisar abrir o terminal. Faço uma cópia de segurança dos seus dados antes.",
          )}
        </span>
      </div>
      {erro && <p className="mt-3 text-sm text-error-fg">{erro}</p>}
    </>
  );
}

/**
 * O log do update.sh, recolhido. Sem isto o dono de uma instalação que falhou
 * precisa de `psql`/SSH para saber o que houve — o terminal que esta tela
 * existe para eliminar.
 */
function DetalhesTecnicos({ texto }: { texto: string | undefined }) {
  const t = useT();
  if (!texto?.trim()) return null;
  return (
    <details className="mt-4 rounded-md border">
      <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground">
        {t("Detalhes técnicos (útil se for pedir ajuda)")}
      </summary>
      <pre className="max-h-72 overflow-auto px-3 pb-3 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
        {texto}
      </pre>
    </details>
  );
}

/**
 * O AVISO DE "SEM SMTP", no topo do painel e FORA do cartão de conteúdo.
 *
 * Fica aqui, e não dentro do `<Card>`, porque não é um estado da atualização: é
 * um fato da INSTALAÇÃO que continua verdadeiro enquanto ele não for
 * consertado, em qualquer estado desta tela.
 *
 * O endereço aparece como texto, do mesmo jeito que o kit escreve a mesma
 * instrução no terminal ("Configure em /admin/email"): uma chave de dicionário
 * só, e nenhuma promessa de navegação entre superfícies diferentes.
 */
function AvisoDeSmtp() {
  const t = useT();
  return (
    <div
      data-testid="aviso-sem-smtp"
      className="rounded-md border border-warning bg-warning-bg p-3 text-sm text-warning-fg"
    >
      <p className="font-medium">⚠️ {t("Sem SMTP configurado")}</p>
      <p className="mt-1">
        {t(
          'O serviço de login desta instalação não envia e-mail: "esqueci a senha" e a confirmação de cadastro não chegam. Configure o servidor de e-mail em /admin/email e, no servidor, rode bash hostgator-setup-kit/update.sh — é ele que leva o SMTP ao serviço de login.',
        )}
      </p>
    </div>
  );
}

/**
 * `semSmtp` atravessa TODOS os estados desta tela — inclusive a espera e o
 * reinício. O aviso é da instalação, não do estado da atualização: quem abriu
 * esta página para atualizar é a mesma pessoa que precisa saber, agora, que o
 * e-mail não sai.
 */
function Layout({
  titulo,
  children,
  semSmtp,
}: {
  titulo?: string;
  children: React.ReactNode;
  semSmtp?: boolean;
}) {
  const t = useT();
  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {titulo ?? t("Atualização do sistema")}
        </h1>
      </header>
      <InstalledVersion />
      {semSmtp ? <AvisoDeSmtp /> : null}
      <Card className="p-6">{children}</Card>
    </div>
  );
}

function Reiniciando({ semSmtp }: { semSmtp?: boolean }) {
  const t = useT();
  return (
    <Layout semSmtp={semSmtp} titulo={t("Reiniciando…")}>
      <p className="text-sm text-muted-foreground">
        {t("O sistema está voltando. Esta página se atualiza sozinha em alguns instantes.")}
      </p>
    </Layout>
  );
}

function AvisoVoltaAutomatica({
  anterior,
  alvo,
  finishedAt,
}: {
  anterior: string;
  alvo: string;
  finishedAt?: string | null;
}) {
  const t = useT();
  return (
    <p className="text-sm" data-testid="volta-automatica">
      {t("O sistema voltou sozinho para a versão")} <strong>{anterior}</strong>
      {finishedAt ? (
        <>
          {" "}
          {t("às")} <strong>{horaCurta(finishedAt)}</strong>
        </>
      ) : null}
      {t(", porque o site não respondeu logo depois da atualização para a versão")}{" "}
      <strong>{alvo}</strong>.
    </p>
  );
}

function Comando({ comando }: { comando: string }) {
  const t = useT();
  const [copiado, setCopiado] = useState(false);
  return (
    <div className="mt-3 flex items-center gap-2">
      <code className="flex-1 overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">
        {comando}
      </code>
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          await copyToClipboard(comando);
          setCopiado(true);
          setTimeout(() => setCopiado(false), 2000);
        }}
      >
        {copiado ? t("Copiado") : t("Copiar")}
      </Button>
    </div>
  );
}

/** Present in every branch: installed identity and update requests are separate. */
function InstalledVersion() {
  const t = useT();
  const { data } = useSystemVersion();
  if (!data) return null;
  const identity = data.identity;
  return (
    <section className="rounded-md border p-3 text-sm" aria-label={t("Versão instalada")}>
      <p className="font-medium">
        {t("Versão instalada")}: {semV(data.current_version) || t("Ainda não confirmada")}
        {identity?.customized === true ? ` · ${t("Personalizada")}` : ""}
      </p>
      {identity && identity.status !== "confirmed" && (
        <p className="mt-1 text-muted-foreground">
          {t(
            identity.status === "divergent"
              ? "Os serviços executam revisões diferentes"
              : identity.status === "stale"
                ? "A confirmação do servidor venceu"
                : "Execução não confirmada",
          )}
        </p>
      )}
      {data.is_owner && data.runtime_services && identity?.status !== "confirmed" && (
        <ul className="mt-2 space-y-1">
          {data.runtime_services.map((service) => (
            <li key={service.role} className="break-all">
              <code>{service.role}</code>: {service.base_version || "?"} ·{" "}
              {service.revision?.slice(0, 12) || "?"} ·{" "}
              {t(
                service.running && service.healthy && service.source_verified
                  ? "Confirmado"
                  : "Não confirmado",
              )}
            </li>
          ))}
        </ul>
      )}
      {data.is_owner && data.official_latest_version && (
        <p className="mt-1">
          {t("Última release oficial")}: {semV(data.official_latest_version)}
        </p>
      )}
      {data.is_owner && identity?.revision && (
        <p className="mt-1 break-all">
          {t("Revisão")}: <code>{identity.revision}</code>
        </p>
      )}
      {data.is_owner && identity?.confirmed_at && (
        <p className="mt-1">
          {t("Última confirmação")}: {new Date(identity.confirmed_at).toLocaleString()}
        </p>
      )}
    </section>
  );
}
