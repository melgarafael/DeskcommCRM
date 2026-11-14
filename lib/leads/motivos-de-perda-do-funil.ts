/**
 * OS MOTIVOS DE PERDA QUE O FUNIL OFERECE — não os que o produto tem.
 *
 * ─── O defeito que este arquivo fecha ──────────────────────────────────────
 *
 * `settings.lost_reasons` é a lista que o operador cadastra em Configurações ›
 * Funis, e o servidor JÁ a respeita: o trigger `fn_validate_lost_reason_required`
 * aceita canônico ∪ cadastrado, e `pipelineConfigPatchSchema` guarda os dois
 * lados dessa mesma regra. A janela de perder, sozinha, renderizava sempre
 * `CANONICAL_LOST_REASONS`: quem cadastrou "Sem orçamento" não via o próprio
 * motivo na tela, digitava à mão dentro de "Outro" e descobria só no clique se
 * o funil daquele card aceitava o que ele escreveu.
 *
 * ─── O que este arquivo NÃO decide ─────────────────────────────────────────
 *
 * Não escreve no banco nem afrouxa o que o trigger aceita — ele é a régua. Aqui
 * só se LÊ o que está cadastrado e se respondem as duas perguntas que a tela faz
 * antes de gravar: "o que eu ofereço?" e "este valor passa?".
 */

import {
  CANONICAL_LOST_REASONS,
  CATEGORIAS_DE_PERDA,
  MAX_CARACTERES_DA_CATEGORIA_DE_PERDA,
  MAX_CATEGORIAS_DE_PERDA,
  categoriaPadraoDoMotivo,
} from "@/lib/schemas/leads";
import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";
import { MOTIVO_DA_TRANSFERENCIA } from "@/lib/leads/motivo-da-perda";

/** O valor canônico de "outro": a saída de quem não acha o motivo na lista. */
export const OUTRO = "other";

const CANONICOS: readonly string[] = CANONICAL_LOST_REASONS;

/** O mesmo teto do PATCH (`.max(50)`): acima disso a tela não é lista, é rolagem. */
const MAX_MOTIVOS = 50;

/**
 * Os motivos cadastrados neste funil, limpos e sem repetição.
 *
 * Cada item é validado pela MESMA régua da gravação
 * (`pipelineConfigPatchSchema.shape.lost_reasons`): ler com uma régua mais
 * frouxa deixaria entrar na tela um valor que o PATCH recusa depois. Mas a
 * régua é aplicada POR ITEM, de propósito — um cadastro sujo (um vazio numa
 * lista de seis, por exemplo) não pode derrubar os cinco motivos bons e jogar
 * o funil inteiro de volta no padrão do produto.
 */
export interface MotivoDePerdaCadastrado {
  /** O que vai para `lost_reason`: o rótulo COMO ESTÁ NO BANCO (ver abaixo). */
  valor: string;
  /** A categoria que o funil deu a este motivo; ausente resolve no padrão. */
  categoria?: string;
}

/**
 * Os motivos do funil COM a categoria (issue #1537).
 *
 * Aceita os DOIS formatos que `settings.lost_reasons` pode ter — `"Preço"` e
 * `{ label: "Preço", categoria: "Cliente" }` — porque o texto puro é o que já
 * existe em todo funil instalado e não pode ser migrado por capricho.
 */
