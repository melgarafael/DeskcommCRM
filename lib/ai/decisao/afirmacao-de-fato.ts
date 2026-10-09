/**
 * A CONFERÊNCIA DE FATO NO TURNO (#2231) — quem conversa com o Jev e quem grava.
 *
 * A camada pura está em `@/lib/agent-engine/guardrails/factual-claim` (frases,
 * perguntas, limiares, veredito). Aqui é o resto: a leitura do interruptor da
 * organização, a UMA requisição por turno, a credencial pelo mesmo seam do Jev
 * (`decidirNoPonto`), o disjuntor, a linha de custo em `llm_calls` e a
 * observação em `jev_observacoes`.
 *
 * ═══ AS REGRAS QUE ESTE ARQUIVO GARANTE ═══
 *
 *  - `desligada` ou `sem_credencial`: ZERO requisição e ZERO linha em
 *    `llm_calls` — o envio fica idêntico ao de hoje (a catraca de
 *    `./provedores-de-decision-catraca.test.ts`).
 *  - Falha do provedor (timeout acima de `TETO_PADRAO_MS`, 429, 5xx ou 401) →
 *    a mensagem segue como hoje e o disjuntor pausa a tarefa. Fail-open: quem
 *    não sabe o que a base diz não pode proibir a frase.
 *  - A candidata passa pelo `scrubMessage` antes de virar estado: a resposta do
 *    assistente pode repetir dado do cliente (telefone, CPF), e o estado é o
 *    que sai para o fornecedor.
 *  - A evidência de OUTRA organização nunca chega ao estado: quem alimenta é o
 *    `evidenciasComerciais` do MESMO turno, registrado pelas ferramentas que
 *    este agente chamou (mesma cerca do #2010).
 *  - Em `observando` a única consequência é a observação: rótulo e ponteiro,
 *    nunca texto — a mesma economia de `jev_observacoes` (0421).
 */
import { costCents } from "@/lib/agent-engine/edge/llm/pricing";
import {
  decidirAfirmacoes,
  frasesParaConferir,
  type ConferenciaDeFato,
  type MotivoDeNaoConferir,
} from "@/lib/agent-engine/guardrails/factual-claim";
import type { EvidenciaComercial } from "@/lib/agent-engine/guardrails/promise/evidencias-comerciais";
import { logger } from "@/lib/logger";
import { scrubMessage } from "@/lib/sentry/scrub";
import type { createAdminClient } from "@/lib/supabase/admin";

import { MODELO_DO_JEV, type FalhaDaDecisao, type Pergunta, type Resposta } from "./cliente";
import { lerConfigDoJev, type EstadoDaTarefa } from "./config";
import { podeTentar, registrarFalha, registrarSucesso } from "./disjuntor";
import { decidirNoPonto, type DependenciasDoPonto } from "./ponto";
import { codigoDoErroDoJev } from "./textos";
import { AFIRMACAO_DE_FATO, estadoEfetivoDaTarefa, TAREFA_DA_AFIRMACAO_DE_FATO } from "./tarefas";

type Admin = ReturnType<typeof createAdminClient>;

/** O que o chamador fecha dentro da closure (inbound-turn), uma vez por turno. */
export interface EntradaBaseDaConferencia {
  organizationId: string;
  conversationId: string | null;
  contactId: string | null;
  /** A linha de custo vai para a conta dele em Uso de IA. */
  agentId: string | null;
  /** Lido NA HORA: as evidências nascem no meio do turno, quando as ferramentas rodam. */
  lerEvidencias: () => readonly EvidenciaComercial[];
}

export interface EntradaDaConferenciaDeFato extends EntradaBaseDaConferencia {
  estado: EstadoDaTarefa;
  /** O corpo do MODELO, antes da post-produção — ainda não scrubbed. */
  candidata: string;
}

function naoConferida(motivo: MotivoDeNaoConferir, quantidadeDeFrases = 0): ConferenciaDeFato {
  return {
    estado: "nao_conferida",
    veredito: "nao_conferido",
    motivo,
    frase: null,
    quantidadeDeFrases,
    pediu: false,
  };
}

