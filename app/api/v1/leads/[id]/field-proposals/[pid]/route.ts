/**
 * POST /api/v1/leads/[id]/field-proposals/[pid] — o HUMANO decide sobre o que a
 * IA leu num documento (issue #3316): `accept` grava no card, `dismiss` recusa.
 *
 * ═══ ESTA ROTA É A ÚNICA PORTA DE GRAVAÇÃO, E ELA EXISTE DE PROPÓSITO ═══
 *
 * A régua de nascimento (`lib/leads/proposta-de-campos-por-documento.ts`)
 * NUNCA toca em `crm_leads.custom_fields`. O caminho do dado é este: proposta na
 * fila → pessoa confirma campo a campo (com valor atual, proposto e trecho à
 * vista, em `GET .../field-proposals`) → AQUI grava. Sem esta etapa, um voucher
 * com o hotel errado viraria card errado sem ninguém ver — e a revisão campo a
 * campo é a única coisa que transforma leitura de máquina em dado da operação.
 *
 * ⚠️ A GRAVAÇÃO PASSA PELA PORTA DE EDIÇÃO (`updateLeadHandler`), não por um
 * UPDATE direto.
 *
 * É a mesma decisão da rota de decisão de contatos
 * (`app/api/v1/contacts/[id]/proposals/[proposal_id]`): `updateLeadHandler`
 * já barre contato pessoal, já valida o `padrao` (#2730) com o DIFF contra o
 * que está gravado, já mescla `custom_fields` pela RPC que preserva o resto, já
 * emite a atividade da linha do tempo (`lead_edited`) e o audit. Escrever
 * direto duplicaria as cinco regras — e a cópia é que fica para trás.
 *
 * ⚠️ A TRAVA É O `eq("status","pending")` DENTRO DO UPDATE.
 *
 * Entre a tela renderizar e alguém clicar, a proposta pode ter vencido, sido
 * decidida por um colega, ou sumido porque o negócio foi apagado. Ler e depois
 * escrever deixaria a janela aberta; o UPDATE condicional fecha a corrida no
 * banco, e quem perde recebe 409 com a razão — em vez de aplicar, em nome de
 * quem clicou, uma decisão que o sistema já tinha encerrado.
 *
 * ⚠️ O VALOR É RE-CONFERIDO AQUI, contra o funil DE HOJE.
 *
 * Entre a proposta nascer e a confirmação, o dono pode ter trocado a lista ou o
 * `padrao` do funil. Confirmar sem re-conferir gravaria um valor que a régua de
 * hoje recusaria pela porta do formulário — duas portas, dois vereditos. A
 * re-conferência é a MESMA função do nascimento (`confereCampoLido`); a
 * correção da pessoa (o campo corrigido na tela) passa pela mesma régua.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { ApiError } from "@/lib/api/types";
import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { camposDoFunil, camposPorEscopo } from "@/lib/leads/campos-do-funil";
import { settingsDoFunil } from "@/lib/leads/campos-exigidos";
import { confereCampoLido, propostaVencida } from "@/lib/leads/proposta-de-campos-por-documento";
import {
  mensagemDaRecusa,
  type RecusaDePadrao,
} from "@/lib/leads/padrao-do-campo";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";
import type { CustomFieldDef } from "@/lib/schemas/settings";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string; pid: string }>;
}

const Body = z.object({
  decision: z.enum(["accept", "dismiss"]),
  /**
   * Por que recusou. É o laço de retorno — sem ele, o sinal de "a IA leu errado"
   * vira só um número, e o número não muda o prompt de ninguém.
   */
  motivo: z.string().max(300).optional(),
  /**
   * O valor CORRIGIDO pela pessoa, quando ela corrige em vez de aceitar como
 * está. String, porque é o que um input de formulário devolve — e a conversão
   * para o tipo do funil é da MESMA régua do nascimento (número, booleano,
   * lista), nunca do formulário.
   */
  valor: z.string().max(2000).optional(),
});

