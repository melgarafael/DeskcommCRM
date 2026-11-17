import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { metadadosDaSessao, requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { atendenteRestrito, lerEscopoDoAtendente } from "@/lib/tarefas/escopo-do-atendente";
import { filtroInicialDaTela } from "@/lib/tarefas/preferencia-do-filtro";

import { TarefasClient } from "./_components/TarefasClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Tarefas" };

/**
 * TAREFAS — "ligar de volta na terça", num lugar que não é a memória de ninguém.
 *
 * Extraído do PR #418, de @clinicacentrodosorrisosc-code, que construiu o
 * módulo inteiro rodando o produto numa operação real. O que muda aqui é o
 * vocabulário: a tela dele somava tarefas com "agendamentos" derivados de
 * `custom_fields.agendamento_*` do lead, e falava consulta/procedimento/
 * compareceu. Compromisso com cliente já é a Agenda (migration 0177), que tem
 * tabela, horário, local e confirmação — e este produto atende clínica,
 * imobiliária, loja e infoproduto com as mesmas telas.
 *
 * ─── Quem pode o quê ───────────────────────────────────────────────────────
 *
 * `viewer` VÊ as tarefas: saber o que o time combinou é informação de operação.
 * Criar e editar é `agent` — e a rota cobra de novo (`requireRole("agent")`).
 * A tela esconder o botão é cortesia, não autorização.
 *
 * ─── O FILTRO COM QUE A TELA ABRE (#4737) ──────────────────────────────────
 *
 * Duas decisões, e as duas no SERVIDOR:
 *
 *  1. **O padrão do papel.** Quem tem papel de atendente abre em "Minhas": a
 *     fila dele é o que ele veio ver, e "Todos" numa operação com dez pessoas
 *     é a lista do colega misturada com a sua.
 *  2. **A escolha lembrada.** O último filtro que a pessoa escolheu volta no
 *     próximo carregamento, lido do `raw_user_meta_data` pelo MESMO mecanismo
 *     da Agenda (`lib/tarefas/preferencia-do-filtro.ts`). `?assigned_to=me`
 *     continua ganhando de tudo: é o endereço que o lembrete abre.
 *
 * A opção da organização "Atendente vê só as próprias tarefas" também é lida
 * aqui — mas só para a tela não oferecer um filtro que a API recusaria. QUEM
 * RESTRINGE É A ROTA (`app/api/v1/tasks/route.ts`): esconder o seletor não é
 * restrição, e o token da sessão não passa por esta página.
 */
export default async function TarefasPage({
  searchParams,
}: {
  searchParams: Promise<{ assigned_to?: string }>;
}) {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const podeEditar = (user.is_platform_admin && !user.support) || ROLE_RANK[activeOrg.role] >= ROLE_RANK.agent;

  // `?assigned_to=me` é o endereço que o lembrete e o push de tarefa abrem.
  const { assigned_to } = await searchParams;

  // Os funis vivos da organização ativa, para o seletor. Lido aqui e não por `GET /api/v1/pipelines`
  // (que exige manager): a tela de Tarefas abre para qualquer papel. `organization_id` à mão porque
  // a RLS libera todas as organizações do usuário.
  const supabase = await createClient();
  const { data: funis } = await supabase
    .from("crm_pipelines")
    .select("id, name")
    .eq("organization_id", activeOrg.orgId)
    .eq("is_archived", false)
    .order("position");

  // A opção da ORGANIZAÇÃO, lida pela MESMA régua que a rota aplica
  // (`lerEscopoDoAtendente` + `atendenteRestrito`): a tela não pode oferecer
  // "Todos" a quem a API responderia com a lista recortada.
  const { data: organizacao } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .limit(1);
  const escopoProprio = atendenteRestrito({
    papel: activeOrg.role,
    isPlatformAdmin: user.is_platform_admin,
    escopoLigado: lerEscopoDoAtendente(
      (organizacao?.[0] as { settings?: unknown } | undefined)?.settings,
    ),
  });

  // O padrão do papel: atendente abre em "Minhas"; o resto continua em "Todos".
  const filtroInicial = filtroInicialDaTela(await metadadosDaSessao(), {
    padrao: activeOrg.role === "agent" ? "eu" : "todos",
    restritoAoProprio: escopoProprio,
    pedidoNoEndereco: assigned_to ?? null,
  });

  return (
    <TarefasClient
      podeEditar={podeEditar}
      filtroInicial={filtroInicial}
      escopoProprio={escopoProprio}
      funis={(funis ?? []) as Array<{ id: string; name: string }>}
      setoresLigados={await moduloLigado(createAdminClient(), "setores")}
    />
  );
}
