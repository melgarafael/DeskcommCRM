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
 * um mês. Este arquivo é a boca dos três avisos.
 *
 * ─── O texto NÃO tem ramo brasileiro, e isso é decisão de produto ────────────
 *
 * Os avisos novos valem só para organizações FORA do Brasil (decisão de
 * 2026-10-16): no Brasil nada muda por enquanto, porque a promessa feita
 * quando Portugal entrou foi "o Brasil fica exatamente igual" — e texto
 * jurídico com o artigo errado chegando a titular real é pior que nenhum
 * texto. Por isso o ramo pt-BR (o antigo `mensagemDoBrasil`, com a LGPD citada
 * artigo por artigo) SAIU deste arquivo inteiro: o texto brasileiro fica para
 * uma revisão própria. Quem garante que uma organização brasileira não chega
 * aqui é o WORKER (que não chama o aviso de apagamento) e a ROTA do art. 12.º
 * (que recusa antes de tocar em qualquer coisa) — este módulo é a boca dos
 * dois, não a porta.
 *
 * O prazo e a citação continuam vindo do PERFIL DO PAÍS da organização (doc
 * 88, mesma régua do e-mail de exportação): a lei só é citada quando o perfil
 * tem citação revisada (`citacaoDaLei`), e o RÓTULO da linha é o do perfil
 * (`lei.rotuloNoDocumento`) em vez do "Base legal:" fixo — no RGPD, "base
 * legal" é o art. 6.º (licitude) e o art. 15.º é o direito que o titular
 * exerceu.
 *
 * ─── O motivo NÃO é enfeite, e a lei não aceita aviso sem ele ────────────────
 *
 * "Informamos que o pedido foi recusado" sem dizer POR QUÊ não cumpre nada: a
 * norma exige a razão da recusa e o motivo da demora, juntos do prazo. Por isso
 * `montarAvisoArt12` LANÇA `MotivoObrigatorio` quando o desfecho é recusa ou
 * prorrogação e o motivo vem vazio — não é texto que se complete com
 * placeholder, é um pedido de informação que a rota devolve antes de mandar
 * e-mail nenhum.
 *
 * ─── "Dentro do prazo" só se for verdade ────────────────────────────────────
 *
 * O e-mail de APAGAMENTO afirmava ter cumprido o prazo de um mês em todo
 * aviso; o prazo, porém, é contado do recebimento e a cascata pode terminar
 * depois dele. A frase agora é CONDICIONAL (`dentroDoPrazoDeUmMes`): dentro do
 * prazo afirma o cumprimento; fora dele, diz o dia em que o prazo terminou, sem
 * inventar justificativa nenhuma.
 *
 * Nenhum texto daqui carrega o nome do produto: o remetente é a marca de quem
 * OPEROU (`marcaDaSaida`), resolvida por quem chama.
 */
import { NEUTROS_DE_SAIDA, type MarcaDeSaida } from "@/lib/branding/saida";
import { sendEmail } from "@/lib/email/roteador";
import { citacaoDaLei, type PerfilDoPais } from "@/lib/legal/perfil-do-pais";
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
  /** O país da organização decide a lei, o rótulo e a língua do texto. */
  perfil: PerfilDoPais;
  /** Obrigatório em `recusa` e `prorrogacao`; ignorado em `apagamento`. */
  motivo?: string | null;
  /** A data nova prometida na prorrogação. */
  novaData?: Date | null;
  /** O prazo de um mês, contado do recebimento — é ele que o texto afirma cumprir. */
  prazoDeUmMes: Date;
  /** Recebimento do pedido, para o texto mostrar de quando se conta. */
  recebidoEm: Date;
  /** O instante do envio, injetável para o texto poder ser medido; padrão: agora. */
  agora?: Date;
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
 * O rótulo da linha da lei, do PERFIL — como o e-mail de exportação faz.
 *
 * O Brasil não declara `rotuloNoDocumento`, e por isso o rótulo de sempre
 * ("Base legal") continua valendo onde ninguém declarou nada. Portugal declara
 * "Direito exercido": no RGPD, "base legal" é o art. 6.º (licitude), e o art.
 * 15.º é o direito que o titular exerceu — o mesmo motivo escrito em
 * `lib/legal/perfil-do-pais.ts`.
 */
