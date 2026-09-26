/**
 * O ROTEADOR, PERGUNTADO AO JEV — a terceira tarefa dele, a segunda no turno do
 * agente (`lib/agent-engine/agent/resolve-turn-agent.ts`).
 *
 * Com um roteador de intenção ativo no número, cada mensagem nova do cliente
 * passa por um modelo de linguagem que escolhe a intenção (`classifyIntent`,
 * ponto `intent_router`), e a intenção escolhe o agente. O Jev responde a MESMA
 * pergunta, entre as MESMAS intenções, ao mesmo tempo.
 *
 * ═══ O QUE ELE PODE, EM CADA ESTADO ═══
 *
 *  - observando (toda tarefa nova começa assim, R1/R7): só se grava, e o turno
 *    NÃO espera por ele — a resposta vai para `jev_observacoes` quando chegar.
 *  - decidindo: vale a escolha dele, com o `min_confidence` do roteador sobre a
 *    probabilidade dele, e a IA de sempre é a reserva quando ele não responde —
 *    e a cobertura deixa rastro: uma linha em `llm_calls` com a origem
 *    `reserva_do_jev`, a que o cartão conta em "Vezes que a IA de sempre cobriu
 *    o Jev" (`registrarCobertura`).
 *    O turno espera por ele o que ele passar da IA de sempre, que roda junto:
 *    a leitura do estado (pelo banco do turno, como as demais consultas dele) e,
 *    num prazo só de no máximo `TETO_PADRAO_MS`, a busca da chave e a resposta
 *    (`decidirNoPonto`).
 *  - sem a IA de sempre (o classificador falhou ou a empresa não tem um): vale
 *    a regra de hoje — o agente de antes, ou o de reserva do roteador —, nunca
 *    o Jev (R2). Quem aplica é o turno; aqui só se pergunta e se grava.
 *
 * A concordância é o MESMO AGENTE FINAL, e não a mesma intenção: duas
 * intenções podem levar ao mesmo agente, e o mínimo de confiança pode mandar
 * uma intenção certa para o agente de reserva. Quem sabe calcular o agente é o
 * turno (`destinoDoVeredito`); ele entrega os rótulos prontos a `observar`.
 *
 * ═══ O QUE SAI DA MÁQUINA ═══
 *
 * A última mensagem do cliente, sozinha (R4), passada pelo `scrubMessage`, e as
 * intenções do roteador — descrição e exemplos, que são textos da empresa, não
 * do cliente. Pergunta dinâmica, montada com os membros da organização, vai em
 * chamada PRÓPRIA (R6): uma pergunta malformada derruba a chamada inteira
 * (medido), e ela não pode levar junto a de outra tarefa.
 *
 * ═══ NUNCA LANÇA ═══
 *
 * Falha de leitura, do fornecedor ou da gravação vira `null` ou um aviso no
 * log, sem o texto da mensagem.
 */
import type pg from "pg";

import type { IntentVerdict } from "@/lib/agent-engine/agent/intent-classifier";
import type { RouterMember } from "@/lib/agent-engine/agent/router-config";
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import { logger } from "@/lib/logger";
import { scrubMessage } from "@/lib/sentry/scrub";

import { MODELO_DO_JEV, type MotivoDaAusencia, type Pergunta } from "./cliente";
import type { EstadoDaTarefa, EstadoQuePergunta } from "./config";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { estadoDaTarefaNoPool, registrarFalhaQuePedeAcao } from "./pool";
import { decidirNoPonto, type DependenciasDoPonto } from "./ponto";
import { roteadorCabeNaPergunta, TAREFA_DO_ROTEADOR } from "./tarefas";
import { codigoDoErroDoJev } from "./textos";

export { MEMBROS_NO_MAXIMO } from "./tarefas";

/** "Nenhuma se aplica" — a mesma palavra do classificador de sempre (`parseIntentVerdict`). */
const NENHUMA = "none";

