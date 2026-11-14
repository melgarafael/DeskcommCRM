/**
 * EPIC-09 Team & Permissions — Zod schemas for invite, accept, role change, and api token.
 *
 * Roles are stored as `text` with a check constraint (not enum) on
 * `user_organizations.role` per project doctrine — keep this list in sync
 * with the DB constraint when adding/removing roles.
 */
import { z } from "zod";
import { senhaDoAcesso } from "@/lib/auth/schemas";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";

export const ROLES = ["viewer", "agent", "manager", "admin"] as const;
export type Role = (typeof ROLES)[number];

export const inviteMemberSchema = z.object({
  invitations: z
    .array(
      z
        .object({
          email: z.string().email(),
          role: z.enum(ROLES),
          interface_settings: interfaceSettingsSchema.optional(),
        })
        .refine((v) => !v.interface_settings || interfaceTemDestino(v.interface_settings, v.role), {
          message: "Selecione ao menos uma área permitida ao papel.",
          path: ["interface_settings"],
        }),
    )
    .min(1)
    .max(20),
});
export type InviteMemberInput = z.infer<typeof inviteMemberSchema>;

/**
 * "ADMIN CRIA A PESSOA" (#3876) — o corpo de `POST /api/v1/team/users`.
 *
 * Um e-mail por pedido, e não a lista de 20 do convite: criar conta com senha é
 * um ato por pessoa, e um lote aqui significaria uma senha só para vinte gente
 * ou vinte senhas num corpo só — as duas piores que a alternativa de convidar.
 *
 * `password` usa a MESMA régua do fluxo de redefinição (`senhaDoAcesso`): quem
 * define a senha de outra pessoa tem de passar pelo mesmo piso de quem
 * redefine a própria. `password_confirm` não existe aqui de propósito — ela é
 * uma conferência de DIGITAÇÃO, e quem digita é o admin na tela; o corpo da API
 * não tem como errar duas vezes o mesmo campo.
 */
export const criarMembroSchema = z
  .object({
    email: z.string().email("Email inválido"),
    full_name: z.string().trim().min(2, "Informe o nome da pessoa").max(120).optional(),
    password: senhaDoAcesso,
    role: z.enum(ROLES),
    interface_settings: interfaceSettingsSchema.optional(),
  })
  .refine((v) => !v.interface_settings || interfaceTemDestino(v.interface_settings, v.role), {
    message: "Selecione ao menos uma área permitida ao papel.",
    path: ["interface_settings"],
  });
export type CriarMembroBody = z.infer<typeof criarMembroSchema>;

export const acceptInviteSchema = z.object({
  token: z.string().min(20),
});
export type AcceptInviteInput = z.infer<typeof acceptInviteSchema>;

export const changeRoleSchema = z.object({
  role: z.enum(ROLES),
});
export type ChangeRoleInput = z.infer<typeof changeRoleSchema>;

export const createApiTokenSchema = z.object({
  name: z.string().min(2).max(100),
  scopes: z.array(z.string()).min(1),
  expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
});
export type CreateApiTokenInput = z.infer<typeof createApiTokenSchema>;
