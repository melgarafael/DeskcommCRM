import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PUT /api/v1/message-templates/[id]/ordem — a REORDENAÇÃO da resposta rápida
 * (#3244): põe a resposta `id` logo DEPOIS do vizinho que a tela manda.
 *
 * ─── O corpo carrega o VIZINHO, não o número ────────────────────────────────
 *
 * `{ depois_de: <id> | null }` — `null` é a primeira posição. É o mesmo contrato
 * da reordenação de etapa do funil (`PATCH .../stages/:stageId`), e pelo mesmo
 * motivo: quem arrasta sabe em que resposta soltou, não qual fração de `ordem`
 * isso vira — mandar o número duplicaria a conta que `posicaoEntre`
 * (`lib/templates/ordem.ts`) já faz, e as duas divergiriam no primeiro ajuste.
 *
 * ─── A POSSE é a mesma régua das mídias ─────────────────────────────────────
 *
 * A lista de onde saem as vizinhas é a lista VISÍVEL (RLS `message_templates_select`
 * + `.eq("organization_id", org.orgId)`), a mesma que a `[id]/midias` percorre
 * para conferir o caminho do arquivo. Um `depois_de` de outra organização — ou
 * de outro colega, num pessoal que este papel não lê — não está nela, e a rota
 * recusa antes de tocar no banco. Sem isso, um id de fora daria à resposta uma
 * posição calculada contra vizinhas que quem pediu não enxerga.
 *
 * ─── Só a linha arrastada é escrita — e NUNCA o `updated_at` ────────────────
 *
 * A posição nova é a média entre as duas vizinhas, então nenhuma delas muda:
 * reordenar não é editar. `updated_at` fica fora do UPDATE de propósito — a
 * listagem desempata empate por ele, e carimbá-lo faria uma reordenação mexer na
 * ordem de quem divide a MESMA posição (duas respostas criadas ao mesmo tempo).
 * Título, corpo, atalho e `midias` também não são tocados: reordenar não muda
 * conteúdo.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { moverTemplateSchema } from "@/lib/schemas/templates";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { ordemDaRenumeracao, posicaoEntre } from "@/lib/templates/ordem";

export const dynamic = "force-dynamic";
const COLS =
  "id, organization_id, owner_user_id, title, body, shortcut, midias, created_by_user_id, created_at, updated_at, ordem";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Uma linha da lista, no mínimo que a conta da posição e a régua da RLS precisam. */
interface Linha {
  id: string;
  ordem: number;
  owner_user_id: string | null;
}

export async function PUT(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "message_templates" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;

  const parsed = moverTemplateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const { depois_de } = parsed.data;

  const supabase = await createClient();
  // A lista VISÍVEL da organização ativa, na ordem em que a tela a mostra: RLS
  // limita a compartilhados + próprios, e o desempate é o mesmo da listagem
  // (`updated_at desc`, depois `id`) — a rota precisa enxergar os empates do
  // jeito que a tela enxerga, senão calcula a posição entre um par que na tela
  // não é par.
  const { data: lista, error: erroLista } = await supabase
    .from("message_templates")
    .select("id, ordem, owner_user_id")
    .eq("organization_id", org.orgId)
    .order("ordem", { ascending: true })
    .order("updated_at", { ascending: false })
    .order("id", { ascending: true });
  if (erroLista) {
    logger.error("[message-templates/ordem] falha ao listar", {
      detalhe: erroLista.message,
      requestId,
    });
    return fail("internal_error", "Erro ao reordenar a resposta rápida.", 500, { requestId });
  }
  const atual = (lista ?? []) as Linha[];

  if (!atual.some((linha) => linha.id === id)) {
    return fail("not_found", t("Template não encontrado."), 404, { requestId });
  }
  // A régua de posse das mídias, aplicada ao vizinho que chega do cliente: ele
  // tem de estar na MESMA lista visível — de outra organização, ou pessoal de
  // quem este papel não lê, não está.
  if (depois_de !== null && !atual.some((linha) => linha.id === depois_de)) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: { depois_de: [t("Vizinho que não pertence a esta organização.")] },
    });
  }

  // As vizinhas são contadas SEM a linha arrastada (como no quadro): se ela
  // mesma se contasse, soltar sobre si não mudaria nada e o índice sairia
  // deslocado em um.
  const semAlvo = atual.filter((linha) => linha.id !== id);
  let anterior: number | null;
  let proxima: number | null;
  let indice: number;
  if (depois_de === null) {
    anterior = null;
    proxima = semAlvo[0]?.ordem ?? null;
    indice = 0;
  } else {
    const i = semAlvo.findIndex((linha) => linha.id === depois_de);
    anterior = semAlvo[i]!.ordem;
    proxima = semAlvo[i + 1]?.ordem ?? null;
    indice = i + 1;
  }

  const nova = posicaoEntre(anterior, proxima);

  /**
   * Caminho normal: a média existe e é estritamente entre as vizinhas. Grava UMA
   * linha — o vizinho e o seguinte ficam byte a byte como estavam.
   */
  if (nova !== null) {
    const { data, error } = await supabase
      .from("message_templates")
      // Sem `updated_at`: reordenar não é editar (ver o cabeçalho).
      .update({ ordem: nova })
      .eq("id", id)
      .eq("organization_id", org.orgId)
      .select("id")
      .maybeSingle();
    if (error) {
      logger.error("[message-templates/ordem] falha ao gravar a ordem", {
        detalhe: error.message,
        requestId,
      });
      return fail("internal_error", "Erro ao reordenar a resposta rápida.", 500, { requestId });
    }
    // Sem linha de volta, a RLS recusou a escrita (um `agent` movendo resposta
    // COMPARTILHADA): nada mudou, então nada é auditado nem respondido como
    // movido — a releitura de `finalizar` acharia a linha (ele a LÊ) e diria 200.
    if (!data) {
      return fail("forbidden", t("Você não pode reordenar esta resposta rápida."), 403, {
        requestId,
      });
    }
    return finalizar(false, nova);
  }

  /**
   * Não há posição representável (empate entre as vizinhas — duas respostas
   * criadas ao mesmo tempo, ou linhas de antes da 0729 —, ou precisão da média
   * esgotada): a lista visível
   * inteira é renumerada com passos largos, na ordem pedida. É o mesmo desfecho
   * que o quadro chama de "global rebalance", e aqui ele é obrigatório: gravar
   * `NaN` ordenaria a linha como "sempre no fim" e o arrasto não teria efeito.
   *
   * A renumeração escreve as OUTRAS linhas também, então a régua da RLS
   * (`message_templates_write`: a própria com `agent`, a compartilhada com
   * manager+) é conferida na lista inteira ANTES do primeiro UPDATE: nada é
   * escrito se a lista tiver linha que este papel não grava. Conferir só no
   * meio do laço deixaria as linhas anteriores já renumeradas e responderia 409.
   */
  const gravavel = (linha: Linha) =>
    linha.owner_user_id === user.id ||
    (linha.owner_user_id === null && roleAtLeast(org.role, "manager"));
  if (!atual.every(gravavel)) {
    return fail(
      "conflict",
      t("Não foi possível reordenar a lista inteira. Recarregue a página."),
      409,
      { requestId },
    );
  }
  const ids = semAlvo.map((linha) => linha.id);
  ids.splice(indice, 0, id);
  for (let i = 0; i < ids.length; i++) {
    const { data, error } = await supabase
      .from("message_templates")
      .update({ ordem: ordemDaRenumeracao(i) })
      .eq("id", ids[i]!)
      .eq("organization_id", org.orgId)
      .select("id")
      .maybeSingle();
    if (error) {
      logger.error("[message-templates/ordem] falha ao renumerar", {
        detalhe: error.message,
        requestId,
      });
      return fail("internal_error", "Erro ao reordenar a resposta rápida.", 500, { requestId });
    }
    // Defesa em profundidade: a régua acima já recusou o que a RLS recusaria;
    // chegar aqui é corrida (a linha mudou de dono ou sumiu entre as consultas).
    if (!data) {
      return fail(
        "conflict",
        t("Não foi possível reordenar a lista inteira. Recarregue a página."),
        409,
        { requestId },
      );
    }
  }
  return finalizar(true, ordemDaRenumeracao(indice));

  /**
   * Registra o efeito e devolve a linha final.
   *
   * O `update` acima pediu só `id` de volta (o que interessa é se a RLS deixou
   * escrever); a resposta é a linha inteira relida, para o cliente atualizar o
   * cache com o mesmo formato da listagem — e o `select` da releitura é quem
   * prova que a linha continua existindo.
   */
  async function finalizar(renumerada: boolean, ordem: number): Promise<Response> {
    void audit({
      action: "template.reordered",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "message_template",
      resourceId: id,
      requestId,
      metadata: { depois_de, ordem, renumerada },
    });
    const { data, error } = await supabase
      .from("message_templates")
      .select(COLS)
      .eq("id", id)
      .eq("organization_id", org.orgId)
      .maybeSingle();
    if (error || !data) {
      return fail("not_found", t("Template não encontrado."), 404, { requestId });
    }
    return ok(data, { requestId });
  }
}