const INSTRUCAO =
  "Qual destas intenções descreve a ÚLTIMA mensagem do cliente? Ela decide qual área da empresa vai atendê-lo.";

/**
 * A pergunta, ou `null` quando não há o que perguntar: sem membro nenhum, ou
 * com mais do que o fornecedor aceita — a API recusaria a chamada inteira, e a
 * recusa abriria o disjuntor da tarefa sem ninguém ter errado nada.
 *
 * Os critérios são os do prompt do classificador de sempre
 * (`buildClassifierPrompt`), intenção a intenção. Um membro chamado `none`
 * fica de fora, como lá: o classificador de sempre também lê `none` como
 * "nenhuma".
 */
export function perguntaDoRoteador(membros: readonly RouterMember[]): Pergunta | null {
  if (!roteadorCabeNaPergunta(membros.length)) return null;
  const criterios: Record<string, string> = {};
  for (const m of membros) {
    const exemplos = m.examples.length > 0 ? ` Exemplos: ${m.examples.join("; ")}.` : "";
    criterios[m.intentName] = `${m.intentDescription}.${exemplos}`;
  }
  criterios[NENHUMA] = "Nenhuma das intenções acima se aplica.";
  return { tipo: "choice", instrucao: INSTRUCAO, criterios };
}

export interface EscolhaDoJev {
  /** O estado da tarefa quando ele respondeu. */
  estado: EstadoQuePergunta;
  /**
   * Na língua do classificador de sempre: a intenção (`null` = nenhuma, ou uma
   * que não é do roteador) e a probabilidade calibrada da escolha — é sobre ela
   * que o `min_confidence` do roteador vale.
   */
  veredito: IntentVerdict;
  confianca: number;
  /** A versão que DE FATO respondeu — vai para `llm_calls.model` e para o preço. */
  modelo: string;
  tokensDeEntrada: number;
  tokensDeSaida: number;
  latenciaMs: number;
}

/**
 * Por que ele não opinou — é o que a cobertura grava. Também quando nada saiu
 * para a rede (sem chave, disjuntor aberto): decidindo, a IA de sempre cobriu
 * do mesmo jeito, e numa queda longa eram centenas de coberturas sem rastro.
 * `linhaId` é a linha de erro que a falha que pede ação já deixou
 * (`registrarFalhaQuePedeAcao`): a cobertura a remarca, sem duplicar.
 */
interface FalhaDoJev {
  motivo: MotivoDaAusencia;
  status: number | null;
  latenciaMs: number | null;
  linhaId: string | null;
}

type RespostaDoJev = { escolha: EscolhaDoJev; falha: null } | { escolha: null; falha: FalhaDoJev | null };

const SEM_OPINIAO: RespostaDoJev = { escolha: null, falha: null };

/** A pergunta não saiu — mas, se ele decide, a IA de sempre o cobre, e isso deixa rastro. */
const semRede = (motivo: "sem_credencial" | "disjuntor_aberto"): RespostaDoJev => ({
  escolha: null,
  falha: { motivo, status: null, latenciaMs: null, linhaId: null },
});

export interface EntradaDoRoteador {
  organizationId: string;
  /** A última mensagem do cliente, sozinha. */
  mensagem: string;
  membros: readonly RouterMember[];
  contactId: string | null;
  jobId: string | null;
}

/**
 * Pergunta ao Jev com a tarefa já lida (`estado`). Sem escolha quando ele não
 * opina: disjuntor aberto, sem chave, falha do fornecedor, resposta que não é
 * uma escolha — e sempre com o porquê. Uma escolha fora
 * das intenções do roteador vale "nenhuma" — a mesma defesa do classificador
 * de sempre contra intenção inventada: o roteamento dá ao cliente as
 * ferramentas do agente escolhido.
 */
