import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

export type SmtpSecurity = "starttls" | "tls" | "none";

/**
 * O formato que a CHECK `platform_smtp_settings_host` aceita (0333; ampliada
 * pela 0669). A validação de tela ESPELHA a constraint para o operador não
 * descobrir o formato pela mensagem do banco.
 *
 * O `_` entrou por decisão do item 2 da issue #2804: o `.env` sempre o aceitou,
 * e quem roda um relé na própria VPS em Docker (`meu_relay`,
 * `supabase_inbucket_…`) é o público do self-host. Segue recusando espaço,
 * barra e esquema — o que não é nome de máquina.
 */
export const FONTE_DO_FORMATO_DO_ENDERECO = "^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$";

/**
 * A régua vem da FONTE em string, e não de uma regex literal, para que o teste
 * compare letra a letra com o CHECK do SQL (`app/actions/settings/smtp.test.ts`).
 * A guarda de divergência veio do #3227, de @webtecnica.
 */
export const FORMATO_DO_ENDERECO_DE_SERVIDOR = new RegExp(FONTE_DO_FORMATO_DO_ENDERECO);

export const MENSAGEM_DO_ENDERECO_DE_SERVIDOR =
  "Endereço de servidor inválido. Use o nome da máquina, como smtp.suaempresa.com ou meu_relay — sem espaço, sem barra e sem http://.";

export const MENSAGEM_DO_REMETENTE_INVALIDO =
  "O e-mail do remetente está em formato inválido. Use algo como suporte@suaempresa.com.";

export const MENSAGEM_DA_FALHA_AO_SALVAR_SMTP =
  "Não foi possível salvar o servidor de e-mail. Nada foi gravado; tente novamente em instantes.";

export interface SmtpConfig {
  host: string;
  port: number;
  security: SmtpSecurity;
  username: string;
  password: string;
  fromEmail: string;
  fromName: string;
  source: "database" | "environment" | "none";
}

const EMPTY: SmtpConfig = {
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  password: "",
  fromEmail: "",
  fromName: "",
  source: "none",
};

/** Banco primeiro; o .env permite provisionar uma VPS sem abrir a interface. */
export async function getSmtpConfig(): Promise<SmtpConfig> {
  return (await lerSmtp()).config;
}

/**
 * O mesmo que `getSmtpConfig`, dizendo também se o BANCO respondeu. "Sem linha"
 * e "banco falhou" caem os dois no `.env`, mas só o primeiro permite afirmar
 * que a instalação não tem SMTP: quem decide por isso (o "esqueci a senha",
 * #2755) não pode tratar um soluço do banco como falta de configuração.
 */
export async function lerSmtp(): Promise<{ config: SmtpConfig; bancoRespondeu: boolean }> {
  let bancoRespondeu = false;
  try {
    const { data, error } = await createAdminClient()
      .from("platform_smtp_settings")
      .select(
        "smtp_host,smtp_port,smtp_security,smtp_username,smtp_password_encrypted,from_email,from_name",
      )
      .eq("id", 1)
      .maybeSingle();
    if (!error && data) {
      const row = data as {
        smtp_host: string | null;
        smtp_port: number;
        smtp_security: SmtpSecurity;
        smtp_username: string | null;
        smtp_password_encrypted: string | null;
        from_email: string | null;
        from_name: string | null;
      };
      const config: SmtpConfig = {
        host: row.smtp_host?.trim() ?? "",
        port: row.smtp_port,
        security: row.smtp_security,
        username: row.smtp_username?.trim() ?? "",
        password: row.smtp_password_encrypted
          ? ((await decryptWebhookSecret(createAdminClient(), row.smtp_password_encrypted)) ?? "")
          : "",
        fromEmail: row.from_email?.trim() ?? "",
        fromName: row.from_name?.trim() ?? "",
        source: "database",
      };
      return { config, bancoRespondeu: true };
    }
    // Sem erro e sem linha: o banco respondeu "ninguém configurou pela tela".
    bancoRespondeu = !error;
  } catch {
    // Clones anteriores à migration caem no ambiente até serem atualizados.
  }
  const config: SmtpConfig = {
    host: env.SMTP_HOST.trim(),
    port: env.SMTP_PORT,
    security: env.SMTP_SECURITY,
    username: env.SMTP_USERNAME.trim(),
    password: env.SMTP_PASSWORD,
    fromEmail: env.SMTP_FROM_EMAIL.trim(),
    fromName: env.SMTP_FROM_NAME.trim(),
    source: "environment",
  };
  return { config: config.host || config.fromEmail ? config : EMPTY, bancoRespondeu };
}

export async function saveSmtpConfig(input: Omit<SmtpConfig, "source"> & { updatedBy: string }) {
  const admin = createAdminClient();
  let encrypted: string | null = null;
  if (input.password) encrypted = await encryptWebhookSecret(admin, input.password);
  else {
    const { data } = await admin
      .from("platform_smtp_settings")
      .select("smtp_password_encrypted")
      .eq("id", 1)
      .maybeSingle();
    encrypted =
      (data as { smtp_password_encrypted?: string | null } | null)?.smtp_password_encrypted ?? null;
  }
  if (input.password && !encrypted)
    return {
      ok: false as const,
      error: "A cifra está indisponível nesta instalação; a senha não foi gravada.",
    };
  const { error } = await admin.from("platform_smtp_settings").upsert(
    {
      id: 1,
      smtp_host: input.host || null,
      smtp_port: input.port,
      smtp_security: input.security,
      smtp_username: input.username || null,
      smtp_password_encrypted: encrypted,
      from_email: input.fromEmail || null,
      from_name: input.fromName || null,
      updated_by: input.updatedBy,
    },
    { onConflict: "id" },
  );
  if (error) {
    // O texto do Postgres NUNCA vai para o toast (issue #2804): ele nomeia
    // constraint e relação, o que não diz nada a quem opera a tela. A violação
    // PREVISTA (formato do endereço/remetente) ganha a mensagem do campo; o
    // inesperado ganha a genérica — e o cru fica inteiro no log do servidor,
    // que é onde alguém consegue agir sobre ele.
    logger.error("[email.config] falha ao gravar o servidor SMTP", {
      code: error.code,
      detail: error.message,
    });
    const mensagem = error.message.includes("platform_smtp_settings_host")
      ? MENSAGEM_DO_ENDERECO_DE_SERVIDOR
      : error.message.includes("platform_smtp_settings_from_email")
        ? MENSAGEM_DO_REMETENTE_INVALIDO
        : MENSAGEM_DA_FALHA_AO_SALVAR_SMTP;
    return { ok: false as const, error: mensagem };
  }
  return { ok: true as const };
}
