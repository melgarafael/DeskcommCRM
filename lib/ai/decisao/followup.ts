/**
 * A RESPOSTA AO FOLLOW-UP, PERGUNTADA AO JEV — a sexta tarefa dele, a primeira
 * no turno do follow-up (`lib/agent-engine/agent/followup-turn.ts`, ramo
 * `classify`).
 *
 * Num fluxo de follow-up, o passo "Classificar (IA)" lê a resposta do cliente à
 * mensagem do fluxo e escolhe por qual das saídas que a empresa criou o fluxo
 * segue (`classifyFollowupReply`, ponto `followup_classify`). O Jev responde a
 * MESMA pergunta, entre as MESMAS saídas, ao mesmo tempo.
 *
 * ═══ SÓ OBSERVA ═══
 *
 * Nesta versão a tarefa só observa (`soObserva`, `./tarefas.ts`): a saída que
 * move o fluxo é SEMPRE a da IA de sempre, e ninguém espera pelo Jev — o turno
 * conclui o passo, e a observação é gravada quando as duas respostas chegarem.
 * Por isso aqui não há `decidindo`, cobertura nem reserva: não há nada que o
 * Jev decida para alguém cobrir.
 *
 * ═══ O QUE SAI DA MÁQUINA ═══
 *
 * Só o que o cliente DIGITOU na resposta (sem mídia, sem transcrição nem texto
 * lido dela), passado pelo `scrubMessage`, e as saídas do passo com a dica dele —
 * textos da empresa, não do cliente. As saídas vão como critérios SEM
 * descrição: o nome da saída é a definição inteira, como na IA de sempre. Sem
 * "nenhuma": a IA de sempre não tem essa saída, e a comparação é de igual para
 * igual. A pergunta é dinâmica e vai em chamada PRÓPRIA (R6).
 *
 * ═══ NUNCA LANÇA ═══
 *
 * Falha de leitura, do fornecedor ou da gravação vira `null` ou um aviso no
 * log, sem o texto da mensagem: o follow-up é o atendimento do cliente.
 */
import type pg from "pg";

import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { logger } from "@/lib/logger";
import { scrubMessage } from "@/lib/sentry/scrub";

import type { Pergunta } from "./cliente";
import type { EstadoQuePergunta } from "./config";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { estadoDaTarefaNoPool, registrarFalhaQuePedeAcao } from "./pool";
import { decidirNoPonto, type DependenciasDoPonto } from "./ponto";
import { saidasCabemNaPergunta, TAREFA_DO_FOLLOWUP } from "./tarefas";

const INSTRUCAO =
  "Em qual destas saídas do fluxo de follow-up se encaixa a resposta do cliente à mensagem do follow-up? Ela decide por onde o fluxo segue.";

/**
 * A pergunta, ou `null` quando as saídas não cabem (`saidasCabemNaPergunta`):
 * uma só (não há escolha — a concordância seria certa por construção), mais do
 * que o fornecedor aceita, uma em branco ou duas iguais. É a MESMA regra que o
 * cartão usa para dizer se a tarefa roda.
 */
export function perguntaDoFollowup(classes: readonly string[], dica?: string): Pergunta | null {
  if (!saidasCabemNaPergunta(classes)) return null;
  const comDica = dica?.trim() ? `${INSTRUCAO} Dica de quem montou o fluxo: ${dica.trim()}` : INSTRUCAO;
  return { tipo: "choice", instrucao: comDica, criterios: Object.fromEntries(classes.map((c) => [c, null])) };
}

export interface EscolhaDoJev {
  /** O estado da tarefa quando ele respondeu. */
  estado: EstadoQuePergunta;
  /** Uma das saídas do passo — fora delas não há escolha (`perguntar`). */
  classe: string;
  /** A probabilidade calibrada da saída escolhida. */
  probabilidade: number;
  confianca: number;
  /** A versão que DE FATO respondeu — vai para `llm_calls.model` e para o preço. */
  modelo: string;
  tokensDeEntrada: number;
  tokensDeSaida: number;
  latenciaMs: number;
  /** A resposta do cliente em `messages` — o que impede o retry de contar em dobro. */
  messageId: string;
}

