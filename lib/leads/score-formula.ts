import type { RiskBucket } from "@/lib/leads/risk-radar";
import { resolveBand, type ScoreBand } from "@/lib/kanban/score-band";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/**
 * O score é FÓRMULA, não chamada de modelo — e a diferença não é de custo.
 *
 * Com fórmula, o `reason` é DERIVADO do cálculo: cada parcela que mexeu no
 * número aparece na frase, e "número sem porquê" fica impossível por
 * construção. Com um modelo, a frase seria gerada AO LADO do número, e a lei
 * ("score sem razão não é gravado") passaria a ser cumprida na aparência —
 * a constraint aceitaria uma explicação que não explica nada.
 *
 * É também o que torna o score discutível: um humano que discorda pode apontar
 * QUAL parcela está errada, em vez de discordar de um oráculo.
 */

/** O que a fórmula lê. Nada aqui é inventado: tudo já existe no sistema. */
export interface SinaisDoLead {
  /** `lead_checkpoints.commitments` do checkpoint mais recente. */
  commitments: string[];
  /** `lead_checkpoints.objections` do mesmo checkpoint. */
  objections: string[];
  /** Id do checkpoint que sustenta os dois acima — o lastro citável. */
  checkpointId: string | null;
  /** `lead_state.qualification` (BANT): só as chaves preenchidas contam. */
  qualification: Record<string, unknown>;
  /**
   * Recência, VINDA do classificador único (`classifyRisk`).
   *
   * Não se calcula janela de tempo aqui. Escrever "sem resposta há N horas"
   * dentro da fórmula criaria um segundo classificador ESCONDIDO DENTRO DE UM
   * CÁLCULO — o pior lugar possível, porque ninguém procuraria por ele lá.
   */
  risco: RiskBucket;
  /**
   * `crm_leads.status`. Negócio FECHADO não tem probabilidade de fechar —
   * um lead ganho exibindo "72%" para sempre é o dado que não muda decisão
   * nenhuma, e o card ficaria carregando um número que já foi respondido.
   */
  status: "open" | "won" | "lost";
  /** Faixa anterior, para a histerese. `null` na primeira vez. */
  bandAnterior: ScoreBand | null;
}

/**
 * Uma parcela do cálculo, ESTRUTURADA — não só dentro da frase.
 *
 * O card precisa renderizar as evidências separadas, e extraí-las do `reason`
 * exigiria fazer parse de volta do texto que a fórmula acabou de montar. É o
 * mesmo anti-pattern já barrado no 4.5 (ler a frase legível em vez do payload):
 * frase é para humano, estrutura é para máquina, e quem precisa das duas grava
 * as duas.
 */
export interface FatorDoScore {
  /** Com sinal: o sinal É o número. Campo separado poderia divergir dele. */
  pontos: number;
  frase: string;
  /** Para onde o clique leva, quando existe um ponto no tempo. */
  ancora?: { kind: "checkpoint" | "message"; id: string };
}

/** Versão da fórmula. Sem ela, score de v1 e de v2 são maçã com pera. */
export const FORMULA_V = 1;

export interface ScoreCalculado {
  /** `null` = sinal insuficiente. NUNCA zero — zero é uma afirmação. */
  score: number | null;
  reason: string;
  /**
   * FONTE ÚNICA (migration 0077): só `factors`, cada um com a sua âncora.
   *
   * Os arrays de ids saíram: manter as duas listas trocava "podem não existir
   * juntas" por "existem juntas e podem DISCORDAR" — mais raro e mais difícil
   * de detectar, porque as duas passam.
   */
  evidence: {
    formula_v?: number;
    factors?: FatorDoScore[];
  };
  band: ScoreBand | null;
  /** Por que não deu score, quando não deu — para o log, não para a tela. */
  semSinal?: "sem_lastro_citavel" | "sem_conteudo" | "negocio_fechado";
}

/** Uma parcela do cálculo: o quanto mexeu e como isso se lê em português. */
interface Parcela {
  pontos: number;
  frase: string;
}

const BASE = 30;
const POR_COMPROMISSO = 12;
const POR_OBJECAO = -8;
const POR_CAMPO_BANT = 5;
const TETO_COMPROMISSOS = 3;
const TETO_OBJECOES = 3;
const TETO_BANT = 4;
/** Abaixo disto não há score: um sinal só é magro demais para virar porcentagem. */
const MINIMO_DE_SINAIS = 2;
/** O contrato promete três evidências na tela; a frase acompanha. */
const MAX_PARCELAS_NA_FRASE = 3;

/** Recência entra como AJUSTE, com os buckets do classificador único. */
const PESO_RISCO: Record<RiskBucket, number> = {
  em_dia: 10,
  em_voo: 0,
  em_risco: -10,
  critico: -20,
};

const FRASE_RISCO: Record<RiskBucket, string> = {
  em_dia: "conversa em dia",
  em_voo: "resposta da IA a caminho",
  em_risco: "sem resposta além do esperado",
  critico: "sem resposta há muito tempo",
};

