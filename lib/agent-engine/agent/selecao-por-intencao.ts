/**
 * Seleção de motos por INTENÇÃO (G4 do PLANO-SELECAO-MOTOS-INTENCAO).
 *
 * ─── O defeito que isto resolve ─────────────────────────────────────────────
 * O motor escolhia as semelhantes só quando o modelo havia consultado o catálogo
 * naquele turno (`catalogoDoTurno`). No turno da objeção ("Achei caro") o modelo
 * NÃO consulta o catálogo → nada era oferecido. Aqui a seleção vira uma função
 * PURA, chamável também quando só existe a MOTO ATUAL da conversa.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 * 1. Separa PREFERÊNCIAS de ordem (`{preco:"menor"}`) dos critérios de
 *    semelhança (`{marca:"Honda"}`). Vale para QUALQUER coluna.
 * 2. Intenção "alternativa" + moto atual: usa os ATRIBUTOS da moto atual como
 *    âncora (só nas colunas de comparação que NÃO são preferência) e tira a
 *    própria moto da lista — o cliente quer algo parecido, mas diferente dela.
 *    A coluna que é PREFERÊNCIA fica FORA dos critérios de semelhança, senão a
 *    distância até o valor da atual (ex.: preço) diluiria "as mais baratas".
 * 3. `escolherComReferencia` mantém a reserva de `moto_similar` na frente.
 *
 * Funções PURAS — testáveis e sem I/O.
 */
import {
  colunaDeSimilares,
  colunasDeComparacao,
  type CatalogoMapeamento,
} from '@/lib/external-db/catalogo';

import { normalizarNomeDeMoto, type MotoDoCatalogo } from './fotos-do-catalogo';
import { numeroDaCelula } from './similaridade';
import { escolherComReferencia } from './similaridade-referencia';

/**
 * Valores que a pergunta dirigida devolve quando o cliente quer um valor
 * DIFERENTE do atual naquela coluna (ex.: "quero outra cor" → `{cor:"outra"}`).
 * Nesse caso o motor FILTRA (exclui o valor da moto atual), em vez de tratar
 * "outra" como um valor literal de semelhança.
 */
const TOKENS_DIFERENTE = new Set([
  'outra',
  'outro',
  'outras',
  'outros',
  'diferente',
  'diferentes',
]);

export interface EntradaSelecaoPorIntencao {
  /** Texto do pedido do cliente (mensagem do turno), base do casamento textual. */
  termoBase: string;
  /** Critérios já reunidos (IA ou motor), por coluna. */
  criterios: Readonly<Record<string, string | number>>;
  /** Intenção classificada pela pergunta dirigida. */
  intencao: 'pedido' | 'alternativa' | null;
  /** Moto atual da conversa (âncora no modo "alternativa"). */
  motoAtual: MotoDoCatalogo | null;
  /** Motos candidatas (catálogo do turno, guardado e/ou consultado no banco). */
  candidatos: readonly MotoDoCatalogo[];
  mapeamento: CatalogoMapeamento;
  /**
   * Quantas motos oferecer quando há teto (default: `mapeamento.similaresQtd`,
   * por retrocompatibilidade). A fonte REAL agora é
   * `ai_agents.config.catalog.similares_qtd`, passada pelo chamador.
   */
  quantidade?: number;
  /**
   * Toggle B (`usar_limite_quantidade`): aplicar o teto de `quantidade`. Com
   * `false`, não recorta nada — devolve todas as candidatas (respeitando
   * `todasSeEspecificacao`, que também abre o teto). Default `true`.
   */
  aplicarLimite?: boolean;
  /**
   * Toggle A (`especificacao_mostra_todas`): quando o pedido casa um MODELO que
   * existe (ex.: "CB 300"), devolver TODAS as unidades que batem em vez de
   * recortar. O veredito "o modelo existe?" depende do catálogo casado — quem
   * decide é o chamador; aqui só se obedece.
   */
  todasSeEspecificacao?: boolean;
}

export interface ResultadoSelecaoPorIntencao {
  motos: MotoDoCatalogo[];
  preferencias: Record<string, 'menor' | 'maior'>;
  criterios: Record<string, string | number>;
}

/**
 * Aplica a intenção sobre os candidatos e devolve as motos escolhidas (até N).
 * Nunca lança; lista vazia de candidatos ⇒ lista vazia.
 */