export function motivosComCategoriaDoFunil(settings: unknown): MotivoDePerdaCadastrado[] {
  const bruto = (settings as { lost_reasons?: unknown } | null | undefined)?.lost_reasons;
  if (!Array.isArray(bruto)) return [];

  const regra = pipelineConfigPatchSchema.shape.lost_reasons;
  const vistos = new Set<string>();
  const limpos: MotivoDePerdaCadastrado[] = [];

  for (const item of bruto) {
    const rotuloBruto = typeof item === "string" ? item : (item as { label?: unknown } | null)?.label;
    if (typeof rotuloBruto !== "string") continue;
    const texto = rotuloBruto.trim();
    if (vistos.has(texto)) continue;

    const categoriaBruta =
      typeof item === "object" && item !== null
        ? (item as { categoria?: unknown }).categoria
        : undefined;
    const categoria =
      typeof categoriaBruta === "string" && categoriaBruta.trim() ? categoriaBruta.trim() : null;

    // A régua do PATCH aplicada POR ITEM, de sempre. A categoria só entra se
    // ELA passar na régua: um `categoria` vazio ou longo demais derruba o
    // motivo? Não — derruba só a categoria. Cadastro sujo não apaga motivo bom.
    const rotuloOk = regra.safeParse([typeof item === "string" ? texto : { label: texto }]);
    if (!rotuloOk.success) continue;
    const categoriaOk = categoria
      ? regra.safeParse([{ label: texto, categoria }]).success
      : false;
    vistos.add(texto);
    // O texto COMO ESTÁ NO BANCO, não o aparado. O trigger compara por
    // IGUALDADE EXATA (`new.lost_reason = any(...)`, com o `label` extraído dos
    // objetos), então oferecer a versão aparada de um `lost_reasons` com espaço
    // nas pontas — gravado por script, seed ou API, nunca pela tela de Funis,
    // que apara — faria a janela mostrar um rótulo que o banco recusa com 22023
    // no clique. É a classe de defeito que este arquivo existe para fechar. O
    // HTML colapsa espaço nas pontas, então o rótulo na tela continua o mesmo.
    limpos.push(
      categoria && categoriaOk ? { valor: rotuloBruto, categoria } : { valor: rotuloBruto },
    );
  }

  return limpos.slice(0, MAX_MOTIVOS);
}

/** Os rótulos do funil, na ordem cadastrada — o que as telas antigas querem. */
export function motivosDoFunil(settings: unknown): string[] {
  return motivosComCategoriaDoFunil(settings).map((m) => m.valor);
}

/**
 * O rótulo do que NÃO tem categoria (#4437).
 *
 * Motivo sem categoria não pode virar linha EM BRANCO no relatório "Perdas":
 * um buraco não diz a quem lê se o dado falta, se a categoria foi apagada ou se
 * aquele motivo nunca foi categorizado. O texto é do produto (traduzível) e é o
 * mesmo que o relatório, o filtro do quadro e a tela de Funis usam — uma cópia
 * em cada arquivo divergiria no primeiro ajuste.
 */
export const SEM_CATEGORIA = "Sem categoria";

/**
 * As categorias que o FUNIL DECLAROU (`settings.lost_reason_categories`, #4437),
 * na ordem da tela — ou `null` quando ele nunca declarou nada.
 *
 * `null` e `[]` são estados DIFERENTES, e é a diferença que faz a doutrina da
 * chave funcionar: `null` é "nunca mexeu" (vale a lista de fábrica) e `[]` é
 * "escondeu todas" (decisão da organização, que a fábrica não pode desfazer).
 * Por isso a leitura não usa `?? []`.
 *
 * A régua é aplicada ITEM a ITEM, como em `motivosComCategoriaDoFunil`: um
 * registro sujo gravado à mão (string vazia, texto de 200 caracteres) não pode
 * derrubar a lista inteira e devolver o funil ao padrão do produto.
 */
export function categoriasDeclaradasDoFunil(settings: unknown): string[] | null {
  const bruto = (settings as { lost_reason_categories?: unknown } | null | undefined)
    ?.lost_reason_categories;
  if (!Array.isArray(bruto)) return null;

  const vistos = new Set<string>();
  const limpas: string[] = [];
  for (const item of bruto) {
    if (typeof item !== "string") continue;
    const texto = item.trim();
    if (!texto || texto.length > MAX_CARACTERES_DA_CATEGORIA_DE_PERDA) continue;
    if (vistos.has(texto)) continue;
    vistos.add(texto);
    if (limpas.length >= MAX_CATEGORIAS_DE_PERDA) break;
    limpas.push(texto);
  }
  return limpas;
}

