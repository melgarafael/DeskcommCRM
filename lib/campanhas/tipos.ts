/**
 * O vocabulário do módulo de Campanhas — os dois conjuntos de estado e os
 * motivos de exclusão, num lugar só.
 *
 * Os valores são os mesmos do CHECK da migration 0375, estendido pela 0563
 * (`personal`). Quem mudar um lado muda o outro: `tests/invariants/vocabulario-banco-x-typescript.test.ts` varre as
 * colunas que têm CHECK e reprova divergência.
 */

export const STATUS_DA_CAMPANHA = [
  "draft",
  "preparing",
  "ready",
  "scheduled",
  "running",
  "paused",
  "completed",
  "cancelled",
  "failed",
] as const;

export type StatusDaCampanha = (typeof STATUS_DA_CAMPANHA)[number];

/**
 * O que a campanha manda (migrations 0710 e 9334). `text` = corpo livre em
 * `message_body`, para número por QR; `template` = modelo aprovado, para número
 * oficial, que só aceita texto livre dentro das 24 horas da última mensagem do
 * cliente — e campanha fala justamente com quem não escreveu; `email` = assunto
 * em `email_subject` mais corpo em `message_body`, sem número nenhum (#3441).
 */
export const MODOS_DA_MENSAGEM = ["text", "template", "email"] as const;

export type ModoDaMensagem = (typeof MODOS_DA_MENSAGEM)[number];

/**
 * Em que velocidade a campanha sai (migration 0711). `gradual` = uma mensagem
 * por número a cada rodada do cron (uma por minuto) — a proteção do número por
 * QR e o mais seguro para a qualidade de qualquer número. `rapida` = rajada de
 * várias por segundo, só com modelo aprovado: o número oficial não é banido por
 * volume, quem limita ali é a plataforma (nível diário e mensagens por segundo).
 * `transmissao` (migration 0712) = a lista inteira entregue ao PROVEDOR numa
 * chamada, que manda a todos e devolve o relatório por destinatário — só no
 * número cujo provedor faz transmissão, e só com variáveis de texto fixo.
 */
export const VELOCIDADES_DA_CAMPANHA = ["gradual", "rapida", "transmissao"] as const;

export type VelocidadeDaCampanha = (typeof VELOCIDADES_DA_CAMPANHA)[number];

export function ehVelocidadeDaCampanha(v: unknown): v is VelocidadeDaCampanha {
  return typeof v === "string" && (VELOCIDADES_DA_CAMPANHA as readonly string[]).includes(v);
}

export const STATUS_DO_DESTINATARIO = [
  "pending",
  "queued",
  "sending",
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "cancelled",
  "opted_out",
  /** Spec 21: saída própria de quem vira pessoal — nunca `opted_out` (D7). */
  "personal",
] as const;

export type StatusDoDestinatario = (typeof STATUS_DO_DESTINATARIO)[number];

/**
 * Estados dos quais o despacho não tira mais ninguém.
 *
 * `sent` está aqui e continua evoluindo para `delivered`/`read`/`replied`: a
 * campanha conclui quando não há mais o que DESPACHAR, não quando todo mundo
 * leu — esperar leitura deixaria campanha aberta para sempre por causa de quem
 * nunca abre o WhatsApp.
 */
export const TERMINAIS_DE_DESPACHO: ReadonlySet<StatusDoDestinatario> = new Set([
  "sent",
  "delivered",
  "read",
  "replied",
  "failed",
  "skipped",
  "cancelled",
  "opted_out",
  "personal",
]);

/**
 * Por que alguém do recorte não vai receber.
 *
 * Código, não frase: a frase é traduzida na borda (`TEXTO_DA_EXCLUSAO`), e
 * gravar frase no banco impede contar "quantos por motivo" sem `like`.
 */
export const MOTIVOS_DE_EXCLUSAO = [
  "sem_telefone",
  "telefone_invalido",
  "opt_out",
  "anonimizado",
  "recusou_marketing",
  "excluido_manualmente",
  "duplicado",
  "variavel_ausente",
  "ja_em_campanha",
  "suprimido",
  /** Spec 21: o contato virou pessoal e saiu da campanha com a saída própria. */
  "contato_pessoal",
  /**
   * Campanha de e-mail (#3441): o recorte é o mesmo, o ENDEREÇO muda. Contato
   * sem e-mail não recebe e-mail — o telefone dele não serve para nada aqui, e
   * reaproveitar `sem_telefone` faria a tela mentir sobre o motivo.
   */
  "sem_email",
  "email_invalido",
] as const;

export type MotivoDeExclusao = (typeof MOTIVOS_DE_EXCLUSAO)[number];

/** O que o operador lê na tela. Espanhol entra pelo `traduzir()` da borda. */
export const TEXTO_DA_EXCLUSAO: Record<MotivoDeExclusao, string> = {
  sem_telefone: "Sem telefone no cadastro",
  telefone_invalido: "Telefone fora do formato de envio",
  opt_out: "Pediu para não receber mensagens",
  anonimizado: "Contato anonimizado (LGPD)",
  recusou_marketing: "Recusou receber contato comercial",
  excluido_manualmente: "Excluído à mão desta campanha",
  // "Endereço", e não "telefone": a unicidade é do canal, e na campanha de
  // e-mail o que se repete é o e-mail (#3441).
  duplicado: "Mesmo endereço de outro contato da lista",
  variavel_ausente: "Falta um dado que a mensagem usa",
  ja_em_campanha: "Já está em outra campanha ainda não concluída",
  suprimido: "Está na lista de exclusão de campanhas",
  contato_pessoal: "Contato marcado como pessoal",
  sem_email: "Sem e-mail no cadastro",
  email_invalido: "E-mail fora do formato de envio",
};
