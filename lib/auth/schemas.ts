import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
});

export type LoginInput = z.infer<typeof loginSchema>;

export const signupSchema = z
  .object({
    org_name: z
      .string()
      .min(2, "Nome da empresa deve ter pelo menos 2 caracteres")
      .max(120, "Nome da empresa deve ter no máximo 120 caracteres"),
    email: z.string().email("Email inválido"),
    password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
    password_confirm: z.string(),
    // Billing pago (ADR-0002) — opcionais e SEPARADOS do resto do formulário.
    // plan_id só chega da tela quando a instância tem billing_plans ativos
    // (self-host: SignupForm nem renderiza o seletor, então isto nunca vem
    // preenchido). cnpj é exigido pela Asaas para abrir o customer — a
    // checagem real mora em lib/auth/provision.ts, não aqui: recusar no
    // schema faria o cadastro inteiro falhar por causa de um campo de
    // billing, quando o certo é a org nascer e o billing ficar pendente
    // (ver "billing_subscription_pending" na Central de avisos).
    plan_id: z.string().uuid().optional().or(z.literal("")),
    cnpj: z.string().optional().or(z.literal("")),
  })
  .refine((v) => v.password === v.password_confirm, {
    path: ["password_confirm"],
    message: "As senhas não coincidem",
  });

export type SignupInput = z.infer<typeof signupSchema>;

/**
 * Signup de quem foi CONVIDADO: a empresa já existe, então pedir o nome dela
 * seria pedir para a pessoa batizar a organização de outra gente.
 *
 * É um schema à parte, e não `org_name` opcional no de cima, de propósito: o
 * caminho normal continua exigindo o nome, com a mesma mensagem, e nada no
 * fluxo de quem abre a própria empresa afrouxa por causa deste.
 */
export const signupComConviteSchema = z
  .object({
    email: z.string().email("Email inválido"),
    password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
    password_confirm: z.string(),
  })
  .refine((v) => v.password === v.password_confirm, {
    path: ["password_confirm"],
    message: "As senhas não coincidem",
  });

export type SignupComConviteInput = z.infer<typeof signupComConviteSchema>;

export const forgotPasswordSchema = z.object({
  email: z.string().email("Email inválido"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z
  .object({
    password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
    password_confirm: z.string(),
    // Código TOTP: só exigido quando a conta tem MFA (a sessão de recovery é
    // AAL1 e o GoTrue pede AAL2 para trocar a senha). Opcional no schema; a
    // action decide se é obrigatório.
    mfa_code: z.string().optional(),
  })
  .refine((v) => v.password === v.password_confirm, {
    path: ["password_confirm"],
    message: "As senhas não coincidem",
  });

export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
