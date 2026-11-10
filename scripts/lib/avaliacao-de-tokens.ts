/**
 * AS AVALIAÇÕES QUE AINDA SEGURAM TRÊS ESCOLHAS DAS FRENTES DE TOKENS — a parte
 * PURA: braços, o que se mede em cada execução, o veredito e o custo previsto.
 * Sem rede e sem banco; quem fala com o mundo é `scripts/avaliar-tokens.ts`.
 * Procedimento, corpus e critérios: docs/runbooks/avaliacoes-de-tokens.md.
 *
 *   C  — LLM_TOOL_SCHEMA_SEM_PADRAO: sem o `pattern` que repete o `format`, o
 *        modelo continua chamando as ferramentas com argumentos válidos?
 *   F5 — LEAD_CONTEXT_HISTORY_FORMAT=linhas: o histórico em linhas preserva quem
 *        disse o quê, o raciocínio de horário e o remetente de grupo?
 *   G  — o fechamento do turno no modelo econômico perde mais que o próprio
 *        modelo do agente perde de uma execução para outra (controle A/A)?
 *
 * Todo erro de classificação cai do lado de NÃO virar o padrão: chamada sem
 * esquema de referência não conta como válida, braço que não provou ser o braço
 * derruba a execução, e amostra abaixo do mínimo é INCONCLUSIVO, nunca aprova.
 */
import { createHash } from "node:crypto";

import { resumir, type AvaliacaoDaConversa } from "@/lib/agent-engine/agent/abertura/comparar-fechamentos";

// ═══ Braços ═══════════════════════════════════════════════════════════════════

export type AvaliacaoDoTurno = "C" | "F5";
export type Avaliacao = AvaliacaoDoTurno | "G";

/** `json_b` é o A/A do F5 — PROPOSTA (o desenho não tem): sem ele, os ≥95% de sequência igual não têm régua de ruído. */
export const BRACOS: Readonly<Record<AvaliacaoDoTurno, readonly string[]>> = {
  C: ["off", "on"],
  F5: ["json", "linhas", "json_b"],
};

/**
 * O ambiente de cada braço: o knob avaliado no valor do braço e o OUTRO no
 * padrão, para que uma avaliação nunca meça as duas mudanças juntas.
 */
export function knobsDoBraco(avaliacao: AvaliacaoDoTurno, braco: string): Record<string, string> {
  if (!BRACOS[avaliacao].includes(braco)) throw new Error(`braço ${braco} não é de ${avaliacao} (${BRACOS[avaliacao].join(", ")})`);
  return avaliacao === "C"
    ? { LLM_TOOL_SCHEMA_SEM_PADRAO: braco, LEAD_CONTEXT_HISTORY_FORMAT: "json" }
    : { LLM_TOOL_SCHEMA_SEM_PADRAO: "off", LEAD_CONTEXT_HISTORY_FORMAT: braco === "linhas" ? "linhas" : "json" };
}

// ═══ O que se grava de cada chamada ao modelo ══════════════════════════════════

export type Validade = "ok" | "formato" | "invalida" | "json_quebrado" | "inexistente" | "sem_referencia";

export interface ChamadaDeFerramenta {
  nome: string;
  validade: Validade;
  /** O nome do esquema de referência tem campo com `format` (uuid, data, e-mail). */
  temFormato: boolean;
  /** Valores com cara de uuid de aterro (`ehUuidDeAterro`). */
  aterro: number;
}

export interface Tokens {
  entrada: number;
  lidos: number;
  gravados: number;
  saida: number;
}

export interface ChamadaGravada {
  /** O pedido levou ferramentas: é passo do turno, e não fechamento ou classificador. */
  comFerramentas: boolean;
  /** Nós de esquema com `pattern` E `format` nas ferramentas do pedido — a prova do braço C. */
  padraoComFormato: number;
  ferramentas: ChamadaDeFerramenta[];
  tokens: Tokens;
  custoUsd: number;
}

export interface Execucao {
  avaliacao: AvaliacaoDoTurno;
  braco: string;
  modelo: string;
  conversa: string;
  k: number;
  chamadas: ChamadaGravada[];
  /** Corpos que o turno propôs enviar (send_message aceitos pela cadeia). */
  candidatos: string[];
  /** Códigos de veto e de aviso de gate da prévia (o sandbox rebaixa pacing e fato a aviso). */
  vetos: string[];
  erro: string | null;
  /** O checkpoint que o fechamento do turno gravaria (para ver se a fala do cliente virou fato). */
  checkpoint?: unknown;
  /** Ferramentas propostas no turno, com os argumentos (notas e estado do lead incluídos). */
  propostas?: Array<{ tool: string; arguments: unknown }>;
}

