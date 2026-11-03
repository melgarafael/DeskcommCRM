/**
 * O produto que o assistente APRESENTOU vira etiqueta do negócio.
 *
 * ─── Por que o sinal é o envio, e não o modelo ──────────────────────────────
 *
 * O fluxo de acompanhamento escolhe o modelo aprovado pela etiqueta do NEGÓCIO
 * (a condição `tag` do grafo lê `crm_leads.tags` do negócio mais recente do
 * contato). Pedir ao modelo que ponha a etiqueta com a ferramenta de etiquetas
 * não é confiável nem medível: ele esquece, e ninguém vê que esqueceu. Já o
 * envio da mensagem com `produto_codigo` é determinístico — o código resolveu um
 * produto ATIVO do catálogo (`prepararFotosDoProduto`) e o canal devolveu
 * "enviada". É esse fato que etiqueta, não a memória do modelo.
 *
 * ─── O que esta função garante ──────────────────────────────────────────────
 *
 * - O negócio é o ÚNICO aberto do contato. Zero abertos: não há onde pendurar.
 *   Mais de um: não adivinha — etiquetar o negócio errado mandaria o
 *   acompanhamento do produto errado, que é o defeito que isto existe para
 *   fechar. Quem decide "qual é o aberto" é `resolveActiveLeadForContact`, o
 *   mesmo ponteiro contato→negócio do resto do motor.
 * - Não duplica: o `update` só acrescenta se a etiqueta não está lá, na MESMA
 *   instrução — sem janela entre ler e escrever para uma edição humana
 *   simultânea se perder.
 * - Respeita o teto de 20 etiquetas do editor (`conversationTagsSchema`):
 *   passar dele seria gravar o que a tela recusa.
 * - Deixa rastro onde as outras escritas de etiqueta deixam: o evento
 *   `lead.tag_added` (o mesmo do PATCH do negócio e da automação — é ele que os
 *   webhooks e as automações escutam) e uma linha na linha do tempo do negócio.
 *
 * Quem chama trata tudo como best-effort: a mensagem ao cliente JÁ saiu quando
 * isto roda, e nenhuma falha aqui pode desfazê-la nem atrasá-la.
 */
import type pg from "pg";

import { TAMANHO_MAXIMO_DA_TAG, normalizarTag, normalizarTags } from "@/lib/contacts/tag-normalizada";
import { emitAgentActivityForContact } from "@/lib/leads/agent-activity";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";

/** O teto do editor de etiquetas — `conversationTagsSchema` (lib/schemas/messaging.ts). */
const TETO_DE_ETIQUETAS = 20;

export type EtiquetaDoProduto =
  | {
      etiquetou: true;
      leadId: string;
      etiqueta: string;
      /**
       * O que NÃO saiu do rastro, se algo não saiu. A etiqueta já está gravada —
       * o evento e a linha do tempo falham para dentro, cada um por si, e quem
       * chama registra no log do turno.
       */
      falhasDoRastro: string[];
    }
  | {
      etiquetou: false;
      motivo:
        | "codigo_invalido"
        | "sem_negocio_aberto"
        | "mais_de_um_negocio_aberto"
        | "ja_tinha"
        | "teto_de_etiquetas"
        /** O negócio fechou ou ganhou a etiqueta entre a leitura e a escrita. */
        | "mudou_no_meio";
      leadId?: string;
      etiqueta?: string;
    };

/** A etiqueta de um código de produto: o próprio código, em minúsculas. `null` se não cabe. */
export function etiquetaDoCodigo(codigo: string): string | null {
  const limpo = codigo.trim();
  // Cortar em 40 (o que `normalizarTag` faria) gravaria uma etiqueta que não é
  // o código — e o fluxo, que compara pelo código, nunca a acharia.
  if (limpo === "" || limpo.length > TAMANHO_MAXIMO_DA_TAG) return null;
  return normalizarTag(limpo);
}

interface NegocioDoContato extends LeadCandidate {
  tags: string[] | null;
}

