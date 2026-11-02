/**
 * OUVIDORIA — A LISTA DA TELA DE GESTÃO (#3611, fatia 3).
 *
 * ─── O que esta camada é ───────────────────────────────────────────────────
 *
 * A leitura de MUITAS manifestações da organização ativa: protocolo, data,
 * status e canal, com filtro por status e uma página por vez. O texto do relato
 * NÃO sai daqui — a lista é a tela onde se escolhe o que abrir, e o relato
 * sigiloso só aparece no DETALHE (`lib/ouvidoria/leitura.ts`, a mesma leitura
 * da fatia 1). Uma lista que carrega 25 relatos para mostrar 25 protocolos
 * aumenta a superfície de um dado que a issue chama de confidencial sem
 * entregar nada a quem olha.
 *
 * ─── As duas cercas, na mesma ordem da fatia 1 ─────────────────────────────
 *
 * 1. AQUI: `organization_id` entra no predicado de TODA leitura. Num cliente de
 *    sessão a RLS separa, mas ela é a SEGUNDA cerca — e num teste de unidade
 *    ela nem existe. É este `.eq("organization_id", …)` que o caso de tenant
 *    mede; apagá-lo faz a manifestação do vizinho aparecer na lista, e o
 *    sintoma na tela seria "mais uma linha", não um erro.
 * 2. A RLS da 9030 (`fn_user_org_ids()` E `fn_role_at_least(…, 'admin')`).
 *
 * ─── Por que a régua de página vem do catálogo ─────────────────────────────
 *
 * `paginaDaUrl` e `intervaloDaPagina` já existem em
 * `lib/catalogo/busca-da-tela.ts`, com o tratamento dos casos que doem: `0`,
 * `-3`, `2x` e `abc` na URL viram página 1, e o `range` sai sempre inclusivo.
 * Escrever a segunda cópia aqui é como a paginação deste repo já quebrou antes
 * (limite negativo virando "sem limite"): uma régua, um lugar.
 *
 * ⚠️ O tamanho da página NÃO vem da URL. É `MANIFESTACOES_POR_PAGINA`, ponto. Um
 * `?limit=` público é o vetor clássico de "me manda o acervo inteiro", e a tela
 * não tem por que oferecer isso a ninguém.
 *
 * ─── O filtro por status é validado, não confiado ───────────────────────────
 *
 * `?status=` chega como texto de qualquer pessoa. Um valor fora dos três do
 * CHECK (`recebida`, `em_analise`, `concluida`) é tratado como AUSENTE — a
 * lista mostra todas —, e não como erro nem como página vazia: um link antigo
 * com `?status=aberta` não pode dizer a quem administra que a empresa não tem
 * manifestação nenhuma. É a mesma decisão de `paginaDaUrl` para página
 * inválida.
 *
 * ─── Página além da última ─────────────────────────────────────────────────
 *
 * O PostgREST responde 416 `PGRST103` quando o `range` começa depois do total
 * (o comentário inteiro está em `lib/catalogo/busca-da-tela.ts`). Aqui isso é
 * uma lista vazia, não um erro: acontece ao apagar a última manifestação da
 * última página ou ao abrir um link antigo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { FAIXA_ALEM_DO_FIM, intervaloDaPagina, paginaDaUrl } from "@/lib/catalogo/busca-da-tela";
import { logger } from "@/lib/logger";

import { STATUS_DA_OUVIDORIA, type CanalDaOuvidoria, type StatusDaOuvidoria } from "./registro";

/** Manifestações por página. Constante do servidor, nunca da URL (ver cabeçalho). */
export const MANIFESTACOES_POR_PAGINA = 25;

/** Uma linha da lista. Sem `texto`: o relato é do detalhe. */
export interface ManifestacaoNaLista {
  id: string;
  protocolo: string;
  canal: CanalDaOuvidoria;
  status: StatusDaOuvidoria;
  createdAt: string;
}