// ═══ Validade dos argumentos (C) ═══════════════════════════════════════════════

/** O pedaço do zod que importa aqui — o `safeParse` do esquema real da ferramenta. */
export interface EsquemaDeReferencia {
  safeParse(v: unknown): { success: true } | { success: false; error: { issues: ReadonlyArray<{ code: string }> } };
}

/**
 * A régua é o ZOD da ferramenta — a mesma validação que o servidor aplica —, e
 * não o JSON Schema que foi ao fio: no braço `on` o fio não tem mais o `pattern`,
 * e medir pelo fio aprovaria justamente o que se quer pegar.
 */
export function validarChamada(
  nome: string,
  entrada: string,
  ferramentasDoPedido: ReadonlySet<string>,
  esquemaDe: (nome: string) => EsquemaDeReferencia | null,
): Validade {
  if (!ferramentasDoPedido.has(nome)) return "inexistente";
  let valor: unknown;
  try {
    valor = JSON.parse(entrada === "" ? "{}" : entrada);
  } catch {
    return "json_quebrado";
  }
  const esquema = esquemaDe(nome);
  if (esquema === null) return "sem_referencia";
  const r = esquema.safeParse(valor);
  if (r.success) return "ok";
  return r.error.issues.some((i) => i.code === "invalid_format" || i.code === "invalid_string") ? "formato" : "invalida";
}

/** Folhas string do argumento que o detector de aterro acusa. */
export function contarAterro(entrada: string, ehAterro: (v: unknown) => boolean): number {
  let valor: unknown;
  try {
    valor = JSON.parse(entrada);
  } catch {
    return 0;
  }
  const folhas = (v: unknown): unknown[] =>
    Array.isArray(v) ? v.flatMap(folhas) : v !== null && typeof v === "object" ? Object.values(v).flatMap(folhas) : [v];
  return folhas(valor).filter((v) => typeof v === "string" && ehAterro(v)).length;
}

/** Nós de um JSON Schema que têm `pattern` e `format` juntos (o que o braço `on` tira). */
export function nosComPadraoEFormato(esquema: unknown): number {
  if (Array.isArray(esquema)) return esquema.reduce((s: number, x) => s + nosComPadraoEFormato(x), 0);
  if (esquema === null || typeof esquema !== "object") return 0;
  const no = esquema as Record<string, unknown>;
  const aqui = typeof no.pattern === "string" && typeof no.format === "string" ? 1 : 0;
  return aqui + Object.values(no).reduce((s: number, x) => s + nosComPadraoEFormato(x), 0);
}

/**
 * O braço C se prova pelo fio, não pelo rótulo: `off` manda ao menos um nó com
 * `pattern` e `format` (o agente tem ferramenta com uuid/data/e-mail), `on` não
 * manda nenhum. Devolve o problema, ou `null` quando o fio bate com o braço.
 */
export function provaDoBraco(e: Pick<Execucao, "avaliacao" | "braco" | "chamadas">): string | null {
  if (e.avaliacao !== "C") return null;
  const passos = e.chamadas.filter((c) => c.comFerramentas);
  if (passos.length === 0) return "nenhum passo com ferramentas foi gravado";
  const nos = passos.reduce((s, c) => s + c.padraoComFormato, 0);
  if (e.braco === "on" && nos > 0) return `braço on mandou ${nos} nó(s) com pattern e format — o knob não chegou ao fio`;
  if (e.braco === "off" && nos === 0) return "braço off não mandou nenhum pattern com format — o agente não tem ferramenta em risco, ou o knob vazou";
  return null;
}

// ═══ Indicadores de uma execução ═══════════════════════════════════════════════

/** Os nomes chamados, na ordem, com repetições seguidas fundidas (3 bolhas = um envio). */
export function sequencia(e: Pick<Execucao, "chamadas">): string[] {
  const nomes = e.chamadas.filter((c) => c.comFerramentas).flatMap((c) => c.ferramentas.map((f) => f.nome));
  return nomes.filter((n, i) => i === 0 || nomes[i - 1] !== n);
}

export interface Indicadores {
  chamadas: number;
  comFormato: number;
  invalidas: number;
  porFormato: number;
  inexistentes: number;
  aterro: number;
  passos: number;
  vetos: number;
}

