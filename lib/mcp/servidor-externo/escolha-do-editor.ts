/**
 * A ESCOLHA das ferramentas do servidor MCP externo no EDITOR do agente
 * (#2147, item 6 — a metade de cima; a de baixo, runtime e validação, já
 * existia).
 *
 * ── Por que a regra mora aqui e não no componente ───────────────────────────
 *
 * É a mesma razão de `lib/mcp/tools/selecao-por-pacote.ts`: regra dentro de
 * `onChange` é regra que nunca é exercitada. Marcar, desmarcar, trocar a marca
 * e achar a escolha órfã são operações sobre um array de strings — funções
 * puras, testáveis sem DOM, e o cartão do editor só chama e renderiza.
 *
 * ── O que este módulo NÃO decide ────────────────────────────────────────────
 *
 * Não fala com o servidor (quem lista é a action `listarFerramentasMcpExternas`,
 * a MESMA que a tela de cadastro usa no "Testar conexão") e não grava nada
 * (quem grava é o `tool_ids` da versão, pelo salvar do editor). Aqui só se
 * responde: com esta marcação, qual é o `tool_ids` resultante.
 *
 * ── Client-safe ─────────────────────────────────────────────────────────────
 *
 * Zero import de zod, supabase, `next/headers` ou rede: só `./ids`, que também
 * é puro. É o que permite o cartão do editor (client component) chamar isto.
 */
import {
  type EscolhaRemota,
  type MarcaRemota,
  escolhasRemotas,
  lerToolIdRemoto,
  toolIdRemoto,
} from "./ids";

/**
 * A escolha que já está gravada para esta ferramenta, ou `null` se ela não está
 * marcada. É o estado inicial da caixa, lido do `tool_ids` — nunca do que o
 * servidor anunciou.
 */
export function marcaDaRemota(toolIds: readonly string[], nome: string): MarcaRemota | null {
  for (const id of toolIds) {
    const escolha = lerToolIdRemoto(id);
    if (escolha && escolha.nome === nome) return escolha.leitura ? "leitura" : "escrita";
  }
  return null;
}

/**
 * Marca a ferramenta com a marca dada — marcando pela primeira vez ou TROCANDO
 * a marca de uma já marcada.
 *
 * Trocar é remover-e-inserir no MESMO nome, e não acrescentar: duas entradas
 * com o mesmo nome seriam duas verdades sobre a mesma tool no turno (a primeira
 * vence, em `escolhasRemotas`), e o administrador veria o clique sem efeito.
 *
 * O resto do `tool_ids` — inclusive capacidades compiladas — sai intacto e na
 * mesma ordem: a lista é snapshot da versão e vira diff, então reordenar a cada
 * clique é diff ilegível.
 */
export function marcarRemota(
  toolIds: readonly string[],
  nome: string,
  marca: MarcaRemota,
): string[] {
  return [...desmarcarRemota(toolIds, nome), toolIdRemoto(nome, marca)];
}

/**
 * Desmarca UMA ferramenta remota — e só ela.
 *
 * Id com prefixo mas forma inválida não é escolha (ver `lerToolIdRemoto`) e por
 * isso não é tocado: quem recusa id malformado é a validação, não uma remoção
 * silenciosa no meio de um clique.
 */
export function desmarcarRemota(toolIds: readonly string[], nome: string): string[] {
  return toolIds.filter((id) => {
    const escolha = lerToolIdRemoto(id);
    return escolha === null || escolha.nome !== nome;
  });
}

/**
 * As escolhas SALVAS que o servidor não anuncia mais.
 *
 * Só faz sentido perguntar isto depois de uma listagem que deu certo: com o
 * servidor fora do ar a lista é vazia e chamar toda escolha de órfã apagaria o
 * trabalho do administrador por causa de um terceiro desligado. Quem chama
 * (o cartão do editor) só pergunta quando a descoberta respondeu.
 */
export function remotasOrfas(
  toolIds: readonly string[],
  anunciadas: readonly string[],
): EscolhaRemota[] {
  const nomes = new Set(anunciadas);
  return escolhasRemotas(toolIds).filter((escolha) => !nomes.has(escolha.nome));
}

/** Remove as órfãs — as demais escolhas e o catálogo compilado ficam. */
export function removerRemotasOrfas(
  toolIds: readonly string[],
  anunciadas: readonly string[],
): string[] {
  const nomes = new Set(anunciadas);
  return toolIds.filter((id) => {
    const escolha = lerToolIdRemoto(id);
    return escolha === null || nomes.has(escolha.nome);
  });
}
