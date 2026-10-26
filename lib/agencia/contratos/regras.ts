/**
 * As regras dos contratos, puras e testáveis sem banco (docs/agencia/SPEC-contratos.md).
 */
import { formatCentsBRL } from "@/lib/money";

import { somarDias } from "../calendario/regras";

/** Os campos que um modelo pode usar, com o que cada um mostra (a tela do editor lista estes). */
export const CAMPOS_DO_CONTRATO = {
  "cliente.nome": "Nome do cliente",
  "cliente.razao_social": "Razão social",
  "cliente.cnpj": "CNPJ",
  "cliente.endereco": "Endereço",
  "cliente.cidade": "Cidade",
  "cliente.responsavel": "Responsável",
  "cliente.email": "E-mail do cliente",
  "cliente.whatsapp": "WhatsApp do cliente",
  "contratacao.servicos": "Serviços contratados",
  "contratacao.quantidades": "Quantidades mensais",
  "contrato.valor_mensal": "Valor mensal",
  "contrato.forma_pagamento": "Forma de pagamento",
  "contrato.dia_vencimento": "Dia do vencimento",
  "contrato.prazo_meses": "Prazo mínimo (meses)",
  "contrato.data": "Data do contrato",
  "contrato.validade": "Validade da proposta",
  "agencia.nome": "Nome da agência",
} as const;
export type CampoDoContrato = keyof typeof CAMPOS_DO_CONTRATO;

const PADRAO_DO_CAMPO = /\{\{\s*([a-z_]+\.[a-z_]+)\s*\}\}/g;

/**
 * Preenche o modelo. Campo sem valor fica como `[FALTA: rótulo]` no texto e entra
 * na lista `faltando` — a tela mostra antes de gerar; campo que não existe no
 * vocabulário entra em `desconhecidos` (erro de digitação no modelo).
 */
export function preencherModelo(
  corpo: string,
  valores: Partial<Record<CampoDoContrato, string | null>>,
): { texto: string; faltando: string[]; desconhecidos: string[] } {
  const faltando = new Set<string>();
  const desconhecidos = new Set<string>();
  const texto = corpo.replace(PADRAO_DO_CAMPO, (_, nome: string) => {
    if (!(nome in CAMPOS_DO_CONTRATO)) {
      desconhecidos.add(nome);
      return `[CAMPO DESCONHECIDO: ${nome}]`;
    }
    const v = valores[nome as CampoDoContrato];
    if (v === null || v === undefined || v.trim() === "") {
      const rotulo = CAMPOS_DO_CONTRATO[nome as CampoDoContrato];
      faltando.add(rotulo);
      return `[FALTA: ${rotulo}]`;
    }
    return v.trim();
  });
  return { texto, faltando: [...faltando], desconhecidos: [...desconhecidos] };
}

export function valorMensalPorExtenso(cents: number): string {
  return formatCentsBRL(cents);
}

/** A proposta vale N dias depois do Fechamento (5 por padrão — mapa › Etapa 1). */
export function validadeDaProposta(fechamento: string, dias = 5): string {
  return somarDias(fechamento, dias);
}

export type SituacaoVisivel = "rascunho" | "aguardando" | "assinado" | "pago" | "concluido" | "vencido" | "recusado" | "cancelado";

/** A situação que a tela mostra, das datas e da situação guardada. */
export function situacaoVisivel(
  c: { situacao: string; assinado_em: string | null; pago_em: string | null; valido_ate: string },
  hoje: string,
): SituacaoVisivel {
  if (c.situacao === "concluido") return "concluido";
  if (c.situacao === "recusado") return "recusado";
  if (c.situacao === "cancelado") return "cancelado";
  if (c.assinado_em && !c.pago_em) return "assinado";
  if (c.pago_em && !c.assinado_em) return "pago";
  if (c.valido_ate < hoje) return "vencido";
  return c.situacao === "rascunho" ? "rascunho" : "aguardando";
}

export const ROTULO_DA_SITUACAO_DO_CONTRATO: Record<SituacaoVisivel, string> = {
  rascunho: "Rascunho",
  aguardando: "Aguardando assinatura e pagamento",
  assinado: "Assinado, falta o pagamento",
  pago: "Pago, falta a assinatura",
  concluido: "Assinado e pago",
  vencido: "Proposta vencida",
  recusado: "Recusado",
  cancelado: "Cancelado",
};

/** Assinado E pago: a data que conta é a última das duas (mapa › Calendário do contrato). */
export function dataDeAssinadoEPago(assinadoEm: string | null, pagoEm: string | null): string | null {
  if (!assinadoEm || !pagoEm) return null;
  return new Date(assinadoEm).getTime() >= new Date(pagoEm).getTime() ? assinadoEm : pagoEm;
}

/** O nome do grupo do cliente (D10). */
export function nomeDoGrupo(agencia: string, empresa: string): string {
  return `${agencia} - ${empresa}`.slice(0, 100);
}

/** Telefone E.164 → o id que o WAHA usa para um contato. */
export function idDoWhatsapp(e164: string): string | null {
  const d = e164.replace(/\D/g, "");
  return d.length >= 10 ? `${d}@c.us` : null;
}