export function selecionarPorIntencao(
  input: EntradaSelecaoPorIntencao,
): ResultadoSelecaoPorIntencao {
  const preferencias: Record<string, 'menor' | 'maior'> = {};
  const criterios: Record<string, string | number> = {};
  for (const [coluna, valor] of Object.entries(input.criterios)) {
    const v = String(valor).toLowerCase();
    if (v === 'menor' || v === 'maior') preferencias[coluna] = v;
    else criterios[coluna] = valor;
  }

  const colunasComparacao = colunasDeComparacao(input.mapeamento);
  const alternativo = input.intencao === 'alternativa' && input.motoAtual !== null;

  let candidatos = input.candidatos;
  if (alternativo) {
    const atual = input.motoAtual!;
    for (const coluna of colunasComparacao) {
      // A coluna de preferência NÃO entra na âncora: ela já ordena por "menor/
      // maior". Se entrasse, viraria critério de distância até o valor da atual
      // e a preferência (ex.: mais barata) seria diluída.
      if (preferencias[coluna] !== undefined) continue;
      const v = atual.valores?.[coluna];
      if (v !== undefined && v !== '' && criterios[coluna] === undefined) criterios[coluna] = v;
    }
    // Remove a PRÓPRIA moto atual. Compara pela BASE (`valores.nome`) e não pelo
    // nome composto: a mesma moto pode chegar com nome composto diferente
    // (ex.: a referência veio de uma consulta que omitiu colunas → "Biz 125
    // 2021", e o catálogo traz "HONDA Biz 125 FLEX 2021"). Pela base, casa.
    const chaveAtual = normalizarNomeDeMoto(atual.valores?.nome ?? atual.nome);
    candidatos = candidatos.filter(
      (m) => normalizarNomeDeMoto(m.valores?.nome ?? m.nome) !== chaveAtual,
    );
    // A PREFERÊNCIA numérica vira FILTRO relativo à moto atual (plano §4:
    // `preco < atual`): "Achei caro" só pode oferecer o que é MAIS BARATO que a
    // atual. Sem o filtro a preferência era só desempate e a resposta ainda
    // trazia motos mais caras (medido ao vivo). Sem ninguém do lado pedido, NÃO
    // filtra — melhor oferecer parecidas do que nada.
    for (const [coluna, pref] of Object.entries(preferencias)) {
      const alvo = numeroDaCelula(atual.valores?.[coluna] ?? '');
      if (alvo === null) continue;
      const filtrados = candidatos.filter((m) => {
        const v = numeroDaCelula(m.valores?.[coluna] ?? '');
        return v !== null && (pref === 'menor' ? v < alvo : v > alvo);
      });
      if (filtrados.length > 0) candidatos = filtrados;
    }
    // Critério "DIFERENTE" (ex.: `{cor:"outra"}`, "outro modelo", "diferente") →
    // FILTRA as motos cujo valor naquela coluna é diferente do da atual. É o
    // caso "quero outra cor": o modelo devolve "outra" e o motor exclui as de
    // mesma cor. Vira filtro, não critério de semelhança.
    for (const [coluna, valor] of Object.entries(criterios)) {
      if (!TOKENS_DIFERENTE.has(String(valor).toLowerCase())) continue;
      const alvo = normalizarNomeDeMoto(atual.valores?.[coluna] ?? '');
      if (alvo === '') continue;
      const filtrados = candidatos.filter((m) => {
        const v = normalizarNomeDeMoto(m.valores?.[coluna] ?? '');
        return v !== '' && v !== alvo;
      });
      if (filtrados.length > 0) candidatos = filtrados;
      delete criterios[coluna];
    }
  }

  const extras = Object.values(criterios)
    .map(String)
    .filter((s) => s.trim() !== '')
    .join(' ');
  const termoFinal = extras !== '' ? `${input.termoBase} ${extras}` : input.termoBase;

  const criteriosColunas = colunasComparacao.filter((c) => preferencias[c] === undefined);

  // Teto: `todasSeEspecificacao` (modelo existe) OU `aplicarLimite: false`
  // (toggle B desligado) abrem o teto e devolvem TODAS as candidatas. O teto é o
  // próprio catálogo — `escolherComReferencia` recebe o tamanho (nunca
  // "quantidade livre"). A fonte do número é a config do AGENTE, passada pelo
  // chamador; o default cai no `similaresQtd` do mapeamento (retrocompatível).
  const semTeto = input.todasSeEspecificacao === true || input.aplicarLimite === false;
  const quantidade = semTeto
    ? Math.max(candidatos.length, 1)
    : Math.max(1, input.quantidade ?? input.mapeamento.similaresQtd ?? 3);
  const motos = escolherComReferencia(termoFinal, candidatos, {
    quantidade,
    criteriosColunas,
    // No modo ALTERNATIVA a reserva por `moto_similar` NÃO se aplica: o cliente
    // não está pedindo uma moto pelo nome, e casar o termo (que inclui a objeção
    // e a âncora) contra as referências traria "reservas" espúrias (medido ao
    // vivo: "Achei caro" na Biz 125 reservou quase o catálogo, com a BMW G 310
    // em 2º). A reserva continua valendo para o PEDIDO de um modelo.
    colunaSimilares: alternativo ? null : colunaDeSimilares(input.mapeamento),
    ...(Object.keys(preferencias).length > 0 ? { preferencias } : {}),
  });
  return { motos, preferencias, criterios };
}

/**
 * PRÉ-FILTRO determinístico: a mensagem sugere que o cliente quer algo DIFERENTE
 * da moto atual (ou reclamou do preço/condições)? Evita acionar a classificação e
 * a consulta ao banco externo em TODO turno (ex.: "obrigado", "ok", "vou
 * financiar") — o dono pediu que o motor só consulte quando houver necessidade.
 *
 * A classificação fina continua sendo da IA; isto apenas decide se vale
 * perguntar. Falso-negativo aqui só significa "não busca sozinho" (cai no
 * comportamento atual); falso-positivo custa uma classificação barata.
 */
export function querAlternativa(mensagem: string): boolean {
  const n = normalizarNomeDeMoto(mensagem);
  if (n === '') return false;
  return /\b(caro|barat\w*|desconto|preco|mais nova|mais novo|outra|outro|mud(ei|ar|ou|ando)|diferente|troc\w*|mais opcoes|outras motos|ver mais|alternativa|parecid\w*|semelhant\w*)\b/.test(
    n,
  );
}
