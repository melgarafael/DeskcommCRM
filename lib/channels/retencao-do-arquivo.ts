/**
 * A PODA DO ARQUIVO DE WEBHOOKS.
 *
 * ─── O defeito, medido numa instalação real ─────────────────────────────────
 *
 * `webhook_events_log` guarda o corpo cru de todo webhook que entra, e nunca
 * foi podado por ninguém. Em 20/08/2026, no banco do dono deste fork:
 *
 *   banco inteiro ............ 545 MB
 *   webhook_events_log ....... 468 MB   (86%)
 *   api_audit_log ............  27 MB
 *   event_log ................  20 MB
 *   messages .................  3,2 MB
 *
 * As 56.291 linhas eram TODAS dos últimos 20 dias — não havia nenhuma com mais
 * de 30. Ou seja: ~23 MB/dia, ~700 MB/mês, sem teto. O plano gratuito do
 * Supabase acaba em 500 MB, que é onde a maioria dos clones vive, e o dado de
 * negócio inteiro (mensagens, contatos, leads) não chegava a 10 MB.
 *
 * ─── Esvaziar, e não apagar ─────────────────────────────────────────────────
 *
 * Apagar a linha responderia ao espaço e mataria o instrumento. A pergunta que
 * este arquivo existe para responder é a de DEPOIS do incidente — "quantos
 * eventos de que tipo chegaram, quando, e a assinatura conferia?" — e foi ela
 * que decidiu o caso das identidades opacas (`@lid`), contando "76 de 76" no
 * banco.
 *
 * As três colunas pesadas são ~97% do peso; a linha sem elas custa ~200 B.
 * Esvaziando, o índice forense inteiro sobrevive por ~11 MB.
 *
 * ─── Por que em lotes, e por que dois passos ────────────────────────────────
 *
 * Um `update` sem teto sobre 31 mil linhas segura a tabela que TODO webhook
 * escreve — a poda derrubaria a entrada de mensagem, que é o oposto do que ela
 * existe para proteger. O lote pequeno, chamado de 5 em 5 minutos (o crontab
 * do serviço `scheduler`), chega ao
 * mesmo lugar sem nunca ser o dono de uma trava longa.
 *
 * São dois passos porque `supabase-js` não escreve `update ... where id in
 * (select ... limit n)`: primeiro escolhe o lote, depois esvazia. As duas idas
 * custam menos que a trava que a alternativa pediria.
 *
 * ─── E o segundo passo NÃO pode ser por lista de id ─────────────────────────
 *
 * Era, e não funcionava. O PostgREST põe o filtro na QUERY STRING: 500 uuids
 * (36 caracteres cada, fora o separador) passam de 18 KB de URL, e o gateway na
 * frente dele recusa por tamanho — o Kong 2.8.1 devolve `414 URI too long` acima
 * de 8.192 B, o mesmo muro que `app/api/v1/conversations/_handler.ts` já mede
 * (`ORCAMENTO_DE_IDS_NA_URL`). O `archived_at` nunca era gravado, a rodada
 * seguinte escolhia a MESMA leva, e o ciclo se repetia a cada rodada, com um
 * `warn` como única voz: a poda existia, rodava, e não esvaziava uma linha.
 *
 * O corte agora é o `received_at` da ÚLTIMA linha do lote: o mesmo predicado da
 * escolha (`archived_at is null`), com um teto de tempo em vez de uma lista.
 * Nada vai na URL além de duas datas. Pode esvaziar algumas linhas a mais que o
 * lote — as que empatam no mesmo instante —, e isso é aceitável de propósito:
 * continua idempotente, continua limitado no tempo, e um empate de microssegundo
 * não é uma trava longa.
 *
 * ─── A ordem e o erro, na MESMA régua das podas irmãs (issue #1769) ─────────
 *
 * O segundo passo nasceu no molde antigo e ficou nele em dois pontos, ambos
 * medidos contra a poda irmã (`webhook_lead_captures`, consertada no #1721
 * logo depois de a casa corrigir a décima poda do `data-retention` no #1719):
 *
 *   1. o DELETE ia `.limit(lote)` SEM `order`. O PostgREST 12.2 recusa isso
 *      com 400 PGRST109 (medido no v12.2.12 pelo mantenedor; com `order=id`
 *      volta 200) — e, aqui, a recusa virava `apagadas: 0`. Esta é a poda que
 *      segura o ESPAÇO: o arquivo medido é 468 MB de um banco de 545 MB, e
 *      `limit` sem `order` é a diferença entre ele deixar de crescer e ele
 *      continuar crescendo ~23 MB/dia contra o teto de 500 MB do plano
 *      gratuito. Onde o banco aceitasse, sem ordem o lote sai ARBITRÁRIO e
 *      a drenagem deixa de ser reproduzível.
 *   2. o erro do DELETE era ENGOLIDO (`logger.warn` + `apagadas: 0`). Na
 *      resposta do cron, "o banco recusou o DELETE" e "não havia nada
 *      vencido" eram a MESMA linha, e o único sinal vivia num log de
 *      contêiner atrás de um `curl -fsS` que joga tudo para /dev/null. Agora a
 *      falha SOBE, e quem chama (o handler do cron) a reporta pelos três
 *      canais das irmãs: `logger.error`, a linha `retention.sweep_run` com
 *      `falhou: true` e Sentry.
 *
 * O que NÃO mudou, e é deliberado: o PRIMEIRO passo (a busca) continua
 * devolvendo zero em vez de subir. A busca é idempotente e o lote volta a ser
 * escolhido na rodada seguinte de 5 em 5 minutos, enquanto o DELETE é a linha
 * que some para sempre — e é por isso que só a segunda falha é irreversível
 * o bastante para derrubar o 200.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { logger } from "@/lib/logger";

/** Quantas linhas cada rodada esvazia. Ver o cabeçalho: lote pequeno é o ponto. */
export const LOTE_PADRAO = 500;

