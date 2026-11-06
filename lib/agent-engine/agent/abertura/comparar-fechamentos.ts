/**
 * A RÉGUA DA AVALIAÇÃO OFFLINE DO FECHAMENTO (Frente G).
 *
 * Trocar o modelo do checkpoint pelo econômico só vale se ele perder no máximo o
 * que o próprio modelo do agente já perde de uma execução para outra. Por isso a
 * avaliação tem TRÊS execuções do mesmo pedido: o `atual` (modelo do agente), o
 * `controle` (o modelo do agente de novo, A/A) e a `sombra` (o econômico). Cada
 * braço é medido contra o atual pela MESMA função, e o veredito é a diferença
 * sombra − controle com intervalo (`naoInferioridade`).
 *
 * Tudo aqui é puro: `avaliarConversa` recebe `chamar` injetado. A rede mora só em
 * `scripts/avaliar-fechamento.ts`. O resultado tem só números e nomes de modelo —
 * nenhum texto da conversa sai daqui.
 */
import { z } from "zod";

import type { Intencao, Promessa } from "../declaracao";
import {
  CHECKPOINT_INSTRUCTION,
  checkpointContentSchema,
  fecharOTurno,
  FechamentoRecusado,
  tirarLinkDaReuniao,
  type CheckpointContent,
} from "./checkpoint";

const PARADAS = new Set(["que", "por", "para", "com", "uma", "uns", "dos", "das", "nos", "nas", "seu", "sua", "vou", "vai", "voce"]);

const semAcento = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

// ponytail: tokenização ingênua; o viés é igual nos dois braços e cancela na diferença
// sombra − controle. Teto: paráfrase sem palavra em comum conta como perda nos dois.
export function tokens(s: string): Set<string> {
  return new Set(semAcento(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 3 && !PARADAS.has(t)));
}

function jaccardDeConjuntos(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let comum = 0;
  for (const t of a) if (b.has(t)) comum++;
  return comum / (a.size + b.size - comum);
}

export function jaccard(a: string, b: string): number {
  return jaccardDeConjuntos(tokens(a), tokens(b));
}

const ISO_8601 = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * O prazo como minuto (só quando é ISO 8601) ou texto normalizado; `null` fica
 * `null`. Só ISO vira minuto porque o `Date.parse` do V8 aceita texto livre e
 * faz "sexta 10" e "segunda 10" darem o mesmo instante.
 */
export function instante(prazo: string | null): number | string | null {
  if (prazo === null) return null;
  const limpo = prazo.trim();
  const ms = ISO_8601.test(limpo) ? Date.parse(limpo) : Number.NaN;
  return Number.isNaN(ms) ? semAcento(limpo).replace(/\s+/g, " ") : Math.floor(ms / 60_000);
}

const mesmoInstante = (x: string | null, y: string | null) => {
  const a = instante(x);
  return a !== null && a === instante(y);
};

/**
 * Casa com J ≥ 0,5; ou com J ≥ 0,3 e o MESMO instante não nulo. No reforço, o J
 * ignora os tokens com dígito: o horário já está no prazo, e "amanhã 10h" escrito
 * nos dois textos não pode fazer duas promessas diferentes casarem. Prazo sozinho
 * nunca casa. Devolve a nota do par, ou `null` quando não casa.
 */
export function notaDaPromessa(x: Promessa, y: Promessa): number | null {
  const j = jaccard(x.o_que, y.o_que);
  if (j >= 0.5) return j;
  if (!mesmoInstante(x.prazo, y.prazo)) return null;
  const semNumero = (s: string) => new Set([...tokens(s)].filter((t) => !/\d/.test(t)));
  const jSemNumero = jaccardDeConjuntos(semNumero(x.o_que), semNumero(y.o_que));
  return jSemNumero >= 0.3 ? jSemNumero : null;
}

export function notaDaIntencao(x: Intencao, y: Intencao): number | null {
  const j = jaccard(x.o_que, y.o_que);
  return j >= 0.5 ? j : null;
}

/** Pareamento GULOSO 1-para-1: maior nota primeiro, cada índice de A e de B usado uma vez. */
export function parear<T>(a: readonly T[], b: readonly T[], nota: (x: T, y: T) => number | null): Array<[number, number]> {
  const candidatos: Array<[number, number, number]> = [];
  a.forEach((x, i) =>
    b.forEach((y, j) => {
      const n = nota(x, y);
      if (n !== null) candidatos.push([n, i, j]);
    }),
  );
  candidatos.sort((p, q) => q[0] - p[0]);
  const usadosA = new Set<number>();
  const usadosB = new Set<number>();
  const pares: Array<[number, number]> = [];
  for (const [, i, j] of candidatos) {
    if (usadosA.has(i) || usadosB.has(j)) continue;
    usadosA.add(i);
    usadosB.add(j);
    pares.push([i, j]);
  }
  return pares;
}

