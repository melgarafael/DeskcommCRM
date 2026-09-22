import { canonicalPhoneBR } from "@/lib/channels/phone-variants";

/**
 * A NORMALIZAÇÃO — tudo que entra vira forma canônica antes de comparar.
 *
 * Telefone usa `canonicalPhoneBR` (a regra do CRM, não uma segunda regra —
 * duas normalizações divergem no primeiro nono dígito). O resto é local:
 * nome (minúsculas, sem acento, sem sufixo societário), domínio (host limpo)
 * e WhatsApp potencial (móvel BR = 11 dígitos com 9 após o DDD).
 */

export function normalizarNome(nome: string): string {
  const limpo = nome
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Sufixo societário SÓ no fim (depois do trim — "ME " com espaço não casava
  // `$` e o sufixo vazava para a comparação, separando a mesma empresa).
  return limpo.replace(/\s+(ltda|eireli|me|mei|sa|s\s*a)\.?$/i, "").trim();
}

export function normalizarTelefone(telefone: string | null | undefined): string | null {
  if (!telefone || !telefone.trim()) return null;
  let digitos = telefone.replace(/\D/g, "");
  // Prospecção BR: sem DDI, presume +55 (DDD + número = 10–11 dígitos). Fora
  // disso não se presume nada — fragmento casa errado.
  if (digitos.length === 10 || digitos.length === 11) digitos = `55${digitos}`;
  if (digitos.length < 12 || digitos.length > 13) return null;
  const canonico = canonicalPhoneBR(`+${digitos}`).replace(/\D/g, "");
  if (canonico.length < 12 || canonico.length > 13) return null;
  return `+${canonico}`;
}

/**
 * Celular com 9 → WhatsApp POTENCIAL (não confirmado). Fixo nunca é.
 * Potencial, não certeza: número pode não ter WhatsApp — a tela diz isso.
 */
export function whatsappPotencial(normalizado: string | null): boolean {
  if (!normalizado) return false;
  const d = normalizado.replace(/\D/g, "");
  return /^55\d{2}9\d{8}$/.test(d);
}

export function extrairDominio(website: string | null | undefined): string | null {
  if (!website || !website.trim()) return null;
  const comProto = /^[a-z]+:\/\//i.test(website) ? website : `https://${website}`;
  try {
    const host = new URL(comProto).hostname.toLowerCase().replace(/^www\./, "");
    if (!host.includes(".")) return null;
    return host;
  } catch {
    return null;
  }
}

export function normalizarWebsite(website: string | null | undefined): string | null {
  const dominio = extrairDominio(website);
  return dominio ? `https://${dominio}` : null;
}

export interface EnderecoPartido {
  logradouro: string | null;
  numero: string | null;
  bairro: string | null;
  cidade: string | null;
  estado: string | null;
  cep: string | null;
}

/**
 * Parte endereço BR "Rua A, 123 - Centro, Canoinhas - SC, 89460-000".
 * Heurística documentada, não parser universal: o que não casa fica no
 * `endereco` cru, e os campos saem NULL em vez de chute.
 */
export function partirEndereco(endereco: string | null | undefined): EnderecoPartido {
  const vazio: EnderecoPartido = {
    logradouro: null,
    numero: null,
    bairro: null,
    cidade: null,
    estado: null,
    cep: null,
  };
  if (!endereco || !endereco.trim()) return vazio;
  const cepMatch = endereco.match(/(\d{5})-?(\d{3})/);
  const cep = cepMatch ? `${cepMatch[1]}-${cepMatch[2]}` : null;
  const semCep = (cepMatch ? endereco.replace(cepMatch[0], "") : endereco).replace(/,\s*$/, "").trim();
  const partes = semCep.split(",").map((p) => p.trim()).filter(Boolean);
  const ufMatch = semCep.match(/([A-Z]{2})\s*$/);
  const estado: string | null = ufMatch?.[1] ?? null;
  const semUf = (parte: string) => parte.replace(/\s*-\s*[A-Z]{2}\s*$/, "").trim();
  const primeira: string = partes[0] ?? "";
  const segunda: string = partes[1] ?? "";
  const ultima: string = partes[partes.length - 1] ?? "";
  const out: EnderecoPartido = { ...vazio, cep, estado };
  // "Rua X, 123 - Bairro, Cidade - UF": o número mora no COMEÇO da segunda
  // parte (antes do " - "), não no fim da primeira. Sem esse ramo, número ia
  // para o bairro e a cidade vinha com lixo.
  const mNumSegunda = partes.length >= 2 ? segunda.match(/^(\d+[A-Za-z]?|S\/N)\s*-\s*(.+)$/i) : null;
  if (mNumSegunda?.[1] && mNumSegunda?.[2]) {
    out.logradouro = primeira || null;
    out.numero = mNumSegunda[1].trim();
    out.bairro = mNumSegunda[2].trim() || null;
    out.cidade = semUf(ultima) || null;
  } else if (partes.length >= 3) {
    const mNum = primeira.match(/^(.*?)\s+(\d+[A-Za-z]?|\bS\/N\b)$/i);
    out.logradouro = (mNum?.[1] ?? primeira).trim() || null;
    out.numero = mNum?.[2]?.trim() ?? null;
    out.cidade = semUf(ultima) || null;
    out.bairro = partes.length > 3 ? (partes.slice(1, -1).join(", ") || null) : (segunda || null);
  } else if (partes.length === 2) {
    out.logradouro = primeira || null;
    out.cidade = semUf(segunda) || null;
  } else {
    out.logradouro = primeira || null;
  }
  return out;
}