/**
 * A razão e as frases dos fatores são GRAVADAS (`ai_probability_reason`,
 * `ai_probability_evidence`) e a tela as mostra como vieram, então nascem no
 * idioma da organização. `pt-BR` devolve a chave: byte a byte o de antes.
 */
let idiomaDaFrase: Idioma = "pt-BR";
const tr = (texto: string): string => traduzir(texto, idiomaDaFrase);

function plural(n: number, singular: string, plural_: string): string {
  return `${n} ${tr(n === 1 ? singular : plural_)}`;
}

/**
 * Calcula o score, ou recusa a calcular.
 *
 * A RECUSA É O CAMINHO NORMAL para um lead novo, e isso é deliberado: um lead
 * criado à mão há cinco minutos tem estágio e tem recência, e não tem nada a
 * dizer sobre fechar. Por isso VITALIDADE NÃO CONTA PARA O MÍNIMO — só conteúdo
 * conta (compromisso, objeção ou BANT). Sem essa cláusula, todo lead novo
 * nasceria com um número, e o cenário 17 falharia por dentro parecendo sucesso.
 *
 * E exige-se LASTRO CITÁVEL: sem o checkpoint que sustenta os fatos, a razão
 * viraria adjetivo e a evidência ficaria vazia — a constraint recusaria a
 * gravação, e com razão. Melhor recusar aqui, com motivo legível, do que
 * descobrir no INSERT.
 */
export function calculaScore(sinais: SinaisDoLead, idioma: Idioma = "pt-BR"): ScoreCalculado {
  idiomaDaFrase = idioma;
  try {
    return calculaScoreNoIdioma(sinais);
  } finally {
    idiomaDaFrase = "pt-BR";
  }
}

