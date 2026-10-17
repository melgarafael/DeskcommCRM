/**
 * OS AVISOS DO ART. 12.º — o que o sistema diz ao TITULAR depois que decide.
 *
 * ─── Por que este módulo existe ──────────────────────────────────────────────
 *
 * A triagem do #2342 mediu três falhas no mesmo pedido de exclusão. Duas
 * entraram na cascata (rótulo derivado do id, `messages.external_id` legível);
 * a terceira é esta: a anonimização terminava em silêncio. O art. 12.º, n.º 3
 * do RGPD obriga a informar o titular depois de apagar, e os n.ºs 3 e 4
 * obrigam a informar a RECUSA — ou a PRORROGAÇÃO, com o MOTIVO — no prazo de
 * um mês. O Brasil diz o mesmo em palavras diferentes: LGPD art. 18, I
 * (eliminação), art. 19, §1 (confirmação ou negativa) e art. 19, §2 (prorrogação
 * justificada). Este arquivo é a boca única dos três avisos.
 *
 * ─── O motivo NÃO é enfeite, e a lei não aceita aviso sem ele ────────────────
 *
 * "Informamos que o pedido foi recusado" sem dizer POR QUÉ não cumpre nada: a
 * norma exige a razão da recusa e o motivo da demora, juntos do prazo. Por isso
 * `montarAvisoArt12` LANÇA `MotivoObrigatorio` quando o desfecho é recusa ou
 * prorrogação e o motivo vem vazio — não é texto que se complete com
 * placeholder, é um pedido de informação que a rota devolve antes de mandar
 * e-mail nenhum.
 *
 * ─── O texto depende do PAÍS da organização (doc 88, mesma régua do e-mail de
 * exportação) ────────────────────────────────────────────────────────────────
 *
 * Brasil: pt-BR, LGPD citada com número de artigo. Fora do Brasil: pt-PT, sem
 * LGPD, com a lei do país citada só quando o perfil tem citação revisada
 * (`citacaoDaLei`). Um titular português recebendo "LGPD art. 18" é o defeito
 * que o `lib/lgpd/email-delivery.ts` já consertou no e-mail de exportação — e a
 * mesma frase escrita em dois lugares é frase que diverge no primeiro ajuste.
 *
 * Nenhum texto daqui carrega o nome do produto: o remetente é a marca de quem
 * OPEROU (`marcaDaSaida`), resolvida por quem chama.
 */
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";
import { citacaoDaLei, PAIS_PADRAO, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
import { EmailNotConfigured, EmailSendFailed } from "@/lib/lgpd/email-delivery";

export class MotivoObrigatorio extends Error {
  constructor() {
    super("o aviso de recusa ou prorrogação do art. 12.º exige o motivo escrito");
    this.name = "MotivoObrigatorio";
  }
}

/** Os TRÊS desfechos que a lei manda comunicar ao titular. */
export type DesfechoDoPedido = "apagamento" | "recusa" | "prorrogacao";

export interface AvisoArt12 {
  desfecho: DesfechoDoPedido;
  /** `lgpd_requests.id` — o mesmo curto do e-mail de exportação. */
  requestId: string;
  /** A marca de quem OPEROU o pedido, já resolvida por `marcaDaSaida`. */
  marca: MarcaDeSaida;
  /** O país da organização decide a lei e o idioma do texto. */
  perfil: PerfilDoPais;
  /** Obrigatório em `recusa` e `prorrogacao`; ignorado em `apagamento`. */
  motivo?: string | null;
  /** A data nova prometida na prorrogação. */
  novaData?: Date | null;
  /** O prazo de um mês, contado do recebimento — é ele que o texto afirma cumprir. */
  prazoDeUmMes: Date;
  /** Recebimento do pedido, para o texto mostrar de quando se conta. */
  recebidoEm: Date;
  /** Só fora do Brasil; o mesmo contrato do e-mail de exportação. */
  fuso?: string | undefined;
}

export interface TextoDoAviso {
  subject: string;
  html: string;
  text: string;
}

/**
 * O fim do prazo de um mês contado de `recebidoEm`.
 *
 * `setUTCMonth` normaliza o overflow (`2026-01-31` vira `2026-03-03`) em vez de
 * recusar, e é de propósito: a norma fala em mês, não em "o mesmo dia do mês
 * seguinte quando existe" — e um prazo que a data estourasse seria prazo
 * perdido no calendário, não no atendimento.
 */
export function prazoDeUmMes(recebidoEm: Date): Date {
  const fim = new Date(recebidoEm.getTime());
  fim.setUTCMonth(fim.getUTCMonth() + 1);
  return fim;
}

/**
 * O aviso de recusa/prorrogação tem de sair até aqui — art. 12.º, n.os 3 e 4.
 *
 * O prazo é de um MÊS, e um mês vence num DIA: o aviso vale até o FIM do dia do
 * vencimento, não até a hora exata do recebimento um mês depois. A norma fala em
 * mês de calendário; travar na hora encurtaria o prazo que a lei dá — e perder
 * prazo por causa do relógio seria prazo perdido no atendimento.
 */
export function dentroDoPrazoDeUmMes(recebidoEm: Date, agora: Date = new Date()): boolean {
  const fim = prazoDeUmMes(recebidoEm);
  const fimDoDia = Date.UTC(fim.getUTCFullYear(), fim.getUTCMonth(), fim.getUTCDate() + 1) - 1;
  return agora.getTime() <= fimDoDia;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dataBR(quando: Date): string {
  return quando.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });
}

