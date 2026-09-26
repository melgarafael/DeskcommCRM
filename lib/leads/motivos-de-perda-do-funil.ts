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

import { CANONICAL_LOST_REASONS, categoriaPadraoDoMotivo } from "@/lib/schemas/leads";
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
