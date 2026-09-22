import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

/**
 * O PAYLOAD DO SPED — monta o contrato do sidecar a partir do pedido.
 *
 * Função pura (montarSpedPayload) + ida ao banco (carregarContextoSped) em
 * separado: a montagem é testável sem Postgres, e o que falta (NCM do
 * produto, endereço do emitente) volta como ERRO NOMEANDO O CAMPO — nunca
 * como presunção. Imposto presumido é crime fiscal; campo ausente é 422.
 */

export interface EmitenteSped {
  serie: string;
  natureza_operacao: string;
  cfop_padrao: string;
  emitente_documento: string | null;
  ie: string | null;
  crt: string;
  logradouro: string | null;
  numero_end: string | null;
  bairro: string | null;
  municipio: string | null;
  codigo_municipio: string | null;
  uf: string | null;
  cep: string | null;
  ambiente: string;
  certificado_path: string | null;
}

export interface ItemSped {
  codigo: string;
  descricao: string;
  ncm: string | null;
  cfop: string | null;
  unidade: string | null;
  quantidade: number;
  preco_cents: number;
  desconto_pct: number;
}

export interface PayloadSped {
  config: Record<string, unknown>;
  certificado_arquivo: string;
  certificado_senha: string;
  pedido: Record<string, unknown>;
  itens: Record<string, unknown>[];
}

export type FaltaSped = { ok: false; falta: string };
export type ProntoSped = { ok: true; payload: PayloadSped };

/** Devolve o que falta, em português direto, ou o payload pronto. */
export function montarPayloadSped(
  emitente: EmitenteSped,
  senhaCertificado: string,
  pedido: { numero: number; nome: string; documento: string | null; frete_cents: number },
  itens: ItemSped[],
): ProntoSped | FaltaSped {
  if (!emitente.emitente_documento) return { ok: false, falta: "CNPJ do emitente (configuração fiscal)" };
  if (!emitente.ie) return { ok: false, falta: "Inscrição Estadual (configuração fiscal)" };
  if (!emitente.uf) return { ok: false, falta: "UF do emitente (configuração fiscal)" };
  if (!emitente.codigo_municipio) {
    return { ok: false, falta: "Código IBGE do município (configuração fiscal)" };
  }
  if (!emitente.certificado_path) {
    return { ok: false, falta: "Certificado A1: coloque o .pfx em /certs e registre o caminho" };
  }
  if (!senhaCertificado) return { ok: false, falta: "Senha do certificado" };
  if (itens.length === 0) return { ok: false, falta: "Ao menos 1 item" };

  for (const item of itens) {
    if (!item.ncm) return { ok: false, falta: `NCM do produto "${item.descricao}"` };
  }

  return {
    ok: true,
    payload: {
      config: {
        ambiente: emitente.ambiente,
        serie: emitente.serie,
        cnpj: emitente.emitente_documento,
        razao: emitente.emitente_documento,
        ie: emitente.ie,
        crt: emitente.crt,
        natureza: emitente.natureza_operacao,
        cfop: emitente.cfop_padrao,
        logradouro: emitente.logradouro,
        numero_end: emitente.numero_end,
        bairro: emitente.bairro,
        municipio: emitente.municipio,
        codigo_municipio: emitente.codigo_municipio,
        uf: emitente.uf,
        cep: emitente.cep,
      },
      certificado_arquivo: emitente.certificado_path,
      certificado_senha: senhaCertificado,
      pedido: {
        numero_nota: pedido.numero,
        nome: pedido.nome,
        documento: pedido.documento,
        frete_cents: pedido.frete_cents,
      },
      itens: itens.map((i) => ({
        codigo: i.codigo,
        descricao: i.descricao,
        ncm: i.ncm,
        cfop: i.cfop,
        unidade: i.unidade ?? "UN",
        quantidade: i.quantidade,
        preco_cents: i.preco_cents,
        desconto_pct: i.desconto_pct,
      })),
    },
  };
}

export interface ContextoSped {
  emitente: EmitenteSped;
  senhaCertificado: string | null;
}

/** Lê config + senha (decifrada) com admin client. Fonte confiável: org do JWT. */
export async function carregarContextoSped(orgId: string): Promise<ContextoSped | null> {
  const admin = createAdminClient();
  const { data } = await admin
    .from("fiscal_settings")
    .select(
      "serie, natureza_operacao, cfop_padrao, emitente_documento, ie, crt, " +
        "logradouro, numero_end, bairro, municipio, uf, cep, ambiente, provedor, " +
        "certificado_path, certificado_senha_encrypted",
    )
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!data) return null;
  const cfg = data as unknown as Record<string, unknown> & {
    certificado_senha_encrypted: string | null;
  };
  let senha: string | null = null;
  if (cfg.certificado_senha_encrypted) {
    senha = await decryptWebhookSecret(admin, cfg.certificado_senha_encrypted);
  }
  const { certificado_senha_encrypted: _, ...emitente } = cfg;
  return { emitente: emitente as unknown as EmitenteSped, senhaCertificado: senha };
}