/**
 * O estado EFETIVO da tarefa para a organização: interruptor, aceite e o que a
 * empresa escolheu. Nunca lança — leitura que falha é `desligada` (a camada não
 * roda, o envio é o de sempre) e deixa rastro em log.
 */
export async function estadoDaAfirmacao(admin: Admin, organizationId: string): Promise<EstadoDaTarefa> {
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", organizationId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return estadoEfetivoDaTarefa(lerConfigDoJev(data?.settings ?? null), TAREFA_DA_AFIRMACAO_DE_FATO);
  } catch (erro) {
    logger.warn("a conferência de fato não leu a configuração do Jev; a tarefa fica de fora", {
      organization_id: organizationId,
      erro: (erro instanceof Error ? erro.message : String(erro)).slice(0, 160),
    });
    return "desligada";
  }
}

// ── Degrau 2: as perguntas ─────────────────────────────────────────────────

/**
 * Três perguntas por frase, na ordem das frases. Os nomes `claim_i`,
 * `supported_i` e `contradicts_i` são da issue; o `evidencias` citado é o
 * campo do ESTADO (`{ frases, evidencias }`), que sai junto.
 */
export function perguntasDaAfirmacao(frases: readonly string[]): Record<string, Pergunta> {
  const perguntas: Record<string, Pergunta> = {};
  frases.forEach((frase, i) => {
    perguntas[`claim_${i}`] = {
      tipo: "noul",
      instrucao:
        `Does "${frase}" state a fact about this business (opening hours, address, prices, ` +
        "product or service features, availability, policies)? Greetings, questions and generic " +
        "marketing slogans are not facts.",
    };
    perguntas[`supported_${i}`] = {
      tipo: "noul",
      instrucao: `Is the fact in "${frase}" stated in evidencias, in any wording or format?`,
    };
    perguntas[`contradicts_${i}`] = {
      tipo: "noul",
      instrucao: `Does evidencias state something that contradicts "${frase}"?`,
    };
  });
  return perguntas;
}

/**
 * Uma conferência, sem cache e sem conta de requisição — quem chama duas vezes
 * no mesmo turno é `criarConferidorDeAfirmacoes`. Nunca lança.
 */
