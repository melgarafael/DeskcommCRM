import { z } from "zod";

import { CANAIS_DE_CONVERSA } from "@/lib/channels/canais-de-conversa";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";
import { parseDialablePhone } from "@/lib/messaging/contact-card";

/**
 * O pré-go-live é uma especialização do gate `allowlist`, não um terceiro
 * motor de autorização. O marcador existe para separar duas intenções que
 * usam o mesmo gate:
 *
 * - allowlist comum: origens do negócio autorizam o contato por prazo;
 * - pré-go-live: somente os números escolhidos para teste podem passar.
 *
 * Sem esta distinção, uma campanha ou automação poderia autorizar um contato
 * real enquanto o operador ainda acredita que o canal está fechado ao público.
 */
export const AI_GATE_PRE_GO_LIVE = "pre_go_live" as const;
export const AI_TEST_PHONE_NUMBERS_KEY = "ai_test_phone_numbers" as const;
/**
 * A segunda lista de testadores: contas de rede social (Instagram, Facebook),
 * que não têm telefone. O valor é o MESMO texto de `contacts.social_identity`
 * que a ingestão do intermediário social grava ao criar o contato:
 * `<rede>:<conta conectada>:<participante>`.
 */
export const AI_TEST_SOCIAL_IDENTITIES_KEY = "ai_test_social_identities" as const;

/**
 * As redes cuja identidade pode ser testadora: as de `CANAIS_DE_CONVERSA` que
 * entram pelo intermediário social. `whatsapp` tem a lista de telefones, e o
 * `telegram` (bot nativo) grava outra forma de identidade — a do robô, não a
 * de uma conta de 24 dígitos hexadecimais. O `webchat` (Spec 36) grava a
 * identidade do visitante do site, e fica de fora pelo mesmo motivo.
 */
export const REDES_COM_TESTADOR_SOCIAL: readonly string[] = CANAIS_DE_CONVERSA.filter(
  (canal) => canal !== "whatsapp" && canal !== "telegram" && canal !== "webchat",
);

/** Teto da lista por canal — é lista de teste, não de público. O mesmo teto vive na RPC. */
export const MAX_TESTADORES_SOCIAIS = 50;

export const AI_ACCESS_MODES = ["open", "allowlist", "pre_go_live"] as const;
export type AiAccessMode = (typeof AI_ACCESS_MODES)[number];

const numeroDeTesteSchema = z.string().transform((valor, ctx) => {
  const discavel = parseDialablePhone(valor);
  if (discavel === null || !/^\+[1-9][0-9 ()-]*$/.test(valor.trim())) {
    ctx.addIssue({
      code: "custom",
      message: "Use um telefone com DDI, por exemplo +5511999998888.",
    });
    return z.NEVER;
  }
  return canonicalPhoneBR(discavel);
});

/**
 * `<rede>:<conta de 24 hex>:<participante>`. Comparada por IGUALDADE EXATA com
 * `contacts.social_identity`: a conta conectada faz parte da identidade, então
 * o mesmo participante visto por OUTRA conta nunca casa — e não há variante a
 * calcular, como no nono dígito do telefone. Espelhada na RPC
 * `fn_configurar_pre_go_live_canal` e em `fn_automatico_da_conversa`.
 */
const IDENTIDADE_SOCIAL_RE = /^([a-z]+):[0-9a-fA-F]{24}:[A-Za-z0-9_.-]{1,128}$/;

/** `true` quando o texto tem a forma de uma identidade social testadora. */
export function ehIdentidadeSocialDeTeste(valor: unknown): valor is string {
  if (typeof valor !== "string") return false;
  const m = IDENTIDADE_SOCIAL_RE.exec(valor);
  return m !== null && REDES_COM_TESTADOR_SOCIAL.includes(m[1] ?? "");
}

export const identidadeSocialDeTesteSchema = z.string().transform((valor, ctx) => {
  const limpo = valor.trim();
  if (!ehIdentidadeSocialDeTeste(limpo)) {
    ctx.addIssue({
      code: "custom",
      message: "Identidade social inválida. Escolha um contato que já conversou com este canal.",
    });
    return z.NEVER;
  }
  return limpo;
});

