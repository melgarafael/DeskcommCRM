/**
 * O FUNIL DO INTERESSE, ACHADO PELA REFERÊNCIA DO ITEM (Spec 25, R5c).
 *
 * Medido no espelho (22/10/2026): o destino configurado na receita (R5b) chegava
 * ao agente dentro do resultado da consulta, e esse resultado NÃO acompanha a
 * conversa. No turno em que o cliente dizia "tenho interesse nesse", o agente não
 * tinha o funil nem a etapa, não abria o negócio e ainda escrevia "registrei seu
 * interesse". Duas tentativas, duas vezes: nenhum `crm_create_lead`.
 *
 * Aqui o sistema resolve sozinho: o agente passa só a referência do item
 * (`<receita>:<id>`, que ele lê da conversa) e o funil e a etapa saem da receita
 * da organização. O agente nunca escolhe o funil — quem escolheu foi o dono, na
 * tela de receitas.
 *
 * A organização vem SEMPRE de quem chama. O cliente de serviço ignora a RLS, então
 * o filtro é explícito.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { ehReferenciaExterna } from "@/lib/leads/referencia-externa";

import type { DestinoDoInteresse } from "./destino-do-interesse";
import { nomesDoDestinoValido } from "./destino-no-banco";
import { lerReceitasDoBanco } from "./instancias";

export type DestinoPelaReferencia =
  | { ok: true; destino: DestinoDoInteresse }
  | {
      ok: false;
      motivo: "referencia_invalida" | "sem_destino" | "destino_ambiguo" | "indisponivel";
      mensagem: string;
    };

const PASSE_PARA_A_EQUIPE =
  "Não abra o negócio por conta própria: chame crm_request_human_handoff e diga ao cliente que a equipe dará continuidade.";

/** A receita da referência (`wordpress-conteudo:4821` → `wordpress-conteudo`). */
function receitaDaReferencia(referencia: string): string {
  return referencia.slice(0, referencia.indexOf(":"));
}

/**
 * Procura, nas conexões ativas da organização, o destino das instâncias ATIVAS da
 * receita da referência. Só vale se existir exatamente UM destino válido: nenhum
 * é "esta receita não tem funil" e mais de um (instâncias da mesma receita com
 * funis diferentes) é ambíguo — nos dois casos o agente passa para a equipe, em
 * vez de o sistema adivinhar.
 */
export async function destinoPelaReferencia(
  admin: SupabaseClient,
  organizationId: string,
  referencia: string,
): Promise<DestinoPelaReferencia> {
  if (!ehReferenciaExterna(referencia)) {
    return {
      ok: false,
      motivo: "referencia_invalida",
      mensagem: "a referência do item deve ter o formato <receita>:<id> (ex.: wordpress-conteudo:4821).",
    };
  }
  const receita = receitaDaReferencia(referencia);

  const { data, error } = await admin
    .from("external_db_connections")
    .select("receitas")
    .eq("organization_id", organizationId)
    .eq("enabled", true);
  if (error) {
    return {
      ok: false,
      motivo: "indisponivel",
      mensagem: `não foi possível ler as receitas agora. ${PASSE_PARA_A_EQUIPE}`,
    };
  }

  const destinos = new Map<string, DestinoDoInteresse>();
  for (const conexao of (data ?? []) as { receitas: unknown }[]) {
    const lida = lerReceitasDoBanco(conexao.receitas);
    if (!lida.ok) continue;
    for (const instancia of lida.instancias) {
      if (!instancia.ativa || instancia.receita !== receita || !instancia.destino_do_interesse) continue;
      // O funil pode ter sido arquivado depois de configurado: destino que não vale
      // mais não conta.
      if (!(await nomesDoDestinoValido(admin, organizationId, instancia.destino_do_interesse))) continue;
      const { pipeline_id, stage_id } = instancia.destino_do_interesse;
      destinos.set(`${pipeline_id}:${stage_id}`, { pipeline_id, stage_id });
    }
  }

  if (destinos.size === 0) {
    return {
      ok: false,
      motivo: "sem_destino",
      mensagem: `esta receita não tem funil de destino configurado. ${PASSE_PARA_A_EQUIPE}`,
    };
  }
  if (destinos.size > 1) {
    return {
      ok: false,
      motivo: "destino_ambiguo",
      mensagem: `há mais de um funil de destino para esta receita. ${PASSE_PARA_A_EQUIPE}`,
    };
  }
  return { ok: true, destino: [...destinos.values()][0]! };
}

/**
 * Completa `pipeline_id` e `stage_id` dos argumentos de `crm_create_lead` quando
 * o agente passou só a `referencia_externa`. EDITA `args` no lugar: o chamador
 * (o wrapper do agente) precisa dos valores ANTES do escopo de funil, que julga o
 * funil que vai ser escrito — preencher depois deixaria a guarda olhando para um
 * argumento ausente.
 *
 * Funil e etapa informados pelo chamador nunca são trocados.
 */
export async function completarDestinoDoNegocio(
  admin: SupabaseClient,
  organizationId: string,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; resposta: Record<string, unknown> }> {
  const temFunil = typeof args.pipeline_id === "string" && args.pipeline_id !== "";
  const temEtapa = typeof args.stage_id === "string" && args.stage_id !== "";
  if (temFunil && temEtapa) return { ok: true };

  if (temFunil !== temEtapa) {
    return {
      ok: false,
      resposta: {
        erro: "funil_e_etapa_juntos",
        mensagem: "informe pipeline_id e stage_id juntos, ou nenhum dos dois junto com referencia_externa.",
      },
    };
  }
  if (typeof args.referencia_externa !== "string") {
    return {
      ok: false,
      resposta: {
        erro: "funil_obrigatorio",
        mensagem:
          "informe pipeline_id e stage_id, ou a referencia_externa de um item cuja receita tem funil de destino configurado.",
      },
    };
  }

  const achado = await destinoPelaReferencia(admin, organizationId, args.referencia_externa);
  if (!achado.ok) {
    return { ok: false, resposta: { erro: achado.motivo, mensagem: achado.mensagem } };
  }
  args.pipeline_id = achado.destino.pipeline_id;
  args.stage_id = achado.destino.stage_id;
  return { ok: true };
}
