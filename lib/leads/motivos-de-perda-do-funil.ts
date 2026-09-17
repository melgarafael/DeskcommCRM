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

import { CANONICAL_LOST_REASONS } from "@/lib/schemas/leads";
import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

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
export function motivosDoFunil(settings: unknown): string[] {
  const bruto = (settings as { lost_reasons?: unknown } | null | undefined)?.lost_reasons;
  if (!Array.isArray(bruto)) return [];

  const regra = pipelineConfigPatchSchema.shape.lost_reasons;
  const vistos = new Set<string>();
  const limpos: string[] = [];

  for (const item of bruto) {
    if (typeof item !== "string") continue;
    const texto = item.trim();
    if (vistos.has(texto)) continue;
    if (!regra.safeParse([texto]).success) continue;
    vistos.add(texto);
    // O texto COMO ESTÁ NO BANCO, não o aparado. O trigger compara por
    // IGUALDADE EXATA (`new.lost_reason = any(jsonb_array_elements_text(...))`),
    // então oferecer a versão aparada de um `lost_reasons` com espaço nas pontas
    // — gravado por script, seed ou API, nunca pela tela de Funis, que apara —
    // faria a janela mostrar um rótulo que o banco recusa com 22023 no clique.
    // É a classe de defeito que este arquivo existe para fechar. O HTML colapsa
    // espaço nas pontas, então o rótulo na tela continua o mesmo.
    limpos.push(item);
  }

  return limpos.slice(0, MAX_MOTIVOS);
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
 */
export function opcoesDeMotivoDePerda(motivosCadastrados: readonly string[]): OpcaoDeMotivo[] {
  const doFunil = motivosCadastrados.length > 0;
  const base: string[] = doFunil ? [...motivosCadastrados] : [...CANONICOS];
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
