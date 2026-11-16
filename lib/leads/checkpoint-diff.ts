import { preencher } from "@/lib/i18n/idioma-do-aviso";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

/** O conteúdo de um checkpoint do agente (lead_checkpoints). */
export interface CheckpointContent {
  commitments: string[];
  objections: string[];
  next_action: string | null;
  rolling_summary: string | null;
}

export interface CheckpointDiff {
  /** Entra na timeline? */
  emit: boolean;
  /** Compromissos que NÃO existiam no checkpoint anterior. */
  addedCommitments: string[];
  /** Objeções que NÃO existiam no checkpoint anterior. */
  addedObjections: string[];
  nextActionChanged: boolean;
  /** Motivo legível quando emit=true; explicação do descarte quando false. */
  reason: string;
}

/**
 * Diff, nunca snapshot.
 *
 * O agente grava um checkpoint por turno. Emitir atividade a cada checkpoint
 * encheria a timeline com "a IA pensou" quarenta vezes e enterraria a única
 * linha que muda o que alguém faria a seguir. Então só entra o que ACRESCENTA
 * objeção ou compromisso, ou o que MUDA a próxima ação.
 *
 * Fica de fora de propósito: `rolling_summary` reescrito (a IA resumindo de
 * novo não é fato novo), repetição do mesmo compromisso, e o checkpoint que só
 * confirma o estado anterior.
 */
export function diffCheckpoint(
  anterior: CheckpointContent | null,
  atual: CheckpointContent,
  /**
   * O idioma em que a timeline GRAVA o motivo. A linha é dado (a tela a mostra
   * como veio), então nasce no idioma da organização; `pt-BR` sai byte a byte.
   */
  idioma: Idioma = "pt-BR",
): CheckpointDiff {
  const antesCommit = new Set(normalizar(anterior?.commitments));
  const antesObj = new Set(normalizar(anterior?.objections));

  const addedCommitments = dedup(atual.commitments).filter((c) => !antesCommit.has(chave(c)));
  const addedObjections = dedup(atual.objections).filter((o) => !antesObj.has(chave(o)));

  const antesAcao = texto(anterior?.next_action);
  const agoraAcao = texto(atual.next_action);
  const nextActionChanged = agoraAcao !== "" && agoraAcao !== antesAcao;

  const emit = addedCommitments.length > 0 || addedObjections.length > 0 || nextActionChanged;

  return {
    emit,
    addedCommitments,
    addedObjections,
    nextActionChanged,
    reason: emit
      ? motivo(addedObjections, addedCommitments, nextActionChanged, atual.next_action, idioma)
      : anterior === null
        ? "primeiro checkpoint sem compromisso, objeção ou próxima ação"
        : "só reescreveu o resumo — não muda o que fazer a seguir",
  };
}

/** "Nova objeção: preço acima do orçamento" — o humano lê o fato, não o diff. */
function motivo(
  objecoes: string[],
  compromissos: string[],
  mudouAcao: boolean,
  proximaAcao: string | null,
  idioma: Idioma,
): string {
  // O rótulo passa pelo dicionário; o que a IA escreveu entra DEPOIS, numa
  // passada só (`preencher`): um `{texto}` dentro do conteúdo nunca é marcador.
  const rotulo = (chave: string, valores: { n?: number; texto: string }): string =>
    preencher(traduzir(chave, idioma), { n: String(valores.n ?? ""), texto: valores.texto });
  const partes: string[] = [];
  if (objecoes.length === 1) partes.push(rotulo("Nova objeção: {texto}", { texto: objecoes[0] ?? "" }));
  else if (objecoes.length > 1)
    partes.push(rotulo("{n} novas objeções: {texto}", { n: objecoes.length, texto: objecoes.join("; ") }));

  if (compromissos.length === 1) partes.push(rotulo("Novo compromisso: {texto}", { texto: compromissos[0] ?? "" }));
  else if (compromissos.length > 1)
    partes.push(rotulo("{n} novos compromissos: {texto}", { n: compromissos.length, texto: compromissos.join("; ") }));

  if (mudouAcao && proximaAcao) partes.push(rotulo("Próxima ação: {texto}", { texto: proximaAcao }));
  return partes.join(" · ");
}

/** Compara por conteúdo normalizado: reescrever com outro espaçamento não é fato novo. */
function chave(valor: string): string {
  return valor.trim().toLowerCase().replace(/\s+/g, " ");
}

function texto(valor: string | null | undefined): string {
  return (valor ?? "").trim();
}

function normalizar(lista: string[] | null | undefined): string[] {
  return (lista ?? []).filter((v) => typeof v === "string").map(chave);
}

/** Remove repetição dentro do próprio checkpoint (a IA às vezes repete o item). */
function dedup(lista: string[] | null | undefined): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const item of lista ?? []) {
    if (typeof item !== "string") continue;
    const limpo = item.trim();
    if (limpo === "") continue;
    const k = chave(limpo);
    if (vistos.has(k)) continue;
    vistos.add(k);
    saida.push(limpo);
  }
  return saida;
}