export interface ResultadoDaPoda {
  /** Linhas que perderam o corpo nesta rodada. */
  esvaziadas: number;
  /** Linhas apagadas de vez (velhas demais até para o índice forense). */
  apagadas: number;
  /** `true` quando o lote encheu — ainda há trabalho para a próxima rodada. */
  temMais: boolean;
}

/**
 * O DELETE das linhas velhas foi recusado, e o que o passo 1 já esvaziou vem
 * PRESO na exceção (issue #1769).
 *
 * Por que uma classe e não um `Error` com uma propriedade ad hoc: quem chama
 * precisa distinguir "o DELETE foi recusado, e aqui está o que o passo 1
 * conseguiu" de "a chamada estourou em outro ponto" — e o `catch` do handler
 * tem de continuar devolvendo um relatório honesto nos dois casos, sem
 * inventar um `esvaziadas: 0` que nunca aconteceu. Um `name` ou uma
 * `instanceof` sobre um objeto ad hoc seria o mesmo contrato com menos régua:
 * o `instanceof` é o que impede uma exceção vinda de baixo (uma falha de
 * rede dentro do próprio `supabase-js`, por exemplo) de ser lida como se fosse
 * o banco recusando o DELETE.
 */
export class ErroAoApagarLinhasVelhas extends Error {
  /** O que a rodada JÁ tinha esvaziado antes de o DELETE ser recusado. */
  readonly parcial: ResultadoDaPoda;

  constructor(mensagem: string, parcial: ResultadoDaPoda) {
    super(mensagem);
    this.name = "ErroAoApagarLinhasVelhas";
    this.parcial = parcial;
  }
}

function limiteEm(dias: number): string {
  return new Date(Date.now() - dias * 86_400_000).toISOString();
}

/**
 * Esvazia o corpo das linhas velhas e apaga as velhas demais.
 *
 * Os dois horizontes são independentes de propósito: o primeiro protege o
 * ESPAÇO (o corpo é 97% do peso) e o segundo protege a TABELA de crescer em
 * número de linhas para sempre. Colapsá-los num só forçaria a escolha entre
 * perder o índice forense cedo ou carregar o corpo por meses.
 */