async function perguntar(
  pool: pg.Pool,
  entrada: EntradaDoRoteador,
  estado: EstadoQuePergunta,
  pergunta: Pergunta,
  deps: DependenciasDoPonto,
): Promise<RespostaDoJev> {
  const alvo = { organizationId: entrada.organizationId, tarefa: TAREFA_DO_ROTEADOR.id };
  if (!podeTentar(alvo)) return semRede("disjuntor_aberto");

  const r = await decidirNoPonto(
    {
      ponto: "intent_router",
      organizationId: entrada.organizationId,
      estado: scrubMessage(entrada.mensagem),
      perguntas: { roteador: pergunta },
    },
    deps,
  );
  if (!r.ok) {
    registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
    if (r.motivo !== "sem_credencial") {
      logger.warn("Jev não respondeu sobre o roteador; vale só a IA de sempre", {
        organization_id: entrada.organizationId,
        motivo: r.motivo,
      });
    }
    const linhaId = r.exigeAcao
      ? await registrarFalhaQuePedeAcao(pool, { ...entrada, purpose: "intent_router" }, r)
      : null;
    if (r.motivo === "sem_credencial" || r.motivo === "disjuntor_aberto") return semRede(r.motivo);
    return {
      escolha: null,
      falha: { motivo: r.motivo, status: r.status, latenciaMs: r.latenciaMs ?? null, linhaId },
    };
  }

  const resposta = r.respostas["roteador"];
  if (resposta?.tipo !== "choice") {
    registrarFalha(alvo, "resposta_ilegivel", Date.now());
    logger.warn("Jev respondeu ao roteador fora de uma escolha; vale só a IA de sempre", {
      organization_id: entrada.organizationId,
    });
    return {
      escolha: null,
      falha: { motivo: "resposta_ilegivel", status: null, latenciaMs: r.latenciaMs, linhaId: null },
    };
  }

  registrarSucesso(alvo);
  const conhecida = resposta.escolha !== NENHUMA && entrada.membros.some((m) => m.intentName === resposta.escolha);
  const probabilidade = resposta.probabilidades[resposta.escolha] ?? resposta.confianca;
  return {
    escolha: {
      estado,
      // Fora da lista, a confiança é zero, como no `parseIntentVerdict`: não há
      // probabilidade de "nenhuma" que ele tenha de fato dado.
      veredito: conhecida
        ? { intentName: resposta.escolha, confidence: probabilidade }
        : { intentName: null, confidence: resposta.escolha === NENHUMA ? probabilidade : 0 },
      confianca: resposta.confianca,
      modelo: r.modelo,
      tokensDeEntrada: r.uso.tokensDeEntrada,
      tokensDeSaida: r.uso.tokensDeSaida,
      latenciaMs: r.latenciaMs,
    },
    falha: null,
  };
}

/**
 * Decidindo, o Jev não respondeu e a IA de sempre escolheu no lugar dele: a
 * linha que o cartão conta em "Vezes que a IA de sempre cobriu o Jev" e que
 * Execuções mostra. Sem ela, com o Jev estourando o teto em parte das
 * mensagens, o cartão dizia zero coberturas e nenhuma falha. A falha que pede
 * ação já deixou a linha dela: é remarcada, e não duplicada. Nunca lança.
 */
async function registrarCobertura(pool: pg.Pool, entrada: EntradaDoRoteador, falha: FalhaDoJev): Promise<void> {
  try {
    if (falha.linhaId !== null) {
      await pool.query(
        `update public.llm_calls set origem_da_escolha = 'reserva_do_jev'
          where id = $1 and organization_id = $2`,
        [falha.linhaId, entrada.organizationId],
      );
      return;
    }
    await pool.query(
      `insert into public.llm_calls
         (organization_id, contact_id, job_id, purpose, provider, model,
          input_tokens, output_tokens, cost_cents, latency_ms, status, error_code, http_status, origem_da_escolha)
       values ($1, $2, $3, 'intent_router', 'typesafe', $4, 0, 0, 0, $5, 'erro', $6, $7, 'reserva_do_jev')`,
      [
        entrada.organizationId,
        entrada.contactId,
        entrada.jobId,
        `typesafe/${MODELO_DO_JEV}`,
        falha.latenciaMs,
        codigoDoErroDoJev(falha.motivo),
        falha.status,
      ],
    );
  } catch (erro) {
    logger.warn("cobertura do Jev no roteador não foi gravada", {
      organization_id: entrada.organizationId,
      erro: erro instanceof Error ? erro.message.slice(0, 200) : typeof erro,
    });
  }
}