/** O prazo escrito no fuso da organização, com o NOME do fuso — mesma borda do e-mail de exportação. */
function dataComFuso(quando: Date, fuso: string | undefined): string {
  const formato = (timeZone: string) => quando.toLocaleDateString("pt-PT", { timeZone, timeZoneName: "short" });
  try {
    return formato(fuso ?? "UTC");
  } catch {
    return formato("UTC");
  }
}

const MOTIVOS_OBRIGATORIOS: ReadonlySet<DesfechoDoPedido> = new Set(["recusa", "prorrogacao"]);

/** O motivo limpo; `null` quando não veio nada que preste. */
function motivoLido(aviso: AvisoArt12): string | null {
  const bruto = (aviso.motivo ?? "").trim();
  return bruto === "" ? null : bruto;
}

/**
 * Monta o aviso. Função PURA: não lê `env`, não manda e-mail, não toca banco —
 * é ela que os testes leem linha a linha.
 */
export function montarAvisoArt12(aviso: AvisoArt12): TextoDoAviso {
  const motivo = motivoLido(aviso);
  if (MOTIVOS_OBRIGATORIOS.has(aviso.desfecho) && motivo === null) {
    throw new MotivoObrigatorio();
  }

  const shortId = aviso.requestId.slice(0, 8);
  const orgName = escapeHtml(aviso.marca.nome);
  const noBrasil = aviso.perfil.codigo === PAIS_PADRAO;

  return noBrasil ? mensagemDoBrasil(aviso, shortId, orgName, motivo) : mensagemForaDoBrasil(aviso, shortId, orgName, motivo, aviso.fuso);
}

