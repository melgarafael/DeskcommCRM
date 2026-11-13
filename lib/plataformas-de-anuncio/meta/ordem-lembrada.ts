/**
 * A ORDEM QUE A TABELA DE CAMPANHAS LEMBRA — por navegador (#4480, item 4 da #3911).
 *
 * O critério morava num `useState` que nascia em `ORDEM_PADRAO`: trocar de aba,
 * recarregar ou desmontar a tabela devolvia "Mais recentes" a quem prefere
 * "Ativas primeiro". É preferência de LEITURA, não dado do sistema — e o
 * precedente da casa para isso é `localStorage`, como o grupo fechado do menu
 * lateral (`components/shell/Sidebar.tsx`) e os filtros do Inbox
 * (`lib/inbox/filtros-lembrados.ts`). Nada de coluna de preferência: a issue
 * deixou o servidor explicitamente fora de escopo.
 *
 * A leitura NUNCA confia no valor gravado: storage é território de outra versão
 * do produto (ou de quem abriu o DevTools), então valor desconhecido, JSON
 * quebrado e storage bloqueado caem todos na ordem padrão.
 */
import { ORDEM_PADRAO, type CriterioDeOrdenacao } from "./tabela-de-campanhas";

export const CHAVE_DA_ORDEM = "meta-ads:ordem-das-campanhas:v1";

const CRITERIOS: readonly CriterioDeOrdenacao[] = ["mais_recentes", "mais_antigas", "status"];

type Armazenamento = Pick<Storage, "getItem" | "setItem">;

/**
 * O `window.localStorage` do navegador, ou `null` onde ele não existe.
 *
 * O getter da propriedade LANÇA (`SecurityError`) quando o navegador bloqueia
 * armazenamento — por isso a guarda é aqui, e não no chamador.
 */
export function armazenamentoLocal(): Armazenamento | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Só os três critérios que a tabela sabe ordenar; o resto vira o padrão. */
export function criterioLembrado(valor: unknown): CriterioDeOrdenacao {
  return typeof valor === "string" && (CRITERIOS as readonly string[]).includes(valor)
    ? (valor as CriterioDeOrdenacao)
    : ORDEM_PADRAO;
}

/** O critério lembrado, ou `ORDEM_PADRAO` quando não há memória legível. */
export function lerOrdemLembrada(storage: Armazenamento | null): CriterioDeOrdenacao {
  if (!storage) return ORDEM_PADRAO;
  try {
    return criterioLembrado(storage.getItem(CHAVE_DA_ORDEM));
  } catch {
    return ORDEM_PADRAO;
  }
}

/** Grava a escolha. Falha silenciosa de propósito: sem storage, vale só a sessão. */
export function gravarOrdemLembrada(
  storage: Armazenamento | null,
  criterio: CriterioDeOrdenacao,
): void {
  if (!storage) return;
  try {
    storage.setItem(CHAVE_DA_ORDEM, criterioLembrado(criterio));
  } catch {
    // Aba privada ou quota cheia: a troca continua valendo até o F5.
  }
}
