/**
 * Os PADRÕES de campanha da organização — `organizations.settings.campanhas`.
 *
 * ═══ O que mora aqui, e por quê ═══
 *
 * Duas coisas que estavam cravadas no código e não deviam estar:
 *
 * 1. A JANELA DE ATRIBUIÇÃO DE RESPOSTA. Era uma constante de 72h. É decisão de
 *    produto, muda a taxa de resposta de toda campanha já enviada, e quem opera
 *    precisa poder ajustá-la sem esperar uma versão nova.
 * 2. O RITMO PADRÃO de campanha nova. Sem isto, quem quer prospectar devagar
 *    tinha de repetir os mesmos quatro números a cada campanha criada — e
 *    esquecer uma vez é a vez que queima o número.
 *
 * ═══ O que NÃO mora aqui ═══
 *
 * A proteção do NÚMERO (intervalo, janela, teto diário, warm-up) continua em
 * `channel_knobs`, editada em Conexões › Proteção de envio. Isto aqui é o
 * padrão da CAMPANHA, e campanha só sabe ir mais devagar que o número. Duplicar
 * a proteção do canal neste jsonb criaria a segunda fonte que a 0375 recusou.
 *
 * Ausente = usa o default do produto. Nenhuma instalação precisa abrir esta tela
 * para a campanha funcionar.
 */
import { z } from "zod";

/**
 * 72 horas: decisão do dono do produto em 2026-09-18. Três dias pegam quem
 * responde no fim de semana sem atribuir à campanha uma conversa que começou por
 * outro motivo semanas depois. Continua sendo o default — o que mudou é que
 * agora se pode mudá-lo sem trocar de versão.
 */
export const ATRIBUICAO_PADRAO_HORAS = 72;

export const configuracaoDeCampanhasSchema = z.object({
  /** Quanto tempo depois do envio uma resposta ainda conta como resposta. */
  atribuicao_horas: z.number().int().min(1).max(720).default(ATRIBUICAO_PADRAO_HORAS),
  /** Ritmo que toda campanha NOVA já nasce sugerindo. `null` = herda o número. */
  intervalo_segundos: z.number().int().min(1).max(86_400).nullable().default(null),
  janela_inicio_hora: z.number().int().min(0).max(23).nullable().default(null),
  janela_fim_hora: z.number().int().min(1).max(24).nullable().default(null),
  teto_diario: z.number().int().min(1).max(10_000).nullable().default(null),
  teto_horario: z.number().int().min(1).max(10_000).nullable().default(null),
});

export type ConfiguracaoDeCampanhas = z.infer<typeof configuracaoDeCampanhasSchema>;

export const CONFIGURACAO_PADRAO: ConfiguracaoDeCampanhas = {
  atribuicao_horas: ATRIBUICAO_PADRAO_HORAS,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
};

/**
 * Lê o que está guardado sem nunca lançar.
 *
 * Config inválida no banco (mão humana, versão antiga, migração pela metade)
 * cai no PADRÃO em vez de derrubar a rodada de envio — falhar aqui pararia a
 * campanha inteira por causa de um número fora de faixa.
 */
export function lerConfiguracao(settings: unknown): ConfiguracaoDeCampanhas {
  if (!settings || typeof settings !== "object") return CONFIGURACAO_PADRAO;
  const bruto = (settings as Record<string, unknown>).campanhas;
  if (!bruto || typeof bruto !== "object") return CONFIGURACAO_PADRAO;
  const r = configuracaoDeCampanhasSchema.safeParse(bruto);
  return r.success ? r.data : CONFIGURACAO_PADRAO;
}

/** A janela de atribuição em milissegundos, que é como o handler a usa. */
export function janelaDeAtribuicaoMs(config: ConfiguracaoDeCampanhas): number {
  return config.atribuicao_horas * 60 * 60 * 1000;
}