function mensagemDoBrasil(
  aviso: AvisoArt12,
  shortId: string,
  orgName: string,
  motivo: string | null,
): TextoDoAviso {
  const prazoFmt = dataBR(aviso.prazoDeUmMes);
  const recebidoFmt = dataBR(aviso.recebidoEm);

  const linhas: Record<DesfechoDoPedido, { subject: string; bloco: string[] }> = {
    apagamento: {
      subject: `Seus dados pessoais foram apagados #${shortId}`,
      bloco: [
        `  <p>Seu pedido de eliminação de dados pessoais foi atendido por <strong>${orgName}</strong>: o contato, a conversa e o histórico de atendimento que tínhamos sobre você foram apagados de forma irreversível.</p>`,
        "  <p>O que permanece não o identifica: o que ficou é estatístico e operacional, sem nome, telefone, e-mail ou documento.</p>",
        `  <p>Atendido dentro do prazo de um mês contado do recebimento (até ${prazoFmt}), como a lei exige para a eliminação.</p>`,
        "  <p style=\"font-size:12px;color:" + NEUTROS_DE_SAIDA.suave + ";\">Base legal: LGPD Lei nº 13.709/2018, art. 18, I (eliminação de dados pessoais), com a confirmação do art. 12.</p>",
      ],
    },
    recusa: {
      subject: `Seu pedido de dados pessoais não foi atendido #${shortId}`,
      bloco: [
        `  <p>Seu pedido de dados pessoais, recebido em ${recebidoFmt}, <strong>não foi atendido</strong> por <strong>${orgName}</strong>.</p>`,
        `  <p><strong>Motivo:</strong> ${escapeHtml(motivo ?? "")}</p>`,
        `  <p>Este aviso chega dentro do prazo de um mês contado do recebimento (até ${prazoFmt}), como a lei exige para a recusa.</p>`,
        "  <p style=\"font-size:12px;color:" + NEUTROS_DE_SAIDA.suave + ";\">Base legal: LGPD Lei nº 13.709/2018, art. 19, §1 (confirmação ou negativa do tratamento) e art. 12.</p>",
      ],
    },
    prorrogacao: {
      subject: `Seu pedido de dados pessoais foi prorrogado #${shortId}`,
      bloco: [
        `  <p>Seu pedido de dados pessoais, recebido em ${recebidoFmt}, segue em tratamento por <strong>${orgName}</strong> e foi prorrogado.</p>`,
        `  <p><strong>Motivo da prorrogação:</strong> ${escapeHtml(motivo ?? "")}</p>`,
        `  <p>A resposta deve sair até ${dataBR(aviso.novaData ?? aviso.prazoDeUmMes)}. O aviso da prorrogação, com o motivo, chega dentro do prazo de um mês contado do recebimento (até ${prazoFmt}).</p>`,
        "  <p style=\"font-size:12px;color:" + NEUTROS_DE_SAIDA.suave + ";\">Base legal: LGPD Lei nº 13.709/2018, art. 19, §§1 e 2 (prorrogação justificada) e art. 12.</p>",
      ],
    },
  };

  const escolhido = linhas[aviso.desfecho];
  const corpo = `${escolhido.bloco.join("\n")}\n  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">Se você não reconhece este pedido, ignore este e-mail — nenhuma ação é necessária.</p>\n  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">PEDIDO:${shortId}</p>`;

  return {
    subject: escolhido.subject,
    html: `<!doctype html>
<html lang="pt-BR">
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:${NEUTROS_DE_SAIDA.texto};line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <p>Olá,</p>
${corpo}
</body>
</html>`,
    text: textoPuro(aviso, shortId, aviso.marca.nome, motivo, "pt-BR"),
  };
}

function mensagemForaDoBrasil(
  aviso: AvisoArt12,
  shortId: string,
  orgName: string,
  motivo: string | null,
  fuso: string | undefined,
): TextoDoAviso {
  const citacao = citacaoDaLei(aviso.perfil);
  const base = citacao ? `Base legal: ${citacao}.` : null;
  const prazoFmt = dataComFuso(aviso.prazoDeUmMes, fuso);
  const recebidoFmt = dataComFuso(aviso.recebidoEm, fuso);

  const linhas: Record<DesfechoDoPedido, { subject: string; bloco: string[] }> = {
    apagamento: {
      subject: `O seu pedido de dados pessoais foi atendido #${shortId}`,
      bloco: [
        `  <p>O seu pedido de eliminação de dados pessoais foi atendido por <strong>${orgName}</strong>: o contacto, a conversação e o histórico de atendimento que tínhamos sobre si foram apagados de forma irreversível.</p>`,
        "  <p>O que permanece não o identifica: o que ficou é estatístico e operacional, sem nome, telefone, e-mail ou documento.</p>",
        `  <p>Atendido dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}), como a lei exige para a eliminação.</p>`,
      ],
    },
    recusa: {
      subject: `O seu pedido de dados pessoais não foi atendido #${shortId}`,
      bloco: [
        `  <p>O seu pedido de dados pessoais, recebido em ${recebidoFmt}, <strong>não foi atendido</strong> por <strong>${orgName}</strong>.</p>`,
        `  <p><strong>Motivo:</strong> ${escapeHtml(motivo ?? "")}</p>`,
        `  <p>Este aviso segue o prazo de um mês a contar do recebimento (até ${prazoFmt}), como a lei exige para a recusa.</p>`,
      ],
    },
    prorrogacao: {
      subject: `O seu pedido de dados pessoais foi prorrogado #${shortId}`,
      bloco: [
        `  <p>O seu pedido de dados pessoais, recebido em ${recebidoFmt}, continua em tratamento por <strong>${orgName}</strong> e foi prorrogado.</p>`,
        `  <p><strong>Motivo da prorrogação:</strong> ${escapeHtml(motivo ?? "")}</p>`,
        `  <p>A resposta deve sair até ${dataComFuso(aviso.novaData ?? aviso.prazoDeUmMes, fuso)}. A prorrogação é comunicada dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}).</p>`,
      ],
    },
  };

  const escolhido = linhas[aviso.desfecho];
  const extras: string[] = [];
  if (base) extras.push(`  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">${escapeHtml(base)}</p>`);
  const corpo = `${escolhido.bloco.join("\n")}\n${extras.join("\n")}\n  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">Se não fez este pedido, ignore este e-mail — não é necessária nenhuma ação.</p>\n  <p style="font-size:12px;color:${NEUTROS_DE_SAIDA.suave};">PEDIDO:${shortId}</p>`;

  return {
    subject: escolhido.subject,
    html: `<!doctype html>
<html lang="pt-PT">
<body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:${NEUTROS_DE_SAIDA.texto};line-height:1.5;max-width:560px;margin:0 auto;padding:24px;">
  <p>Olá,</p>
${corpo}
</body>
</html>`,
    text: textoPuro(aviso, shortId, aviso.marca.nome, motivo, "pt-PT"),
  };
}

