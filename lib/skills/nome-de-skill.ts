/**
 * Formato do nome de uma skill (kebab-case, até 120 caracteres): `objecao-preco`, `agendamento`.
 *
 * Fica FORA do `nameSchema` das rotas de `ai/skills/[name]` de propósito. Esse schema é do contrato que
 * o módulo conectado enxerga (`tests/unit/modulo-contrato-congelado.test.ts`), e o nome é parâmetro de
 * CAMINHO, não corpo: apertar o texto dele fazia o teste exigir `HOST_API_VERSION` 3 e suspender todo
 * módulo antigo por uma regra que só rejeita nomes que nunca existiram. A regra continua valendo — cada
 * rota a aplica logo depois do `safeParse` — e é a mesma classe que o proxy exige do token em
 * `lib/auth/portas-de-token/configuracao.ts`. Tira-se uma, tira-se a outra: manter as duas iguais.
 */
export const NOME_DE_SKILL = /^[a-z0-9][a-z0-9-]{0,119}$/;

export function nomeDeSkillValido(nome: string): boolean {
  return NOME_DE_SKILL.test(nome);
}
