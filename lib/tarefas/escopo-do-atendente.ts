/**
 * "ATENDENTE VÊ SÓ AS PRÓPRIAS TAREFAS (E AS SEM RESPONSÁVEL)" — a opção por
 * ORGANIZAÇÃO da #4737, parte 2.
 *
 * ─── O que ela muda, e onde ────────────────────────────────────────────────
 *
 * LIGADA: quem tem papel `agent` lista e abre apenas as tarefas atribuídas a si,
 * as que ELE criou e as SEM responsável (a fila que ninguém pegou ainda —
 * esconder dela deixaria trabalho sem dono invisível para quem poderia pegar).
 *
 * DESLIGADA (o padrão de toda organização, e de quem atualiza o produto): esta
 * opção não recorta nada — a rota não acrescenta filtro de responsável nem
 * recusa. O que o atendente vê, então, é o que o BANCO já entrega: a policy
 * `crm_tasks_select` do `supabase/baseline.sql` (ver o par, abaixo) e a opção
 * "Atendentes podem mexer na agenda dos colegas", que quando ligada abre a
 * equipe inteira. ⚠️ "Desligada" NÃO significa "vê a equipe inteira": com
 * `settings.visibility_mode` em `own_and_unassigned` (o padrão) ou `own`, a RLS
 * já recorta, mesmo com esta chave desligada. Foi o que o fragmento de release
 * afirmava errado antes do #4800.
 *
 * ─── O PAR da RLS, e não metade dele ──────────────────────────────────────
 *
 * `crm_tasks_select` não decide por `assigned_to` sozinho: ela chama
 * `fn_can_view_task(organization_id, assigned_to, created_by)`, e a função
 * libera a linha quando `p_assigned_to = auth.uid()` OU quando
 * `p_created_by = auth.uid()`. `crm_tasks_write` usa a MESMA função no `using`
 * e no `with check`.
 *
 * Este arquivo olhava só o responsável — metade do par. Resultado medido no
 * #4800: a tarefa que o atendente CRIOU e entregou a um colega, que a RLS deixa
 * ver e editar, recebia `403 forbidden_scope` na rota. Duas regras discordando
 * sobre a mesma linha é o pior tipo de defeito de permissão: uma delas está
 * mentindo, e quem lê o 403 não sabe qual.
 *
 * Agora o recorte é o MESMO par: dono atribuído OU criador. O `created_by` vem
 * da pré-leitura que a rota já fazia (nenhuma consulta nova), e o criador
 * continua alcançando o que escreveu depois de entregar — contrato que o
 * próprio baseline documenta: "com o criador enxergando o que criou, o agent
 * continua podendo ENTREGAR trabalho a um colega".
 *
 * ⚠️ A RESTRIÇÃO VALE NA ROTA, não na tela. Esconder o seletor não é
 * restrição: qualquer pessoa com o token da sessão chama
 * `GET /api/v1/tasks` direto, e `app/api/v1/tasks/route.ts` é quem aplica o
 * `or(assigned_to = eu, assigned_to is null, created_by = eu)`. A tela lê a
 * MESMA função para não oferecer um filtro que a rota recusaria
 * (`app/app/tasks/page.tsx`).
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
 * "De outra pessoa" = NÃO é a minha por nenhum dos dois lados do par que a
 * policy usa: nem `assigned_to` (o dono atribuído), nem `created_by` (quem
 * escreveu). É o MESMO par de `fn_can_view_task(organization_id, assigned_to,
 * created_by)` — olhar só o responsável era metade da regra, e fazia a rota
 * recusar (403) a tarefa que o banco deixa ver e editar: a que o atendente
 * criou e entregou a um colega.
 *
 * `assignedTo` nulo NÃO é "de outro": é a fila sem dono, que o atendente
 * restrito continua vendo e podendo assumir. Tratar `null` como alheio
 * esvaziaria a tela dele justamente nas tarefas que ninguém pegou.
 */
export function tarefaForaDoEscopo(entrada: {
  restrito: boolean;
  usuarioId: string;
  assignedTo: string | null | undefined;
  /** `crm_tasks.created_by` — o outro lado do par da policy. */
  createdBy?: string | null;
}): boolean {
  if (!entrada.restrito) return false;
  // O criador alcança o que escreveu, mesmo depois de entregar a um colega —
  // é o contrato declarado no baseline ("o agent continua podendo ENTREGAR
  // trabalho a um colega") e o que `p_created_by = auth.uid()` libera.
  if (entrada.createdBy && entrada.createdBy === entrada.usuarioId) return false;
  if (!entrada.assignedTo) return false;
  return entrada.assignedTo !== entrada.usuarioId;
}