function textoPuro(
  aviso: AvisoArt12,
  shortId: string,
  marca: string,
  motivo: string | null,
  idioma: "pt-BR" | "pt-PT",
): string {
  const br = idioma === "pt-BR";
  const prazoFmt = br ? dataBR(aviso.prazoDeUmMes) : dataComFuso(aviso.prazoDeUmMes, aviso.fuso);
  const cabecalho = `Pedido #${shortId} de dados pessoais, tratado por ${marca}.`;
  const corpo: Record<DesfechoDoPedido, string[]> = {
    apagamento: br
      ? [
          "Seus dados pessoais foram apagados de forma irreversível: o contato, a conversa e o histórico de atendimento.",
          `Seu pedido foi atendido dentro do prazo de um mês contado do recebimento (até ${prazoFmt}).`,
        ]
      : [
          "O seu pedido de eliminação de dados pessoais foi atendido: os seus dados foram apagados de forma irreversível — o contacto, a conversação e o histórico de atendimento.",
          `O seu pedido foi atendido dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}).`,
        ],
    recusa: br
      ? [
          `Seu pedido NÃO foi atendido. Motivo: ${motivo ?? ""}`,
          `Aviso enviado dentro do prazo de um mês contado do recebimento (até ${prazoFmt}).`,
        ]
      : [
          `O seu pedido NÃO foi atendido. Motivo: ${motivo ?? ""}`,
          `Aviso enviado dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}).`,
        ],
    prorrogacao: br
      ? [
          `Seu pedido segue em tratamento e foi prorrogado. Motivo: ${motivo ?? ""}`,
          `Resposta prevista até ${dataBR(aviso.novaData ?? aviso.prazoDeUmMes)}; prorrogação comunicada dentro do prazo de um mês (até ${prazoFmt}).`,
        ]
      : [
          `O seu pedido continua em tratamento e foi prorrogado. Motivo: ${motivo ?? ""}`,
          `Resposta prevista até ${dataComFuso(aviso.novaData ?? aviso.prazoDeUmMes, aviso.fuso)}; prorrogação comunicada dentro do prazo de um mês (até ${prazoFmt}).`,
        ],
  };
  const cit = citacaoDaLei(aviso.perfil);
  return [cabecalho, "", ...corpo[aviso.desfecho], "", cit ? `Base legal: ${cit}.` : ""].filter(Boolean).join("\n");
}

/**
 * Manda o aviso pelo transporte que a instalação tiver (o mesmo roteador do
 * e-mail de exportação). NUNCA grava o endereço do titular no log: só o
 * `request_short` entra nas tags.
 */
export async function sendAvisoArt12(aviso: AvisoArt12, to: string): Promise<{ messageId: string }> {
  const { subject, html, text } = montarAvisoArt12(aviso);
  const shortId = aviso.requestId.slice(0, 8);

  const result = await sendEmail({
    to,
    subject,
    html,
    text,
    fromName: aviso.marca.nome,
    tags: [
      { name: "kind", value: `lgpd_art12_${aviso.desfecho}` },
      { name: "request_short", value: shortId },
    ],
  });

  if (!result.ok) {
    if (result.error === "not_configured") {
      throw new EmailNotConfigured();
    }
    throw new EmailSendFailed(result.details ?? result.error ?? "unknown");
  }

  return { messageId: result.id ?? "unknown" };
}