/**
 * As categorias que os motivos JÁ USAM — o vínculo gravado em
 * `lost_reasons[].categoria`.
 *
 * É esta lista que faz o contrário do que a issue relata: em vez de a categoria
 * sumir quando o motivo é renomeado, ela sobrevive enquanto houver motivo
 * apontando para ela. Inclui o "Risco" gravado à mão no "Possível fraude" antes
 * de a tela existir — sem migration nenhuma.
 */
export function categoriasUsadasPelosMotivos(settings: unknown): string[] {
  const vistos = new Set<string>();
  for (const motivo of motivosComCategoriaDoFunil(settings)) {
    if (motivo.categoria) vistos.add(motivo.categoria);
  }
  return [...vistos];
}

/**
 * O catálogo EFETIVO de categorias do funil (#4437): o que a tela oferece no
 * menu de cada motivo, o que o filtro do quadro lista e o que o relatório
 * agrupa.
 *
 * Composição, nesta ordem: a lista DECLARADA (ou a de fábrica, para quem nunca
 * declarou) e, depois, as categorias em USO. As duas partes existem por um
 * motivo cada:
 *
 *   - a declarada é a decisão da organização — inclusive a categoria nova que
 *     ninguém usou ainda precisa aparecer para ser escolhida;
 *   - a em uso é o que impede a mentira contrária: esconder "Mérito" da lista
 *     não pode apagar o agrupamento dos motivos que já são "Mérito", nem fazer o
 *     menu do motivo mostrar um valor que não está entre as opções.
 *
 * Deduplicado e sem vazios, na ordem em que apareceram.
 */
export function categoriasDoFunil(settings: unknown): string[] {
  const declaradas = categoriasDeclaradasDoFunil(settings) ?? [...CATEGORIAS_DE_PERDA];
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const categoria of [...declaradas, ...categoriasUsadasPelosMotivos(settings)]) {
    if (!categoria || vistos.has(categoria)) continue;
    vistos.add(categoria);
    saida.push(categoria);
  }
  return saida;
}

/**
 * A lista que a TELA de Funis edita (#4437): a declarada, ou — para o funil que
 * nunca declarou — o catálogo efetivo (fábrica + em uso).
 *
 * A diferença para `categoriasDoFunil` é de propósito: a tela mostra só o que a
 * organização declarou, senão uma categoria ESCONDIDA voltaria à lista na
 * próxima abertura (ela continua "em uso") e esconder não esconderia nada. Na
 * primeira abertura de um funil que nunca declarou, o catálogo efetivo é o que
 * a tela oferece — e é ele que o primeiro "salvar" grava, o que migra o "Risco"
 * do banco para a lista do funil sem tocar em motivo nenhum.
 */
export function categoriasEditaveisDoFunil(settings: unknown): string[] {
  return categoriasDeclaradasDoFunil(settings) ?? categoriasDoFunil(settings);
}