export async function conferirAfirmacoes(
  admin: Admin,
  e: EntradaDaConferenciaDeFato,
  deps: DependenciasDoPonto = {},
): Promise<ConferenciaDeFato> {
  // 1. Desligada: zero requisição, zero linha, envio idêntico ao de hoje.
  if (e.estado === "desligada") return naoConferida("desligada");
  // 2. Sem evidência consultada no turno o agente respondeu de memória: a
  //    camada não roda e grava "não conferido" — a postura do #2010.
  const evidencias = e.lerEvidencias();
  if (evidencias.length === 0) return naoConferida("sem_evidencia");
  // 3. Degrau 1 (sem rede): pergunta, saudação e link saem por regra simples.
  const frases = frasesParaConferir(scrubMessage(e.candidata));
  if (frases.length === 0) return naoConferida("sem_frases");

  const alvo = { organizationId: e.organizationId, tarefa: AFIRMACAO_DE_FATO.purpose };
  if (!podeTentar(alvo)) {
    await gravarFalha(admin, e, {
      ok: false,
      motivo: "disjuntor_aberto",
      exigeAcao: false,
      defeitoNosso: false,
      status: null,
      latenciaMs: undefined,
    });
    return naoConferida("falha", frases.length);
  }

  // 4. O estado que sai é EXATAMENTE { frases, evidencias } — nem a conversa,
  //    nem a pessoa, nem a organização viajam junto.
  const r = await decidirNoPonto(
    {
      organizationId: e.organizationId,
      ponto: "afirmacao_de_fato",
      estado: { frases, evidencias },
      perguntas: perguntasDaAfirmacao(frases),
    },
    deps,
  );
  if (!r.ok) {
    registrarFalha(alvo, r.motivo, Date.now(), r.retryAfterMs);
    // `sem_credencial` é configuração, não falha: nada saiu e nada se conta —
    // a catraca do aceite exige ZERO linha em `llm_calls`.
    if (r.motivo !== "sem_credencial") {
      logger.warn("a conferência de fato não respondeu; a mensagem segue como hoje", {
        organization_id: e.organizationId,
        motivo: r.motivo,
      });
      await gravarFalha(admin, e, r);
    }
    return {
      ...naoConferida(r.motivo === "sem_credencial" ? "sem_credencial" : "falha", frases.length),
      pediu: r.motivo !== "sem_credencial" && r.motivo !== "disjuntor_aberto",
    };
  }
  registrarSucesso(alvo);
  await gravarCusto(admin, e, r);

  // 5. Degrau 3: a decisão é em CÓDIGO, pelo máximo das frases. Resposta fora
  //    de probabilidade é `resposta_ilegivel` — fail-open, nunca um veto.
  //    A evidência vai junto (#2582): é o que a corroboração mecânica usa para
  //    não vetar paráfrase cujo preço e itens estão na base, em qualquer forma.
  const evidenciaEmTexto = evidencias.map((ev) => `${ev.titulo}\n${ev.conteudo}`).join("\n");
  const calculo = decidirAfirmacoes(frases, r.respostas, evidenciaEmTexto);
  if (calculo.ilegivel) {
    registrarFalha(alvo, "resposta_ilegivel", Date.now());
    logger.warn("a conferência de fato respondeu fora de uma probabilidade", {
      organization_id: e.organizationId,
    });
    await gravarFalha(admin, e, {
      ok: false,
      motivo: "resposta_ilegivel",
      exigeAcao: false,
      defeitoNosso: false,
      status: 200,
      latenciaMs: r.latenciaMs,
    });
    return { ...naoConferida("falha", frases.length), pediu: true };
  }

  await gravarObservacao(
    admin,
    e,
    e.estado,
    { veredito: calculo.veredito ?? "passa", frase: calculo.frase },
    r.respostas,
    frases,
    r,
  );
  return {
    estado: e.estado,
    veredito: calculo.veredito ?? "passa",
    frase: calculo.frase,
    quantidadeDeFrases: frases.length,
    pediu: true,
  };
}

/**
 * UMA requisição por turno, com a evidência lida na hora. `inbound-turn` fecha
 * esta closure antes do modelo rodar e a repassa ao `runBeforeSend` — que pode
 * ser chamado mais de uma vez no mesmo turno (fail-safes) e sempre recebe o
 * mesmo resultado, sem pagar duas vezes.
 */
export function criarConferidorDeAfirmacoes(
  admin: Admin,
  base: EntradaBaseDaConferencia,
  deps: DependenciasDoPonto = {},
): (candidata: string) => Promise<ConferenciaDeFato> {
  let estado: EstadoDaTarefa | null = null;
  let pediuEsteTurno = false;
  const cache = new Map<string, ConferenciaDeFato>();
  return async (candidata: string): Promise<ConferenciaDeFato> => {
    const emCache = cache.get(candidata);
    if (emCache !== undefined) return emCache;
    // A catraca vale por CANDIDATA: a reescrita do modelo paga no máximo uma
    // nova conferência, e as seguintes do mesmo turno são "não conferido".
    if (pediuEsteTurno) return naoConferida("outra_por_turno");
    if (base.lerEvidencias().length === 0) {
      const semEvidencia = naoConferida("sem_evidencia");
      cache.set(candidata, semEvidencia);
      return semEvidencia;
    }
    if (estado === null) estado = await estadoDaAfirmacao(admin, base.organizationId);
    const r = await conferirAfirmacoes(admin, { ...base, estado, candidata }, deps);
    if (r.pediu) pediuEsteTurno = true;
    cache.set(candidata, r);
    return r;
  };
}

/** A maior `claim_i` da candidata — o que a observação guarda de probabilidade. */
function maiorClaim(respostas: Readonly<Record<string, Resposta>>, quantidadeDeFrases: number): number {
  let maior = 0;
  for (let i = 0; i < quantidadeDeFrases; i += 1) {
    const resposta = respostas[`claim_${i}`];
    if (resposta?.tipo === "noul" && Number.isFinite(resposta.noul) && resposta.noul > maior) {
      maior = resposta.noul;
    }
  }
  return maior;
}