export interface EntradaDoFollowup {
  organizationId: string;
  contactId: string | null;
  jobId: string | null;
  conversationId: string | null;
  /** O que o cliente DIGITOU na resposta — `''` quando ela é mídia, e aí nada sai. */
  mensagem: string;
  /** As saídas do passo, na ordem e com o texto exatos que a IA de sempre recebe. */
  classes: readonly string[];
  dica?: string;
  /**
   * O id da resposta em `messages`: é ele que o índice único de
   * `jev_observacoes` usa para o retry do job não contar em dobro. Chamado só
   * com a tarefa rodando; sem ele, não se pergunta — a resposta não teria onde
   * ficar.
   */
  idDaMensagem: () => Promise<string | null>;
}

/**
 * Pergunta ao Jev com a tarefa já lida (`estado`). `null` quando ele não opina:
 * disjuntor aberto, sem chave, falha do fornecedor, resposta que não é uma
 * escolha, ou uma saída que o passo não tem — sem par para comparar, e uma
 * saída inventada contaria como discordância.
 */
async function perguntar(
  pool: pg.Pool,
  entrada: EntradaDoFollowup,
  estado: EstadoQuePergunta,
  pergunta: Pergunta,
  messageId: string,
  deps: DependenciasDoPonto,
): Promise<EscolhaDoJev | null> {
  const alvo = { organizationId: entrada.organizationId, tarefa: TAREFA_DO_FOLLOWUP.id };
  if (!podeTentar(alvo)) return null;

  const r = await decidirNoPonto(
    {
      ponto: "followup_classify",
      organizationId: entrada.organizationId,
      estado: scrubMessage(entrada.mensagem),
      perguntas: { followup: pergunta },
    },
    deps,
  );
  if (!r.ok) {
    registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
    if (r.motivo !== "sem_credencial") {
      logger.warn("Jev não respondeu sobre a resposta ao follow-up; vale só a IA de sempre", {
        organization_id: entrada.organizationId,
        motivo: r.motivo,
      });
    }
    if (r.exigeAcao) await registrarFalhaQuePedeAcao(pool, { ...entrada, purpose: "followup_classify" }, r);
    return null;
  }

  const resposta = r.respostas["followup"];
  if (resposta?.tipo !== "choice" || !entrada.classes.includes(resposta.escolha)) {
    registrarFalha(alvo, "resposta_ilegivel", Date.now());
    logger.warn("Jev respondeu ao follow-up fora das saídas do passo; vale só a IA de sempre", {
      organization_id: entrada.organizationId,
    });
    return null;
  }

  registrarSucesso(alvo);
  return {
    estado,
    classe: resposta.escolha,
    probabilidade: resposta.probabilidades[resposta.escolha] ?? resposta.confianca,
    confianca: resposta.confianca,
    modelo: r.modelo,
    tokensDeEntrada: r.uso.tokensDeEntrada,
    tokensDeSaida: r.uso.tokensDeSaida,
    latenciaMs: r.latenciaMs,
    messageId,
  };
}

/**
 * Uma linha em `jev_observacoes` (o par) e uma em `llm_calls` (o custo, em
 * Execuções — R8), no MESMO comando: uma sem a outra contaria uma resposta que
 * não custou, ou um custo sem resposta. Sem texto do cliente em nenhuma das
 * duas. `classeDaIa` nula: a IA de sempre não classificou (ou o passo não foi
 * concluído com a dela), o job vai ser repetido, e a linha fica sem par (fora
 * da concordância) — a repetição do MESMO job, que esbarra no índice único, só
 * preenche o lado que faltava. Outro job sobre a mesma mensagem (outro passo
 * "Classificar", outro fluxo do mesmo contato) não completa o par: ele
 * perguntou entre OUTRAS saídas, e a classe dele contra a do Jev seria uma
 * concordância que não mede nada. A resposta do Jev que fica é sempre a
 * primeira. Nunca lança.
 */