/** Os rótulos de uma caixa de texto separada por vírgula, na ordem e sem vazios. */
export function rotulosDaCaixaDeMotivos(texto: string): string[] {
  return texto
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * CARREGA A CATEGORIA DE UM MOTIVO QUANDO O TEXTO DELE MUDA (#4437).
 *
 * ─── O defeito que isto fecha ──────────────────────────────────────────────
 *
 * A tela guarda a categoria num mapa indexado pelo TEXTO do motivo
 * (`{ "Possível fraude": "Risco" }`), porque é assim que o banco guarda
 * (`lost_reasons: [{ label, categoria }]` — o trigger compara o rótulo por
 * igualdade exata, então o vínculo persistido É textual). Quem renomeava o
 * motivo na caixa de texto perdia a categoria: o mapa continuava com a chave
 * antiga, a nova não casava e o motivo voltava sem categoria no save.
 *
 * ─── A chave estável ───────────────────────────────────────────────────────
 *
 * O identificador do motivo é a POSIÇÃO dele na lista, não o texto: a edição da
 * caixa é um diff entre a lista de antes e a de depois, e o que sobrou no mesmo
 * lugar é o MESMO motivo com outro nome. Assim "Possível fraude" → "Fraude
 * confirmada" mantém o "Risco", que é o que a issue pede.
 *
 * Regras, e o porquê de cada uma:
 *
 *   - rótulo IGUAL (aparado) casa direto, mesmo que tenha mudado de posição —
 *     reordenar a caixa não é renomear;
 *   - num trecho onde saiu K rótulos e entraram K, o i-ésimo novo herda a
 *     categoria do i-ésimo que saiu: é a definição de renomear dentro de uma
 *     caixa de texto, onde o que existe é substituição;
 *   - num trecho de contagens diferentes (colar a lista inteira, apagando um
 *     motivo e renomeando outro no mesmo evento) o par sai da SEMELHANÇA do
 *     texto, com piso: "Possível fraude" → "Fraude confirmada" herda, dois
 *     rótulos sem trecho comum nenhum não herdam. O piso existe porque vínculo
 *     errado é pior que vínculo perdido — o relatório não denuncia o primeiro;
 *   - sobra sem par é criação (nasce sem categoria) ou remoção (a categoria vai
 *     embora com o motivo).
 *
 * A comparação é pelo texto aparado porque é o que o save grava (a caixa apara
 * cada item), e o mapa de entrada é lido só nas chaves que ainda existem — o
 * que ficou para trás é descartado junto com o motivo que sumiu.
 */

/**
 * O trecho comum mínimo, em caracteres, para dois rótulos serem "o mesmo motivo
 * com outro nome" quando as contagens do trecho não batem.
 *
 * 3 é o menor valor que ainda distingue um rename de verdade ("fraude" em comum)
 * de coincidência de duas letras ("or", "de") que qualquer frase em português
 * tem. Abaixo disso, não herda.
 */
const TRECHO_COMUM_MINIMO = 3;

/** O maior trecho de texto comum entre dois rótulos — a nota do rename. */
function maiorTrechoComum(a: string, b: string): number {
  if (!a || !b) return 0;
  let melhor = 0;
  // `anterior`/`atual` são a coluna do DP: o comprimento do trecho comum que
  // TERMINA em cada posição de `b`.
  let anterior = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const atual = new Array<number>(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        const comprimento = (anterior[j - 1] ?? 0) + 1;
        atual[j] = comprimento;
        if (comprimento > melhor) melhor = comprimento;
      }
    }
    anterior = atual;
  }
  return melhor;
}
export function categoriasQueSobrevivemAoTexto(
  rotulosAnteriores: readonly string[],
  rotulosNovos: readonly string[],
  categorias: Readonly<Record<string, string>>,
): Record<string, string> {
  const anteriores = rotulosAnteriores.map((r) => r.trim());
  const novos = rotulosNovos.map((r) => r.trim());
  const saida: Record<string, string> = {};

  const categoriaDe = (rotulo: string): string | undefined => categorias[rotulo];

  // Caminho mais comum e mais barato: a lista não mudou (só o texto da caixa em
  // volta dela) — devolve o mapa intacto, sem reconstruir nada.
  if (anteriores.length === novos.length && anteriores.every((r, i) => r === novos[i])) {
    return { ...categorias };
  }

  // LCS dos rótulos aparados: os que sobrevivem IGUAIS, na ordem.
  const n = anteriores.length;
  const m = novos.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        anteriores[i] === novos[j]
          ? (lcs[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]![j] ?? 0, lcs[i]![j + 1] ?? 0);
    }
  }
  const pares: Array<{ antigo: number; novo: number }> = [];
  {
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (anteriores[i] === novos[j]) {
        pares.push({ antigo: i, novo: j });
        i++;
        j++;
      } else if ((lcs[i + 1]![j] ?? 0) >= (lcs[i]![j + 1] ?? 0)) {
        i++;
      } else {
        j++;
      }
    }
  }

  // Os trechos ENTRE os pares: substituição 1:1 herda, contagem diferente não.
  const trechos: Array<{ saida: number[]; entrada: number[] }> = [];
  {
    let antigoAnterior = 0;
    let novoAnterior = 0;
    const fechar = (antigoAte: number, novoAte: number) => {
      trechos.push({
        saida: Array.from({ length: antigoAte - antigoAnterior }, (_, k) => antigoAnterior + k),
        entrada: Array.from({ length: novoAte - novoAnterior }, (_, k) => novoAnterior + k),
      });
    };
    for (const par of pares) {
      fechar(par.antigo, par.novo);
      antigoAnterior = par.antigo + 1;
      novoAnterior = par.novo + 1;
    }
    fechar(n, m);
  }

  for (const trecho of trechos) {
    if (trecho.saida.length === trecho.entrada.length) {
      trecho.saida.forEach((indiceVelho, k) => {
        const novoRotulo = novos[trecho.entrada[k]!];
        if (!novoRotulo || saida[novoRotulo]) return;
        const herdada = categoriaDe(anteriores[indiceVelho]!);
        if (herdada) saida[novoRotulo] = herdada;
      });
      continue;
    }

    // CONTAGEM DIFERENTE: apagar um motivo e renomear outro no MESMO evento
    // (colar a lista inteira na caixa) cai aqui, e parear por posição erraria o
    // alvo. O par é escolhido pela SEMELHANÇA do texto — "Possível fraude" →
    // "Fraude confirmada" compartilha "fraude" —, e o que não tem par de
    // verdade (semelhança abaixo de um trecho comum mínimo) nasce sem categoria.
    // Sem esse piso, dois motivos quaisquer herdariam vínculo por acidente, que
    // é pior do que perder o vínculo: vínculo errado o relatório não denuncia.
    const candidatos: Array<{ antigo: number; novo: number; nota: number }> = [];
    for (const antigo of trecho.saida) {
      for (const novo of trecho.entrada) {
        const nota = maiorTrechoComum(
          (anteriores[antigo] ?? "").toLowerCase(),
          (novos[novo] ?? "").toLowerCase(),
        );
        if (nota >= TRECHO_COMUM_MINIMO) candidatos.push({ antigo, novo, nota });
      }
    }
    candidatos.sort(
      (a, b) =>
        b.nota - a.nota ||
        Math.abs(a.antigo - a.novo) - Math.abs(b.antigo - b.novo) ||
        a.novo - b.novo,
    );
    const antigosUsados = new Set<number>();
    const novosUsados = new Set<number>();
    for (const candidato of candidatos) {
      if (antigosUsados.has(candidato.antigo) || novosUsados.has(candidato.novo)) continue;
      antigosUsados.add(candidato.antigo);
      novosUsados.add(candidato.novo);
      const novoRotulo = novos[candidato.novo];
      const herdada = categoriaDe(anteriores[candidato.antigo] ?? "");
      if (novoRotulo && herdada && !saida[novoRotulo]) saida[novoRotulo] = herdada;
    }
  }

  // RÓTULO IGUAL mantém o vínculo, mesmo tendo mudado de posição — reordenar a
  // caixa não é renomear. Entra DEPOIS dos trechos porque o texto é a prova
  // mais forte: um rótulo que continua escrito igual é o mesmo motivo, e a
  // categoria dele não depende de o alinhamento por posição ter casado.
  for (const rotulo of novos) {
    const herdada = categoriaDe(rotulo);
    if (herdada) saida[rotulo] = herdada;
  }

  return saida;
}

