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
import type { FaixasDoPedido, HipoteseDeMoto } from './extrair-criterios';
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
  /**
   * Hipóteses devolvidas pela IA (configurações de motos parecidas). Viram
   * FILTRO quando `filtrarPorComparacao` estiver ligado.
   */
  hipoteses?: readonly HipoteseDeMoto[];
  /**
   * Faixas/intervalos devolvidos pela IA (cc/preço/…). Viram FILTRO numérico.
   */
  faixas?: FaixasDoPedido;
  /**
   * Ligar o FILTRO por hipóteses/faixas (decisão do dono, 2026-09-26). Só as
   * colunas com valor/faxa filtram; colunas sem dado do cliente não filtram.
   * Se o filtro zerar, cai no comportamento de ranking (fallback garantido).
   */
  filtrarPorComparacao?: boolean;
  /** Tolerância (%) para casar número da hipótese × moto (cc/preço). Default 30. */
  toleranciaPct?: number;
  /**
   * C-090: interruptor "Enviar todas as motos que casam". Ligado = ignora o teto
   * N, não completa e não pagina — devolve TODAS as que casaram o filtro.
   */
  enviarTodasQueCasam?: boolean;
}

export interface ResultadoSelecaoPorIntencao {
  motos: MotoDoCatalogo[];
  preferencias: Record<string, 'menor' | 'maior'>;
  criterios: Record<string, string | number>;
  /** Quantos candidatos o filtro por comparação manteve (0 = filtro ignorado). */
  filtrados: number;
  /** Sobrou moto parecida fora do corte? (o turno pergunta "quer ver mais?"). */
  temMaisOpcoes: boolean;
  /** Perfil interpretado pela IA (marcas/categorias) — para a fila de opções. */
  perfil: { marcas: string[]; categorias: string[] };
}

/** Perfil interpretado pela IA: marcas e categorias das hipóteses + faixas. */
export interface PerfilDaIA {
  marcas: Set<string>;
  categorias: Set<string>;
}

/** Extrai o perfil (marcas/categorias) das hipóteses e faixas da IA. */
export function perfilDaIA(
  hipoteses: readonly HipoteseDeMoto[],
  faixas: FaixasDoPedido,
): PerfilDaIA {
  const marcas = new Set<string>();
  const categorias = new Set<string>();
  for (const h of hipoteses) {
    for (const campo of ['marca'] as const) {
      const v = h[campo];
      if (typeof v === 'string' && v.trim() !== '') marcas.add(normalizarNomeDeMoto(v));
    }
    for (const campo of ['categoria', 'tipo'] as const) {
      const v = h[campo];
      if (typeof v === 'string' && v.trim() !== '') categorias.add(normalizarNomeDeMoto(v));
    }
  }
  // Faixas de marca/categoria (quando a IA devolve lista, ex.: {categoria:["Naked"]}).
  const faixaMarca = faixas.marca;
  if (Array.isArray(faixaMarca)) {
    for (const v of faixaMarca) if (typeof v === 'string' && v.trim() !== '') marcas.add(normalizarNomeDeMoto(v));
  }
  const faixaCat = faixas.categoria;
  if (Array.isArray(faixaCat)) {
    for (const v of faixaCat) if (typeof v === 'string' && v.trim() !== '') categorias.add(normalizarNomeDeMoto(v));
  }
  return { marcas, categorias };
}

/**
 * A moto casa o perfil da IA? Marca igual OU categoria contida (o catálogo traz
 * "Street, Naked" e a IA pode devolver "Naked"). Perfil vazio ⇒ true (sem
 * restrição — não exclui nada).
 */
export function casaPerfil(moto: MotoDoCatalogo, perfil: PerfilDaIA): boolean {
  if (perfil.marcas.size === 0 && perfil.categorias.size === 0) return true;
  const marca = normalizarNomeDeMoto(moto.valores?.marca ?? '');
  if (marca !== '' && perfil.marcas.has(marca)) return true;
  const categoria = normalizarNomeDeMoto(moto.valores?.categoria ?? moto.valores?.tipo ?? '');
  if (categoria !== '') {
    for (const c of perfil.categorias) {
      if (categoria.includes(c) || c.includes(categoria)) return true;
    }
  }
  return false;
}

/** A célula da moto numérica? (usa o mesmo critério do ranking). */
function valorNumerico(valor: string | undefined): number | null {
  if (valor === undefined || valor === '') return null;
  return numeroDaCelula(valor);
}

