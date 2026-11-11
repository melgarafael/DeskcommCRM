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

export const PROVEDORES_DE_COBRANCA = ["stripe", "asaas", "efi"] as const;
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

/**
 * O RECURSO DO PLANO é uma DECLARAÇÃO, não um nome solto: ela diz onde o teto é
 * guardado (`cobranca_planos.<coluna>`), qual é o piso do CHECK (`minimo`) e
 * como o admin chama o recurso. É a fonte única do eixo: o schema zod, o
 * `SELECT` do painel e a derivação do limite saem daqui — nenhum outro módulo
 * repete `max_assentos`/`max_canais`/`teto_ia_usd_cents`.
 *
 * Recurso novo = uma entrada aqui + o literal no `fn_limite_do_plano` (migration
 * e apêndice do baseline) + a coluna na tabela, no MESMO commit. Faltar um dos
 * lados não compila (o tipo exige a coluna) ou reprova em
 * `lib/cobranca/vocabulario.test.ts` (o SQL não aceita o recurso).
 */
export interface DeclaracaoDeRecurso {
  /** Coluna de `cobranca_planos` que guarda o teto; `null` na linha = sem limite. */
  readonly coluna: string;
  /** Piso do CHECK do banco — o schema zod usa o MESMO número, não uma cópia. */
  readonly minimo: number;
  /** Como a tela de planos chama o recurso. */
  readonly rotulo: string;
}

export const RECURSOS = {
  assentos: { coluna: "max_assentos", minimo: 1, rotulo: "Pessoas" },
  canais: { coluna: "max_canais", minimo: 1, rotulo: "Números conectados" },
  ia_usd_cents: { coluna: "teto_ia_usd_cents", minimo: 100, rotulo: "IA" },
} as const satisfies Record<string, DeclaracaoDeRecurso>;

/**
 * O que `public.fn_limite_do_plano` aceita. Derivado de `RECURSOS` para não
 * existir uma segunda lista: a tupla e o tipo saem da MESMA declaração, e o
 * invariante `tests/invariants/cobranca-limite-do-plano.test.ts` confere no
 * Postgres que o SQL aceita exatamente isto.
 */
export type RecursoDoPlano = keyof typeof RECURSOS;

export const RECURSOS_DO_PLANO = Object.keys(RECURSOS) as readonly RecursoDoPlano[];
