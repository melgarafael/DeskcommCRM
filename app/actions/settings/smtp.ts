"use server";
import { z } from "zod";
import { headers } from "next/headers";
import { audit } from "@/lib/audit";
import { escritaDeAdminOuRecusa } from "@/lib/auth/escritaDeAdminOuRecusa";
import { checkSmtpConfiguration } from "@/lib/email/smtp";
import {
  FORMATO_DO_ENDERECO_DE_SERVIDOR,
  MENSAGEM_DO_ENDERECO_DE_SERVIDOR,
  saveSmtpConfig,
} from "@/lib/email/config";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";

const schema = z.object({
  host: z
    .string()
    .trim()
    .max(253)
    // Espelha a CHECK `platform_smtp_settings_host` — agora com `_`, decisão do
    // item 2 da issue #2804 (o vazio é o "apagar", que a constraint aceita como
    // NULL). O que não é nome de máquina — espaço, barra, `http://` — é
    // recusado ANTES de qualquer escrita: era por aqui que o `_` chegava ao
    // banco e voltava como texto cru do Postgres na tela.
    .refine(
      (valor) => valor === "" || FORMATO_DO_ENDERECO_DE_SERVIDOR.test(valor),
      MENSAGEM_DO_ENDERECO_DE_SERVIDOR,
    ),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(["starttls", "tls", "none"]),
  username: z.string().trim().max(320),
  password: z.string().max(500),
  from_email: z.string().trim().email().or(z.literal("")),
  from_name: z.string().trim().max(120),
});

export async function updateSmtp(input: z.input<typeof schema>) {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  const { user } = escrita.ctx;
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const error =
      field === "host"
        ? MENSAGEM_DO_ENDERECO_DE_SERVIDOR
        : field === "port"
          ? "Informe uma porta entre 1 e 65535."
          : field === "from_email"
            ? "Informe somente o e-mail do remetente, por exemplo suporte@empresa.com."
            : field === "security"
              ? "Selecione STARTTLS, TLS ou Sem criptografia."
              : "Revise os dados SMTP informados.";
    return { ok: false as const, error };
  }

  const result = await saveSmtpConfig({
    host: parsed.data.host,
    port: parsed.data.port,
    security: parsed.data.security,
    username: parsed.data.username,
    password: parsed.data.password,
    fromEmail: parsed.data.from_email,
    fromName: parsed.data.from_name,
    updatedBy: user.id,
  });
  if (!result.ok) return result;

  const requestHeaders = await headers();
  await audit({
    action: "platform_smtp_settings.updated",
    actorUserId: user.id,
    resourceType: "platform_smtp_settings",
    requestId: requestHeaders.get("x-request-id") ?? undefined,
    ip: ipDoCliente(requestHeaders) ?? undefined,
    userAgent: requestHeaders.get("user-agent") ?? undefined,
    actingAsPlatformAdmin: true,
    metadata: {
      campos: ["host", "port", "security", "username", "from_email", "from_name"],
      senha_trocada: Boolean(parsed.data.password),
    },
  });
  return result;
}

export async function checkSmtp() {
  const escrita = await escritaDeAdminOuRecusa();
  if (!escrita.ok) return escrita;
  return checkSmtpConfiguration();
}