export function indicadores(e: Pick<Execucao, "chamadas" | "vetos">): Indicadores {
  const fs = e.chamadas.filter((c) => c.comFerramentas).flatMap((c) => c.ferramentas);
  const ruim = (v: Validade) => v !== "ok";
  return {
    chamadas: fs.length,
    comFormato: fs.filter((f) => f.temFormato).length,
    invalidas: fs.filter((f) => ruim(f.validade) && f.validade !== "inexistente").length,
    porFormato: fs.filter((f) => f.validade === "formato").length,
    inexistentes: fs.filter((f) => f.validade === "inexistente").length,
    aterro: fs.reduce((s, f) => s + f.aterro, 0),
    passos: e.chamadas.filter((c) => c.comFerramentas).length,
    vetos: e.vetos.length,
  };
}

const somar = (xs: readonly Indicadores[]): Indicadores =>
  xs.reduce(
    (a, b) => ({
      chamadas: a.chamadas + b.chamadas,
      comFormato: a.comFormato + b.comFormato,
      invalidas: a.invalidas + b.invalidas,
      porFormato: a.porFormato + b.porFormato,
      inexistentes: a.inexistentes + b.inexistentes,
      aterro: a.aterro + b.aterro,
      passos: a.passos + b.passos,
      vetos: a.vetos + b.vetos,
    }),
    { chamadas: 0, comFormato: 0, invalidas: 0, porFormato: 0, inexistentes: 0, aterro: 0, passos: 0, vetos: 0 },
  );

const por100 = (n: number, d: number) => (d === 0 ? 0 : (100 * n) / d);
const media = (xs: readonly number[]) => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
const mesmaSequencia = (a: Execucao, b: Execucao) => JSON.stringify(sequencia(a)) === JSON.stringify(sequencia(b));

export interface Veredito {
  modelo: string;
  resultado: "aprova" | "reprova" | "inconclusivo";
  linhas: string[];
  motivos: string[];
}

// ═══ Veredito C — nenhum indicador sai da banda off×off ════════════════════════

/**
 * Os critérios do desenho C, operacionalizados — a OPERACIONALIZAÇÃO é PROPOSTA:
 * o desenho diz "passa se nenhum indicador sair da banda off×off". Cada execução
 * `k` de um braço vira um valor por indicador, somado sobre as conversas; a banda
 * é [mín, máx] dos `k` do `off`. Indicador em que menor é melhor (inválidas,
 * inexistentes, aterro, passos e vetos por turno) reprova quando a MÉDIA dos `k`
 * do `on` passa do máximo do `off`; a sequência de ferramentas reprova quando a
 * concordância off×on fica abaixo da menor concordância entre execuções do `off`.
 */
export const CRITERIOS_C = {
  /** Chamadas a ferramenta com campo de formato, por braço, antes de qualquer veredito (PROPOSTA). */
  minimoComFormato: 100,
};