function calculaScoreNoIdioma(sinais: SinaisDoLead): ScoreCalculado {
  // DELTA 1 — negócio fechado não tem probabilidade de fechar. Vem antes de
  // tudo: não importa quanto sinal exista, a pergunta já foi respondida.
  if (sinais.status !== "open") {
    return { score: null, reason: "", evidence: {}, band: null, semSinal: "negocio_fechado" };
  }

  const compromissos = sinais.commitments.filter((c) => c.trim() !== "");
  const objecoes = sinais.objections.filter((o) => o.trim() !== "");
  const camposBant = Object.entries(sinais.qualification).filter(
    ([, v]) => typeof v === "string" && v.trim() !== "",
  ).length;

  // DELTA 4 — DOIS sinais substantivos, não um. Score construído sobre um
  // único campo preenchido é magro demais para virar porcentagem na tela, e
  // uma porcentagem magra é indistinguível de uma bem apurada para quem lê.
  // Recência NÃO conta aqui: vitalidade não é conteúdo (ver cenário 17).
  const substantivos = compromissos.length + objecoes.length + camposBant;
  if (substantivos < MINIMO_DE_SINAIS) {
    return { score: null, reason: "", evidence: {}, band: null, semSinal: "sem_conteudo" };
  }
  if (sinais.checkpointId === null) {
    return { score: null, reason: "", evidence: {}, band: null, semSinal: "sem_lastro_citavel" };
  }

  const ancora = { kind: "checkpoint" as const, id: sinais.checkpointId };
  const fatores: FatorDoScore[] = [];
  const nComp = Math.min(compromissos.length, TETO_COMPROMISSOS);
  if (nComp > 0) {
    fatores.push({
      pontos: nComp * POR_COMPROMISSO,
      frase: plural(nComp, "compromisso do cliente", "compromissos do cliente"),
      ancora,
    });
  }
  const nObj = Math.min(objecoes.length, TETO_OBJECOES);
  if (nObj > 0) {
    fatores.push({
      pontos: nObj * POR_OBJECAO,
      frase: plural(nObj, "objeção em aberto", "objeções em aberto"),
      ancora,
    });
  }
  const nBant = Math.min(camposBant, TETO_BANT);
  if (nBant > 0) {
    // QUALIFICAÇÃO NÃO GANHA ÂNCORA, e a ausência é DECIDIDA — não esquecimento.
    //
    // ⚠️ Ela era acidental até 2026-08-30, e a diferença custou um defeito: no
    // fator de recência logo abaixo a ausência sempre teve comentário; aqui não
    // tinha nenhum, e foi justamente a não documentada que quebrou. Um negócio
    // só-BANT montava fatores sem âncora nenhuma e morria no INSERT com 23514,
    // sem score e sem sintoma legível (ver a guarda de lastro adiante).
    // Observação do @Maestro (2), conferindo o conserto: no mesmo arquivo, a
    // ausência pensada estava escrita e a acidental não.
    //
    // POR QUE ela não pode ganhar a âncora que está à mão: os campos BANT vêm de
    // `lead_state.qualification`, e o formato é `{kind: "checkpoint" | "message"}`.
    // Apontar para o checkpoint seria citar como fonte algo que não sustenta
    // aquele número — e âncora falsa é pior que ausente, porque a âncora existe
    // exatamente para dizer DE ONDE veio.
    //
    // Devolver score ao lead só-BANT exige um `kind` novo, e isso é contrato:
    // decisão de produto, registrada e não tomada aqui.
    fatores.push({
      pontos: nBant * POR_CAMPO_BANT,
      frase: plural(nBant, "item de qualificação", "itens de qualificação"),
    });
  }
  // Recência não ganha âncora: ela não é um ponto no tempo da conversa, é a
  // AUSÊNCIA de pontos. Dar-lhe âncora seria apontar para o que não aconteceu.
  fatores.push({ pontos: PESO_RISCO[sinais.risco], frase: tr(FRASE_RISCO[sinais.risco]) });

  const bruto = fatores.reduce((soma, f) => soma + f.pontos, BASE);
  const score = Math.max(0, Math.min(100, bruto));

  const relevantes = fatores
    .filter((f) => f.pontos !== 0)
    .sort((a, b) => Math.abs(b.pontos) - Math.abs(a.pontos));

  /**
   * LASTRO CITÁVEL É SOBRE O FATOR, NÃO SOBRE O CHECKPOINT EXISTIR.
   *
   * A guarda lá em cima recusa quando não há checkpoint nenhum — necessária,
   * mas não suficiente: só os fatores de COMPROMISSO e OBJEÇÃO recebem a
   * âncora. Um negócio cujo conteúdo é apenas qualificação (BANT) passa por
   * aquela guarda, tem dois sinais substantivos, e produz fatores em que NENHUM
   * tem âncora — enquanto a constraint do banco exige
   * `evidence @? '$.factors[*].ancora'`.
   *
   * O desfecho, medido pelo caminho de produção (`recalculaScoreDoLead` contra
   * o Postgres do `test:db`, invariante `score-escritor-real-satisfaz-a-constraint`):
   * `23514` dentro do worker, e o lead fica **sem score nenhum** — tela vazia e
   * causa só no log. O cabeçalho desta função já prometia o contrário: "melhor
   * recusar aqui, com motivo legível, do que descobrir no INSERT". A promessa
   * estava escrita; a verificação parou no checkpoint EXISTIR, e não em algum
   * fator USAR a âncora dele.
   *
   * A conta é sobre `relevantes` e não sobre `fatores`: é `relevantes` que vai
   * para `evidence`, e um fator de zero ponto é filtrado antes de chegar lá —
   * checar a lista errada deixaria a mesma linha passar por outro caminho.
   *
   * NÃO se resolve dando âncora ao fator de qualificação: ela viria de
   * `lead_state`, e o formato da âncora é `{kind: "checkpoint" | "message"}`.
   * Apontar o BANT para o checkpoint seria citar como fonte algo que não o
   * sustenta. Dar-lhe âncora própria é decisão de produto (um `kind` novo), não
   * conserto de defeito.
   */
  if (!relevantes.some((f) => f.ancora)) {
    return { score: null, reason: "", evidence: {}, band: null, semSinal: "sem_lastro_citavel" };
  }

  // DELTA 4 (segunda metade) — no máximo TRÊS parcelas nomeadas, que é o que o
  // contrato promete. O resto vira UMA linha agregada em vez de sumir: truncar
  // sem dizer quebraria a reconstrução da frase, e uma razão que não soma o
  // próprio número é a frase gerada que a C1 proíbe, com outro disfarce.
  const nomeadas = relevantes.slice(0, MAX_PARCELAS_NA_FRASE);
  const resto = relevantes.slice(MAX_PARCELAS_NA_FRASE);
  const pontosDoResto = resto.reduce((soma, f) => soma + f.pontos, 0);
  const partes = nomeadas.map(escreveParcela);
  if (resto.length > 0 && pontosDoResto !== 0) {
    partes.push(
      `${pontosDoResto > 0 ? "+" : "−"}${Math.abs(pontosDoResto)} ` +
        plural(resto.length, "outro fator", "outros fatores"),
    );
  }

  // O CLAMP PRECISA APARECER. É o único caso em que a soma das parcelas não dá o
  // número exibido — e uma razão que não fecha com o próprio score é
  // indistinguível de razão gerada, que é o que a C1 proíbe. Dizer "limitado a
  // 0" custa quatro palavras e mantém a conta auditável por quem lê.
  if (score !== bruto) {
    partes.push(tr("limitado a {n}").replace("{n}", String(score)));
  }

  return {
    score,
    reason: partes.length > 0 ? partes.join(", ") : tr("sem parcelas relevantes além da base"),
    evidence: { formula_v: FORMULA_V, factors: relevantes },
    band: resolveBand(score, sinais.bandAnterior),
  };
}

function escreveParcela(f: FatorDoScore): string {
  return `${f.pontos > 0 ? "+" : "−"}${Math.abs(f.pontos)} ${f.frase}`;
}
