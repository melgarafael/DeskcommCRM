/**
 * O REMETENTE DA AUTOMAÇÃO POR ORGANIZAÇÃO (#3287, fatia 1).
 *
 * ─── O que esta peça resolve ─────────────────────────────────────────────────
 *
 * O e-mail que a AUTOMAÇÃO manda ao cliente final sai com o NOME de exibição e o
 * "responder para" da ORGANIZAÇÃO quando ela os configurou, mantendo o ENDEREÇO
 * da PLATAFORMA no `From:`. Sem configuração, o envio sai exatamente como hoje —
 * mesmo nome, mesmo destino de resposta, mesmo remetente.
 *
 * ─── O que fica FORA, e por quê ──────────────────────────────────────────────
 *
 * O SMTP PRÓPRIO da organização (host, porta, usuário, senha cifrada e o botão
 * "Testar conexão") é a FATIA 2 da mesma issue. Aqui não se escolhe transporte:
 * quem entrega continua sendo `lib/email/roteador.ts` (SMTP da plataforma
 * configurado → SMTP; senão Resend), e nenhum chamador precisa saber disso.
 *
 * ─── Por que a leitura degrada para "sem configuração" ───────────────────────
 *
 * Quem chama é o disparo de um e-mail. Um envio que falha porque a LEITURA do
 * `settings` deu erro trocaria um problema de configuração por um cliente que
 * não recebe nada — e o sintoma aparece longe da causa. Em qualquer falha, o
 * resultado é o de HOJE: sem nome próprio, sem resposta própria, e o envio
 * segue pelo remetente da plataforma. A recusa sai no log de quem lê.
 *
 * ─── Por que o endereço de resposta é VALIDADO AQUI ──────────────────────────
 *
 * `email_reply_to` é jsonb livre: a tela grava o que a pessoa digitou, mas uma
 * escrita manual (ou um clone antigo) pode deixar qualquer texto lá. Um valor
 * torto no `Reply-To:` vira erro opaco do provedor no meio do envio — recusar o
 * endereço aqui é "falhar fechado na ação": sem resposta própria, e o e-mail sai
 * como sempre saiu. O NOME não é validado aqui porque quem monta o cabeçalho já
 * o sanitiza (`fromAddress` na Resend, `formatFromAddress` no SMTP): a mesma
 * limpeza de `<>"\r\n` que a marca da plataforma já recebe.
 */
import { marcaDaOrganizacaoDeSettings } from "@/lib/branding/organizacao";

export interface RemetenteDaOrganizacao {
  /** `null` = a organização não configurou um nome de exibição. */
  readonly fromName: string | null;
  /** `null` = sem "responder para" utilizável. */
  readonly replyTo: string | null;
}

/** O que sai quando a organização não configurou nada — o comportamento de hoje. */
export const SEM_REMETENTE_DA_ORGANIZACAO: RemetenteDaOrganizacao = {
  fromName: null,
  replyTo: null,
};

/**
 * O piso de "cara de endereço" — o mesmo regex de `EMAIL` em
 * `lib/automation/actions/send-email.ts`. NÃO é validação de entregabilidade:
 * é o suficiente para não entregar ao provedor um `Reply-To:` que ele devolveria
 * como erro genérico três segundos depois.
 */
const ENDERECO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function textoOuNulo(valor: string | null | undefined): string | null {
  const limpo = (valor ?? "").trim();
  return limpo.length > 0 ? limpo : null;
}

/**
 * Os dois campos a partir do `organizations.settings` CRU.
 *
 * Recebe a linha inteira (e não só `branding`) para reusar
 * `marcaDaOrganizacaoDeSettings` — o MESMO leitor do jsonb que a marca usa. Um
 * segundo leitor da mesma forma divergiria do primeiro no dia em que a marca
 * aprender uma chave nova.
 */
export function remetenteDaOrganizacaoDeSettings(settings: unknown): RemetenteDaOrganizacao {
  const marca = marcaDaOrganizacaoDeSettings(settings);
  if (!marca) return SEM_REMETENTE_DA_ORGANIZACAO;
  const replyTo = textoOuNulo(marca.email_reply_to);
  return {
    fromName: textoOuNulo(marca.email_from_name),
    replyTo: replyTo && ENDERECO.test(replyTo) ? replyTo : null,
  };
}
