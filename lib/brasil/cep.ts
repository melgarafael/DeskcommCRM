/**
 * CEP — validar, buscar e mapear (cadastro de cliente).
 *
 * Fonte: ViaCEP (`/ws/{cep}/json/`), pública e sem chave. Timeout de 10s e
 * erros NOMEADOS (cep_invalido, nao_encontrado, servico_indisponivel) para a
 * tela dizer o motivo em vez de "algo deu errado" — mesmo molde do cnpj.ts.
 *
 * O que o CEP entrega: rua, bairro, cidade, UF. NÃO entrega número nem
 * complemento do imóvel — esses o usuário digita (o botão Buscar nunca
 * apaga o que já está nos campos de número/complemento).
 */

export type ErroCep = "cep_invalido" | "nao_encontrado" | "servico_indisponivel";

export class ErroDeCep extends Error {
  readonly codigo: ErroCep;
  constructor(codigo: ErroCep) {
    super(codigo);
    this.codigo = codigo;
  }
}

export interface EnderecoDoCep {
  logradouro: string;
  complemento: string;
  bairro: string;
  cidade: string;
  uf: string;
}

/** "89460-000" → "89460000" (ou NULL se nem tem 8 dígitos). */
export function normalizarCep(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/\D/g, "");
  return d.length === 8 ? d : null;
}

interface RespostaViaCep {
  cep?: string;
  logradouro?: string;
  complemento?: string;
  bairro?: string;
  localidade?: string;
  uf?: string;
  erro?: boolean;
}

/** Mapeia a resposta crua para os campos do cadastro (puro, testável). */
export function mapearViaCep(res: RespostaViaCep): EnderecoDoCep {
  return {
    logradouro: (res.logradouro ?? "").trim(),
    complemento: (res.complemento ?? "").trim(),
    bairro: (res.bairro ?? "").trim(),
    cidade: (res.localidade ?? "").trim(),
    uf: (res.uf ?? "").trim().toUpperCase(),
  };
}

export async function buscarCep(raw: string, timeoutMs = 10000): Promise<EnderecoDoCep> {
  const cep = normalizarCep(raw);
  if (!cep) throw new ErroDeCep("cep_invalido");
  const controle = new AbortController();
  const limite = setTimeout(() => controle.abort(), timeoutMs);
  try {
    const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`, { signal: controle.signal });
    if (!res.ok) throw new ErroDeCep("servico_indisponivel");
    const j = (await res.json()) as RespostaViaCep;
    if (j.erro) throw new ErroDeCep("nao_encontrado");
    return mapearViaCep(j);
  } catch (e) {
    if (e instanceof ErroDeCep) throw e;
    throw new ErroDeCep("servico_indisponivel");
  } finally {
    clearTimeout(limite);
  }
}
