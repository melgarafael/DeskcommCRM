/**
 * O QUE A TELA DA MEMÓRIA PODE AFIRMAR — E O QUE ELA NÃO PODE (#4171).
 *
 * ─── O defeito medido ───────────────────────────────────────────────────────
 *
 * `page.tsx` lia quatro coisas com o cliente do usuário (RLS) e ignorava o
 * `error` de todas. Falha de leitura (policy, coluna ausente, timeout) virava
 * `null`/`[]`, e a mesma tela dizia "Nenhuma versão publicada ainda" e "Nenhum
 * aprendizado ainda" — duas afirmações fortes sobre o trabalho de quem
 * instalou, feitas sem ter conseguido perguntar. A memória continuava lá: os
 * agentes leem por outro caminho (o pool do servidor) e seguiam usando.
 *
 * ─── Por que a decisão é uma função pura, e não um trio de `if` no JSX ──────
 *
 * São três estados por campo (tem conteúdo, leu e está vazio, NÃO leu) e a
 * ordem entre eles é a regra toda: a falha VENCE o vazio, e o conteúdo vence
 * os dois. Espalhado no JSX, esse trio é reescrito a cada card e erra em
 * silêncio — foi assim que o defeito passou. Aqui ele é medido uma vez e o
 * teste cobra o vazio honesto de volta (a correção não pode inventar erro em
 * toda tela).
 */
export const CAMPOS_DA_MEMORIA = ["documento", "historico", "aprendizados"] as const;

export type CampoDaMemoria = (typeof CAMPOS_DA_MEMORIA)[number];

/** Os campos que esta renderização NÃO conseguiu ler. Vazio = leu tudo. */
export type CamposNaoLidos = readonly CampoDaMemoria[];

export function naoFoiLido(campos: CamposNaoLidos | undefined, campo: CampoDaMemoria): boolean {
  return campos !== undefined && campos.includes(campo);
}

/**
 * `ativo`  — há versão publicada, e ela foi lida;
 * `vazio`  — a leitura funcionou e não há versão: aí sim pode dizer "nenhuma";
 * `nao_lido` — não deu para perguntar: a tela diz isso, e só isso.
 */
export type EstadoDoDocumento = "ativo" | "vazio" | "nao_lido";

export function estadoDoDocumento(entrada: {
  temDocumento: boolean;
  camposNaoLidos?: CamposNaoLidos;
}): EstadoDoDocumento {
  if (entrada.temDocumento) return "ativo";
  return naoFoiLido(entrada.camposNaoLidos, "documento") ? "nao_lido" : "vazio";
}

/** `lista` | `vazio` | `nao_lido`, pela mesma ordem: falha vence o vazio. */
export type EstadoDosAprendizados = "lista" | "vazio" | "nao_lido";

export function estadoDosAprendizados(entrada: {
  quantidadeVisivel: number;
  camposNaoLidos?: CamposNaoLidos;
}): EstadoDosAprendizados {
  if (entrada.quantidadeVisivel > 0) return "lista";
  return naoFoiLido(entrada.camposNaoLidos, "aprendizados") ? "nao_lido" : "vazio";
}

/**
 * O histórico é o único que não tem estado vazio próprio: quando não há versão
 * nenhuma, a lista simplesmente não aparece. O que ele NÃO pode é sumir por
 * falha de leitura sem avisar — daí o terceiro estado.
 */
export type EstadoDoHistorico = "lista" | "ausente" | "nao_lido";

export function estadoDoHistorico(entrada: {
  quantidade: number;
  camposNaoLidos?: CamposNaoLidos;
}): EstadoDoHistorico {
  if (entrada.quantidade > 0) return "lista";
  return naoFoiLido(entrada.camposNaoLidos, "historico") ? "nao_lido" : "ausente";
}
