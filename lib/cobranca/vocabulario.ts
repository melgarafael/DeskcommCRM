/**
 * O VOCABULÁRIO DA COBRANÇA DO REVENDEDOR: o lado TypeScript dos CHECKs de
 * `cobranca_planos` e `cobranca_assinaturas` (migration 0583; spec §2.2, §2.3,
 * §2.7). Cada tupla é par de uma coluna, vigiado por
 * tests/invariants/vocabulario-banco-x-typescript.test.ts: valor novo entra no
 * CHECK (migration + apêndice do baseline) e aqui, no MESMO commit.
 * `RECURSOS_DO_PLANO` não é coluna: é o que `public.fn_limite_do_plano` aceita,
 * vigiado por tests/invariants/cobranca-limite-do-plano.test.ts.
 */

export const ESTADOS_DA_ASSINATURA = ["trial", "ativa", "em_atraso", "cancelada"] as const;
export type EstadoDaAssinatura = (typeof ESTADOS_DA_ASSINATURA)[number];

export const PROVEDORES_DE_COBRANCA = ["stripe", "asaas"] as const;
export type ProvedorDeCobranca = (typeof PROVEDORES_DE_COBRANCA)[number];

export const MODOS = ["teste", "producao"] as const;
export type Modo = (typeof MODOS)[number];

export const INTERVALOS = ["mes", "ano"] as const;
export type Intervalo = (typeof INTERVALOS)[number];

/** O Asaas não tem moeda e o boleto da Stripe é só BRL. Alargar = alargar o CHECK. */
export const MOEDAS = ["BRL"] as const;
export type Moeda = (typeof MOEDAS)[number];

export const AVISOS_DA_REGUA = ["trial_acabando", "venceu", "suspende_em_breve", "suspensa"] as const;
export type AvisoDaRegua = (typeof AVISOS_DA_REGUA)[number];

export const ERROS_DE_LEITURA = [
  "credencial_invalida",
  "provedor_fora",
  "pagamento_de_assinatura_cancelada",
  "leitura_invalida",
] as const;
export type ErroDeLeitura = (typeof ERROS_DE_LEITURA)[number];

export const RECURSOS_DO_PLANO = ["assentos", "canais", "ia_usd_cents"] as const;
export type RecursoDoPlano = (typeof RECURSOS_DO_PLANO)[number];
