import { pacoteFactualDaRevisao, temDecisaoElegivel, type PacoteFactual } from './contrato-contexto';
import type { PromiseClassification } from './semantic';

export type FalhaDaRevisaoHumana = 'negativa_sem_prova' | 'candidata_desvinculada' | 'fonte_desvinculada' | 'sinais_conflitantes';
const objeto = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const naturezas = new Set(['beneficiario', 'objeto', 'data', 'condicoes', 'novo_compromisso', 'execucao_nao_comprovada', 'fonte_insuficiente']);

/** Referência sempre aponta à projeção que o revisor recebeu, nunca ao contexto bruto.
 * Uma nota copiada integralmente só identifica a fonte quando é única entre TODAS
 * as decisões projetadas e essa fonte é elegível. Não há busca por trecho ou semelhança.
 */
function resolverReferencias(decisions: unknown, references: unknown): boolean {
  const rows = Array.isArray(decisions) ? decisions.map(objeto).filter(d => d !== undefined) : [];
  const eligible = new Set(rows.filter(d => d.elegivel === true).map(d => d.referencia));
  if (!Array.isArray(references) || references.length === 0 || references.length > eligible.size) return false;
  const resolved = references.map(reference => {
    if (typeof reference !== 'string') return undefined;
    if (eligible.has(reference)) return reference;
    // ID desconhecido/inelegível não pode se disfarçar de texto de nota.
    if (/^decisao_[0-9]+$/.test(reference) || !reference.trim()) return undefined;
    const matches = rows.filter(d => typeof d.nota === 'string' && d.nota.normalize('NFC') === reference.normalize('NFC'));
    const match = matches.length === 1 ? matches[0] : undefined;
    return match?.elegivel === true && typeof match.referencia === 'string' ? match.referencia : undefined;
  });
  return resolved.every(reference => reference !== undefined) && new Set(resolved).size === resolved.length;
}

/** Diagnóstico não dá autoridade: a elegibilidade, o positivo estrito e os demais gates continuam necessários.
 * Uma negativa sem vínculo fica fechada como falha técnica, sem acusar divergência que não foi demonstrada.
 * Não persiste nem registra o texto. Não dispara chamada adicional ou confirmador sem binding explícito.
 */
export function vincularRevisaoHumana(args: PacoteFactual, classification: PromiseClassification, raw: unknown): PromiseClassification {
  if (!temDecisaoElegivel(args) || classification.afirmouConclusaoHumana !== true) return classification;
  const proof = objeto(objeto(raw)?.verificacao_decisao);
  const negative = classification.repasseConcluidoFiel !== true;
  let issue: FalhaDaRevisaoHumana | undefined;
  if (classification.repasseConcluidoFiel === true && classification.prometeuRetornoHumano) issue = 'sinais_conflitantes';
  // Positivo legado conserva o contrato estrito existente; diagnóstico fornecido sempre precisa ser válido.
  else if (!proof) issue = negative ? 'negativa_sem_prova' : undefined;
  else {
    const packet = pacoteFactualDaRevisao(args);
    const current = String(packet.mensagem).normalize('NFC');
    const decisions = objeto(packet.contexto_decisoes)?.decisoes;
    const refs = proof.referencias_decisoes;
    if (typeof proof.candidata_analisada !== 'string' || proof.candidata_analisada.normalize('NFC') !== current) issue = 'candidata_desvinculada';
    else if (!resolverReferencias(decisions, refs)) issue = 'fonte_desvinculada';
    else if (negative) {
      const divergence = objeto(proof.divergencia);
      if (!divergence || typeof divergence.trecho !== 'string' || !divergence.trecho.trim() || !current.includes(divergence.trecho.normalize('NFC')) || typeof divergence.natureza !== 'string' || !naturezas.has(divergence.natureza)) issue = 'negativa_sem_prova';
    } else if (proof.divergencia !== null) issue = 'sinais_conflitantes';
  }
  return issue ? { ...classification, repasseConcluidoFiel: false, humanDecisionReviewIssue: issue } : classification;
}