/**
 * A moto casa UMA hipótese? Casa quando TODAS as colunas preenchidas na hipótese
 * batem: número → dentro de ±tolerância; texto → contém o token (normalizado).
 * Hipótese sem coluna alguma nunca casa (evita "filtro vazio").
 */
function casaHipotese(
  moto: MotoDoCatalogo,
  hipotese: HipoteseDeMoto,
  toleranciaPct: number,
): boolean {
  const entradas = Object.entries(hipotese).filter(
    ([, v]) => typeof v === 'string' && v.trim() !== '',
  );
  if (entradas.length === 0) return false;
  for (const [coluna, alvo] of entradas) {
    const celula = moto.valores?.[coluna];
    if (celula === undefined || celula === '') return false;
    const alvoNum = valorNumerico(alvo as string);
    const celulaNum = valorNumerico(celula);
    if (alvoNum !== null && celulaNum !== null) {
      const margem = Math.max(1, (Math.abs(alvoNum) * toleranciaPct) / 100);
      if (Math.abs(celulaNum - alvoNum) > margem) return false;
    } else if (!normalizarNomeDeMoto(celula).includes(normalizarNomeDeMoto(alvo as string))) {
      return false;
    }
  }
  return true;
}

/** A moto casa TODAS as faixas presentes (números fora do intervalo reprovam). */
function casaFaixas(moto: MotoDoCatalogo, faixas: FaixasDoPedido): boolean {
  let avaliou = false;
  for (const [coluna, faixa] of Object.entries(faixas)) {
    if (typeof faixa !== 'object' || faixa === null) continue;
    const f = faixa as { min?: unknown; max?: unknown };
    const celula = valorNumerico(moto.valores?.[coluna]);
    if (celula === null) continue; // coluna não numérica/ausente não reprova
    if (typeof f.min === 'number' && celula < f.min) return false;
    if (typeof f.max === 'number' && celula > f.max) return false;
    avaliou = true;
  }
  return avaliou;
}

/**
 * FILTRA os candidatos por hipóteses/faixas devolvidas pela IA (decisão do dono,
 * 2026-09-26). Só as colunas COM valor/faxa filtram. Uma moto entra se casar
 * QUALQUER hipótese E todas as faixas. Nunca lança. Lista vazia = filtro ignorado
 * (o chamador cai no ranking) — nunca zera a resposta.
 */
