/** O vocabulário das reuniões da agência (docs/agencia/SPEC-calendario.md). CHECK no banco (9005). */
export const TIPOS_DE_REUNIAO = ["apresentacao", "fechamento", "ativacao", "mensal", "interna", "outra"] as const;
export type TipoDeReuniao = (typeof TIPOS_DE_REUNIAO)[number];

export const ROTULO_DO_TIPO: Record<TipoDeReuniao, string> = {
  apresentacao: "Apresentação",
  fechamento: "Fechamento",
  ativacao: "Ativação",
  mensal: "Reunião mensal",
  interna: "Interna",
  outra: "Outra",
};

/** Cor de cada tipo na semana e no mês. */
export const COR_DO_TIPO: Record<TipoDeReuniao, string> = {
  apresentacao: "#2563eb",
  fechamento: "#16a34a",
  ativacao: "#ea580c",
  mensal: "#7c3aed",
  interna: "#64748b",
  outra: "#0d9488",
};

export const FORMATOS = ["online", "presencial", "ligacao"] as const;
export type Formato = (typeof FORMATOS)[number];

export const ROTULO_DO_FORMATO: Record<Formato, string> = {
  online: "Online (Google Meet)",
  presencial: "Presencial",
  ligacao: "Ligação",
};

export const SITUACOES_DA_REUNIAO = ["marcada", "realizada", "remarcada", "cancelada", "nao_compareceu"] as const;
export type SituacaoDaReuniao = (typeof SITUACOES_DA_REUNIAO)[number];

export const ROTULO_DA_SITUACAO: Record<SituacaoDaReuniao, string> = {
  marcada: "Marcada",
  realizada: "Realizada",
  remarcada: "Remarcada",
  cancelada: "Cancelada",
  nao_compareceu: "Não compareceu",
};

/** Os marcos de lembrete que a tela oferece, em minutos antes (CHECK `agencia_config_lembretes`). */
export const MARCOS_DE_LEMBRETE = [10080, 2880, 1440, 180, 60, 30, 15] as const;

export const ROTULO_DO_MARCO: Record<(typeof MARCOS_DE_LEMBRETE)[number], string> = {
  10080: "1 semana antes",
  2880: "2 dias antes",
  1440: "1 dia antes",
  180: "3 horas antes",
  60: "1 hora antes",
  30: "30 minutos antes",
  15: "15 minutos antes",
};

/**
 * A pauta com que a Apresentação nasce (K6): o checklist do apêndice A do mapa
 * de capacidades. Editável no modal; aqui é só o ponto de partida.
 */
export const PAUTA_DA_APRESENTACAO = `O negócio
- O que vocês vendem e qual é o carro-chefe (o que mais dá lucro)?
- Ticket médio e margem aproximada.
- Há quanto tempo existem e como os clientes chegam hoje?
- Tem sazonalidade? Meses fortes e fracos.

O cliente deles
- Quem é o cliente ideal (idade, região, poder de compra)?
- Por que o cliente compra deles e não do concorrente?
- Quais objeções o cliente mais faz antes de fechar?

Concorrência
- Quais concorrentes mais preocupam, e o que fazem bem nas redes?

Objetivo com o marketing
- O que seria sucesso daqui a 3 meses?
- Qual meta concreta (faturamento, clientes por mês, seguidores)?
- O que já tentaram em marketing, o que funcionou e o que não?

Operação e conteúdo
- Quem pode aparecer nos vídeos e tem facilidade para falar?
- Melhores dias e horários para gravar no local.
- Se o marketing trouxer o dobro de clientes, vocês dão conta?
- Verba disponível para anúncios por mês.`;