export async function podarArquivoDeWebhooks(
  admin: SupabaseClient,
  opcoes: { diasComCorpo: number; diasParaApagar: number; lote?: number },
): Promise<ResultadoDaPoda> {
  const lote = opcoes.lote ?? LOTE_PADRAO;

  // ── 1. Esvaziar o corpo ───────────────────────────────────────────────────
  //
  // `archived_at is null` é o que torna a rodada IDEMPOTENTE: linha já esvaziada
  // não volta a ser escolhida, então rodar duas vezes seguidas não custa nada e
  // não escreve nada. É também o predicado do índice parcial da 0163.
  const { data: alvos, error: erroBusca } = await admin
    .from("webhook_events_log")
    .select("id,received_at")
    .is("archived_at", null)
    .lt("received_at", limiteEm(opcoes.diasComCorpo))
    .order("received_at", { ascending: true })
    .limit(lote);

  if (erroBusca) {
    logger.warn("[retencao-webhook] não consegui escolher as linhas", {
      detail: erroBusca.message.slice(0, 160),
    });
    return { esvaziadas: 0, apagadas: 0, temMais: false };
  }

  const linhas = (alvos ?? []) as { id: string; received_at: string }[];
  // O corte é a data da ÚLTIMA linha do lote — as linhas vêm da mais velha para
  // a mais nova, então tudo até ela é o lote inteiro e nada além dele. A string
  // vai como o banco a devolveu: passar por `Date` perderia os microssegundos e
  // deixaria a própria última linha de fora do teto.
  const corte = linhas.length > 0 ? (linhas[linhas.length - 1]?.received_at ?? null) : null;
  let esvaziadas = 0;

  if (corte !== null) {
    const { data: esvaziadasRows, error: erroUpdate } = await admin
      .from("webhook_events_log")
      .update({
        raw_body: null,
        payload_parsed: null,
        headers: null,
        // O carimbo é o que diz "o corpo existiu e foi descartado" — sem ele,
        // NULL se confundiria com "nunca teve corpo", e a próxima pessoa a
        // investigar não saberia se o arquivo falhou ou se a poda passou.
        archived_at: new Date().toISOString(),
      })
      // O MESMO predicado da escolha, e por isso continua idempotente: linha já
      // esvaziada não volta a ser escolhida nem a ser escrita.
      .is("archived_at", null)
      .lte("received_at", corte)
      .select("id");

    if (erroUpdate) {
      logger.warn("[retencao-webhook] não consegui esvaziar o lote", {
        detail: erroUpdate.message.slice(0, 160),
      });
    } else {
      // Contar o que VOLTOU, e não o que se pediu: o empate de instante pode
      // levar algumas linhas a mais, e o número que a rodada reporta tem de ser
      // o que aconteceu.
      esvaziadas = (esvaziadasRows ?? []).length;
    }
  }

  // ── 2. Apagar as velhas demais ────────────────────────────────────────────
  //
  // Só depois do horizonte longo. Aqui a linha já não tem corpo há muito tempo,
  // então o que se perde é o registro de que um evento existiu — aceitável
  // passados meses, e é o único jeito de a tabela não crescer para sempre em
  // número de linhas.
  const { data: apagadasRows, error: erroDelete } = await admin
    .from("webhook_events_log")
    .delete()
    .lt("received_at", limiteEm(opcoes.diasParaApagar))
    .select("id")
    // O `order` ANTES do `limit` (issue #1769), na MESMA coluna e na MESMA
    // direção da poda irmã (`webhook_lead_captures`, #1721) e da décima poda do
    // `data-retention`: `id` ASCENDENTE. Duas propriedades, e as duas
    // importam.
    //
    // A PRIMEIRA é o que o PostgREST 12.2 exige: `limit` sem `order` num
    // DELETE volta 400 PGRST109 (medido pelo mantenedor no v12.2.12), e sem
    // esta linha esta poda nunca apaga nada em nenhum clone novo. Para esta
    // tabela, cujo arquivo é 468 MB de um banco de 545 MB, isso é a diferença
    // entre o banco deixar de crescer e ele continuar crescendo ~23 MB/dia sem
    // teto — em silêncio, porque o erro vivia num `warn`.
    //
    // A SEGUNDA é a drenagem: sem ordem o banco devolve um subconjunto
    // ARBITRÁRIO dentro de `lt(received_at, limite)`, então duas rodadas com o
    // mesmo backlog não apagam as mesmas linhas e a sequência de lotes deixa
    // de ser reproduzível. A coluna é `id` e não `received_at` pela mesma razão
    // das irmãs: é a chave primária, logo a ordem é estável — `received_at`
    // muda de valor conforme entra linha nova, e a ordem junto.
    .order("id")
    .limit(lote);

  if (erroDelete) {
    // A falha SOBE — o mesmo caminho de `podarHistoricoDeCaptacao`
    // (`lib/webhooks/retencao-da-captacao.ts`, #1721) e de `drenar`
    // (`app/api/v1/cron/data-retention/route.ts`, #1719). O `warn` que vivia
    // aqui dizia a causa e devolvia `apagadas: 0`, que na resposta do cron é a
    // MESMA linha de "não havia nada vencido": um banco que parou de aceitar o
    // DELETE ficava indistinguível de um banco em dia, e o único sinal morava
    // num log de contêiner atrás de um `curl -fsS` que joga tudo para
    // /dev/null. O NOME da tabela vai na frente porque a mesma rodada tem uma
    // poda irmã, e o operador precisa saber qual das duas falhou. E o que o
    // PASSO 1 já esvaziou vai PRESO na exceção (`ErroAoApagarLinhasVelhas`),
    // porque essa é a informação que o `catch` do handler não tem e não pode
    // reconstruir: uma rodada que esvaziou 500 linhas e falhou ao apagar não
    // é a mesma que uma que não fez nada, e reportar `esvaziadas: 0` na
    // segunda seria inventar um número.
    throw new ErroAoApagarLinhasVelhas(`webhook_events_log: ${erroDelete.message}`, {
      esvaziadas,
      apagadas: 0,
      // `temMais` olha o que a BUSCA escolheu, e não o que o DELETE apaga: a
      // fila continua cheia de linhas que o passo 1 ainda tem que esvaziar, e
      // quem chama usa este sinal para saber que a poda não chegou ao regime
      // estável — o que, numa falha, é literalmente verdade.
      temMais: linhas.length >= lote,
    });
  }

  return {
    esvaziadas,
    apagadas: (apagadasRows ?? []).length,
    // Lote cheio = ainda há fila. Quem chama pode usar isto para saber que a
    // poda ainda não alcançou o estado estável — útil no primeiro dia, quando
    // há 31 mil linhas atrasadas e a varredura leva várias rodadas.
    temMais: linhas.length >= lote,
  };
}