export function vereditoC(execucoes: readonly Execucao[], modelo: string, c = CRITERIOS_C): Veredito {
  const doModelo = execucoes.filter((e) => e.modelo === modelo && e.avaliacao === "C" && e.erro === null);
  const ks = (braco: string) => [...new Set(doModelo.filter((e) => e.braco === braco).map((e) => e.k))].sort((a, b) => a - b);
  const execs = (braco: string, k: number) => doModelo.filter((e) => e.braco === braco && e.k === k);
  const porK = (braco: string) =>
    ks(braco).map((k) => {
      const es = execs(braco, k);
      const s = somar(es.map(indicadores));
      return {
        invalidas: por100(s.invalidas, s.chamadas),
        porFormato: por100(s.porFormato, s.comFormato),
        inexistentes: por100(s.inexistentes, s.chamadas),
        aterro: por100(s.aterro, s.chamadas),
        passos: s.passos / Math.max(1, es.length),
        vetos: s.vetos / Math.max(1, es.length),
        comFormato: s.comFormato,
      };
    });
  const off = porK("off");
  const on = porK("on");
  const motivos: string[] = [];
  const linhas: string[] = [];
  let resultado: Veredito["resultado"] = "aprova";
  if (off.length < 2 || on.length < 1) {
    return { modelo, resultado: "inconclusivo", linhas, motivos: [`execuções off=${off.length} on=${on.length}; o critério pede ≥2 off (banda) e ≥1 on`] };
  }
  const comFormato = (xs: typeof off) => xs.reduce((s, x) => s + x.comFormato, 0);
  for (const nome of ["invalidas", "porFormato", "inexistentes", "aterro", "passos", "vetos"] as const) {
    const banda = off.map((x) => x[nome]);
    const valor = media(on.map((x) => x[nome]));
    const teto = Math.max(...banda);
    linhas.push(`${nome}: off [${Math.min(...banda).toFixed(2)}, ${teto.toFixed(2)}] · on ${valor.toFixed(2)}`);
    if (valor > teto + 1e-9) {
      resultado = "reprova";
      motivos.push(`${nome}: on ${valor.toFixed(2)} acima da banda off (máx ${teto.toFixed(2)})`);
    }
  }
  // Sequência: concordância por conversa entre pares de execuções.
  const conversas = [...new Set(doModelo.map((e) => e.conversa))];
  const concordancia = (pares: Array<[Execucao, Execucao]>) => (pares.length === 0 ? null : pares.filter(([a, b]) => mesmaSequencia(a, b)).length / pares.length);
  const dentroDoOff: number[] = [];
  const ksOff = ks("off");
  for (let i = 0; i < ksOff.length; i++)
    for (let j = i + 1; j < ksOff.length; j++) {
      const pares = conversas.flatMap((cv) => {
        const a = doModelo.find((e) => e.conversa === cv && e.braco === "off" && e.k === ksOff[i]);
        const b = doModelo.find((e) => e.conversa === cv && e.braco === "off" && e.k === ksOff[j]);
        return a && b ? [[a, b] as [Execucao, Execucao]] : [];
      });
      const v = concordancia(pares);
      if (v !== null) dentroDoOff.push(v);
    }
  const cruzados = conversas.flatMap((cv) =>
    doModelo.filter((e) => e.conversa === cv && e.braco === "off").flatMap((a) =>
      doModelo.filter((e) => e.conversa === cv && e.braco === "on").map((b) => [a, b] as [Execucao, Execucao]),
    ),
  );
  const cruz = concordancia(cruzados);
  if (dentroDoOff.length > 0 && cruz !== null) {
    const piso = Math.min(...dentroDoOff);
    linhas.push(`sequência igual: off×off [${pct(piso)}, ${pct(Math.max(...dentroDoOff))}] · off×on ${pct(cruz)}`);
    if (cruz < piso - 1e-9) {
      resultado = "reprova";
      motivos.push(`sequência: off×on ${pct(cruz)} abaixo da banda off×off (mín ${pct(piso)})`);
    }
  }
  if (resultado === "aprova" && (comFormato(off) < c.minimoComFormato || comFormato(on) < c.minimoComFormato)) {
    resultado = "inconclusivo";
    motivos.push(`chamadas com campo de formato: off ${comFormato(off)}, on ${comFormato(on)}; o critério pede ≥${c.minimoComFormato} por braço`);
  }
  return { modelo, resultado, linhas, motivos };
}

// ═══ Veredito F5 — histórico em linhas contra JSON ═════════════════════════════

export type TipoDeSonda = "quem_disse" | "horario" | "grupo";

export interface Sonda {
  tipo: TipoDeSonda;
  /** Ao menos um destes aparece na resposta (sem acento, minúsculas). Vazio = não exige. */
  espera: readonly string[];
  /** Nenhum destes pode aparecer. */
  proibe: readonly string[];
}

const normalizar = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** A sonda passa quando nada proibido aparece e algo esperado aparece. Sem resposta, não passa. */
export function sondaPassa(s: Sonda, corpos: readonly string[]): boolean {
  if (corpos.length === 0) return false;
  const texto = normalizar(corpos.join("\n"));
  if (s.proibe.some((p) => texto.includes(normalizar(p)))) return false;
  return s.espera.length === 0 || s.espera.some((p) => texto.includes(normalizar(p)));
}

export type VotoDoJuiz = "json" | "linhas" | "empate" | "invalido";

export interface Juizo {
  modelo: string;
  conversa: string;
  voto: VotoDoJuiz;
  custoUsd: number;
  /** A resposta crua do juiz — é o que se confere à mão. Ausente nos juízos de antes de 03/11. */
  texto?: string;
  /** Por que o voto saiu `invalido`; `null` nos demais. */
  motivo?: string | null;
  /** Tokens de saída da resposta (o raciocínio do modelo conta aqui). */
  tokensDeSaida?: number | null;
}

/** A ordem do par é sorteada por conversa (hash), e não alternada: a mesma conversa cai na mesma ordem em toda rodada. */
export function jsonPrimeiro(conversa: string): boolean {
  return (createHash("sha256").update(conversa).digest()[0] ?? 0) % 2 === 0;
}