export interface PaginaDaLista {
  manifestacoes: ManifestacaoNaLista[];
  /** A página que foi lida (1 quando a URL não pedia nenhuma). */
  pagina: number;
  porPagina: number;
  /** Total de manifestações que casam com o filtro — não o tamanho da página. */
  total: number;
  temMais: boolean;
}

export type ResultadoDaLista =
  | { ok: true; pagina: PaginaDaLista }
  | { ok: false; erro: "erro_ao_ler" };

export interface DepsDaLista {
  supabase: SupabaseClient;
  /** A organização ATIVA da sessão — nunca de argumento do pedido. */
  organizationId: string;
}

/** O pedido como ele chega da URL: texto solto, sem tipo. */
export interface PedidoDaLista {
  status?: string | null;
  pagina?: string | null;
}

const COLUNAS = "id, protocolo, canal, status, created_at";

function objeto(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * O status pedido, ou `null` para "todos". Valor desconhecido NÃO é erro: cai em
 * "todos" (ver cabeçalho). `null` aqui nunca significa "nenhum status".
 */
export function statusPedido(bruto: unknown): StatusDaOuvidoria | null {
  if (typeof bruto !== "string") return null;
  const limpo = bruto.trim();
  return (STATUS_DA_OUVIDORIA as readonly string[]).includes(limpo)
    ? (limpo as StatusDaOuvidoria)
    : null;
}

/** Uma página da lista da organização. Nunca lança. */
export async function listarManifestacoes(
  deps: DepsDaLista,
  pedido: PedidoDaLista = {},
): Promise<ResultadoDaLista> {
  const pagina = paginaDaUrl(pedido.pagina ?? null);
  const status = statusPedido(pedido.status);
  const [de, ate] = intervaloDaPagina(pagina, MANIFESTACOES_POR_PAGINA);

  let consulta = deps.supabase
    .from("ouvidoria_manifestacoes")
    .select(COLUNAS, { count: "exact" })
    // A cerca de tenant: sem esta linha a lista mostra o acervo do vizinho, e
    // não há sintoma na tela (ver cabeçalho e o caso de tenant do teste).
    .eq("organization_id", deps.organizationId);

  if (status) consulta = consulta.eq("status", status);

  const { data, error, count } = await consulta
    // Mais recentes primeiro — é a pergunta da tela. O desempate por `id` existe
    // para a página ser determinística quando duas manifestações entram no
    // mesmo instante (o `created_at` empata, e sem desempate a linha pode
    // aparecer em duas páginas ou em nenhuma).
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(de, ate);

  if (error) {
    // Página além da última: lista vazia, não erro (ver cabeçalho).
    if (error.code === FAIXA_ALEM_DO_FIM) {
      return {
        ok: true,
        pagina: {
          manifestacoes: [],
          pagina,
          porPagina: MANIFESTACOES_POR_PAGINA,
          total: 0,
          temMais: false,
        },
      };
    }
    logger.warn("[ouvidoria] a listagem da tela falhou", {
      organization_id: deps.organizationId,
      error: error.message,
    });
    return { ok: false, erro: "erro_ao_ler" };
  }

  const linhas = Array.isArray(data) ? data : [];
  const manifestacoes = linhas
    .map(objeto)
    .filter((l): l is Record<string, unknown> => l !== null)
    .map<ManifestacaoNaLista>((l) => ({
      id: String(l.id),
      protocolo: String(l.protocolo),
      canal: l.canal as CanalDaOuvidoria,
      status: l.status as StatusDaOuvidoria,
      createdAt: String(l.created_at),
    }));

  const total = typeof count === "number" ? count : manifestacoes.length;

  return {
    ok: true,
    pagina: {
      manifestacoes,
      pagina,
      porPagina: MANIFESTACOES_POR_PAGINA,
      total,
      temMais: pagina * MANIFESTACOES_POR_PAGINA < total,
    },
  };
}
