/**
 * O endereço da pessoa física no contato (#3494).
 *
 * A coluna existe desde a migration 9041 (PR #3670) e a ficha já edita os sete
 * campos. O que faltava — medido na `origin/main` antes desta fatia — era
 * (a) o endereço no CADASTRO e (b) o CEP preenchendo os outros campos. Este
 * módulo é a régua pura dos dois: quem decide o que é um CEP consultável, o que
 * a resposta da BrasilAPI vira em coluna e o que pode ser sobrescrito.
 *
 * Nada aqui fala com a rede nem com o React: os dois dialogs e o hook de
 * consulta usam estas funções, e o teste de unidade as exercita sem dublê.
 */

/** Os sete campos, na ordem em que aparecem na tela e no banco. */
export const CAMPOS_DO_ENDERECO = [
  "zip_code",
  "street",
  "number",
  "complement",
  "district",
  "city",
  "state",
] as const;

export type CampoDoEndereco = (typeof CAMPOS_DO_ENDERECO)[number];

export type EnderecoDoContato = Record<CampoDoEndereco, string>;

export const ENDERECO_VAZIO: EnderecoDoContato = {
  zip_code: "",
  street: "",
  number: "",
  complement: "",
  district: "",
  city: "",
  state: "",
};

/**
 * Os dígitos do CEP, ou `null` quando não há CEP consultável.
 *
 * A régua é de CONSULTA, não de gravação: 7 dígitos, letras ou campo vazio
 * devolvem `null` e a tela simplesmente não consulta — o que foi digitado
 * continua no formulário e é gravado como está. CEP inválido é erro de
 * preenchimento (a pessoa corrige), nunca motivo para recusar o cadastro: há
 * instalação que atende fora do Brasil (`perfilDoPais`), e o campo é texto
 * livre de até 16 posições no schema.
 */
export function normalizarCep(bruto: string | null | undefined): string | null {
  const digitos = (bruto ?? "").replace(/\D/g, "");
  return digitos.length === 8 ? digitos : null;
}

/** `01310100` → `01310-100`. Fora dos 8 dígitos, devolve o que veio. */
export function formatarCep(digitos: string): string {
  const limpos = digitos.replace(/\D/g, "");
  if (limpos.length !== 8) return digitos;
  return `${limpos.slice(0, 5)}-${limpos.slice(5)}`;
}

/** O recorte da resposta da BrasilAPI que interessa ao contato. */
export interface CepConsultado {
  cep?: string | null;
  street?: string | null;
  district?: string | null;
  city?: string | null;
  state?: string | null;
}

/** Só os campos que a resposta REALMENTE trouxe — vazio não apaga o que existe. */
export function enderecoDoCep(resposta: CepConsultado): Partial<EnderecoDoContato> {
  const campos: Partial<EnderecoDoContato> = {};
  const cep = normalizarCep(resposta.cep);
  if (cep) campos.zip_code = formatarCep(cep);
  const street = resposta.street?.trim();
  if (street) campos.street = street;
  const district = resposta.district?.trim();
  if (district) campos.district = district;
  const city = resposta.city?.trim();
  if (city) campos.city = city;
  const state = resposta.state?.trim().toUpperCase();
  if (state) campos.state = state;
  return campos;
}

/**
 * Aplica o que o CEP trouxe sobre o endereço já digitado.
 *
 * `number` e `complement` NUNCA vêm da BrasilAPI e por isso nunca são tocados:
 * o número é do imóvel, não do logradouro, e quem já digitou \"apto 42\" não pode
 * perdê-lo por ter corrigido o CEP. Os quatro campos que o CEP conhece são
 * sobrescritos só quando a resposta tem valor — CEP de cidade pequena que vem
 * sem bairro não apaga o bairro digitado à mão.
 */
export function comEnderecoDoCep(
  atual: EnderecoDoContato,
  resposta: CepConsultado,
): EnderecoDoContato {
  return { ...atual, ...enderecoDoCep(resposta) };
}

/** `true` quando há QUALQUER campo preenchido — a ficha mostra a seção por isto. */
export function temEndereco(endereco: Partial<EnderecoDoContato> | null | undefined): boolean {
  if (!endereco) return false;
  return CAMPOS_DO_ENDERECO.some((campo) => Boolean(endereco[campo]?.trim()));
}
