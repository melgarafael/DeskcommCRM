/**
 * A ENTRADA DAS CONVERSAS DO INBOX (#3011) — o ajuste do funil lido por UMA
 * régua só.
 *
 * O ajuste mora em `crm_pipelines.settings.entrada_do_inbox` e diz em que etapa
 * a conversa nova vira card. Quem GRAVA é `updatePipelineConfig` (pela tela) e
 * quem APLICA é `lib/leads/nascimento-do-lead.ts`; este arquivo é o que os dois
 * — e a tela, que precisa abrir mostrando a escolha feita — leem, para não
 * existirem duas leituras do mesmo jsonb divergindo.
 *
 * ⚠️ O VALOR É JSONB ESCRITO POR FORA. Script, seed e API antiga não passam pelo
 * zod do PATCH, então a leitura aqui é feita com a MESMA régua da gravação
 * (`pipelineConfigPatchSchema.shape.entrada_do_inbox`), como
 * `lib/leads/motivos-de-perda-do-funil.ts` faz com `lost_reasons`. Um `stage_id`
 * que não passa aqui não vira etapa nenhuma.
 *
 * ⚠️ IDENTIFICADOR COM FORMA NÃO É ETAPA QUE EXISTE. Que o valor *pareça* um
 * uuid é tudo o que esta função sabe; se ele aponta para uma etapa DESTE funil,
 * desta organização e aberta é conferido contra o banco em `etapaDeEntrada`.
 */
import { pipelineConfigPatchSchema } from "@/lib/schemas/settings";

export interface EntradaDoInboxDeclarada {
  /**
   * Só o `true` EXPLÍCITO liga — a régua de `settings.crm.cliente_pela_agenda`.
   * Ausente, `false` ou qualquer outro valor é o comportamento de sempre: a
   * conversa nasce na primeira etapa do funil.
   */
  ativa: boolean;
  /**
   * A etapa declarada, mesmo com o ajuste DESLIGADO.
   *
   * `ativa: false` com `stage_id` gravado é um estado de propósito: desligar não
   * apaga a etapa escolhida, e religar não obriga a escolher de novo.
   */
  stage_id: string | null;
}

/** Lê o bloco `entrada_do_inbox` das configurações de um funil. Nunca lança. */
export function entradaDoInboxDeclarada(settings: unknown): EntradaDoInboxDeclarada {
  const bruto = (settings as { entrada_do_inbox?: unknown } | null | undefined)?.entrada_do_inbox;
  const lido = pipelineConfigPatchSchema.shape.entrada_do_inbox.safeParse(bruto);
  if (!lido.success || !lido.data) return { ativa: false, stage_id: null };
  const stageId = lido.data.stage_id;
  return {
    ativa: lido.data.ativa === true,
    stage_id: typeof stageId === "string" && stageId !== "" ? stageId : null,
  };
}