/**
 * A categoria DESTE motivo para ESTE funil (issue #1537) — a pergunta que o
 * filtro do quadro e o relatório "Perdas" fazem antes de agrupar.
 *
 * Ordem: primeiro o que o operador gravou em `{ label, categoria }`; não
 * achando, a categoria padrão do motivo canônico (`other` fica sem). Um motivo
 * cadastrado como TEXTO PURO herda o padrão — é assim que um funil antigo
 * aparece agrupado sem ninguém migrar nada.
 */
/**
 * Os motivos que ESTA categoria alcança, dados os `settings` dos funis (issue #1537).
 *
 * É a mesma régua de `categoriaDoMotivo`, aplicada ao contrário: para filtrar,
 * a pergunta é "qual rótulo devo procurar em `lost_reason`". O padrão canônico
 * entra mesmo sem funil nenhum cadastrá-lo, porque `price` é categoria "Nós"
 * no funil que nunca tocou em `lost_reasons` também.
 *
 * Sem funis (`funis` vazio), só o padrão do produto — e `other`, sem categoria,
 * nunca é retorno de nada.
 */
export function motivosDaCategoria(funis: readonly { settings: unknown }[], categoria: string): string[] {
  const alvo = categoria.trim();
  if (!alvo) return [];
  const vistos = new Set<string>();
  for (const funil of funis) {
    for (const motivo of motivosComCategoriaDoFunil(funil.settings)) {
      if (motivo.categoria === alvo) vistos.add(motivo.valor);
      else if (!motivo.categoria && categoriaPadraoDoMotivo(motivo.valor) === alvo) {
        vistos.add(motivo.valor);
      }
    }
  }
  for (const canonico of CANONICAL_LOST_REASONS) {
    if (categoriaPadraoDoMotivo(canonico) === alvo) vistos.add(canonico);
  }
  return [...vistos];
}

