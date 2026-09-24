/**
 * Objeção de VALOR — estado por conversa e blocos de contexto (C-071).
 *
 * ─── A ordem que o dono definiu ─────────────────────────────────────────────
 * Diante de "achei caro" a resposta certa NÃO é mandar outras motos de cara:
 *   1) JUSTIFICAR com dados/especificações da moto, procedência e a força da loja;
 *   2) ENTENDER o motivo real;
 *   3) TENTAR CONVENCER;
 *   4) só se não contornar, OFERECER outras opções (de forma calorosa e variada);
 *   5) se o cliente estiver decidido nessa moto → HANDOFF (repasse INTERNO, sem
 *      pedir autorização); se estiver aberto → o MOTOR busca as semelhantes.
 *
 * O motor guarda a FASE em `agent_catalogo.objecao` e injeta o bloco do turno; a
 * IA só redige. Funções PURAS — testáveis e sem I/O.
 */
import { normalizarNomeDeMoto } from './fotos-do-catalogo';

export type FaseObjecao = 'persuadir' | 'checar' | 'handoff';

export interface EstadoObjecao {
  /** Moto em foco quando a objeção começou (contexto; pode ficar vazio). */
  moto: string;
  fase: FaseObjecao;
}

/**
 * A mensagem PEDE explicitamente algo DIFERENTE da moto atual? ("outra cor",
 * "mais nova", "tem outra?", "uma mais barata"). Esse caso vai direto para as
 * semelhantes — NÃO é objeção de valor.
 */
export function ehPedidoDiferente(mensagem: string): boolean {
  const n = normalizarNomeDeMoto(mensagem);
  if (n === '') return false;
  const pedeOutra =
    /\b(outra|outro|outras|outros|diferente|diferentes|opcao|opcoes|alternativa)\b/.test(n);
  const pedeMaisNova = /\bmais (nova|novo)\b/.test(n);
  // "mais barata" só é PEDIDO com verbo de pedido; "vi mais barato" é comparação
  // (objeção de valor, persuade) — não confundir.
  const pedeMaisBarata =
    /\b(quero|queria|tem|teria|ver|mostra|mostrar|consegue|arruma|acha)\b.{0,25}\bmais (barata|barato)\b/.test(
      n,
    );
  return pedeOutra || pedeMaisNova || pedeMaisBarata;
}

/**
 * A mensagem é uma OBJEÇÃO DE VALOR? (questiona preço/condição da moto mostrada).
 * NÃO confundir com pedido explícito de algo diferente — esse vai direto para as
 * semelhantes (ferramenta `crm_offer_similar_motos`).
 */
export function ehObjecaoValor(mensagem: string): boolean {
  const n = normalizarNomeDeMoto(mensagem);
  if (n === '') return false;
  if (ehPedidoDiferente(mensagem)) return false;
  return /\b(caro|preco|desconto|barat\w*|parcela\w*|valor|nao tenho|fora do|orcamento|pensar)\b/.test(n);
}

/**
 * A mensagem PEDE DIRETAMENTE uma condição melhor de preço (desconto/abaixar o
 * valor)? Esses casos a IA não pode conceder: persuade na 1ª vez e, se o cliente
 * INSISTIR, encaminha ao consultor (handoff) — não oferece outras motos.
 */
export function ehPedidoDesconto(mensagem: string): boolean {
  const n = normalizarNomeDeMoto(mensagem);
  if (n === '') return false;
  return (
    /\b(desconto|abatimento)\b/.test(n) ||
    /\b(melhorar|abaixar|baixar|reduzir)\b.{0,25}\b(valor|preco)\b/.test(n) ||
    /\b(melhor|menor)\s+preco\b/.test(n) ||
    /\bfaz(er)? por menos\b/.test(n)
  );
}

/**
 * A próxima fase a partir da atual:
 *  - sem objeção anterior → `persuadir` (1ª vez; justificar/convencer);
 *  - JÁ persuadiu e o cliente INSISTE no desconto → `handoff` (a persuasão falhou
 *    e a IA não pode conceder — encaminha ao consultor);
 *  - já persuadiu (objeção genérica) → `checar` (oferecer outras opções);
 *  - já checou/handoff → mantém.
 */
export function proximaFase(faseAtual: FaseObjecao | null, desconto: boolean): FaseObjecao {
  if (faseAtual === null) return 'persuadir';
  if (desconto) return 'handoff';
  if (faseAtual === 'persuadir') return 'checar';
  return faseAtual;
}

/**
 * Bloco de contexto injetado no sufixo do turno (por-lead) — diz à IA o que fazer
 * na fase atual. Determinístico; nunca no prompt fixo da persona.
 */
export function renderBlocoObjecao(fase: FaseObjecao): string {
  if (fase === 'persuadir') {
    return [
      '## Objeção de valor — passo 1: JUSTIFICAR e tentar convencer',
      'O cliente questionou o preço/condição da moto mostrada. Neste turno:',
      '- Entenda o motivo real (orçamento, valor não percebido, comparação, momento). Se estiver ambíguo, pergunte UMA coisa.',
      '- Justifique com dados REAIS do catálogo/base: especificações (ano, km, estado, cilindrada), procedência e a força da loja.',
      '- Tente convencer e termine com o próximo passo concreto.',
      '- NÃO ofereça outra moto ainda. NÃO dê desconto.',
    ].join('\n');
  }
  if (fase === 'handoff') {
    return [
      '## Objeção de valor — passo final: ENCAMINHAR ao consultor',
      'Você já justificou o valor e o cliente INSISTIU numa condição melhor (desconto), que você não pode conceder.',
      '- NÃO ofereça desconto nem prometa nada; NÃO ofereça outras motos.',
      '- Informe, em tom acolhedor, que vai pedir ao responsável para analisar essa condição — SEM pedir autorização ("Vou pedir para o consultor responsável analisar o que dá pra fazer nessa moto e já te retorno por aqui.").',
      '- Chame `crm_request_human_handoff` para encaminhar. NUNCA pergunte "posso encaminhar?".',
    ].join('\n');
  }
  return [
    '## Objeção de valor — passo 2: OFERECER outras opções (caloroso e variado)',
    'A justificativa não bastou e o cliente continua na objeção. Neste turno:',
    '- Ofereça, de forma calorosa e confiante, outras opções parecidas — VARIE as palavras, nunca repita a mesma frase.',
    '- Exemplo de tom (não copie sempre): "Eu tenho algumas opções com especificações parecidas aqui na loja que tenho certeza que você vai gostar — quer que eu te mostre?"',
    '- NÃO liste motos ainda (o sistema envia depois, quando o cliente quiser ver).',
    '- Se ele QUISER ver → chame `crm_offer_similar_motos`.',
    '- Se ele quiser ESSA moto ("é essa", "tem como melhorar o valor?") → informe que vai pedir ao responsável a análise e chame `crm_request_human_handoff`.',
    '- NUNCA pergunte se pode encaminhar a conversa.',
  ].join('\n');
}