const ENTIDADE =
  /(R\$\s?\d(?:[\d.,]*\d)?)|([\w.+-]+@[\w-]+(?:\.[\w-]+)+)|(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)|(\d(?:[\d.,]*\d)?)|((?<![\p{L}\p{N}])\p{Lu}\p{Ll}{2,})/gu;

/**
 * Números, valores, datas, e-mails e palavras capitalizadas (≥ 3 letras), sem
 * espaço e em minúsculas. Uma regex só, com alternância: "R$ 1.200" é um valor,
 * não um valor e dois números.
 */
export function entidades(resumo: string): Set<string> {
  return new Set([...resumo.matchAll(ENTIDADE)].map((m) => m[0].replace(/\s+/g, "").toLowerCase()));
}

export interface MedidaDoPar {
  promessas_atual: number;
  promessas_braco: number;
  promessas_em_comum: number;
  prazos_atual: number;
  prazos_em_comum: number;
  intencoes_atual: number;
  intencoes_braco: number;
  intencoes_em_comum: number;
  nada_atual: boolean | null;
  nada_braco: boolean | null;
  declaracao_ausente_atual: boolean;
  declaracao_ausente_braco: boolean;
  next_nulo_atual: boolean;
  next_nulo_braco: boolean;
  entidades_anteriores: number;
  retidas_atual: number;
  retidas_braco: number;
  similaridade_resumo: number;
}

/** O braço medido contra o atual. Só números e booleanos. */
export function medirPar(atual: CheckpointContent, outro: CheckpointContent, anterior: CheckpointContent | null): MedidaDoPar {
  const pa = atual.declaracao?.promessas ?? [];
  const pb = outro.declaracao?.promessas ?? [];
  const ia = atual.declaracao?.intencoes ?? [];
  const ib = outro.declaracao?.intencoes ?? [];
  const paresDePromessa = parear(pa, pb, notaDaPromessa);
  const antes = entidades(anterior?.rolling_summary ?? "");
  const retidas = (c: CheckpointContent) => {
    const agora = entidades(c.rolling_summary);
    return [...antes].filter((e) => agora.has(e)).length;
  };
  return {
    promessas_atual: pa.length,
    promessas_braco: pb.length,
    promessas_em_comum: paresDePromessa.length,
    prazos_atual: pa.filter((p) => p.prazo !== null).length,
    prazos_em_comum: paresDePromessa.filter(([i, j]) => mesmoInstante(pa[i]?.prazo ?? null, pb[j]?.prazo ?? null)).length,
    intencoes_atual: ia.length,
    intencoes_braco: ib.length,
    intencoes_em_comum: parear(ia, ib, notaDaIntencao).length,
    nada_atual: atual.declaracao?.nada_a_declarar ?? null,
    nada_braco: outro.declaracao?.nada_a_declarar ?? null,
    declaracao_ausente_atual: atual.declaracao === undefined,
    declaracao_ausente_braco: outro.declaracao === undefined,
    next_nulo_atual: atual.next_action === null,
    next_nulo_braco: outro.next_action === null,
    entidades_anteriores: antes.size,
    retidas_atual: retidas(atual),
    retidas_braco: retidas(outro),
    similaridade_resumo: jaccard(atual.rolling_summary, outro.rolling_summary),
  };
}

export interface NaoInferioridade {
  n: number;
  delta: number;
  limite_inferior: number;
}

/**
 * Estimador de razão pareado por conversa, com variância por agrupamento — o
 * mesmo SQL de `como_medir_depois` do desenho: Δ = (Σbraço − Σcontrole)/Σn e
 * limite inferior Δ − 1,96·√Σ((braço − controle) − Δ·n)²/Σn. Sem amostra, `null`.
 */
export function naoInferioridade(pares: ReadonlyArray<{ n: number; braco: number; controle: number }>): NaoInferioridade | null {
  const n = pares.reduce((s, p) => s + p.n, 0);
  if (n === 0) return null;
  const delta = pares.reduce((s, p) => s + p.braco - p.controle, 0) / n;
  const variancia = pares.reduce((s, p) => s + (p.braco - p.controle - delta * p.n) ** 2, 0);
  return { n, delta, limite_inferior: delta - (1.96 * Math.sqrt(variancia)) / n };
}

const mensagemSchema = z.object({ role: z.enum(["user", "assistant"]), content: z.string() });
export type MensagemDoFechamento = z.infer<typeof mensagemSchema>;

/**
 * O corpus: o pedido do fechamento de cada conversa — `system` e as mensagens que
 * o turno manda ANTES de `CHECKPOINT_INSTRUCTION` (abertura em texto, fita do
 * turno e agenda) — e o checkpoint anterior, quando houver.
 */