export async function registrarFollowupDoJev(
  pool: pg.Pool,
  entrada: Pick<EntradaDoFollowup, "organizationId" | "contactId" | "jobId" | "conversationId">,
  jev: EscolhaDoJev,
  classeDaIa: string | null,
): Promise<void> {
  try {
    await pool.query(
      `with observacao as (
         insert into public.jev_observacoes as o
           (organization_id, tarefa, estado, conversation_id, message_id, job_id,
            rotulo_jev, probabilidade_jev, confianca_jev, rotulo_atual, modelo, latencia_ms)
         values ($1, $9, $10, $11, $12, $3, $13, $14, $15, $16, $17, $8)
         on conflict (organization_id, tarefa, message_id) where message_id is not null
         do update set rotulo_atual = excluded.rotulo_atual
          where o.rotulo_atual is null and o.job_id is not distinct from excluded.job_id
       )
       insert into public.llm_calls
         (organization_id, contact_id, job_id, purpose, provider, model,
          input_tokens, output_tokens, cost_cents, latency_ms, status, origem_da_escolha)
       values ($1, $2, $3, 'followup_classify', 'typesafe', $4, $5, $6, $7, $8, 'ok', 'jev_observacao')`,
      [
        entrada.organizationId,
        entrada.contactId,
        entrada.jobId,
        `typesafe/${jev.modelo}`,
        jev.tokensDeEntrada,
        jev.tokensDeSaida,
        // Fracionário, e `null` para versão sem preço na tabela — como o roteador.
        costCents(jev.modelo, {
          inputTokens: jev.tokensDeEntrada,
          outputTokens: jev.tokensDeSaida,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        }),
        jev.latenciaMs,
        TAREFA_DO_FOLLOWUP.id,
        jev.estado,
        entrada.conversationId,
        jev.messageId,
        jev.classe,
        jev.probabilidade,
        jev.confianca,
        classeDaIa,
        jev.modelo,
      ],
    );
  } catch (erro) {
    // A observação é telemetria: perdê-la não pode derrubar o follow-up.
    logger.warn("resposta do Jev sobre o follow-up não foi gravada", {
      organization_id: entrada.organizationId,
      erro: erro instanceof Error ? erro.message.slice(0, 200) : typeof erro,
    });
  }
}

/** O Jev no passo "Classificar (IA)", começado JUNTO da IA de sempre. */
export interface JevNoFollowup {
  /** A escolha dele, ou `null` quando não foi perguntado ou não opinou. Nunca rejeita. */
  escolha: Promise<EscolhaDoJev | null>;
  /**
   * Grava a escolha, quando houver, ao lado da saída da IA de sempre — `null`
   * quando ela não classificou —, sem que ninguém espere: o passo já foi
   * concluído pela dela. Nunca lança.
   */
  observar(classeDaIa: string | null): void;
}

export function consultarJevNoFollowup(
  pool: pg.Pool,
  entrada: EntradaDoFollowup,
  deps: DependenciasDoPonto = {},
): JevNoFollowup {
  // Mídia ou saídas fora do contrato: nem o estado é lido.
  const pergunta = entrada.mensagem.trim() === "" ? null : perguntaDoFollowup(entrada.classes, entrada.dica);
  const escolha: Promise<EscolhaDoJev | null> =
    pergunta === null
      ? Promise.resolve(null)
      : estadoDaTarefaNoPool(pool, entrada.organizationId, TAREFA_DO_FOLLOWUP)
          .then(async (estado) => {
            if (estado === "desligada") return null;
            const messageId = await entrada.idDaMensagem();
            return messageId === null ? null : perguntar(pool, entrada, estado, pergunta, messageId, deps);
          })
          .catch((erro: unknown) => {
            logger.warn("Jev não pôde ser perguntado sobre o follow-up; vale só a IA de sempre", {
              organization_id: entrada.organizationId,
              erro: erro instanceof Error ? erro.name : typeof erro,
            });
            return null;
          });
  return {
    escolha,
    observar: (classeDaIa) => {
      void escolha.then((jev) => (jev === null ? undefined : registrarFollowupDoJev(pool, entrada, jev, classeDaIa)));
    },
  };
}
