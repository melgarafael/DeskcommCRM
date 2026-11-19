/**
 * AS ETIQUETAS DE UM PATCH DE NEGÓCIO: SUBSTITUIR, SOMAR ou SUBTRAIR (#4666).
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * `crm_update_lead` só aceitava `tags`, e `tags` SUBSTITUI a lista inteira
 * (`app/api/v1/leads/_handler.ts`: `patch.tags = input.tags`). O agente que
 * queria ACRESCENTAR a etiqueta "X" mandava `["X"]` e, sem erro, sem aviso,
 * apagava as outras — o modelo não tinha como saber que estava apagando. E o
 * valor entrava cru: `" Cliente VIP "` virava uma terceira grafia ao lado de
 * "cliente vip", quebrando filtro, automação e o agrupamento da tela de Tags.
 *
 * ─── A régua é a MESMA da tela, e é por isso que ela mora em funções puras ──
 *
 * A tela que edita `crm_leads.tags` (`components/inbox/ContactTagsEditor`, o
 * mesmo editor do funil desde a #2979) decide o que gravar em
 * `etiquetaParaGravar` (`lib/contacts/etiquetas.ts`):
 *
 *  - a etiqueta CONHECIDA vence sempre — quem digita "cliente vip" grava a
 *    grafia que já existe ("Cliente VIP"), em vez de criar a variante;
 *  - sem conhecida, o texto passa por `normalizarTag`
 *    (`lib/contacts/tag-normalizada.ts`): apara as pontas, minúscula, corta em
 *    40 — a forma que o banco e o filtro `?tag=` esperam;
 *  - a comparação é pela chave LARGA (`chaveDeComparacaoDeEtiqueta`, sem caixa e
 *    sem acento), porque quem digita "sao paulo" quer a "são paulo" que existe.
 *
 * Este módulo repete ESSAS DUAS funções, não uma terceira regra: a lista
 * gravada é a da tela quando a tela edita, e a do agente quando o agente edita.
 * Sem o reuso, "consertar" o MCP criaria a segunda regra que a issue teme.
 *
 * ─── O que cada campo significa, e a ordem quando vêm juntos ────────────────
 *
 *  - `tags`            — SUBSTITUI a lista inteira (contrato preservado: quem já
 *                        chama continua sendo atendido, e o teste declara isso);
 *  - `tags_adicionar`  — UNIÃO com a lista atual;
 *  - `tags_remover`    — DIFERENÇA contra a lista atual.
 *
 * Quando os três vêm na mesma chamada a ordem é a de cima: `tags` define a base,
 * os acréscimos entram, as remoções saem. É determinística e está escrita aqui
 * porque é o que o modelo lê — não há precedência silenciosa.
 */
import { chaveDeComparacaoDeEtiqueta } from "@/lib/contacts/etiquetas";
import { normalizarTag } from "@/lib/contacts/tag-normalizada";

/** Os três campos do PATCH que falam de etiquetas. */
export type EntradaDeEtiquetas = {
  tags?: string[];
  tags_adicionar?: string[];
  tags_remover?: string[];
};

/** A requisição mexeu em etiquetas? Sem nenhum dos três, o PATCH não as toca. */
export function mencionaEtiquetas(entrada: EntradaDeEtiquetas): boolean {
  return (
    entrada.tags !== undefined ||
    entrada.tags_adicionar !== undefined ||
    entrada.tags_remover !== undefined
  );
}

/**
 * A grafia a GRAVAR para um nome que chegou: a que já está no negócio, quando a
 * chave larga casa (é o que a tela faz — "Cliente VIP" continua "Cliente VIP"),
 * senão a forma canônica de `normalizarTag`.
 */
function grafiaParaGravar(crua: string, atuais: readonly string[]): string {
  const chave = chaveDeComparacaoDeEtiqueta(crua);
  const jaGravada = atuais.find((t) => chaveDeComparacaoDeEtiqueta(t) === chave);
  return jaGravada ?? normalizarTag(crua);
}

/**
 * A lista FINAL de etiquetas do patch, ou `undefined` quando a requisição não
 * fala delas (ausente ≠ vazio: `tags: []` LIMPA a lista, e é contrato).
 *
 * `atuais` é o que a linha tem hoje — só o handler a conhece, e é por isso que
 * a união e a diferença moram aqui e não no schema: `zod` não vê o banco.
 */
export function etiquetasParaGravar(
  entrada: EntradaDeEtiquetas,
  atuais: readonly string[],
): string[] | undefined {
  if (!mencionaEtiquetas(entrada)) return undefined;

  const remover = new Set((entrada.tags_remover ?? []).map(chaveDeComparacaoDeEtiqueta));
  const saida: string[] = [];
  const vistas = new Set<string>();
  const acrescentar = (crua: string) => {
    const chave = chaveDeComparacaoDeEtiqueta(crua);
    // Só espaço não é etiqueta, e repetir não acrescenta: mesma régua de
    // `normalizarTags`, aplicada aqui para a lista final não ter duplicata.
    if (chave === "" || vistas.has(chave)) return;
    vistas.add(chave);
    saida.push(grafiaParaGravar(crua, atuais));
  };

  // Base: `tags` substitui a lista INTEIRA; sem ela, a lista atual é a base.
  for (const crua of entrada.tags ?? atuais) acrescentar(crua);
  for (const crua of entrada.tags_adicionar ?? []) acrescentar(crua);

  return saida.filter((tag) => !remover.has(chaveDeComparacaoDeEtiqueta(tag)));
}
