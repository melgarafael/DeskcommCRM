/**
 * Mescla um PATCH de `ai_agents.config` preservando o que NÃO foi enviado.
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 *
 * `agentConfigSchema.partial()` NÃO é um "só os campos enviados": os
 * `.default()` continuam valendo, e um objeto parcial é PREENCHIDO com o default
 * de todo campo ausente. Medido nesta versão do Zod:
 *
 *   z.object({ a: z.boolean().default(false), b: z.string().default("x") })
 *     .partial().parse({ b: "y" })  // => { a: false, b: "y" }
 *
 * A rota de PATCH montava `{ ...defaults, ...configAtual, ...patch.config }`.
 * Como `patch.config` vinha cheio de defaults, salvar QUALQUER coisa reescrevia
 * TODO campo não enviado com o valor de fábrica. O sintoma era mudo e
 * assimétrico: salvar o catálogo desligava `aceita_comandos_celular` e
 * `aceita_limpeza_cliente`; e no cartão de limpeza, que tem dois interruptores,
 * ligar um desfazia o outro.
 *
 * A regra correta de um PATCH: só a chave que veio no corpo muda. É isso que
 * esta função faz — itera sobre o objeto parseado e copia apenas as chaves que
 * também existem no objeto CRU que o cliente mandou.
 *
 * `enviadas` é o objeto cru (pré-Zod), não o parseado: ele é a única fonte que
 * ainda sabe o que o cliente de fato enviou, porque o parseado já foi preenchido
 * de defaults.
 */
export function mesclarConfigDoAgente(args: {
  /** `ai_agents.config` como está no banco (pode ser null). */
  readonly atual: Record<string, unknown> | null | undefined;
  /** `AGENT_CONFIG_DEFAULTS` — o piso para chaves que nunca existiram. */
  readonly padroes: Record<string, unknown>;
  /** O `config` CRU do corpo da requisição (pré-validação). */
  readonly enviadas: Record<string, unknown> | null | undefined;
  /** O `config` já validado pelo Zod (com defaults preenchidos). */
  readonly parseadas: Record<string, unknown>;
}): Record<string, unknown> {
  const mesclado: Record<string, unknown> = {
    ...args.padroes,
    ...(args.atual ?? {}),
  };
  const enviado = args.enviadas ?? {};
  for (const chave of Object.keys(args.parseadas)) {
    if (Object.prototype.hasOwnProperty.call(enviado, chave)) {
      mesclado[chave] = args.parseadas[chave];
    }
  }
  return mesclado;
}
