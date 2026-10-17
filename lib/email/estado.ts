import { lerSmtp } from "@/lib/email/config";
import { isEmailConfigured } from "@/lib/email/resend";
import { isSmtpConfigured } from "@/lib/email/smtp";

/**
 * O CRM está SEM SMTP, com o banco tendo RESPONDIDO? A base das duas perguntas
 * abaixo. Régua: host E remetente. Um soluço do banco não vira "sem SMTP".
 */
async function semSmtpRespondido(): Promise<boolean> {
  const { config, bancoRespondeu } = await lerSmtp();
  return bancoRespondeu && !isSmtpConfigured(config);
}

/**
 * A INSTALAÇÃO NÃO TEM SMTP — a mesma resposta para quem DECIDE e para quem AVISA.
 *
 * Numa instalação de servidor único (`SINGLE_SERVER=1`) o serviço de login desta
 * VPS não tem por onde mandar e-mail: quem leva o SMTP do CRM até ele é o kit
 * (`sincronizar_smtp_do_gotrue`, em `hostgator-setup-kit/_common.sh`). Mesma
 * régua do kit: host E remetente.
 *
 * Duas guardas, e as duas são de honestidade:
 *
 *   - só afirma "sem SMTP" quando o banco RESPONDEU. Um soluço dele não é falta
 *     de configuração, e afirmar que é seria trocar "não sei" por "não tem" —
 *     quem lê o aviso vai configurar uma coisa que talvez já esteja lá;
 *   - fora do single-server o login tem e-mail próprio (Supabase na nuvem ou
 *     separado), e "configure em /admin/email" não resolveria nada lá.
 *
 * Mora aqui, e não dentro de cada chamador, porque quem DECIDE (o "esqueci a
 * senha", #2755) e quem AVISA (o painel de atualização, #2755) têm de responder
 * a MESMA coisa: com a régua duplicada, no dia em que uma das duas mudasse, a
 * tela mostraria um estado que a ação já não obedece.
 *
 * Limite aceito (o mesmo que o "esqueci a senha" declara): quem pôs SMTP direto
 * no `.env` do Supabase, sem passar pela tela, ouve "sem SMTP" com um e-mail que
 * sairia. O app não enxerga aquele arquivo, e o remédio é o caminho documentado:
 * configurar o mesmo SMTP em /admin/email (que o kit passa a sincronizar).
 */
export async function semSmtpNaInstalacao(): Promise<boolean> {
  if (process.env.SINGLE_SERVER !== "1") return false;
  return semSmtpRespondido();
}

/**
 * A tarja "Sem SMTP configurado" do painel do admin (#2755, item 3) deve
 * aparecer? É uma pergunta mais larga que a de cima, sobre a mesma base:
 *
 *   - servidor único: é `semSmtpNaInstalacao` — o login só recebe o SMTP do
 *     CRM, e nem a Resend salva a recuperação de senha;
 *   - fora dele, só quando também NÃO há Resend: convites, LGPD, cobrança e
 *     automações saem pelo roteador do app (`lib/email/roteador.ts`: SMTP,
 *     senão Resend), e sem nenhum dos dois nada sai. Com a Resend entregando,
 *     a tarja seria alarme falso — o login tem e-mail próprio.
 */
export async function instalacaoSemSmtp(): Promise<boolean> {
  if (!(await semSmtpRespondido())) return false;
  return process.env.SINGLE_SERVER === "1" || !(await isEmailConfigured());
}
