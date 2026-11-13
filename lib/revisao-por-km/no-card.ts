/**
 * A porta do CARD (e da API, do MCP e do webhook de entrada) para a revisão por
 * quilometragem (issue #4376).
 *
 * Toda edição de negócio passa por `updateLeadHandler`, e é ele que grava
 * `custom_fields` pela função do banco (`fn_lead_anotar_campos`, migration
 * 0502). Aqui fica só a montagem do contexto dessa porta: o fuso da organização
 * (o "hoje" é o dela, nunca o do servidor) e o gravador que usa a MESMA função —
 * o caminho que a ação `set_lead_date_field` (#3727) já usa.
 *
 * A decisão de gravar (e o que não gravar) mora em `decisao.ts`;
 * as portas entram por parâmetro para o teste não precisar de Supabase.
 */
import { diaLocal, fusoDaOrganizacao } from "@/lib/automation/cron-de-data";
import { configuracaoDeRevisaoPorKm } from "@/lib/revisao-por-km/conta";
import { armarProximaRevisao, type ResultadoDaArmacao } from "@/lib/revisao-por-km/decisao";
import { revisaoPorKmLigada } from "@/lib/revisao-por-km/modulo";

/** O que a porta precisa do mundo — o handler entrega o cliente já ligado. */
export interface PortasDoCard {
  /** `organizations.timezone`; `null` cai no padrão do produto. */
  fusoDaOrganizacao: () => Promise<string | null>;
  /** Grava no `custom_fields` pela função do banco; `false` = card fechado/sumiu. */
  gravarCampos: (campos: Record<string, unknown>) => Promise<boolean>;
}

export async function armarProximaRevisaoNoCard(args: {
  settings: Record<string, unknown> | null;
  camposAnteriores?: Record<string, unknown> | undefined;
  campos: Record<string, unknown>;
  portas: PortasDoCard;
  /** Injetável para o teste; em produção é o relógio do processo. */
  agora?: Date;
}): Promise<ResultadoDaArmacao> {
  // ── O PORTÃO (adaptação do #4536 para módulo opcional) ─────────────────────
  //
  // A ordem é o custo de quem não usa: (1) o funil declarou a régua? O `settings`
  // já veio na mão do handler, então perguntar é de graça — e um PATCH em funil
  // sem régua sai daqui sem nenhuma ida ao banco a mais que a `main`. (2) Só então
  // a chave da instalação (`MODULO_REVISAO_POR_KM`), que custa uma leitura.
  const declarada = configuracaoDeRevisaoPorKm(args.settings);
  if (!declarada.ok && declarada.motivo === "ausente") {
    return { status: "nenhuma_escrita", motivo: "sem_configuracao" };
  }
  if (!(await revisaoPorKmLigada())) {
    return { status: "nenhuma_escrita", motivo: "modulo_desligado" };
  }

  let fuso: string | null = null;
  try {
    fuso = await args.portas.fusoDaOrganizacao();
  } catch {
    // Fuso ilegível não pode impedir a data de ser gravada — mesma doutrina da
    // ação `set_lead_date_field`. O padrão do produto é declarado, não silencioso.
    fuso = null;
  }

  return armarProximaRevisao(
    {
      settings: args.settings,
      campos: args.campos,
      camposAnteriores: args.camposAnteriores,
      hoje: diaLocal(args.agora ?? new Date(), fusoDaOrganizacao(fuso)),
    },
    args.portas.gravarCampos,
  );
}