export function filtrarPorHipoteses(
  candidatos: readonly MotoDoCatalogo[],
  hipoteses: readonly HipoteseDeMoto[],
  faixas: FaixasDoPedido,
  toleranciaPct: number,
): MotoDoCatalogo[] {
  const temHipoteses = hipoteses.some(
    (h) => Object.values(h).some((v) => typeof v === 'string' && v.trim() !== ''),
  );
  const temFaixas = Object.keys(faixas).length > 0;
  if (!temHipoteses && !temFaixas) return [];
  const saida = candidatos.filter((moto) => {
    const passaFaixas = temFaixas ? casaFaixas(moto, faixas) : true;
    if (!passaFaixas) return false;
    if (!temHipoteses) return true;
    return hipoteses.some((h) => casaHipotese(moto, h, toleranciaPct));
  });
  return saida;
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

  // FILTRO por hipóteses/faixas da IA (só no PEDIDO; no modo alternativa a âncora
  // é a moto atual). As motos que passam ganham PRIORIDADE; se derem menos que N,
  // o motor COMPLETA com as mais próximas (nunca responde vazio, nunca manda o
  // catálogo inteiro). É a regra do dono: modelo inexistente → N alternativas.
  let filtrados = 0;
  let preferidos: Set<MotoDoCatalogo> | null = null;
  const perfil = perfilDaIA(input.hipoteses ?? [], input.faixas ?? {});
  if (
    input.filtrarPorComparacao === true &&
    !alternativo &&
    ((input.hipoteses?.length ?? 0) > 0 || Object.keys(input.faixas ?? {}).length > 0)
  ) {
    const passou = filtrarPorHipoteses(
      candidatos,
      input.hipoteses ?? [],
      input.faixas ?? {},
      // Tolerância de cilindrada/preço para casar hipótese × moto real.
      input.toleranciaPct ?? 30,
    );
    if (passou.length > 0) {
      preferidos = new Set(passou);
      filtrados = passou.length;
    }
  }

  const extras = Object.values(criterios)
    .map(String)
    .filter((s) => s.trim() !== '')
    .join(' ');
  const termoFinal = extras !== '' ? `${input.termoBase} ${extras}` : input.termoBase;

  const criteriosColunas = colunasComparacao.filter((c) => preferencias[c] === undefined);

  // Teto: `todasSeEspecificacao` (modelo existe) OU `aplicarLimite: false`
  // (toggle B desligado) abrem o teto e devolvem TODAS as candidatas. C-090: o
  // interruptor "enviar todas que casam" também abre o teto — manda tudo que casou.
  const semTeto =
    input.todasSeEspecificacao === true ||
    input.aplicarLimite === false ||
    (input.enviarTodasQueCasam === true && preferidos !== null);
  const quantidade = semTeto
    ? Math.max(candidatos.length, 1)
    : Math.max(1, input.quantidade ?? input.mapeamento.similaresQtd ?? 3);
  const basePreferida =
    preferidos !== null ? candidatos.filter((m) => preferidos!.has(m)) : candidatos;
  const quantidadeBase = semTeto ? Math.max(basePreferida.length, 1) : quantidade;
  const motos = escolherComReferencia(termoFinal, basePreferida, {
    quantidade: quantidadeBase,
    criteriosColunas,
    // No modo ALTERNATIVA a reserva por `moto_similar` NÃO se aplica: o cliente
    // não está pedindo uma moto pelo nome, e casar o termo (que inclui a objeção
    // e a âncora) contra as referências traria "reservas" espúrias (medido ao
    // vivo: "Achei caro" na Biz 125 reservou quase o catálogo, com a BMW G 310
    // em 2º). A reserva continua valendo para o PEDIDO de um modelo.
    colunaSimilares: alternativo ? null : colunaDeSimilares(input.mapeamento),
    ...(Object.keys(preferencias).length > 0 ? { preferencias } : {}),
  });
  // COMPLETA até N SOMENTE com o MESMO PERFIL (decisão do dono, 2026-09-26):
  // mesma marca OU categoria das hipóteses/faixas. NÃO completa com perfil alheio
  // (era o defeito: "CB 250" trazia XMax/scooter/BMW). Se casou menos que N e não
  // há mais motos do perfil, o envio fica com as que casam — e o turno PERGUNTA
  // se o cliente quer ver as demais (temMaisOpcoes). C-090: o modo "enviar todas
  // que casam" NÃO completa (já mandou tudo que casou).
  if (preferidos !== null && !semTeto && motos.length < quantidade) {
    const jaTem = new Set(motos);
    const complemento = candidatos
      .filter((m) => !jaTem.has(m))
      .filter((m) => casaPerfil(m, perfil));
    if (complemento.length > 0) {
      const resto = escolherComReferencia(termoFinal, complemento, {
        quantidade: quantidade - motos.length,
        criteriosColunas,
        colunaSimilares: colunaDeSimilares(input.mapeamento),
        ...(Object.keys(preferencias).length > 0 ? { preferencias } : {}),
      });
      motos.push(...resto);
    }
  }
  // Sobrou moto parecida fora do corte? O turno usa isto para perguntar ao cliente
  // se quer ver mais opções (regra do dono, 2026-09-26).
  const temMaisOpcoes =
    preferidos !== null && !semTeto && candidatos.length > motos.length;
  return {
    motos,
    preferencias,
    criterios,
    filtrados,
    temMaisOpcoes,
    perfil: { marcas: [...perfil.marcas], categorias: [...perfil.categorias] },
  };
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

/**
 * C-089: o cliente pediu para ver MAIS opções do que já foi oferecido?
 * ("quero ver mais", "tem mais opções?", "mostra as outras"). Diferente de
 * `querAlternativa` (que é "quero algo diferente"): aqui o motor CONTINUA a
 * fila de opções pendentes do pedido atual, sem repetir e sem reclassificar.
 */
export function querMaisOpcoes(mensagem: string): boolean {
  const n = normalizarNomeDeMoto(mensagem);
  if (n === '') return false;
  return /\b(mais opcoes|mais motos|outras opcoes|outras motos|ver mais|mostra mais|tem mais|quais outras|as demais|as outras|mais alternativas|mais alguma|mais alguma opcao|restantes)\b/.test(
    n,
  );
}
