/**
 * A RECUSA REGISTRADA de uma finalidade de `contacts.consent`, nos DOIS formatos que o banco tem.
 *
 * `contacts.consent` é um mapa de finalidades (`marketing`, `transactional`, `profiling`; regra L-05), e cada finalidade
 * chega por dois escritores com grafias diferentes:
 *
 * - a CAPTAÇÃO (o webhook do Respondi e `fn_consentimento_fundido`) grava a recusa como `declined_at`, com a hora;
 * - a FICHA do contato (o PATCH, e a fila de confirmação de dado que passa por ele) grava `{ granted: false }`, o formato que
 *   o export de LGPD lê.
 *
 * As guardas de envio liam só `declined_at`: uma revogação feita pela ficha não bloqueava nada — a automação, o e-mail, a
 * campanha e a prospecção seguiam mandando para quem a empresa registrou que disse não. Esta função é a régua única, e as
 * quatro a chamam; uma guarda nova que leia `declined_at` direto repete o defeito (« conserto por instância », o mesmo
 * aviso do cabeçalho de `lib/automation/guarda-do-contato.ts`).
 *
 * O que NÃO é recusa, de propósito: a ausência (o DEFAULT da coluna, « ninguém perguntou ») e `granted: null`. Bloquear por
 * ausência pararia toda automação de lead que nunca passou por um formulário com a pergunta.
 */
export type FinalidadeDaRecusa = "marketing" | "transactional" | "profiling";

export function recusaRegistrada(consent: unknown, finalidade: FinalidadeDaRecusa = "marketing"): boolean {
  if (!consent || typeof consent !== "object") return false;
  const f = (consent as Record<string, unknown>)[finalidade];
  if (!f || typeof f !== "object") return false;
  const r = f as Record<string, unknown>;
  return !!r.declined_at || r.granted === false;
}
