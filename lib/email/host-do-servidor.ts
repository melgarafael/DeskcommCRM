/**
 * O FORMATO do endereço do servidor SMTP desta instalação — em um lugar só.
 *
 * ─── Por que este arquivo existe ────────────────────────────────────────────
 *
 * O banco já recusava o endereço errado e a tela não: o CHECK
 * `platform_smtp_settings_host` aceita só `^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$`,
 * e o Zod da action (`app/actions/settings/smtp.ts`) só limitava o tamanho. Quem
 * digitava um nome com sublinhado — o nome de contêiner de um relé na própria
 * VPS, `supabase_inbucket_deskcomm-crm` — batia na constraint e lia, no toast,
 * `new row for relation "platform_smtp_settings" violates check constraint
 * "platform_smtp_settings_host"` (issue #2804).
 *
 * A régua passa a valer ANTES da gravação, e a frase que a tela mostra é a
 * explicação do formato — não o nome da constraint.
 *
 * ─── Por que a FONTE é uma string, e não uma regex literal ──────────────────
 *
 * São TRÊS cópias do mesmo formato: este módulo, `supabase/baseline.sql` (a
 * constraint) e a migration que a criou
 * (`supabase/migrations/20260919154000_0333_transporte_smtp_da_instalacao.sql`).
 * Duas cópias literais divergem no dia em que alguém aceitar o sublinhado (é a
 * decisão que a issue #2804 deixou aberta) e a tela passar a recusar o que o
 * banco aceita — ou, pior, a gravar o que ele recusa.
 *
 * `FONTE_DO_FORMATO_DO_HOST` é a string exata do SQL, e
 * `app/actions/settings/smtp-host-invalido.test.ts` a compara com as duas
 * cópias do repositório: mudar a régua num lugar só fica vermelho.
 */

/**
 * O miolo do CHECK, copiado de `supabase/baseline.sql`
 * (`constraint platform_smtp_settings_host check (smtp_host is null or smtp_host
 * ~ '<isto>')`). String, não regex, porque é o SQL que a guarda lê.
 */
export const FONTE_DO_FORMATO_DO_HOST = "^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$";

/** A mesma régua, em JavaScript: `~` do Postgres é `test` do `RegExp`. */
export const FORMATO_DO_HOST_SMTP = new RegExp(FONTE_DO_FORMATO_DO_HOST);

/**
 * O endereço é aceitável para a instalação?
 *
 * VAZIO É VÁLIDO, e não é detalhe: a constraint é `smtp_host is null or …`, o
 * `saveSmtpConfig` grava `input.host || null`, e o host vazio é como a
 * instalação declara "não uso SMTP, uso o serviço externo". Obrigar um endereço
 * aqui tiraria a porta de quem quer só limpar a configuração.
 *
 * Espera o valor JÁ sem espaços nas pontas — o `trim` é do Zod, que roda antes.
 */
export function hostSmtpAceito(host: string): boolean {
  return host === "" || FORMATO_DO_HOST_SMTP.test(host);
}
