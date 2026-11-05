/**
 * EPIC-09 Team & Permissions — Zod schemas for invite, accept, role change, and api token.
 *
 * Roles are stored as `text` with a check constraint (not enum) on
 * `user_organizations.role` per project doctrine — keep this list in sync
 * with the DB constraint when adding/removing roles.
 */
import { z } from "zod";
import { senhaForteSchema } from "@/lib/auth/schemas";
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
 * Criar a pessoa SEM convite (#3876): quem administra define a senha e a
 * passagem no primeiro acesso é obrigatória.
 *
 * A senha usa `senhaForteSchema` — a MESMA régua da recuperação de senha. O
 * `password_confirm` existe porque a senha é digitada duas vezes por quem cria,
 * num teclado que não é o de quem vai usar: sem confirmação, um erro de
 * digitação só apareceria para a pessoa nova, num login que falha sem dizer o
 * que aconteceu.
 *
 * `interface_settings` segue a regra do convite (`interfaceTemDestino`): papel
 * sem nenhuma área permitida abriria uma conta que não abre nada.
 */
export const createTeamUserSchema = z
  .object({
    full_name: z.string().trim().min(2, "Informe o nome da pessoa").max(120),
    email: z.string().email("Email inválido"),
    role: z.enum(ROLES),
    password: senhaForteSchema,
    password_confirm: z.string(),
    interface_settings: interfaceSettingsSchema.optional(),
  })
  .refine((v) => v.password === v.password_confirm, {
    path: ["password_confirm"],
    message: "As senhas não coincidem",
  })
  .refine((v) => !v.interface_settings || interfaceTemDestino(v.interface_settings, v.role), {
    path: ["interface_settings"],
    message: "Selecione ao menos uma área permitida ao papel.",
  });
export type CreateTeamUserInput = z.infer<typeof createTeamUserSchema>;

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