export function categoriaDoMotivo(valor: string, settings: unknown): string | undefined {
  const alvo = valor.trim();
  if (!alvo) return undefined;
  for (const motivo of motivosComCategoriaDoFunil(settings)) {
    if (motivo.categoria && motivo.valor.trim() === alvo) return motivo.categoria;
  }
  return categoriaPadraoDoMotivo(alvo);
}

export interface OpcaoDeMotivo {
  /** O que vai para `lost_reason` se esta opção for a escolhida. */
  valor: string;
  /**
   * `true` quando o motivo veio do funil: aí o rótulo é o texto que o operador
   * escreveu, mostrado como veio (dado, não interface — traduzir seria errado).
   */
  doFunil: boolean;
}

/**
 * As opções que a janela de perder mostra.
 *
 * Funil com motivos cadastrados manda: a lista configurada substitui o padrão,
 * porque foi ela que o operador escreveu para o negócio dele — e é ela que ele
 * espera ver no relatório de perdas. Sem nada cadastrado, o padrão do produto
 * continua sendo o padrão. "Outro" entra sempre, nas duas situações.
 *
 * ⚠️ O MOTIVO DE SISTEMA NÃO SE OFERECE — em nenhuma das duas situações.
 * `moved_to_another_pipeline` é o motivo com que a troca de funil encerra a
 * origem, e ele é canônico (o trigger o aceita). Só que a migration 0266 o
 * EXCLUI de `fn_attendant_metrics` e `fn_atrito_metrics`: ele existe justamente
 * para a transferência não engordar o número de perdas de ninguém. Oferecido na
 * janela, ele vira o caminho de UM clique para tirar uma perda comercial real da
 * métrica — sem rastro para quem audita, porque o motivo gravado parece legítimo.
 * Quem transfere continua podendo gravá-lo; quem está perdendo o negócio, não o
 * escolhe na lista.
 */
export function opcoesDeMotivoDePerda(motivosCadastrados: readonly string[]): OpcaoDeMotivo[] {
  const doFunil = motivosCadastrados.length > 0;
  const base: string[] = (doFunil ? [...motivosCadastrados] : [...CANONICOS]).filter(
    (valor) => valor !== MOTIVO_DA_TRANSFERENCIA,
  );
  const opcoes: OpcaoDeMotivo[] = base.map((valor) => ({ valor, doFunil }));
  if (!base.includes(OUTRO)) opcoes.push({ valor: OUTRO, doFunil: false });
  return opcoes;
}

/**
 * Este valor passa pelo trigger?
 *
 * `fn_validate_lost_reason_required` aceita canônico ∪ cadastrado no funil do
 * card. Repetir a regra aqui é o que evita o texto livre virar erro 22023
 * (`lost_reason_invalid`) DEPOIS do clique: a tela recusa antes, dizendo o que
 * fazer — que é o que a issue #918 pede por "validar os motivos do funil".
 */
export function motivoDePerdaAceito(valor: string, motivosCadastrados: readonly string[]): boolean {
  const texto = valor.trim();
  if (!texto) return false;
  return CANONICOS.includes(texto) || motivosCadastrados.includes(texto);
}