export const corpusSchema = z.array(
  z.object({
    id: z.string().min(1),
    system: z.string(),
    mensagens: z.array(mensagemSchema).min(1),
    anterior: checkpointContentSchema.nullable().default(null),
  }),
);
export type ConversaDoCorpus = z.infer<typeof corpusSchema>[number];

/**
 * O teto de saída de cada chamada da avaliação: o `TETO_DE_SAIDA_PADRAO` do seam
 * (organização sem `maxOutputTokens`). Repetido, e não importado, porque
 * `run-model-call` carrega `lib/env.ts` e o roteiro roda sem as variáveis do
 * Supabase; o teste da régua prende os dois iguais.
 */
export const TETO_DE_SAIDA_DA_AVALIACAO = 4096;

export type Formato = "ok" | "corrigido" | "recusado" | "falhou";
export type Chamar = (modelo: string, system: string, mensagens: MensagemDoFechamento[]) => Promise<{ text: string }>;

export interface AvaliacaoDaConversa {
  conversa: string;
  atual: { modelo: string; formato: Formato };
  bracos: Array<{ braco: "controle" | "sombra"; modelo: string; formato: Formato; medida: MedidaDoPar | null }>;
}

/** O fechamento de produção num modelo: o mesmo pedido, a mesma correção, o mesmo ajuste — sem reserva. */
async function fecharNoModelo(c: ConversaDoCorpus, modelo: string, chamar: Chamar) {
  try {
    const r = await fecharOTurno({
      pedir: (extra) => chamar(modelo, c.system, [...c.mensagens, { role: "user", content: CHECKPOINT_INSTRUCTION }, ...extra]),
      ajustar: tirarLinkDaReuniao,
    });
    return { formato: (r.corrigido ? "corrigido" : "ok") as Formato, content: r.content };
  } catch (err) {
    // A falha É a medida: o formato vai para o resultado, e o erro não derruba o corpus.
    return { formato: (err instanceof FechamentoRecusado ? "recusado" : "falhou") as Formato, content: null };
  }
}

export async function avaliarConversa(
  c: ConversaDoCorpus,
  chamar: Chamar,
  modelos: { agente: string; economico: string },
): Promise<AvaliacaoDaConversa> {
  const atual = await fecharNoModelo(c, modelos.agente, chamar);
  const resultado: AvaliacaoDaConversa = { conversa: c.id, atual: { modelo: modelos.agente, formato: atual.formato }, bracos: [] };
  if (atual.content === null) return resultado;
  for (const [braco, modelo] of [["controle", modelos.agente], ["sombra", modelos.economico]] as const) {
    const r = await fecharNoModelo(c, modelo, chamar);
    resultado.bracos.push({ braco, modelo, formato: r.formato, medida: r.content === null ? null : medirPar(atual.content, r.content, c.anterior) });
  }
  return resultado;
}

type Contagem = { [K in keyof MedidaDoPar]: MedidaDoPar[K] extends number ? K : never }[keyof MedidaDoPar];

const contarFormatos = (fs: Formato[]) => ({
  ok: fs.filter((f) => f === "ok").length,
  corrigido: fs.filter((f) => f === "corrigido").length,
  recusado: fs.filter((f) => f === "recusado").length,
  falhou: fs.filter((f) => f === "falhou").length,
});

/** O veredito do corpus: formatos por braço e a não-inferioridade da sombra contra o controle. */
export function resumir(avaliacoes: readonly AvaliacaoDaConversa[]) {
  const doBraco = (a: AvaliacaoDaConversa, b: "controle" | "sombra") => a.bracos.find((x) => x.braco === b);
  const pares = avaliacoes.flatMap((a) => {
    const s = doBraco(a, "sombra")?.medida;
    const c = doBraco(a, "controle")?.medida;
    return s && c ? [{ s, c }] : [];
  });
  const metrica = (n: Contagem, comum: Contagem) =>
    naoInferioridade(pares.map(({ s, c }) => ({ n: s[n], braco: s[comum], controle: c[comum] })));
  return {
    conversas: avaliacoes.length,
    pares_validos: pares.length,
    formato: {
      atual: contarFormatos(avaliacoes.map((a) => a.atual.formato)),
      controle: contarFormatos(avaliacoes.flatMap((a) => doBraco(a, "controle")?.formato ?? [])),
      sombra: contarFormatos(avaliacoes.flatMap((a) => doBraco(a, "sombra")?.formato ?? [])),
    },
    promessas: metrica("promessas_atual", "promessas_em_comum"),
    prazos: metrica("prazos_atual", "prazos_em_comum"),
    intencoes: metrica("intencoes_atual", "intencoes_em_comum"),
    retencao: metrica("entidades_anteriores", "retidas_braco"),
  };
}