function rotuloDaBaseLegal(perfil: PerfilDoPais): string {
  return perfil.lei?.rotuloNoDocumento ?? "Base legal";
}

/** A linha da citação pronta (rótulo do perfil + lei revisada), ou `null` sem lei revisada. */
function linhaDaBaseLegal(perfil: PerfilDoPais): string | null {
  const citacao = citacaoDaLei(perfil);
  return citacao ? `${rotuloDaBaseLegal(perfil)}: ${citacao}.` : null;
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
  return mensagem(aviso, shortId, escapeHtml(aviso.marca.nome), motivo);
}

/**
 * O corpo do aviso, para a organização de FORA do Brasil (pt-PT, sem LGPD).
 *
 * É a única forma de texto deste módulo: o ramo brasileiro saiu inteiro
 * (decisão de produto de 2026-10-16, ver o cabeçalho).
 */
function mensagem(
  aviso: AvisoArt12,
  shortId: string,
  orgName: string,
  motivo: string | null,
): TextoDoAviso {
  const base = linhaDaBaseLegal(aviso.perfil);
  const prazoFmt = dataComFuso(aviso.prazoDeUmMes, aviso.fuso);
  const recebidoFmt = dataComFuso(aviso.recebidoEm, aviso.fuso);
  // A frase do prazo só afirma cumprimento quando o cumprimento aconteceu.
  const dentro = dentroDoPrazoDeUmMes(aviso.recebidoEm, aviso.agora ?? new Date());

  const linhas: Record<DesfechoDoPedido, { subject: string; bloco: string[] }> = {
    apagamento: {
      subject: `O seu pedido de dados pessoais foi atendido #${shortId}`,
      bloco: [
        `  <p>O seu pedido de eliminação de dados pessoais foi atendido por <strong>${orgName}</strong>: o contacto, a conversação e o histórico de atendimento que tínhamos sobre si foram apagados de forma irreversível.</p>`,
        "  <p>O que permanece não o identifica: o que ficou é estatístico e operacional, sem nome, telefone, e-mail ou documento.</p>",
        dentro
          ? `  <p>Atendido dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}), como a lei exige para a eliminação.</p>`
          : `  <p>O prazo de um mês a contar do recebimento terminou em ${prazoFmt}; este aviso segue depois do cumprimento do pedido.</p>`,
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
        `  <p>A resposta deve sair até ${dataComFuso(aviso.novaData ?? aviso.prazoDeUmMes, aviso.fuso)}. A prorrogação é comunicada dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}).</p>`,
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
    text: textoPuro(aviso, shortId, aviso.marca.nome, motivo, dentro),
  };
}

/** O texto puro — mesma língua e mesmo prazo condicional do HTML. */
function textoPuro(
  aviso: AvisoArt12,
  shortId: string,
  marca: string,
  motivo: string | null,
  dentro: boolean,
): string {
  const prazoFmt = dataComFuso(aviso.prazoDeUmMes, aviso.fuso);
  const cabecalho = `Pedido #${shortId} de dados pessoais, tratado por ${marca}.`;
  const corpo: Record<DesfechoDoPedido, string[]> = {
    apagamento: [
      "O seu pedido de eliminação de dados pessoais foi atendido: os seus dados foram apagados de forma irreversível — o contacto, a conversação e o histórico de atendimento.",
      dentro
        ? `O seu pedido foi atendido dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}).`
        : `O prazo de um mês a contar do recebimento terminou em ${prazoFmt}; este aviso segue depois do cumprimento do pedido.`,
    ],
    recusa: [
      `O seu pedido NÃO foi atendido. Motivo: ${motivo ?? ""}`,
      `Aviso enviado dentro do prazo de um mês a contar do recebimento (até ${prazoFmt}).`,
    ],
    prorrogacao: [
      `O seu pedido continua em tratamento e foi prorrogado. Motivo: ${motivo ?? ""}`,
      `Resposta prevista até ${dataComFuso(aviso.novaData ?? aviso.prazoDeUmMes, aviso.fuso)}; prorrogação comunicada dentro do prazo de um mês (até ${prazoFmt}).`,
    ],
  };
  const cit = linhaDaBaseLegal(aviso.perfil);
  return [cabecalho, "", ...corpo[aviso.desfecho], "", cit ?? ""].filter(Boolean).join("\n");
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