export function promptDoJuiz(transcricao: string, a: string, b: string): string {
  return [
    "Você avalia o atendimento de uma empresa pelo WhatsApp. Abaixo está a conversa e duas respostas candidatas, A e B, para a última mensagem do cliente.",
    "Escolha a melhor: a que atende o que o cliente pediu, sem inventar fato, sem atribuir a fala de uma pessoa a outra, com datas e horários corretos em relação aos horários das mensagens, e sem tratar como verdade o que só o cliente disse que a empresa disse.",
    "Responda com UMA palavra: A, B ou EMPATE.",
    "",
    "## Conversa",
    transcricao,
    "",
    "## Resposta A",
    a === "" ? "(sem resposta)" : a,
    "",
    "## Resposta B",
    b === "" ? "(sem resposta)" : b,
  ].join("\n");
}

/**
 * O formato pede UMA palavra (4 tokens no Sonnet 4.6), mas os modelos que
 * raciocinam gastam o raciocínio no MESMO teto de saída. Medido em 03/11 nas
 * entradas do piloto, com teto folgado: Sonnet 5 de 539 a 640 tokens por voto
 * (6 votos), gpt-5.6-luna de 199 a 523 (3); no piloto, com 1024, um voto do
 * Sonnet 5 levou 879 e outro bateu os 1024 e saiu `invalido` (pelo custo). O
 * teto é 4× o voto que cortou: a resposta cabe com folga, e um raciocínio
 * desembestado custa no máximo US$ 0,04 por voto no Sonnet 5.
 */
export const TETO_DE_SAIDA_DO_JUIZ = 4096;

/** O que o `julgar` passa ao `generateText` para um par: o prompt e o teto de saída, juntos. */
export function pedidoDoJuiz(transcricao: string, a: string, b: string): { prompt: string; maxOutputTokens: number } {
  return { prompt: promptDoJuiz(transcricao, a, b), maxOutputTokens: TETO_DE_SAIDA_DO_JUIZ };
}

export function lerVoto(texto: string, jsonFoiA: boolean): VotoDoJuiz {
  const t = normalizar(texto).replace(/[^a-z]/g, " ").trim().split(/\s+/)[0] ?? "";
  if (t === "empate") return "empate";
  if (t === "a") return jsonFoiA ? "json" : "linhas";
  if (t === "b") return jsonFoiA ? "linhas" : "json";
  return "invalido";
}

/**
 * O juízo de UMA resposta: o voto pela régua de `lerVoto`, o texto cru e, quando
 * o voto é `invalido`, o porquê. Sem o texto, um `invalido` não se distingue de
 * um juiz que respondeu outra coisa — no piloto de 03/11 um voto do Sonnet 5 saiu
 * `invalido` gastando o teto de saída inteiro, e não havia como conferir.
 */
export function juizoDaResposta(
  r: { text: string; finishReason: string; outputTokens: number | undefined },
  jsonFoiA: boolean,
): Pick<Juizo, "voto" | "texto" | "motivo" | "tokensDeSaida"> {
  const voto = lerVoto(r.text, jsonFoiA);
  const base = { voto, texto: r.text, tokensDeSaida: r.outputTokens ?? null };
  if (voto !== "invalido") return { ...base, motivo: null };
  if (r.finishReason === "length") return { ...base, motivo: `cortada no teto de saída (${r.outputTokens ?? "?"} tokens) antes de terminar` };
  if (r.text.trim() === "") return { ...base, motivo: `resposta vazia (fim: ${r.finishReason})` };
  return { ...base, motivo: "a primeira palavra não é A, B nem EMPATE" };
}

/**
 * Os critérios do desenho F5 (knob, frente F): sequência de ferramentas igual em
 * ≥95%; taxa de vetos não maior; juiz par a par não-inferior; as sondas sem
 * regressão. O δ do juiz e o mínimo de pares são PROPOSTA (o desenho não os fixa).
 */
export const CRITERIOS_F5 = { sequenciaIgual: 0.95, deltaDoJuiz: 0.1, minimoDePares: 60 };

