import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(8, "Senha deve ter pelo menos 8 caracteres"),
});

export type LoginInput = z.infer<typeof loginSchema>;

/**
 * O nome da empresa, com a MESMA régua nos dois caminhos que o aceitam: o
 * cadastro e a recuperação do primeiro acesso. Enquanto a regra morava dentro
 * do `signupSchema`, a segunda teria de repeti-la — e duas cópias divergem na
 * primeira mudança.
 */
export const organizationNameSchema = z
  .string()
  .trim()
  .min(2, "Nome da empresa deve ter pelo menos 2 caracteres")
  .max(120, "Nome da empresa deve ter no máximo 120 caracteres");

/**
 * A régua da senha — UMA, usada por TODOS os caminhos em que alguém escolhe a
 * própria senha: definir a nova senha, criar conta (com ou sem convite) e a
 * senha provisória que a administração define para outra pessoa (#3876).
 *
 * Duas cópias divergiriam na primeira mudança: um caminho aceitaria a senha
 * que o outro recusa, e a pessoa só descobriria depois de enviar.
 *
 * O TETO DA SENHA É DE 72 BYTES — E É BYTES, NÃO CARACTERES.
 *
 * O bcrypt, que o GoTrue usa por baixo, só considera os primeiros 72 bytes da
 * senha e recusa o resto com "Password cannot be longer than 72 characters"
 * (`error_code: validation_failed`). Medido no GoTrue local: uma senha de 38
 * caracteres com acento (74 bytes) é recusada — o provedor conta bytes. Como
 * acento conta 2 bytes em UTF-8 e emoji conta 4, uma senha de 38 caracteres
 * pode estourar o limite que 72 letras ASCII não estouram — por isso a régua é
 * `TextEncoder`, e não `.max(72)`, que mede caracteres e deixaria o caso
 * multibyte passar até o erro genérico do provedor.
 *
 * `TextEncoder` em vez de `Buffer.byteLength` porque estes schemas também
 * rodam no navegador (são o resolver dos formulários) e `Buffer` não existe no
 * bundle do cliente.
 */
export const LIMITE_DA_SENHA_EM_BYTES = 72;

/**
 * A frase da TELA. Diz "caracteres" porque é o que a pessoa conta, e explica o
 * resto entre parênteses: a régua por baixo continua sendo bytes, e o limite
 * técnico aparece inteiro nos comentários e nos testes — quem lê o código não
 * fica com uma meia-verdade.
 */
export const SENHA_LONGA_DEMAIS =
  "A senha deve ter no máximo 72 caracteres (acentos e emojis contam mais de um)";

function bytesDaSenha(valor: string): number {
  return new TextEncoder().encode(valor).byteLength;
}

/**
 * O teto em bytes como refinamento avulso, para quem precisa SÓ do limite — o
 * cadastro não pede composição (letra/número/símbolo) e não é aqui que essa
 * regra entra: acrescentá-la mudaria a senha aceita por um fluxo que a issue
 * não pediu para endurecer.
 */
function recusaAcimaDoTeto(valor: string, ctx: z.RefinementCtx): void {
  if (bytesDaSenha(valor) > LIMITE_DA_SENHA_EM_BYTES) {
    ctx.addIssue({ code: "custom", message: SENHA_LONGA_DEMAIS });
  }
}

/**
 * A senha do cadastro: mínimo de 8 (a regra que já existia) mais o teto que o
 * bcrypt impõe. Sem o teto, uma senha de 80 caracteres passava no formulário e
 * a tela dizia "Não foi possível criar a conta. Tente novamente." — sem dizer
 * que o problema era o tamanho (issue #4313; o GoTrue recusa com 400).
 */
const senhaDoCadastroSchema = z
  .string()
  .min(8, "Senha deve ter pelo menos 8 caracteres")
  .superRefine(recusaAcimaDoTeto);

export const signupSchema = z
  .object({
    org_name: organizationNameSchema,
    cobranca_plan_id: z.string().uuid().optional(),
    continuar_pagamento: z.boolean().optional(),
    email: z.string().email("Email inválido"),
    password: senhaDoCadastroSchema,
    password_confirm: z.string(),
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
    /**
     * QUEM ENTRA POR CONVITE NUNCA TINHA ONDE DIZER O PRÓPRIO NOME.
     *
     * O dono da instalação preenche o nome no onboarding; quem é convidado pula
     * o onboarding inteiro e ficava sem nome para sempre. Medido em produção em
     * 2026-09-10: no diálogo de transferir conversa, o colega aparecia como
     * "Atendente 528ebd09" — um pedaço do identificador interno, para a equipe
     * toda, indefinidamente.
     *
     * É o campo de UMA linha que fecha isso na origem, em vez de cada tela
     * inventar o próprio remendo para a ausência.
     */
    full_name: z.string().trim().min(2, "Informe seu nome").max(120),
    email: z.string().email("Email inválido"),
    password: senhaDoCadastroSchema,
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

/**
 * A senha completa — composição (letra, número, símbolo) mais o teto. É a régua
 * que a recuperação de senha e a senha provisória (#3876) usam; o cadastro usa
 * `senhaDoCadastroSchema`, que tem o mesmo teto e só não exige composição.
 */
export const senhaForteSchema = z
  .string()
  .min(8, "Senha deve ter pelo menos 8 caracteres")
  .regex(/[A-Za-zÀ-ÿ]/, "Senha deve ter pelo menos uma letra")
  .regex(/[0-9]/, "Senha deve ter pelo menos um número")
  .regex(/[^A-Za-zÀ-ÿ0-9\s]/, "Senha deve ter pelo menos um símbolo")
  .superRefine(recusaAcimaDoTeto);

export const resetPasswordSchema = z
  .object({
    password: senhaForteSchema,
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