export async function etiquetarNegocioComProdutoApresentado(
  pool: pg.Pool,
  input: {
    organizationId: string;
    /** No motor, "lead" é o CONTATO (inbound-turn: `leadId = contact_id`). */
    contactId: string;
    codigo: string;
    agentId?: string | null;
    /** A mensagem que apresentou o produto — vai como origem da linha do tempo. */
    messageId?: string | null;
  },
): Promise<EtiquetaDoProduto> {
  const etiqueta = etiquetaDoCodigo(input.codigo);
  if (etiqueta === null) return { etiquetou: false, motivo: "codigo_invalido" };

  const { rows } = await pool.query<NegocioDoContato>(
    `select l.id, l.organization_id, l.pipeline_id, l.status,
            l.last_activity_at, l.created_at, l.tags
       from crm_leads l
      where l.organization_id = $1 and l.contact_id = $2`,
    [input.organizationId, input.contactId],
  );

  const abertos = rows.filter((r) => r.status === "open");
  if (abertos.length > 1) return { etiquetou: false, motivo: "mais_de_um_negocio_aberto", etiqueta };
  const alvo = resolveActiveLeadForContact(rows);
  if (!alvo.routed) return { etiquetou: false, motivo: "sem_negocio_aberto", etiqueta };

  const atuais = normalizarTags(abertos[0]?.tags ?? []);
  if (atuais.includes(etiqueta)) {
    return { etiquetou: false, motivo: "ja_tinha", leadId: alvo.leadId, etiqueta };
  }
  if (atuais.length >= TETO_DE_ETIQUETAS) {
    return { etiquetou: false, motivo: "teto_de_etiquetas", leadId: alvo.leadId, etiqueta };
  }

  // As três guardas de novo, no próprio `update`: entre a leitura acima e esta
  // linha, um humano pode ter fechado o negócio ou mexido nas etiquetas.
  const { rows: gravadas } = await pool.query<{ tags: string[] }>(
    `update crm_leads
        set tags = array_append(coalesce(tags, '{}'::text[]), $3::text),
            updated_at = now()
      where organization_id = $1 and id = $2 and status = 'open'
        and not ($3::text = any(coalesce(tags, '{}'::text[])))
        and coalesce(cardinality(tags), 0) < $4
      returning tags`,
    [input.organizationId, alvo.leadId, etiqueta, TETO_DE_ETIQUETAS],
  );
  const gravada = gravadas[0];
  if (!gravada) return { etiquetou: false, motivo: "mudou_no_meio", leadId: alvo.leadId, etiqueta };

  const falhasDoRastro: string[] = [];
  const falhou = (onde: string, err: unknown) =>
    falhasDoRastro.push(`${onde}: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)}`);

  // O MESMO evento que o PATCH do negócio e a automação emitem quando uma
  // etiqueta entra: é por ele que webhook e automação ficam sabendo. A origem do
  // atendimento é carimbada pelo próprio `emit_event`, no banco.
  try {
    await pool.query(`select public.emit_event($1, $2, $3, $4::jsonb, $5::jsonb, $6)`, [
      "lead.tag_added",
      "crm_lead",
      alvo.leadId,
      JSON.stringify({ added_tags: [etiqueta], tags: gravada.tags }),
      JSON.stringify({ via: "produto_apresentado", agent_id: input.agentId ?? null }),
      input.organizationId,
    ]);
  } catch (err) {
    falhou("evento", err);
  }

  // Linha do tempo: o código do produto não é dado pessoal, então pode ir no
  // texto — é ele que explica por que a etiqueta apareceu.
  try {
    await emitAgentActivityForContact({
      pool,
      organizationId: input.organizationId,
      contactId: input.contactId,
      type: "lead_edited",
      sourceModule: "agent",
      sourceId: input.messageId ?? null,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      reason: `Adicionou a etiqueta «${etiqueta}»: o assistente apresentou este produto com as fotos do catálogo`,
      payload: { fields: ["tags"], added_tags: [etiqueta] },
    });
  } catch (err) {
    falhou("linha_do_tempo", err);
  }

  return { etiquetou: true, leadId: alvo.leadId, etiqueta, falhasDoRastro };
}
