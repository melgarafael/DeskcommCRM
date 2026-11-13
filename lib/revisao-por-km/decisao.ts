/**
 * A decisão de ARMAR a próxima revisão: quando projetar, o que gravar e o que
 * deixar como está (issue #4376).
 *
 * A conta mora em `conta.ts` e não fala com o banco. Aqui fica a
 * camada que decide se a projeção VIRA ESCRITA — e é a única, para que a regra
 * não divirja entre o card, a API, o MCP e a captura do roteiro.
 *
 * ═══ A ESCRITA É A QUE JÁ EXISTE ═══
 *
 * Quem grava é `fn_lead_anotar_campos` (migration 0502) — a MESMA função que a
 * ação `set_lead_date_field` (#3727) usa. Não há caminho paralelo: o valor cai
 * em `crm_leads.custom_fields` e a varredura do gatilho `lead.date_field_due`
 * (#989) o lê no dia certo. Como a chave de disparo leva o VALOR da data
 * (#1540), projetar de novo REARMA o aviso sem nada novo no cron.
 *
 * ═══ O QUE NÃO SE GRAVA ═══
 *
 *   - funil sem a configuração: a régua não foi pedida ali (`sem_configuracao`);
 *   - configuração torta, km ausente, sem data de retirada, leitura no mesmo
 *     dia: motivo NOMEADO no retorno, para quem chama registrar em vez de
 *     deixar o card vazio sem explicação;
 *   - km menor que o anterior: a data já gravada CONTINUA valendo — regredir
 *     apagaria a projeção por causa de um dedo no teclado;
 *   - a data projetada é igual à que já está no card: nada a fazer (idempotente
 *     — é o que impede um PATCH de título rearmar o aviso).
 */
import {
  type ConfigDeRevisaoPorKm,
  type ResultadoDaProjecao,
  configuracaoDeRevisaoPorKm,
  projetarProximaRevisao,
} from "@/lib/revisao-por-km/conta";

/** O que a projeção virou, do ponto de vista de quem chamou. */
export type ResultadoDaArmacao =
  | { status: "armada"; data: string; dia_do_aviso: string; campo: string; projecao: Extract<ResultadoDaProjecao, { status: "projetada" }> }
  | { status: "nenhuma_escrita"; motivo: "ja_gravada" | "km_sem_avanco" | "sem_km" | "sem_data_de_retirada" | "sem_ritmo" | "sem_configuracao" | "configuracao_invalida" | "modulo_desligado"; detalhe?: string }
  | { status: "falhou"; motivo: "gravacao_recusada" | "gravacao_falhou"; detalhe?: string };

export interface ContextoDaArmacao {
  /** `crm_pipelines.settings` do funil do negócio. */
  settings: Record<string, unknown> | null;
  /** `crm_leads.custom_fields` DEPOIS da escrita que trouxe o km. */
  campos: Record<string, unknown>;
  /** `custom_fields` ANTES da escrita — só para saber se o km mudou. */
  camposAnteriores?: Record<string, unknown>;
  /** O dia da leitura no fuso da organização (`AAAA-MM-DD`). */
  hoje: string;
}

/**
 * O km (ou a revisão anterior) mudou nesta escrita? Só assim a conta é refeita.
 *
 * Sem esta guarda, QUALQUER edição de campo do card recalcularia a data — e um
 * PATCH de título rearmaria o aviso de quem já foi avisado. Recalcular é evento
 * de LEITURA de quilometragem, não de edição de card.
 */
export function mexeuNaQuilometragem(
  config: ConfigDeRevisaoPorKm,
  anteriores: Record<string, unknown> | undefined,
  atuais: Record<string, unknown>,
): boolean {
  if (!anteriores) return true;
  const chaves = [
    config.campo_km,
    config.campo_km_da_ultima_revisao ?? "",
    config.campo_da_ultima_revisao ?? "",
  ].filter((chave) => chave !== "");
  return chaves.some((chave) => {
    const antes = anteriores[chave];
    const agora = atuais[chave];
    return String(antes ?? "") !== String(agora ?? "");
  });
}

/**
 * A decisão completa. `gravar` é a porta da escrita (a função do banco, por
 * qualquer cliente) — devolve `true` quando o negócio ainda existe e é da
 * organização.
 */
export async function armarProximaRevisao(
  contexto: ContextoDaArmacao,
  gravar: (campos: Record<string, unknown>) => Promise<boolean>,
): Promise<ResultadoDaArmacao> {
  const leitura = configuracaoDeRevisaoPorKm(contexto.settings);
  if (!leitura.ok) {
    return leitura.motivo === "ausente"
      ? { status: "nenhuma_escrita", motivo: "sem_configuracao" }
      : {
          status: "nenhuma_escrita",
          motivo: "configuracao_invalida",
          detalhe: leitura.detalhe ?? leitura.motivo,
        };
  }
  const config = leitura.config;

  if (!mexeuNaQuilometragem(config, contexto.camposAnteriores, contexto.campos)) {
    return { status: "nenhuma_escrita", motivo: "ja_gravada" };
  }

  const projecao = projetarProximaRevisao({
    config,
    campos: contexto.campos,
    hoje: contexto.hoje,
  });

  if (projecao.status !== "projetada") {
    return {
      status: "nenhuma_escrita",
      motivo: projecao.status,
      ...("motivo" in projecao ? { detalhe: projecao.motivo } : {}),
    };
  }
  if (projecao.ja_gravada) {
    return { status: "nenhuma_escrita", motivo: "ja_gravada", detalhe: projecao.data };
  }

  let gravou: boolean;
  try {
    gravou = await gravar({ [config.campo_saida]: projecao.data });
  } catch (erro) {
    return {
      status: "falhou",
      motivo: "gravacao_falhou",
      detalhe: erro instanceof Error ? erro.message : String(erro),
    };
  }
  if (!gravou) return { status: "falhou", motivo: "gravacao_recusada" };

  return {
    status: "armada",
    data: projecao.data,
    dia_do_aviso: projecao.dia_do_aviso,
    campo: config.campo_saida,
    projecao,
  };
}