export interface RegistroDoRoteador {
  organizationId: string;
  contactId: string | null;
  jobId: string | null;
  jev: EscolhaDoJev;
  /** A escolha dele valeu no turno — é a origem da linha em `llm_calls`. */
  decidiu: boolean;
  /**
   * O par que o cartão compara. `null` na tela "Testar classificação": uma
   * frase digitada por quem configura não é concordância de atendimento (R5).
   */
  observacao: {
    conversationId: string | null;
    messageId: string | null;
    /** O agente a que a escolha DELE levaria. */
    rotuloDoJev: string;
    /** O agente a que a da IA de sempre levou; `null` quando ela não decidiu. */
    rotuloDaIa: string | null;
  } | null;
}

/**
 * Uma linha em `llm_calls` (o custo, em Execuções — R8) e, no turno, uma em
 * `jev_observacoes`, no MESMO comando: uma sem a outra contaria uma resposta que
 * não custou, ou um custo sem resposta. Nunca lança.
 */
export async function registrarRoteadorDoJev(pool: pg.Pool, r: RegistroDoRoteador): Promise<void> {
  const custo = [
    r.organizationId,
    r.contactId,
    r.jobId,
    `typesafe/${r.jev.modelo}`,
    r.jev.tokensDeEntrada,
    r.jev.tokensDeSaida,
    // Fracionário: a centavo por chamada, o Jev custaria ~600x o preço real.
    // Versão sem preço na tabela sai `null`, nunca o preço de outra.
    costCents(r.jev.modelo, {
      inputTokens: r.jev.tokensDeEntrada,
      outputTokens: r.jev.tokensDeSaida,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    r.jev.latenciaMs,
    // Sem observação é o clique de teste: dizer "registrada para comparar" em
    // Execuções seria falso.
    r.observacao === null ? "jev_teste" : r.decidiu ? "jev" : "jev_observacao",
  ];
  const insertDoCusto = `insert into public.llm_calls
       (organization_id, contact_id, job_id, purpose, provider, model,
        input_tokens, output_tokens, cost_cents, latency_ms, status, origem_da_escolha)
     values ($1, $2, $3, 'intent_router', 'typesafe', $4, $5, $6, $7, $8, 'ok', $9)`;
  try {
    if (r.observacao === null) {
      await pool.query(insertDoCusto, custo);
      return;
    }
    await pool.query(
      `with observacao as (
         insert into public.jev_observacoes
           (organization_id, tarefa, estado, conversation_id, message_id, job_id,
            rotulo_jev, probabilidade_jev, confianca_jev, rotulo_atual, modelo, latencia_ms)
         values ($1, $10, $11, $12, $13, $3, $14, $15, $16, $17, $18, $8)
         -- O retry do job pergunta de novo sobre a MESMA mensagem: a primeira
         -- resposta fica, e o custo da segunda entra em llm_calls, porque houve.
         on conflict (organization_id, tarefa, message_id) where message_id is not null do nothing
       )
       ${insertDoCusto}`,
      [
        ...custo,
        TAREFA_DO_ROTEADOR.id,
        r.jev.estado,
        r.observacao.conversationId,
        r.observacao.messageId,
        r.observacao.rotuloDoJev,
        r.jev.veredito.confidence,
        r.jev.confianca,
        r.observacao.rotuloDaIa,
        r.jev.modelo,
      ],
    );
  } catch (erro) {
    // A observação é telemetria: perdê-la não pode derrubar o atendimento.
    logger.warn("resposta do Jev sobre o roteador não foi gravada", {
      organization_id: r.organizationId,
      erro: erro instanceof Error ? erro.message.slice(0, 200) : typeof erro,
    });
  }
}

/** O Jev no roteador, começado JUNTO do classificador de sempre. */
export interface JevNoRoteador {
  /**
   * O estado da tarefa, lido do banco — rápido, e é ele que diz se o turno
   * espera pela escolha. Nunca rejeita (`desligada` quando a leitura falha, ou
   * quando a mensagem vem vazia).
   */
  estado: Promise<EstadoDaTarefa>;
  /** A escolha dele, ou `null` quando não opinou. Nunca rejeita. */
  escolha: Promise<EscolhaDoJev | null>;
  /**
   * Grava a escolha, quando houver, ao lado da de sempre — sem que ninguém
   * espere por isso: observando, o turno já seguiu. Nunca lança.
   */
  observar(r: {
    conversationId: string | null;
    messageId: string | null;
    /** O agente a que um veredito leva — a mesma régua para os dois lados. */
    rotuloDe: (veredito: IntentVerdict) => string;
    /** O veredito da IA de sempre; `null` quando ela não decidiu. */
    vereditoDaIa: IntentVerdict | null;
    decidiu: boolean;
    /**
     * Decidindo, e ele não respondeu: a IA de sempre escolheu no lugar dele. É
     * o turno quem sabe — o estado, e se a IA de sempre respondeu.
     */
    aIaCobriu: boolean;
  }): void;
}

export function consultarJevNoRoteador(
  pool: pg.Pool,
  entrada: EntradaDoRoteador,
  deps: DependenciasDoPonto = {},
): JevNoRoteador {
  const estado: Promise<EstadoDaTarefa> =
    entrada.mensagem.trim() === ""
      ? Promise.resolve("desligada")
      : estadoDaTarefaNoPool(pool, entrada.organizationId, TAREFA_DO_ROTEADOR);
  // A pergunta só é montada com a tarefa rodando: desligado, o Jev não custa
  // nada ao turno além da leitura do estado.
  const resposta: Promise<RespostaDoJev> = estado
    .then((e) => {
      const pergunta = e === "desligada" ? null : perguntaDoRoteador(entrada.membros);
      return e === "desligada" || pergunta === null ? SEM_OPINIAO : perguntar(pool, entrada, e, pergunta, deps);
    })
    // O turno espera esta promessa quando o Jev decide: rejeitada, ela levaria
    // o roteamento inteiro para o caminho de erro. Sem escolha, vale a de sempre.
    .catch((erro: unknown) => {
      logger.warn("Jev não pôde ser perguntado sobre o roteador; vale só a IA de sempre", {
        organization_id: entrada.organizationId,
        erro: erro instanceof Error ? erro.name : typeof erro,
      });
      return SEM_OPINIAO;
    });
  const escolha = resposta.then((r) => r.escolha);
  return {
    estado,
    escolha,
    observar: ({ conversationId, messageId, rotuloDe, vereditoDaIa, decidiu, aIaCobriu }) => {
      void resposta
        .then(({ escolha: jev, falha }) =>
          jev === null
            ? aIaCobriu && falha !== null
              ? registrarCobertura(pool, entrada, falha)
              : undefined
            : registrarRoteadorDoJev(pool, {
                organizationId: entrada.organizationId,
                contactId: entrada.contactId,
                jobId: entrada.jobId,
                jev,
                decidiu,
                observacao: {
                  conversationId,
                  messageId,
                  rotuloDoJev: rotuloDe(jev.veredito),
                  rotuloDaIa: vereditoDaIa === null ? null : rotuloDe(vereditoDaIa),
                },
              }),
        )
        // Ninguém espera esta promessa: sem o catch, um `rotuloDe` que lançasse
        // viraria rejeição solta, e o Node derruba o processo do worker por ela.
        .catch((erro: unknown) => {
          logger.warn("resposta do Jev sobre o roteador não foi gravada", {
            organization_id: entrada.organizationId,
            erro: erro instanceof Error ? erro.message.slice(0, 200) : typeof erro,
          });
        });
    },
  };
}
