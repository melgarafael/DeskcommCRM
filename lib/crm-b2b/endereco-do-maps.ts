/**
 * O endereço que o Google Maps entrega, separado nas colunas da Empresa
 * (issue #3198, fatia 3).
 *
 * O Maps devolve UMA string ("Rua Augusta, 1234 - Consolação, São Paulo - SP,
 * 01304-001"), e `companies` tem sete colunas (`street`, `number`,
 * `complement`, `district`, `city`, `state`, `zip_code`). A fatia 2 deixou o
 * endereço de fora justamente porque um parser que chuta erra em silêncio.
 *
 * Este parser é CONSERVADOR: só devolve campo quando o texto bate com o
 * formato brasileiro padrão do Maps, e devolve `{}` quando não bate. Um
 * endereço que ele não entende fica vazio na Empresa — vazio é uma lacuna que
 * a equipe vê e completa; rua no campo errado é um erro que ninguém percebe.
 *
 * Dois formatos são aceitos:
 *   1. completo: `Rua, número[ - complemento] - bairro, cidade - UF[, CEP][, Brasil]`
 *   2. só o final: `... , cidade - UF[, CEP][, Brasil]` — devolve cidade, estado
 *      e CEP, e NÃO tenta adivinhar a rua nem o número do começo.
 */

export interface EnderecoDaEmpresa {
  street?: string;
  number?: string;
  complement?: string;
  district?: string;
  city?: string;
  state?: string;
  zip_code?: string;
}

const UFS = new Set([
  "AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA",
  "PB", "PR", "PE", "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO",
]);

const PAIS = String.raw`(?:,\s*(?:Brasil|Brazil))?`;
const CEP = String.raw`(?:,\s*(\d{5}-?\d{3}))?`;

/** Rua, número[ - complemento] - bairro, cidade - UF[, CEP][, país]. */
const COMPLETO = new RegExp(
  String.raw`^([^,]+?),\s*(\d{1,6}[A-Za-z]?|s/n|S/N)\s*-\s*([^,]+),\s*([^,]+?)\s*-\s*([A-Z]{2})${CEP}${PAIS}$`,
);

/** O final do endereço: cidade - UF[, CEP][, país]. */
const FINAL = new RegExp(String.raw`,\s*([^,]+?)\s*-\s*([A-Z]{2})${CEP}${PAIS}$`);

function limpo(valor: string): string {
  return valor.replace(/\s+/g, " ").trim();
}

function cepComHifen(cep: string): string {
  const digitos = cep.replace(/\D/g, "");
  return `${digitos.slice(0, 5)}-${digitos.slice(5)}`;
}

/**
 * Separa o endereço do Maps nas colunas da Empresa. Nunca lança e nunca
 * inventa: o que não bate com o formato fica de fora do resultado.
 */
export function enderecoDoMaps(endereco: string | null | undefined): EnderecoDaEmpresa {
  const texto = limpo(endereco ?? "");
  if (!texto || texto.length > 500) return {};

  const completo = COMPLETO.exec(texto);
  const ufDoCompleto = completo?.[5] ?? "";
  if (completo && UFS.has(ufDoCompleto)) {
    const rua = completo[1] ?? "";
    const numero = completo[2] ?? "";
    const meio = completo[3] ?? "";
    const cidade = completo[4] ?? "";
    const uf = ufDoCompleto;
    const cep = completo[6];
    // O que fica entre o número e a cidade é "bairro" ou "complemento - bairro":
    // o ÚLTIMO pedaço é o bairro, e o que vem antes é o complemento.
    const pedacos = meio.split(/\s+-\s+/).map(limpo).filter(Boolean);
    const bairro = pedacos[pedacos.length - 1];
    const complemento = pedacos.slice(0, -1).join(" - ");
    const resultado: EnderecoDaEmpresa = {
      street: limpo(rua),
      number: numero.toUpperCase(),
      city: limpo(cidade),
      state: uf,
    };
    if (bairro) resultado.district = bairro;
    if (complemento) resultado.complement = complemento;
    if (cep) resultado.zip_code = cepComHifen(cep);
    return resultado;
  }

  const final = FINAL.exec(texto);
  const ufDoFinal = final?.[2] ?? "";
  if (final && UFS.has(ufDoFinal)) {
    const resultado: EnderecoDaEmpresa = { city: limpo(final[1] ?? ""), state: ufDoFinal };
    if (final[3]) resultado.zip_code = cepComHifen(final[3]);
    return resultado;
  }

  return {};
}
