/**
 * "ATENDENTE VÊ SÓ AS PRÓPRIAS TAREFAS (E AS SEM RESPONSÁVEL)" — a opção por
 * ORGANIZAÇÃO da #4737, parte 2.
 *
 * ─── O que ela muda, e onde ────────────────────────────────────────────────
 *
 * LIGADA: quem tem papel `agent` lista e abre apenas as tarefas atribuídas a si
 * e as SEM responsável (a fila que ninguém pegou ainda — esconder dela deixaria
 * trabalho sem dono invisível para quem poderia pegar).
 *
 * DESLIGADA (o padrão de toda organização, e de quem atualiza o produto): tudo
 * como hoje — o atendente vê a organização inteira, e o filtro da tela é só
 * conveniência.
 *
 * ⚠️ A RESTRIÇÃO VALE NA ROTA, não na tela. Esconder o seletor não é
 * restrição: qualquer pessoa com o token da sessão chama
 * `GET /api/v1/tasks` direto, e `app/api/v1/tasks/route.ts` é quem aplica o
 * `or(assigned_to = eu, assigned_to is null)`. A tela lê a MESMA função para
 * não oferecer um filtro que a rota recusaria (`app/app/tasks/page.tsx`).
 *
 * ─── Quem NÃO é afetado ────────────────────────────────────────────────────
 *
 * `manager` e `admin` continuam vendo tudo: a opção é sobre a fila de quem
 * atende, e quem responde pela operação precisa enxergá-la inteira para
 * distribuir. `viewer` e `ai_operator` também ficam como estão — `viewer` já é
 * somente leitura e `ai_operator` não é gente na fila. `is_platform_admin`
 * nunca é restringido: é o suporte da instalação, e a restrição o deixaria sem
 * conseguir diagnosticar a tarefa que o cliente relatou.
 *
 * A chave mora em `organizations.settings.tarefas.atendente_ve_so_as_proprias`,
 * ao lado do resto da configuração da empresa no mesmo jsonb — sem migration,
 * como as outras opções por organização (`settings.crm.*`, `settings.satisfacao`).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

/** Onde a opção mora em `organizations.settings`. */
export const BLOCO_DAS_TAREFAS = "tarefas";

/** A chave, por extenso, para quem procura no jsonb. */
export const CHAVE_DO_ESCOPO_DO_ATENDENTE = "atendente_ve_so_as_proprias";

/**
 * A opção da organização, lida com tolerância total.
 *
 * Ausente, `null`, `{}` ou qualquer coisa que não seja `true` devolve `false`:
 * quem nunca ligou continua com o comportamento de antes, e um jsonb torto não
 * derruba a lista de tarefas de ninguém.
 */
export function lerEscopoDoAtendente(settings: unknown): boolean {
  if (typeof settings !== "object" || settings === null || Array.isArray(settings)) return false;
  const bloco = (settings as Record<string, unknown>)[BLOCO_DAS_TAREFAS];
  if (typeof bloco !== "object" || bloco === null || Array.isArray(bloco)) return false;
  return (bloco as Record<string, unknown>)[CHAVE_DO_ESCOPO_DO_ATENDENTE] === true;
}

/**
 * A opção da organização, lida do BANCO — o único jeito honesto de decidir
 * restrição numa rota.
 *
 * O `jsonb` é tolerante por construção (`lerEscopoDoAtendente`): organização
 * que nunca ligou, ou com `settings` torto, continua com o comportamento de
 * antes. A leitura é do banco da SESSÃO (`authz.supabase`); no ramo do token a
 * chamada nem acontece, porque o escopo não se aplica a quem não é gente.
 */
async function escopoDoAtendenteLigado(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  // `.select("settings")` sem `single`: a resposta é um array de uma linha, e o
  // array não transforma "organização sumiu" em erro que derrubaria a lista.
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", organizationId);
  return lerEscopoDoAtendente((data?.[0] as { settings?: unknown } | undefined)?.settings);
}

/**
 * A régua COMPLETA, para as rotas: `atendenteRestrito` + a leitura da opção.
 *
 * É a MESMA função nas duas portas (lista e tarefa única), para a tela e a API
 * não divergirem sobre quem está restrito.
 *
 * ─── Por que a leitura do `settings` é CONDICIONAL ─────────────────────────
 *
 * `atendenteRestrito` já responde `false` para quem não é `agent` e para quem
 * administra a empresa. Ler o `jsonb` antes disso seria uma consulta por
 * requisição cujo resultado ninguém usaria — e ainda mudaria a ORDEM das
 * consultas da lista (a leitura da organização viria antes da consulta das
 * tarefas). A guarda fica aqui, junto da regra, e não repetida em cada rota.
 */
export async function atendenteRestritoNaOrganizacao(
  supabase: SupabaseClient,
  entrada: {
    organizationId: string;
    /** `authz.role` — o papel EFETIVO que o `resolveAuthDual` já resolveu. */
    papel: string | null | undefined;
    /** `authz.administraEmpresa` — o atalho `podeAdministrarEmpresa`. */
    administraEmpresa: boolean | undefined;
    /** `authz.via`: token não é gente na fila e nunca é restringido. */
    via: "session" | "token";
  },
): Promise<boolean> {
  if (entrada.via === "token") return false;
  if (entrada.papel !== "agent" || entrada.administraEmpresa) return false;
  return atendenteRestrito({
    papel: entrada.papel,
    administraEmpresa: entrada.administraEmpresa,
    escopoLigado: await escopoDoAtendenteLigado(supabase, entrada.organizationId),
  });
}

/**
 * Esta PESSOA está restrita às próprias tarefas?
 *
 * Três condições, e todas precisam valer: a opção da organização ligada, o
 * papel EXATO de atendente (`agent` — `manager` e `admin` ficam de fora, e
 * `viewer`/`ai_operator` não são a fila de atendimento) e não ser platform
 * admin.
 *
 * O papel exato, e não `rank >= agent`: a issue pede "atendente", e um
 * `manager` restrito não conseguiria distribuir as tarefas da equipe — que é
 * justamente o trabalho dele.
 */
export function atendenteRestrito(entrada: {
  papel: string | null | undefined;
  /**
   * `podeAdministrarEmpresa(user, org)` — o MESMO atalho das server actions,
   * nunca uma leitura da flag crua. Ele já cobra o scope `full` do platform
   * admin (`escreveComoPlatformAdmin`) e barra a sessão de suporte; ler
   * `.is_platform_admin` na rota seria o atalho que a cerca
   * `tests/unit/admin-escrita-exige-scope-full.test.ts` (regra A) recusa.
   */
  administraEmpresa?: boolean;
  escopoLigado: boolean;
}): boolean {
  if (!entrada.escopoLigado) return false;
  if (entrada.administraEmpresa) return false;
  return entrada.papel === "agent";
}

/**
 * A tarefa é de OUTRA pessoa, na régua da restrição?
 *
 * `assignedTo` nulo NÃO é "de outro": é a fila sem dono, que o atendente
 * restrito continua vendo e podendo assumir. Tratar `null` como alheio
 * esvaziaria a tela dele justamente nas tarefas que ninguém pegou.
 */
export function tarefaForaDoEscopo(entrada: {
  restrito: boolean;
  usuarioId: string;
  assignedTo: string | null | undefined;
}): boolean {
  if (!entrada.restrito) return false;
  if (!entrada.assignedTo) return false;
  return entrada.assignedTo !== entrada.usuarioId;
}