export function vereditoF5(
  execucoes: readonly Execucao[],
  juizos: readonly Juizo[],
  sondas: ReadonlyMap<string, Sonda>,
  modelo: string,
  c = CRITERIOS_F5,
): Veredito {
  const doModelo = execucoes.filter((e) => e.modelo === modelo && e.avaliacao === "F5" && e.erro === null);
  const de = (braco: string) => new Map(doModelo.filter((e) => e.braco === braco).map((e) => [e.conversa, e]));
  const json = de("json");
  const linhas = de("linhas");
  const jsonB = de("json_b");
  const pares = [...json.keys()].flatMap((cv) => {
    const a = json.get(cv);
    const b = linhas.get(cv);
    return a && b ? [[a, b] as const] : [];
  });
  const motivos: string[] = [];
  const saida: string[] = [];
  let resultado: Veredito["resultado"] = "aprova";

  // (1) sequência
  const igual = pares.length === 0 ? 0 : pares.filter(([a, b]) => mesmaSequencia(a, b)).length / pares.length;
  const aa = [...json.keys()].flatMap((cv) => {
    const a = json.get(cv);
    const b = jsonB.get(cv);
    return a && b ? [mesmaSequencia(a, b)] : [];
  });
  saida.push(`sequência igual json×linhas ${pct(igual)} em ${pares.length} pares` + (aa.length > 0 ? ` · referência A/A json×json_b ${pct(aa.filter(Boolean).length / aa.length)} em ${aa.length}` : ""));
  if (igual < c.sequenciaIgual) {
    resultado = "reprova";
    motivos.push(`sequência igual ${pct(igual)} abaixo de ${pct(c.sequenciaIgual)}`);
  }

  // (2) vetos
  const comVeto = (es: ReadonlyArray<Execucao>) => (es.length === 0 ? 0 : es.filter((e) => e.vetos.length > 0).length / es.length);
  const vJson = comVeto(pares.map(([a]) => a));
  const vLinhas = comVeto(pares.map(([, b]) => b));
  saida.push(`turnos com veto: json ${pct(vJson)} · linhas ${pct(vLinhas)}`);
  if (vLinhas > vJson + 1e-9) {
    resultado = "reprova";
    motivos.push(`vetos: linhas ${pct(vLinhas)} acima do json ${pct(vJson)}`);
  }

  // (3) juiz par a par — Δ = (vitórias linhas − vitórias json)/n, LI de 95%
  const votos = juizos.filter((j) => j.modelo === modelo && j.voto !== "invalido");
  const notas: number[] = votos.map((j) => (j.voto === "linhas" ? 1 : j.voto === "json" ? -1 : 0));
  const n = notas.length;
  const delta = media(notas);
  const dp = n > 1 ? Math.sqrt(notas.reduce((s, x) => s + (x - delta) ** 2, 0) / (n - 1)) : 0;
  const li = delta - (1.96 * dp) / Math.sqrt(Math.max(1, n));
  saida.push(`juiz: ${n} votos válidos · Δ(linhas−json) ${delta.toFixed(3)} · limite inferior 95% ${li.toFixed(3)}`);
  if (n > 0 && li < -c.deltaDoJuiz) {
    resultado = "reprova";
    motivos.push(`juiz: limite inferior ${li.toFixed(3)} abaixo de −${c.deltaDoJuiz}`);
  }

  // (4) sondas, por tipo: as falhas do linhas não passam das do json
  for (const tipo of ["quem_disse", "horario", "grupo"] as const) {
    const doTipo = pares.filter(([a]) => sondas.get(a.conversa)?.tipo === tipo);
    if (doTipo.length === 0) continue;
    const falhas = (lado: 0 | 1) =>
      doTipo.filter((p) => {
        const s = sondas.get(p[0].conversa);
        return s !== undefined && !sondaPassa(s, p[lado].candidatos);
      }).length;
    const fJson = falhas(0);
    const fLinhas = falhas(1);
    saida.push(`sonda ${tipo}: falhas json ${fJson} · linhas ${fLinhas} (de ${doTipo.length})`);
    if (fLinhas > fJson) {
      resultado = "reprova";
      motivos.push(`sonda ${tipo}: ${fLinhas} falha(s) no linhas contra ${fJson} no json`);
    }
  }

  if (resultado === "aprova" && (pares.length < c.minimoDePares || n < c.minimoDePares)) {
    resultado = "inconclusivo";
    motivos.push(`pares ${pares.length}, votos do juiz ${n}; o critério pede ≥${c.minimoDePares} de cada`);
  }
  return { modelo, resultado, linhas: saida, motivos };
}

// ═══ Veredito G — não-inferioridade do fechamento econômico ════════════════════

/**
 * Os critérios e mínimos do desenho G (`como_medir_depois`), só nas métricas que
 * o roteiro offline mede (sem juiz LLM: fatos perdidos, contradições e próxima
 * ação ficam de fora, e o veredito diz isso). Os δ são os PROPOSTOS no desenho,
 * à espera da aprovação do dono.
 */
export const CRITERIOS_G = {
  promessas: -0.03,
  prazos: -0.05,
  intencoes: -0.05,
  retencao: -0.02,
  recusadoDaSombra: 0.03,
  minimos: { promessas: 150, prazos: 50, intencoes: 150, comAnterior: 100, turnos: 300 },
};

