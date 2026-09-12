"use server";
import { z } from "zod";
import { headers } from "next/headers";
import { audit } from "@/lib/audit";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { checkSmtpConfiguration } from "@/lib/email/smtp";
import { saveSmtpConfig } from "@/lib/email/config";

const schema = z.object({
  host: z.string().trim().max(253),
  port: z.coerce.number().int().min(1).max(65535),
  security: z.enum(["starttls", "tls", "none"]),
  username: z.string().trim().max(320),
  password: z.string().max(500),
  from_email: z.string().trim().email().or(z.literal("")),
  from_name: z.string().trim().max(120),
});

export async function updateSmtp(input: z.input<typeof schema>) {
  const { user } = await requirePlatformAdmin();
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0];
    const error =
      field === "port"
        ? "Informe uma porta entre 1 e 65535."
        : field === "from_email"
          ? "Informe somente o e-mail do remetente, por exemplo suporte@empresa.com."
          : field === "security"
            ? "Selecione STARTTLS, TLS ou Sem TLS."
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
    ip: requestHeaders.get("x-forwarded-for") ?? undefined,
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
  await requirePlatformAdmin();
  return checkSmtpConfiguration();
}
