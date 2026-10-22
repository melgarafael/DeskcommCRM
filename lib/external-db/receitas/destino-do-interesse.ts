/**
 * PARA ONDE VAI O INTERESSE DO CLIENTE NUM ITEM DO BANCO EXTERNO (Spec 25, R5b).
 *
 * A instância da receita pode declarar o funil e a etapa onde nasce o negócio
 * quando o cliente diz "tenho interesse nesse". O agente lê isso no resultado de
 * `crm_consultar_receita` e cria o negócio com `crm_create_lead` (que carrega a
 * referência do item, R5a).
 *
 * SEM destino configurado o interesse não pode virar um buraco: o resultado diz
 * ao agente para NÃO criar negócio por conta própria e passar a conversa à
 * equipe com `crm_request_human_handoff` — o handoff já tem aviso na Central e
 * contexto pronto (`buildHandoffSummary`), então o laço se fecha sem tipo novo.
 *
 * Funções puras: a consulta ao banco (o funil e a etapa existem, são desta
 * organização e estão ativos?) mora em quem chama.
 */
import { z } from "zod";

/** O que a instância guarda: só os dois ids. Os nomes são lidos na hora. */
export const destinoDoInteresseSchema = z
  .object({
    pipeline_id: z.string().uuid(),
    stage_id: z.string().uuid(),
  })
  .strict();

export type DestinoDoInteresse = z.infer<typeof destinoDoInteresseSchema>;

/** Os nomes que a tela e o agente mostram, lidos de `crm_pipelines` e `crm_stages`. */
export interface NomesDoDestino {
  funil: string;
  etapa: string;
}

/** O bloco que `crm_consultar_receita` devolve ao agente junto com as linhas. */
export type OrientacaoDeInteresse =
  | {
      destino: {
        pipeline_id: string;
        stage_id: string;
        funil: string;
        etapa: string;
      };
      referencia_do_item: string;
      instrucao: string;
    }
  | { destino: null; motivo: "sem_destino" | "destino_indisponivel"; instrucao: string };

/**
 * O texto que ensina o modelo. Em português simples e sem decidir pelo modelo
 * QUANDO há interesse: quem decide é a fala do cliente, o resto é cumprir o
 * caminho.
 */
export function orientacaoDeInteresse(
  receitaId: string,
  destino: DestinoDoInteresse | null | undefined,
  nomes: NomesDoDestino | null,
): OrientacaoDeInteresse {
  if (!destino) {
    return {
      destino: null,
      motivo: "sem_destino",
      instrucao:
        "Esta receita não tem funil de destino configurado. Se o cliente demonstrar interesse em um item, " +
        "NÃO abra negócio por conta própria nem escolha um funil: chame crm_request_human_handoff e diga " +
        "ao cliente que a equipe dará continuidade.",
    };
  }
  if (!nomes) {
    return {
      destino: null,
      motivo: "destino_indisponivel",
      instrucao:
        "O funil de destino desta receita não está mais disponível (apagado ou arquivado). Se o cliente " +
        "demonstrar interesse em um item, NÃO abra negócio por conta própria: chame crm_request_human_handoff " +
        "e diga ao cliente que a equipe dará continuidade.",
    };
  }
  return {
    destino: {
      pipeline_id: destino.pipeline_id,
      stage_id: destino.stage_id,
      funil: nomes.funil,
      etapa: nomes.etapa,
    },
    referencia_do_item: `${receitaId}:<id do item>`,
    // O resultado desta consulta NÃO acompanha a conversa: no turno em que o cliente
    // escolhe, o agente só tem o que está escrito nas mensagens. Medido no espelho
    // (22/10/2026): sem o código no texto mostrado, o agente tentou consultar de
    // novo com filtro inventado, desistiu, e disse "registrei" sem abrir o negócio.
    // Por isso o código vai ao cliente junto do item — imóvel e produto têm código.
    instrucao:
      `Ao mostrar os itens ao cliente, escreva junto de cada um o código dele no formato "cód. <id>" ` +
      `(o campo id da linha): é por esse código que você acha o item quando o cliente escolher, sem ` +
      `consultar de novo. Quando o cliente disser que tem interesse em UM item, abra o negócio com ` +
      `crm_create_lead passando o contact_id desta conversa, um title com o nome do item e ` +
      `referencia_externa no formato indicado (troque <id do item> pelo código). NÃO informe pipeline_id ` +
      `nem stage_id: o sistema usa o funil e a etapa de "destino", que o dono configurou. ` +
      `Só diga ao cliente que registrou o interesse depois que crm_create_lead responder com sucesso. ` +
      `Não abra negócio por item que o cliente apenas viu.`,
  };
}
