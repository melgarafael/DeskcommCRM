/**
 * INSTALAR UM FLUXO DE FOLLOW-UP A PARTIR DE UM MODELO — a regra, fora da rota.
 *
 * ─── Por que este módulo existe ──────────────────────────────────────────────
 *
 * Esta regra nasceu inteira dentro de
 * `app/api/v1/ai/followup-flows/from-model/route.ts`. O servidor MCP instala
 * fluxo pelo assistente e só tinha dois caminhos ruins: chamar a própria API por
 * HTTP, ou copiar a regra — e a cópia envelhece calada. Aqui ela mora uma vez,
 * do mesmo jeito que `listaTiposDeAtendimento` (`lib/agenda/consulta.ts`) já faz
 * no `GET` de `agenda/tipos`. Ver a issue #4688.
 *
 * ─── O QUE NÃO MUDA (e é o contrato) ─────────────────────────────────────────
 *
 * O que a instalação grava, de uma vez: o ponteiro com o nome do modelo, o
 * `draft_graph` inteiro (textos e prazos), o `trigger_config` já armado e a
 * política de handoff. O que ela NÃO faz, e as duas omissões são deliberadas:
 *
 *   • **não publica.** Texto que vai para paciente é lido por uma pessoa antes
 *     de sair. O fluxo nasce `draft`, e publicar continua sendo o botão do
 *     construtor — que roda o mesmo `validateFlowForPublish` de sempre.
 *   • **não mexe em agente nenhum.** Gatilho automático só enrolla se um agente
 *     PUBLICADO tem o ponteiro em `followup.flow_pointer_ids`
 *     (`agent-followup-gate.ts`). Ligar isso sozinha seria mudar o
 *     comportamento de um agente que já atende, sem ninguém pedir.
 *
 * ⚠️ O GRAFO É VALIDADO AQUI, ANTES DO INSERT. `draft_graph` é `jsonb` sem
 * CHECK: um modelo quebrado entraria no banco em silêncio e só apareceria
 * quando o dono da clínica abrisse o construtor. O catálogo é código nosso, e
 * por isso a falha é 500 `modelo_invalido` — defeito do produto, não do pedido.
 *
 * ─── A borda fica na rota ────────────────────────────────────────────────────
 *
 * `requireSupportWrite`, `resolveAuthDual`, `tetoDeEscritaDoToken`, a leitura do
 * JSON, o Zod e a montagem de `ok()`/`fail()` com o `requestId`. Esta função
 * recebe a entrada JÁ validada e não vê `NextRequest` nem devolve `Response`.
 *
 * `ator.t` é o tradutor da borda (o mesmo `traduzir(texto, authz.idioma)`).
 * Entra como dependência porque as mensagens daqui são literais de dicionário e
 * o idioma é resolvido na rota; sem ele o padrão é identidade — pt-BR, que é o
 * texto escrito abaixo.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Actor } from "@/lib/api/handlers/types";
import { audit } from "@/lib/audit";
import type { instalarModeloSchema } from "@/lib/followup/api-schemas";
import { triggerConfigSchema } from "@/lib/followup/api-schemas";
import { flowGraphSchema } from "@/lib/followup/graph-schema";
import { validateFlowForPublish } from "@/lib/followup/validate-publish";
import { modeloPorId } from "@/lib/followup/modelos";
import type { z } from "zod";

/** A linha criada em `followup_flow_pointers` — a rota responde 201 com ela. */
export type FollowupFlowPointerRow = Record<string, unknown> & { id: string };

export type AtorDaInstalacao = {
  organizationId: string;
  actor: Actor;
  apiTokenId: string | null;
  /** O mesmo id que vai na resposta — a trilha fica correlacionada com ela. */
  requestId?: string;
  /** O tradutor da borda. Ausente = identidade (pt-BR). */
  t?: (texto: string) => string;
};

export type RecusaDaInstalacao = {
  ok: false;
  code:
    | "not_found"
    | "trigger_stage_missing"
    | "trigger_stage_not_found"
    | "trigger_stage_archived"
    | "conflict"
    | "internal_error";
  status: 404 | 409 | 422 | 500;
  message: string;
};

