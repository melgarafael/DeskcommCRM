/**
 * "AINDA HÁ ALGO POR SALVAR?" — a pergunta que libera o botão Publicar.
 *
 * ─── O defeito medido (numa instalação em produção) ─────────────────────────
 *
 * A tela do agente comparava o formulário com o estado do servidor por
 * `JSON.stringify(form) !== JSON.stringify(baseline)`. Quem editou o prompt,
 * salvou e foi publicar encontrou o botão "Publicar" cinza para sempre, com a
 * dica "Salve o rascunho antes de publicar" — e salvar de novo não adiantava,
 * porque cada volta repetia o mesmo desencontro. O agente ficou preso na versão
 * antiga; a correção só entrou por fora da tela.
 *
 * Duas diferenças somadas, nenhuma delas uma edição de verdade:
 *
 *   1. **O servidor completa campos.** A versão carregada tinha
 *      `followup = {enabled, flow_pointer_ids}`; ao salvar, o schema grava
 *      `{enabled, flow_pointer_ids, send_window: null}`. O formulário continuou
 *      sem a chave que ele nunca viu, e a comparação leu isso como mudança.
 *   2. **`jsonb` reordena as chaves.** O Postgres guarda por tamanho e ordem de
 *      bytes, então `{ignore_groups, ignore_self, …}` volta como
 *      `{ignore_self, ignore_groups, …}`. Mesmo conteúdo, string diferente —
 *      e `JSON.stringify` compara string.
 *
 * ─── A régua certa ──────────────────────────────────────────────────────────
 *
 * A pergunta não é "os dois objetos são idênticos byte a byte", é **"salvar
 * mudaria alguma coisa?"**. Por isso a comparação é feita sobre o que seria
 * gravado (os payloads), de forma canônica:
 *
 *   • chaves ordenadas em todo nível — a ordem do `jsonb` deixa de importar;
 *   • chave ausente e chave com `null` são a mesma coisa — as duas viram `null`
 *     no banco, e é isso que o servidor completa sozinho;
 *   • arrays mantêm a ordem: nelas a ordem é conteúdo (a lista de capacidades
 *     do agente não é um conjunto desordenado para quem lê a tela).
 *
 * Função pura, fora do componente, porque é a regra que decide se o dono
 * consegue publicar — e dentro do `useMemo` ela não tinha um único teste.
 */

/** Texto canônico de um valor: chaves ordenadas, nulos e ausentes descartados. */
export function textoEstavel(valor: unknown): string {
  return JSON.stringify(canonico(valor));
}

function canonico(valor: unknown): unknown {
  if (Array.isArray(valor)) return valor.map(canonico);
  if (valor === null || typeof valor !== "object") return valor;
  const entradas = Object.entries(valor as Record<string, unknown>)
    // `null` e `undefined` saem: "não informado" e "informado como vazio" são a
    // mesma intenção no que vai para o banco, e é justamente onde o servidor
    // completa o que a tela não mandou.
    .filter(([, v]) => v !== null && v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entradas.map(([chave, v]) => [chave, canonico(v)]));
}

/** `true` quando salvar não mudaria nada — o botão Publicar pode acender. */
export function mesmoRascunho(a: unknown, b: unknown): boolean {
  return textoEstavel(a) === textoEstavel(b);
}