export function vereditoG(conversas: readonly AvaliacaoDaConversa[], c = CRITERIOS_G): Veredito & { resumo: ReturnType<typeof resumir> } {
  const r = resumir(conversas);
  const linhas: string[] = [];
  const motivos: string[] = [];
  let resultado: Veredito["resultado"] = "aprova";
  const comAnterior = conversas.filter((a) => (a.bracos.find((b) => b.braco === "sombra")?.medida?.entidades_anteriores ?? 0) > 0).length;
  for (const nome of ["promessas", "prazos", "intencoes", "retencao"] as const) {
    const m = r[nome];
    linhas.push(`${nome}: ${m === null ? "sem amostra" : `n ${m.n} · Δ ${m.delta.toFixed(3)} · LI ${m.limite_inferior.toFixed(3)} (piso ${c[nome]})`}`);
    if (m !== null && m.limite_inferior < c[nome]) {
      resultado = "reprova";
      motivos.push(`${nome}: limite inferior ${m.limite_inferior.toFixed(3)} abaixo de ${c[nome]}`);
    }
  }
  const sombras = r.formato.sombra.ok + r.formato.sombra.corrigido + r.formato.sombra.recusado + r.formato.sombra.falhou;
  const recusado = sombras === 0 ? 0 : r.formato.sombra.recusado / sombras;
  linhas.push(`formato da sombra: ${JSON.stringify(r.formato.sombra)} · recusado ${pct(recusado)}`);
  if (recusado > c.recusadoDaSombra) {
    resultado = "reprova";
    motivos.push(`recusado da sombra ${pct(recusado)} acima de ${pct(c.recusadoDaSombra)}`);
  }
  const faltas = [
    ["promessas", r.promessas?.n ?? 0, c.minimos.promessas],
    ["prazos", r.prazos?.n ?? 0, c.minimos.prazos],
    ["intencoes", r.intencoes?.n ?? 0, c.minimos.intencoes],
    ["turnos com resumo anterior", comAnterior, c.minimos.comAnterior],
    ["turnos (pares válidos)", r.pares_validos, c.minimos.turnos],
  ].filter(([, n, min]) => (n as number) < (min as number));
  if (resultado === "aprova" && faltas.length > 0) {
    resultado = "inconclusivo";
    motivos.push(...faltas.map(([nome, n, min]) => `${nome}: ${n}, o mínimo é ${min}`));
  }
  linhas.push("NÃO medido offline (sem juiz): fatos perdidos, contradições, intenções divergentes, próxima ação e nada_a_declarar");
  return { modelo: conversas[0]?.atual.modelo ?? "(vazio)", resultado, linhas, motivos, resumo: r };
}

// ═══ Preço e custo ═════════════════════════════════════════════════════════════

/** USD por token, como a OpenRouter publica em GET /api/v1/models. */
export interface Preco {
  entrada: number;
  saida: number;
  leitura: number;
  gravacao: number;
}

/** O id do modelo na OpenRouter: `anthropic:claude-sonnet-4-6` → `anthropic/claude-sonnet-4.6`. */
export function idNaOpenRouter(provedor: string, modelo: string): string {
  if (provedor === "openrouter") return modelo;
  const semVersaoComHifen = provedor === "anthropic" ? modelo.replace(/-(\d+)-(\d+)$/, "-$1.$2") : modelo;
  return `${provedor}/${semVersaoComHifen}`;
}

/**
 * O preço de um modelo na resposta de GET https://openrouter.ai/api/v1/models.
 * A gravação é a de 1 hora quando existe: é o TTL que o motor pede aos Claude
 * (frente E). Sem preço publicado o custo não é zero: lança.
 */
export function precoDaOpenRouter(catalogo: unknown, id: string): Preco {
  const dados = (catalogo as { data?: Array<{ id: string; pricing?: Record<string, unknown> }> }).data ?? [];
  const p = dados.find((m) => m.id === id)?.pricing;
  if (p === undefined) throw new Error(`a OpenRouter não publica preço para ${id}`);
  const n = (k: string) => {
    const v = Number(p[k]);
    return Number.isFinite(v) ? v : null;
  };
  const entrada = n("prompt");
  const saida = n("completion");
  if (entrada === null || saida === null) throw new Error(`preço incompleto para ${id}`);
  return {
    entrada,
    saida,
    leitura: n("input_cache_read") ?? entrada,
    gravacao: n("input_cache_write_1h") ?? n("input_cache_write") ?? entrada,
  };
}