/** Contrato da tela: ela substitui a configuração inteira numa gravação. */
export const aiAccessUpdateSchema = z
  .object({
    mode: z.enum(["open", "pre_go_live"]),
    test_phone_numbers: z.array(numeroDeTesteSchema),
    /**
     * Opcional de propósito: a tela de WhatsApp e quem integrou antes desta
     * lista não a mandam. AUSENTE = não mexer na lista gravada; `[]` = esvaziar.
     */
    test_social_identities: z
      .array(identidadeSocialDeTesteSchema)
      .max(MAX_TESTADORES_SOCIAIS)
      .optional(),
  })
  .transform(({ test_social_identities, ...valor }) => ({
    ...valor,
    test_phone_numbers: [...new Set(valor.test_phone_numbers)],
    ...(test_social_identities !== undefined
      ? { test_social_identities: [...new Set(test_social_identities)] }
      : {}),
  }));

export type AiAccessUpdate = z.output<typeof aiAccessUpdateSchema>;

function comoObjeto(metadata: unknown): Record<string, unknown> {
  return metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/** Lê o estado sem transformar allowlist legado em "aberto" por engano. */
export function lerModoDeAcessoDaIa(metadata: unknown): AiAccessMode {
  const valor = comoObjeto(metadata);
  if (valor.ai_gate !== "allowlist") return "open";
  return valor.ai_gate_mode === AI_GATE_PRE_GO_LIVE ? "pre_go_live" : "allowlist";
}

/**
 * Lista validada e canônica. Metadata antiga ou editada manualmente falha
 * fechado: item inválido é ignorado, nunca vira um match permissivo.
 */
export function lerNumerosDeTeste(metadata: unknown): string[] {
  const raw = comoObjeto(metadata)[AI_TEST_PHONE_NUMBERS_KEY];
  if (!Array.isArray(raw)) return [];

  const numeros: string[] = [];
  for (const item of raw) {
    const lido = numeroDeTesteSchema.safeParse(item);
    if (lido.success) numeros.push(lido.data);
  }
  return [...new Set(numeros)];
}

/**
 * A lista social validada. Mesma regra de `lerNumerosDeTeste`: item inválido
 * (outra rede, conta fora do formato, lixo editado à mão) é ignorado e nunca
 * vira um match permissivo.
 */
export function lerIdentidadesSociaisDeTeste(metadata: unknown): string[] {
  const raw = comoObjeto(metadata)[AI_TEST_SOCIAL_IDENTITIES_KEY];
  if (!Array.isArray(raw)) return [];

  const identidades: string[] = [];
  for (const item of raw) {
    const lido = identidadeSocialDeTesteSchema.safeParse(item);
    if (lido.success) identidades.push(lido.data);
  }
  return [...new Set(identidades)];
}

/**
 * Igualdade exata com a identidade gravada no contato. Contato sem identidade
 * social (todo contato de WhatsApp) nunca casa por aqui.
 */
export function identidadeSocialPodeTestar(
  identidadeDoContato: string | null | undefined,
  identidadesDeTeste: readonly string[],
): boolean {
  if (typeof identidadeDoContato !== "string") return false;
  const alvo = identidadeDoContato.trim();
  if (alvo === "") return false;
  return identidadesDeTeste.includes(alvo);
}

/**
 * A pergunta inteira do pré-go-live, para todo consumidor: o contato está em
 * ALGUMA das duas listas do canal? Telefone OU identidade social. É a única
 * autorização positiva enquanto o canal está em teste.
 */
export function contatoPodeTestar(
  contato: { telefone: string | null | undefined; identidadeSocial: string | null | undefined },
  metadata: unknown,
): boolean {
  return (
    numeroPodeTestar(contato.telefone, lerNumerosDeTeste(metadata)) ||
    identidadeSocialPodeTestar(contato.identidadeSocial, lerIdentidadesSociaisDeTeste(metadata))
  );
}

export function preGoLiveAtivo(metadata: unknown): boolean {
  return lerModoDeAcessoDaIa(metadata) === "pre_go_live";
}

/** Todo canal criado pelo produto nasce fechado até uma abertura explícita. */
export function metadataInicialDoCanal(): Record<string, unknown> {
  return {
    ai_gate: "allowlist",
    ai_gate_mode: AI_GATE_PRE_GO_LIVE,
    [AI_TEST_PHONE_NUMBERS_KEY]: [],
  };
}

/**
 * Compara todas as grafias válidas da identidade. No Brasil, isso cobre o
 * nono dígito sem obrigar o operador a cadastrar o mesmo telefone duas vezes.
 */
export function numeroPodeTestar(
  telefoneDoContato: string | null | undefined,
  numerosDeTeste: readonly string[],
): boolean {
  if (!telefoneDoContato) return false;
  const variantesDoContato = new Set(phoneLookupVariants(telefoneDoContato));
  if (variantesDoContato.size === 0) return false;
  return numerosDeTeste.some((numero) =>
    phoneLookupVariants(numero).some((variante) => variantesDoContato.has(variante)),
  );
}
