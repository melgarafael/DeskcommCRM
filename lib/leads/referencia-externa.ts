/**
 * A REFERÊNCIA DO ITEM EXTERNO QUE VIROU NEGÓCIO (Spec 25, D6 / R5a).
 *
 * O agente consulta uma receita do banco externo (um imóvel, um produto, um
 * carro), o cliente diz "tenho interesse nesse", e o negócio nasce no funil.
 * Para o vendedor humano continuar de onde o robô parou, o negócio carrega QUAL
 * item foi escolhido, num formato único: `<receita>:<id>`
 * (ex.: `wordpress-conteudo:4821`).
 *
 * Duas regras moram aqui, puras, para a ferramenta e o teste lerem a mesma:
 *
 *  1. a FORMA da referência (o modelo a monta do resultado da receita, então ela
 *     é entrada não confiável: tamanho e alfabeto fechados, nada de espaço nem
 *     quebra de linha que viraria texto livre na descrição do negócio);
 *  2. a linha que vai para a descrição, para quem abre o card ver o item sem
 *     abrir nada.
 *
 * A DEDUPLICAÇÃO (interesse repetido no mesmo item não cria outro negócio) fica
 * na ferramenta, porque precisa do banco: aqui só existe o que não precisa dele.
 */

/** `<receita>:<id>` — receita em kebab/minúsculas, id sem espaço. Teto de 100. */
export const REFERENCIA_EXTERNA = /^[a-z0-9][a-z0-9_-]{1,39}:[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;

/** A chave em `crm_leads.source_metadata` onde a referência é guardada. */
export const CHAVE_DA_REFERENCIA = "referencia_externa";

export function ehReferenciaExterna(valor: unknown): valor is string {
  return typeof valor === "string" && REFERENCIA_EXTERNA.test(valor);
}

/**
 * A descrição final do negócio: o que o agente escreveu e, no fim, a linha da
 * referência. Respeita o teto de 2000 caracteres do schema de criação — corta o
 * TEXTO do agente, nunca a referência (ela é o que o humano precisa achar).
 */
export function descricaoComReferencia(
  descricao: string | null | undefined,
  referencia: string,
  teto = 2000,
): string {
  const linha = `Referência externa: ${referencia}`;
  const texto = (descricao ?? "").trim();
  if (texto === "") return linha;
  const separador = "\n\n";
  const cabe = teto - linha.length - separador.length;
  if (cabe <= 0) return linha;
  return `${texto.slice(0, cabe)}${separador}${linha}`;
}
