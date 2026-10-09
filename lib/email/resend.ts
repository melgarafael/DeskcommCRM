/**
 * Resend wrapper. Usado por: convites de team, LGPD (export + alarme de SLA).
 *
 * ── O remetente é do OPERADOR; o nome de exibição é da MARCA ─────────────────
 *
 * `RESEND_FROM_EMAIL` é um endereço de um domínio que precisa estar VERIFICADO
 * na conta Resend de quem instalou — é do operador, e nenhuma resolução de
 * marca muda isso. O que a marca resolve é o NOME de exibição (`fromName`),
 * que é o que o destinatário lê na caixa de entrada. É aqui que o white-label
 * do remetente acontece, e é só aqui.
 *
 * ── Por que vazio significa NÃO CONFIGURADO ─────────────────────────────────
 *
 * O fallback antigo era `"Deskcomm <noreply@deskcomm.app>"`. Num clone isso é
 * PIOR que nada: o domínio não está verificado na conta Resend do revendedor,
 * então TODO envio falha lá na Resend e volta como `send_failed` com mensagem
 * opaca — o operador vai caçar rede, contêiner e chave, quando o problema é uma
 * variável em branco. Tratar como não-configurado joga o fluxo no caminho que
 * JÁ existe e JÁ é bom: `EmailNotConfigured` → `pending_review` no worker de
 * LGPD (`workers/lgpd-export-worker.ts:254-289`) e o convite mostrando o
 * `accept_url` na tela (`app/api/v1/team/invite/route.ts`).
 *
 * As duas chaves saíram do `process.env` cru e entraram no Zod (`lib/env.ts`).
 * Fora dele elas ficavam fora do `.env.example` e fora do `install.sh`, e o
 * `.env` é escrito com truncamento: chave posta à mão sumia no update seguinte.
 */
import { Resend } from "resend";

import { valorDaInstalacao } from "@/lib/instalacao/config";

interface SendArgs {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  replyTo?: string;
  tags?: { name: string; value: string }[];
  /**
   * Nome de exibição do remetente — a marca resolvida (`marcaDaSaida().nome`).
   * Ausente usa o endereço puro: quem não passa marca não ganha a nossa.
   */
  fromName?: string;
}

interface SendResult {
  ok: boolean;
  id?: string;
  error?: "not_configured" | "send_failed" | "rate_limited" | "dominio_nao_verificado";
  details?: string;
}

/**
 * ⚠️ SEM memo de módulo, e a remoção é o ponto da mudança.
 *
 * Isto era `let _client` guardando o cliente do primeiro envio. Enquanto a chave
 * vinha do `.env` — congelada no boot — o memo era inócuo: o valor não mudava
 * durante a vida do processo. Agora ela vem do banco e PODE mudar pela tela, e o
 * mesmo memo passaria a ser um bug: o operador troca a chave, a tela diz
 * "salvo", e este processo segue mandando e-mail com a chave velha até alguém
 * reiniciar o servidor. Pior no `worker`, que é outro processo e nem veria a
 * escrita.
 *
 * Construir um `Resend` é montar um objeto com uma string; o custo de fazê-lo
 * por envio é irrelevante perto de uma chamada de rede ao provedor.
 */
function criarCliente(key: string | null): Resend | null {
  if (!key || key.length < 10) return null;
  return new Resend(key);
}

/**
 * `null` = não há remetente utilizável. Nunca inventa um domínio nosso.
 *
 * O nome de exibição é sanitizado: `<`, `>`, `"` e quebra de linha dentro do
 * cabeçalho `From:` são injeção de cabeçalho SMTP, e a marca vem de um campo
 * que o operador digita numa tela.
 */
export function fromAddress(remetente: string | null, fromName?: string): string | null {
  const endereco = (remetente ?? "").trim();
  if (endereco.length === 0) return null;
  // ⚠️ O ENDEREÇO também é entrada não confiável desde a 0341, e antes não era.
  //
  // Enquanto ele vinha só do `.env`, mexer nele exigia SSH na VPS — quem podia
  // fazer isso já tinha o servidor. Agora ele vem de um campo de tela, e um
  // `\r\n` aqui emenda um cabeçalho novo no `From:` (um `Bcc:` para terceiro, por
  // exemplo). O nome já era sanitizado por esse motivo; o endereço passa a ser
  // pelo mesmo, e RECUSA em vez de limpar: endereço com caractere de cabeçalho
  // não é um endereço a consertar, é um endereço a não usar. Falha fechada.
  if (/[<>"\r\n,;\s]/.test(endereco)) return null;
  const nome = (fromName ?? "").replace(/[<>"\r\n]/g, "").trim();
  return nome.length > 0 ? `${nome} <${endereco}>` : endereco;
}

/**
 * A Resend recusa domínio não verificado com uma mensagem própria, e o ramo
 * genérico `send_failed` a apagava. Classificar aqui é o que faz a diferença
 * entre "reinicie o container" e "verifique seu domínio na Resend" — a lição
 * já paga neste projeto: erro que não nomeia a causa vira caça ao fantasma.
 */
function classificar(nome: string, mensagem: string): NonNullable<SendResult["error"]> {
  if (nome.toLowerCase().includes("rate")) return "rate_limited";
  if (/not verified|domain is not verified|não verificad/i.test(mensagem)) {
    return "dominio_nao_verificado";
  }
  return "send_failed";
}

export async function sendEmail(args: SendArgs): Promise<SendResult> {
  // Banco acima, arquivo de instalação embaixo — a cada envio, nunca do boot.
  const [chave, remetente] = await Promise.all([
    valorDaInstalacao("RESEND_API_KEY"),
    valorDaInstalacao("RESEND_FROM_EMAIL"),
  ]);
  const client = criarCliente(chave.valor);
  const from = fromAddress(remetente.valor, args.fromName);

  if (!client || !from) {
    if (process.env.NODE_ENV !== "production") {
      console.warn(
        "[email] envio desligado — falta RESEND_API_KEY ou RESEND_FROM_EMAIL.",
        {
          tem_chave: client !== null,
          tem_remetente: from !== null,
        },
      );
    }
    return { ok: false, error: "not_configured" };
  }

  try {
    const { data, error } = await client.emails.send({
      from,
      to: args.to,
      subject: args.subject,
      html: args.html,
      text: args.text,
      replyTo: args.replyTo,
      tags: args.tags,
    });

    if (error) {
      return {
        ok: false,
        error: classificar(String(error.name || ""), error.message ?? ""),
        details: error.message,
      };
    }
    return { ok: true, id: data?.id };
  } catch (err) {
    return {
      ok: false,
      error: "send_failed",
      details: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Chave E remetente. Só a chave não basta: com `RESEND_FROM_EMAIL` vazio todo
 * envio devolve `not_configured`, e uma tela que dissesse "e-mail configurado"
 * mandaria o operador esperar uma mensagem que nunca sai.
 */
export async function isEmailConfigured(): Promise<boolean> {
  const [chave, remetente] = await Promise.all([
    valorDaInstalacao("RESEND_API_KEY"),
    valorDaInstalacao("RESEND_FROM_EMAIL"),
  ]);
  return criarCliente(chave.valor) !== null && fromAddress(remetente.valor) !== null;
}
