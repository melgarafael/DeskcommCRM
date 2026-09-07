import {
  interfaceSettingsSchema,
  INTERFACE_COMPLETA,
  interfaceTemDestino,
  type InterfaceSettings,
} from "@/lib/navigation/interface";
import { randomUUID } from "node:crypto";
import { env } from "@/lib/env";
import { audit } from "@/lib/audit";
import { signInviteToken, INVITE_TTL_SECONDS } from "@/lib/auth/invite-token";
import { buildInviteEmail } from "@/lib/email/templates/invite";
import { sendEmail } from "@/lib/email/resend";
import { marcaDaSaida } from "@/lib/branding/saida";

/** Link sempre existe, inclusive quando a instalação não configurou e-mail. */
export async function issueInvite(input: {
  interfaceSettings?: InterfaceSettings;
  email: string;
  role: "viewer" | "agent" | "manager" | "admin";
  organizationId: string;
  orgName: string;
  inviterId: string;
  inviterName: string;
  requestId: string;
  inviteId?: string;
  issuedAt?: number;
  dispatch?: boolean;
}) {
  const interfaceSettings = interfaceSettingsSchema.parse(
    input.interfaceSettings ?? INTERFACE_COMPLETA,
  );
  if (!interfaceTemDestino(interfaceSettings, input.role))
    throw new Error("Selecione ao menos uma área permitida ao papel.");
  const email = input.email.trim().toLowerCase();
  const inviteId = input.inviteId ?? randomUUID();
  const iat = input.issuedAt ?? Math.floor(Date.now() / 1000);
  const exp = iat + INVITE_TTL_SECONDS;
  const token = signInviteToken({
    invite_id: inviteId,
    email,
    organization_id: input.organizationId,
    role: input.role,
    exp,
    iat,
    invited_by: input.inviterId,
    interface_settings: interfaceSettings,
  });
  const acceptUrl = `${env.NEXT_PUBLIC_APP_URL.replace(/\/$/, "")}/team/accept-invite/${token}`;
  let dispatched = false;
  // Falhas de infraestrutura não desfazem a organização já criada nem o link.
  if (input.dispatch !== false) {
    try {
      const marca = await marcaDaSaida(input.organizationId);
      const message = buildInviteEmail({
        inviterName: input.inviterName,
        orgName: input.orgName,
        acceptUrl,
        role: input.role,
        expiresAt: new Date(exp * 1000),
        marca,
      });
      const result = await sendEmail({
        to: email,
        ...message,
        fromName: marca.nome,
        tags: [
          { name: "kind", value: "team_invite" },
          { name: "org", value: input.organizationId },
        ],
      });
      dispatched = result.ok;
    } catch {
      /* A superfície de recuperação é o link devolvido abaixo. */
    }
    await audit({
      action: "member.invited",
      actorUserId: input.inviterId,
      organizationId: input.organizationId,
      resourceType: "membership",
      resourceId: inviteId,
      requestId: input.requestId,
      metadata: { email, role: input.role, email_dispatched: dispatched },
    });
  }
  return {
    email,
    invite_id: inviteId,
    expires_at: new Date(exp * 1000).toISOString(),
    email_dispatched: dispatched,
    accept_url: acceptUrl,
  };
}