/** Uma observação por conferência: SÓ rótulos e ponteiros (0421 — sem texto). */
async function gravarObservacao(
  admin: Admin,
  e: EntradaDaConferenciaDeFato,
  estado: EstadoDaTarefa,
  calculo: { veredito: string; frase: string | null },
  respostas: Readonly<Record<string, Resposta>>,
  frases: readonly string[],
  r: { modelo: string; latenciaMs: number },
): Promise<void> {
  if (estado === "desligada") return;
  const rotulo =
    calculo.veredito === "contradiz"
      ? "vetado_contradicao"
      : calculo.veredito === "nao_esta_na_base"
        ? "vetado_sem_base"
        : "enviado";
  const { error } = await admin.from("jev_observacoes").insert({
    organization_id: e.organizationId,
    tarefa: TAREFA_DA_AFIRMACAO_DE_FATO.id,
    estado,
    conversation_id: e.conversationId,
    // Sem `message_id` (idem campo-do-negocio): a camada não conhece a mensagem.
    // O par que o cartão lê: o que o Jev disse e o que o mecanismo de HOJE fez
    // (mandou — nada na cadeia de hoje barra fato). "Teria sido vetado" é a
    // diferença dos dois, contada sem guardar frase nenhuma.
    rotulo_jev: rotulo,
    probabilidade_jev: maiorClaim(respostas, frases.length),
    rotulo_atual: "enviado",
    modelo: r.modelo,
    latencia_ms: r.latenciaMs,
  });
  if (error) {
    logger.warn("observação da conferência de fato não foi gravada", {
      organization_id: e.organizationId,
      erro: error.message.slice(0, 200),
    });
  }
}

/** A chamada que deu certo vira linha de custo em Uso de IA (molde de `./campo-do-negocio`). */
async function gravarCusto(
  admin: Admin,
  e: EntradaDaConferenciaDeFato,
  r: { modelo: string; latenciaMs: number; uso: { tokensDeEntrada: number; tokensDeSaida: number } },
): Promise<void> {
  const { error } = await admin.from("llm_calls").insert({
    organization_id: e.organizationId,
    contact_id: e.contactId,
    agent_id: e.agentId,
    purpose: AFIRMACAO_DE_FATO.purpose,
    provider: "typesafe",
    model: `typesafe/${r.modelo}`,
    input_tokens: r.uso.tokensDeEntrada,
    output_tokens: r.uso.tokensDeSaida,
    cost_cents: costCents(r.modelo, {
      inputTokens: r.uso.tokensDeEntrada,
      outputTokens: r.uso.tokensDeSaida,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }),
    latency_ms: r.latenciaMs,
    status: "ok",
    origem_da_escolha: e.estado === "decidindo" ? "jev" : "jev_observacao",
  });
  if (error) {
    logger.warn("custo da conferência de fato não foi gravado", {
      organization_id: e.organizationId,
      erro: error.message.slice(0, 200),
    });
  }
}

/** A falha vira linha em Execuções com `error_code` (`jev_*`). */
async function gravarFalha(admin: Admin, e: EntradaDaConferenciaDeFato, falha: FalhaDaDecisao): Promise<void> {
  const { error } = await admin.from("llm_calls").insert({
    organization_id: e.organizationId,
    contact_id: e.contactId,
    agent_id: e.agentId,
    purpose: AFIRMACAO_DE_FATO.purpose,
    provider: "typesafe",
    model: `typesafe/${MODELO_DO_JEV}`,
    input_tokens: 0,
    output_tokens: 0,
    cost_cents: 0,
    latency_ms: falha.latenciaMs ?? null,
    status: "erro",
    error_code: codigoDoErroDoJev(falha.motivo),
    http_status: falha.status,
    origem_da_escolha: e.estado === "decidindo" ? "jev" : "jev_observacao",
  });
  if (error) {
    logger.warn("falha da conferência de fato não foi gravada", {
      organization_id: e.organizationId,
      erro: error.message.slice(0, 200),
    });
  }
}
