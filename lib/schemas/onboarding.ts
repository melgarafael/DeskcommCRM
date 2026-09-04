/**
 * EPIC-02 Tenant Onboarding — Zod schemas for the wizard's Server Actions and
 * the persistent `organizations.onboarding_state jsonb` blob.
 */
import { z } from "zod";

export const welcomeSchema = z.object({
  display_name: z.string().min(2).max(120),
  /**
   * O que o negócio faz, na palavra do dono ("clínica odontológica", "vendo
   * roupa fitness pelo WhatsApp").
   *
   * Era o dado que faltava no produto INTEIRO. Sem ele, o funcionário nasce se
   * apresentando como atendente de uma "loja online" (era o que os três
   * modelos de prompt diziam) e o quadro de clientes nasce com as colunas de
   * e-commerce que o gatilho semeia — os dois defeitos têm a mesma origem: uma
   * instalação que nunca pergunta em que ramo entrou.
   *
   * Opcional porque não pode travar o primeiro passo de quem não soube resumir
   * o próprio negócio em uma linha. Quem pula recebe o quadro genérico.
   */
  o_que_faz: z.string().max(280).optional(),
  timezone: z.string().min(1).default("Africa/Maputo"),
  accepted_terms_at: z.string().datetime().optional(),
});
export type WelcomeInput = z.infer<typeof welcomeSchema>;

export const PROMPT_TEMPLATES = [
  "ecommerce_friendly",
  "ecommerce_professional",
  "support_minimal",
] as const;
export type PromptTemplate = (typeof PROMPT_TEMPLATES)[number];

export const aiAgentDefaultSchema = z.object({
  name: z.string().min(2).max(80).default("Atendente IA"),
  prompt_template: z.enum(PROMPT_TEMPLATES).default("ecommerce_friendly"),
  /**
   * As regras da casa — o que vale para QUALQUER agente desta organização
   * (horário, o que nunca prometer, como chamar o cliente). Vai para a memória
   * da organização, o mesmo lugar que a tela de Memória edita depois.
   *
   * Opcional: quem não souber o que escrever no primeiro dia não pode ficar
   * preso no passo. O teto acompanha o da tela de Memória.
   */
  regras_da_casa: z.string().max(20000).optional(),
});
export type AiAgentDefaultInput = z.infer<typeof aiAgentDefaultSchema>;

export const onboardingStepSchema = z.enum(["welcome", "whatsapp", "ai", "funil", "team", "done"]);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

export const onboardingStateSchema = z.object({
  welcome: z
    .object({
      accepted_at: z.string(),
      timezone: z.string(),
      display_name: z.string(),
      /** O ramo, na palavra do dono. Alimenta o prompt e o quadro de clientes. */
      o_que_faz: z.string().optional(),
    })
    .optional(),
  whatsapp: z
    .object({
      session_id: z.string().optional(),
      session_name: z.string().optional(),
      status: z.string(),
      skipped: z.boolean().optional(),
    })
    .optional(),
  ai: z
    .object({
      agent_id: z.string(),
      prompt_template: z.string(),
      skipped: z.boolean().optional(),
    })
    .optional(),
  /**
   * O passo de ver o funcionário responder. `visto` é o que importa: ninguém é
   * obrigado a testar, mas o wizard precisa saber que a tela foi encarada para
   * não voltar a ela para sempre.
   */
  teste: z
    .object({
      respondeu: z.boolean().optional(),
      skipped: z.boolean().optional(),
    })
    .optional(),
  /**
   * O quadro de clientes. `origem` registra se as colunas vieram da sugestão da
   * IA ou de um dos quadros prontos — é o que permite saber, depois, se a chave
   * da instalação estava funcionando no dia em que a pessoa montou tudo.
   */
  funil: z
    .object({
      pipeline_id: z.string().optional(),
      origem: z.enum(["ia", "pacote"]).optional(),
      etapas: z.number().optional(),
      skipped: z.boolean().optional(),
    })
    .optional(),
  team: z
    .object({
      invites_sent: z.number(),
      skipped: z.boolean().optional(),
    })
    .optional(),
});
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

export const inviteOnboardingSchema = z.object({
  invitations: z
    .array(
      z.object({
        email: z.string().email(),
        role: z.enum(["viewer", "agent", "manager", "admin"]),
      }),
    )
    .min(1)
    .max(20),
});
export type InviteOnboardingInput = z.infer<typeof inviteOnboardingSchema>;