export async function instalarFluxoDoModelo(
  db: SupabaseClient,
  ator: AtorDaInstalacao,
  entrada: z.infer<typeof instalarModeloSchema>,
): Promise<{ ok: true; data: FollowupFlowPointerRow } | RecusaDaInstalacao> {
  const t = ator.t ?? ((texto: string) => texto);
  const { organizationId, actor, apiTokenId, requestId } = ator;

  const modelo = modeloPorId(entrada.model_id);
  if (!modelo) {
    return { ok: false, code: "not_found", status: 404, message: t("Este modelo não existe mais.") };
  }

  // A etapa é conferida AQUI, com alguém na tela — e não só no publish. Etapa de
  // outra organização, apagada ou arquivada deixa o fluxo `active` sem nunca
  // enrollar ninguém: fluxo morto com cara de vivo.
  if (modelo.pedeEtapa) {
    if (!entrada.stage_id) {
      return {
        ok: false,
        code: "trigger_stage_missing",
        status: 422,
        message: t("Escolha a etapa do funil que dispara este fluxo."),
      };
    }
    const { data: etapa, error: etapaErr } = await db
      .from("crm_stages")
      .select("id, name, is_archived")
      .eq("id", entrada.stage_id)
      .eq("organization_id", organizationId)
      .maybeSingle();
    // Sem `t()`: é a mensagem crua do banco, como hoje.
    if (etapaErr) {
      return { ok: false, code: "internal_error", status: 500, message: etapaErr.message };
    }
    if (!etapa) {
      return {
        ok: false,
        code: "trigger_stage_not_found",
        status: 422,
        message: t("A etapa escolhida não existe neste funil — escolha outra."),
      };
    }
    if (etapa.is_archived) {
      // Interpolada, e nunca passou pelo dicionário. Fica como está.
      return {
        ok: false,
        code: "trigger_stage_archived",
        status: 422,
        message: `A etapa «${etapa.name}» está arquivada e nunca receberia um negócio — escolha uma etapa ativa.`,
      };
    }
  }

  const gatilho = triggerConfigSchema.safeParse(modelo.gatilho({ stageId: entrada.stage_id }));
  const grafo = flowGraphSchema.safeParse(modelo.grafo);
  // Sem contexto de conexão: o modelo do catálogo tem de ser publicável em
  // QUALQUER organização, inclusive a que tem canal com janela de 24 h.
  const publicavel = grafo.success ? validateFlowForPublish(grafo.data) : null;
  if (!gatilho.success || !grafo.success || (publicavel && !publicavel.ok)) {
    return {
      ok: false,
      code: "internal_error",
      status: 500,
      message: `modelo_invalido: ${modelo.id}`,
    };
  }

  const nome = entrada.name ?? modelo.nome;
  const { data: criado, error: insErr } = await db
    .from("followup_flow_pointers")
    .insert({
      organization_id: organizationId,
      name: nome,
      draft_graph: grafo.data,
      trigger_config: gatilho.data,
      handoff_policy: modelo.handoffPolicy,
    })
    .select("*")
    .single();

  if (insErr || !criado) {
    // Instalar duas vezes é engano comum (a pessoa não vê o fluxo na lista e
    // clica de novo). O 409 nomeia o fluxo que JÁ existe em vez de criar um
    // segundo com o mesmo desenho disputando o mesmo paciente — só uma
    // inscrição por contato vive por vez (`idx_followup_enrollments_one_live`).
    if (insErr?.code === "23505") {
      return {
        ok: false,
        code: "conflict",
        status: 409,
        message: `Você já tem um fluxo chamado «${nome}». Abra esse ou instale com outro nome.`,
      };
    }
    return {
      ok: false,
      code: "internal_error",
      status: 500,
      message: insErr?.message ?? "followup_flow_insert_failed",
    };
  }

  void audit({
    action: "followup_flow.created",
    actorUserId: actor.type === "user" ? actor.id : null,
    actorApiTokenId: apiTokenId ?? null,
    organizationId,
    resourceType: "followup_flow_pointer",
    resourceId: criado.id,
    requestId,
    metadata: { name: nome, model_id: modelo.id, trigger_kind: gatilho.data.kind },
  });

  return { ok: true, data: criado as FollowupFlowPointerRow };
}