/**
 * O valor que vai ser gravado, já na forma do TIPO do funil.
 *
 * Com correção, é a correção passada pela régua. Sem correção, é o valor da
 * proposta passado pela mesma régua. Número do jsonb permanece número: reler
 * 1.234 como texto regional o multiplicava por mil. O padrão do funil de hoje
 * continua sendo cobrado, tanto do valor persistido quanto da correção.
 */
function valorConfirmado(
  def: CustomFieldDef,
  proposto: unknown,
  correcao: string | undefined,
): { ok: true; valor: unknown } | { ok: false; recusa: RecusaDePadrao } {
  const entrada = correcao ?? (
    typeof proposto === "number"
      ? proposto
      : Array.isArray(proposto) ? proposto.join(", ") : String(proposto ?? "")
  );
  const veredito = confereCampoLido(def, entrada);
  if (veredito.ok) return veredito;
  return {
    ok: false,
    recusa: {
      campo: def.key,
      rotulo: def.label ?? def.key,
      // `RecusaDePadrao` só aceita o par do `padrao`; recusas de forma/lista
      // sobem como "fora_do_padrao" — a frase que `mensagemDaRecusa` já devolve
      // ("fora do formato esperado") é honesta para as duas.
      motivo: veredito.motivo === "padrao_invalido" ? "padrao_invalido" : "fora_do_padrao",
      ...(def.mensagem_padrao ? { mensagemPadrao: def.mensagem_padrao } : {}),
    },
  };
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id: leadId, pid } = await ctx.params;

  // `agent`: paridade com o PATCH do próprio negócio. Confirmar um dado do card
  // é editar o dossiê, e editar dossiê é trabalho de quem atende.
  const guard = await requireRole("agent", { requestId, resource: "crm_leads" });
  if (!guard.ok) return guard.response;
  const t = (texto: string) => traduzir(texto, guard.user.idioma);
  const orgId = guard.org.orgId;
  const userId = guard.user.id;

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("invalid_body", t("decision é obrigatório (accept | dismiss)."), 400, { requestId });
  }
  const { decision, motivo, valor: correcao } = parsed.data;

  const supabase = await createClient();
  // O relógio do SERVIDOR, uma vez: o prazo da proposta e a decisão são
  // comparados com o mesmo instante dentro deste handler.
  const agora = new Date();

  interface PropostaLida {
    id: string;
    lead_id: string;
    campo: string;
    valor_proposto: unknown;
    status: string;
    expires_at: string | null;
    attachment_id: string | null;
  }

  const { data: proposta, error: erroLeitura } = await supabase
    .from("lead_field_proposals")
    .select("id, lead_id, campo, valor_proposto, status, expires_at, attachment_id")
    .eq("id", pid)
    .eq("lead_id", leadId)
    .eq("organization_id", orgId)
    .maybeSingle();

  if (erroLeitura) return fail("internal_error", erroLeitura.message, 500, { requestId });
  if (!proposta) return fail("not_found", t("Sugestão não encontrada."), 404, { requestId });
  const p = proposta as PropostaLida;

  // ── O PRAZO, ANTES DE TUDO ────────────────────────────────────────────────
  //
  // `expires_at` VALE NA DECISÃO (defeito medido no #3415: nada cobrava a
  // coluna, então proposta vencida continuava decidível — e confirmar uma
  // leitura de oito dias atrás grava no card um dado que o documento já não
  // garante). Vencida não se aceita nem se descarta: encerra-se, e é isto que a
  // pessoa lê. A varredura (`vencePropostasDeCampo`) faz o mesmo em lote; este
  // ramo é o caso em que a pessoa clica ANTES de a varredura passar, e sem ele
  // a fila teria um estado que a tela já não mostra e o servidor ainda aceita.
  if (p.status === "pending" && propostaVencida(p, agora)) {
    const { data: encerrada } = await supabase
      .from("lead_field_proposals")
      .update({ status: "expired", decided_at: agora.toISOString() })
      .eq("id", p.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    // Se `encerrada` é null, alguém decidiu no mesmo instante: a resposta abaixo
    // continua valendo neste tique (o prazo já tinha passado), e o registro
    // fica com a decisão de quem chegou primeiro.
    void encerrada;
    await audit({
      action: "lead.field_rejected",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      metadata: { proposal_id: p.id, campo: p.campo, motivo: "prazo", origem: "documento" },
    });
    return fail("proposal_expired", t("Esta sugestão venceu pelo prazo."), 409, { requestId });
  }

  if (p.status !== "pending") {
    return fail(
      "proposal_not_pending",
      p.status === "expired"
        ? t("Esta sugestão venceu pelo prazo.")
        : t("Esta sugestão já foi decidida."),
      409,
      { requestId },
    );
  }

  // ── RECUSA ────────────────────────────────────────────────────────────────
  if (decision === "dismiss") {
    const { data: decidida, error } = await supabase
      .from("lead_field_proposals")
      .update({
        status: "dismissed",
        decided_at: new Date().toISOString(),
        decided_by_user_id: userId,
        motivo_recusa: motivo ?? null,
      })
      .eq("id", p.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();
    if (error) return fail("internal_error", error.message, 500, { requestId });
    if (!decidida) {
      return fail("proposal_not_pending", t("Esta sugestão já foi decidida."), 409, { requestId });
    }
    await audit({
      action: "lead.field_rejected",
      actorUserId: userId,
      organizationId: orgId,
      resourceType: "crm_lead",
      resourceId: leadId,
      requestId,
      // ⚠️ SÓ METADADO. O `valor_recusado` que existia aqui era o defeito
      // medido no #3415: o documento é lido pelo modelo e o valor é o dado do
      // passageiro (localizador, hotel, apólice) — copiá-lo para o audit criava
      // uma SEGUNDA fonte permanente de conteúdo pessoal, que a cascata de
      // anonimização não alcança (audit é append-only e não tem `lead_id`).
      // O valor continua na linha da proposta (que a cascata redige) e o padrão
      // de erro da IA se lê por `campo` + `motivo`, que é o que muda o prompt.
      // `motivo` é texto livre escrito por uma PESSOA e pode citar o dado:
      // fica em `motivo_recusa` (coluna redigida pela cascata), nunca aqui.
      metadata: {
        proposal_id: p.id,
        campo: p.campo,
        origem: "documento",
        attachment_id: p.attachment_id,
        tem_motivo: Boolean(motivo && motivo.trim() !== ""),
      },
    });
    return ok({ decision: "dismissed", campo: p.campo }, { requestId });
  }

  // ── CONFIRMA ──────────────────────────────────────────────────────────────
  //
  // ANTES de decidir a proposta: o valor tem de caber no funil DE HOJE. Se não
  // caber, ninguém decide nada — a pessoa corrige na tela e confirma de novo, e
  // a proposta continua viva para ela poder fazer isso.
  const { data: lead, error: leadErr } = await supabase
    .from("crm_leads")
    .select("id, pipeline_id")
    .eq("organization_id", orgId)
    .eq("id", leadId)
    .maybeSingle();
  if (leadErr) return fail("internal_error", leadErr.message, 500, { requestId });
  if (!lead) return fail("not_found", t("Negócio não encontrado."), 404, { requestId });

  const settings = await settingsDoFunil(supabase, (lead as { pipeline_id?: string | null }).pipeline_id);
  const defs = camposPorEscopo(
    camposDoFunil(
      settings && typeof settings === "object" && !Array.isArray(settings)
        ? (settings as Record<string, unknown>)
        : null,
    ),
    "negocio",
  );
  const def = defs.find((d) => d.key === p.campo);
  if (!def) {
    // O funil MUDOU depois da proposta: o campo saiu do card (ou virou campo do
    // contato). Gravar seria escrever em chave que a régua de hoje não declara —
    // e a issue manda propor/gravar SÓ campos do funil. A proposta fica pendente
    // de propósito: quem decide descartá-la é a pessoa, na mesma tela.
    return fail(
      "campo_fora_do_funil",
      t("Este campo não está mais declarado no funil do negócio — descarte a sugestão."),
      422,
      { requestId },
    );
  }

  const conferido = valorConfirmado(def, p.valor_proposto, correcao);
  if (!conferido.ok) {
    const recusas: RecusaDePadrao[] = [conferido.recusa];
    const codigo =
      conferido.recusa.motivo === "padrao_invalido"
        ? "custom_field_pattern_invalid"
        : "custom_field_pattern_mismatch";
    return fail(codigo, mensagemDaRecusa(conferido.recusa), 422, {
      details: { recusas: recusas.map((r) => ({ campo: r.campo, motivo: r.motivo })) },
      requestId,
    });
  }

  // A TRAVA: só uma decisão vence, e o banco é quem decide quem.
  const { data: decidida, error: erroDecisao } = await supabase
    .from("lead_field_proposals")
    .update({
      status: "accepted",
      decided_at: new Date().toISOString(),
      decided_by_user_id: userId,
    })
    .eq("id", p.id)
    .eq("status", "pending")
    .select("id")
    .maybeSingle();

  if (erroDecisao) return fail("internal_error", erroDecisao.message, 500, { requestId });
  if (!decidida) {
    const { data: existe } = await supabase
      .from("lead_field_proposals")
      .select("status")
      .eq("id", p.id)
      .eq("lead_id", leadId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (existe) {
      const st = (existe as { status: string }).status;
      return fail(
        "proposal_not_pending",
        st === "expired"
          ? t("Esta sugestão venceu pelo prazo.")
          : t("Esta sugestão já foi decidida."),
        409,
        { requestId },
      );
    }
    return fail("not_found", t("Sugestão não encontrada."), 404, { requestId });
  }

  // A GRAVAÇÃO: pela porta que já existe, com o `padrao` (#2730) e a mesclagem
  // que ela faz. Se a régua de HOJE recusar (o funil mudou entre validar e
  // gravar), a proposta VOLTA para pending — a pessoa vê o 422 com a razão e
  // decide corrigir ou descartar; a fila não perde o item por um erro de gravação.
  try {
    await updateLeadHandler(
      supabase,
      { organization_id: orgId, actor: { type: "user", id: userId }, requestId, idioma: guard.user.idioma },
      leadId,
      { custom_fields: { [p.campo]: conferido.valor } },
    );
  } catch (err) {
    await supabase
      .from("lead_field_proposals")
      .update({ status: "pending", decided_at: null, decided_by_user_id: null })
      .eq("id", p.id)
      .eq("status", "accepted");
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, { requestId });
    }
    return fail("internal_error", t("Não foi possível gravar o dado."), 500, { requestId });
  }

  await audit({
    action: "lead.field_confirmed",
    actorUserId: userId,
    organizationId: orgId,
    resourceType: "crm_lead",
    resourceId: leadId,
    requestId,
    // ⚠️ SÓ METADADO — o `valor_gravado` que existia aqui era o defeito do
    // #3415. O dado pessoal que a IA leu do documento vive na linha da
    // proposta (redigida pela cascata) e, depois de confirmado, no
    // `custom_fields` do card (limpo pelo passo 5) — os DOIS lugares que a
    // cascata alcança. O audit não é um deles: ele é append-only, sem
    // `lead_id` e sem caminho de limpeza, então uma cópia aqui seria a segunda
    // fonte PERMANENTE de conteúdo pessoal. Quem confirma já vê o valor na
    // tela e na atividade `lead_edited` que a porta de edição emite.
    metadata: {
      proposal_id: p.id,
      campo: p.campo,
      origem: "documento",
      attachment_id: p.attachment_id,
      corrigido_pela_pessoa: correcao !== undefined,
    },
  });

  return ok({ decision: "accepted", campo: p.campo, valor: conferido.valor }, { requestId });
}