/** O uso que o provedor devolve (V3: objetos com `total`/`cacheRead`; V2: números). */
export function tokensDoUso(uso: unknown): Tokens {
  const u = (uso ?? {}) as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const campo = (v: unknown, k: string) => (v !== null && typeof v === "object" ? num((v as Record<string, unknown>)[k]) : 0);
  const entrada = typeof u.inputTokens === "number" ? u.inputTokens : campo(u.inputTokens, "total");
  const lidos = typeof u.inputTokens === "number" ? num(u.cachedInputTokens) : campo(u.inputTokens, "cacheRead");
  const gravados = typeof u.inputTokens === "number" ? 0 : campo(u.inputTokens, "cacheWrite");
  const saida = typeof u.outputTokens === "number" ? u.outputTokens : campo(u.outputTokens, "total");
  return { entrada, lidos: Math.min(lidos, entrada), gravados: Math.min(gravados, entrada - Math.min(lidos, entrada)), saida };
}

export function custoDosTokens(t: Tokens, p: Preco): number {
  const cheios = t.entrada - t.lidos - t.gravados;
  return cheios * p.entrada + t.lidos * p.leitura + t.gravados * p.gravacao + t.saida * p.saida;
}

/** Uma chamada PREVISTA: o prefixo cacheável (com a chave que o identifica) e o resto. */
export interface ChamadaPrevista {
  prefixo: number;
  chavePrefixo: string;
  resto: number;
  saida: number;
}

/**
 * O custo de um lote rodado em sequência. Com cache, o 1º pedido de cada prefixo
 * grava e os seguintes leem (o lote anda mais rápido que o TTL); sem cache, tudo
 * a preço cheio. `fator` converte a contagem o200k para o tokenizador do modelo.
 */
export function custoDoLote(chamadas: readonly ChamadaPrevista[], p: Preco, cache: boolean, fator = 1): number {
  const vistos = new Set<string>();
  let usd = 0;
  for (const c of chamadas) {
    const prefixo = c.prefixo * fator;
    const resto = c.resto * fator;
    if (!cache || c.prefixo === 0) usd += (prefixo + resto) * p.entrada;
    else if (vistos.has(c.chavePrefixo)) usd += prefixo * p.leitura + resto * p.entrada;
    else {
      vistos.add(c.chavePrefixo);
      usd += prefixo * p.gravacao + resto * p.entrada;
    }
    usd += c.saida * p.saida;
  }
  return usd;
}

/**
 * O que NÃO se conta no corpus, MEDIDO em produção (fonte ao lado de cada um).
 * O resto — ferramentas de cada braço, prompt de cada agente e abertura de cada
 * conversa em cada formato — é contado com o200k sobre o pedido real.
 */
export const MEDIDO = {
  /**
   * O `system` do motor fora o prompt do agente. B: o passo da Nina no luna mede
   * 21,6 mil tokens o200k; C: as ferramentas dela, 14.056; F: o histórico, ~1.500;
   * e ~800 da moldura da abertura (contada aqui à parte, conversa por conversa).
   * Sobra o system INTEIRO da Nina — com o prompt dela dentro. O plano soma ainda
   * o prompt de cada agente de avaliação: conta o prompt duas vezes, de propósito
   * (erra para cima).
   */
  sistemaDoMotor: 21_600 - 14_056 - 1_500 - 800,
  /** E: o mesmo turno da Nina no Sonnet 5 mede ~28,7 mil por passo contra 21,6 mil no luna. */
  fatorClaude: 28_700 / 21_600,
  /** C/E: turno de 2 passos. */
  passosPorTurno: 2,
  /** E: 0,26¢ de saída em 2 passos no Sonnet 5 (US$ 10/M) ≈ 130 por passo. */
  saidaPorPasso: 130,
  /** O que o passo 2 carrega a mais que o 1 (chamada + resultado da ferramenta). Estimativa. */
  crescimentoPorPasso: 300,
  /** G: fechamento, 363 de saída por chamada (Anthropic). */
  saidaDoFechamento: 363,
  /** F6: média semanal do promise_semantic, 3.143 de entrada; saída curta. */
  promessaSemantica: { entrada: 3_143, saida: 22 },
  /** G: 1,05 chamada de fechamento por turno; a sombra corrige mais (estimativa: +5%). */
  correcaoDaSombra: 0.05,
  /** G (2026-09-24, luna): turno da prévia 28 s, dos quais 16 s do fechamento. */
  segundosPorTurno: 28,
  segundosPorFechamento: 16,
  segundosPorJuiz: 6,
  saidaDoJuiz: 5,
};

export function pct(x: number | null): string {
  return x === null ? "—" : `${(x * 100).toFixed(1)}%`;
}
