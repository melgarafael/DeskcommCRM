/**
 * Os valores dos campos de um contrato, lidos do cadastro do cliente e da
 * contratação (docs/agencia/SPEC-contratos.md, K1). Servidor só.
 */
import { formatCentsBRL } from "@/lib/money";
import { marcaDaSaida } from "@/lib/branding/saida";
import { createAdminClient } from "@/lib/supabase/admin";

import { lerQuantidades, QUANTIDADES, ROTULO_DA_QUANTIDADE, ROTULO_DO_SERVICO, type Servico } from "../clientes/vocabulario";
import type { CampoDoContrato } from "./regras";

function dataPorExtenso(dia: string): string {
  return new Date(`${dia}T12:00:00Z`).toLocaleDateString("pt-BR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

export async function valoresDoContrato(p: {
  clienteId: string;
  contratacaoId: string | null;
  valorMensalCents: number;
  formaPagamento: string | null;
  diaVencimento: number | null;
  prazoMeses: number;
  fechamento: string;
  validoAte: string;
}): Promise<Partial<Record<CampoDoContrato, string | null>>> {
  const db = createAdminClient();
  const [{ data: cliente }, { data: contratacao }, marca] = await Promise.all([
    db
      .from("agencia_clientes")
      .select("nome, razao_social, documento, cidade, responsavel_nome, email, whatsapp")
      .eq("id", p.clienteId)
      .maybeSingle(),
    p.contratacaoId
      ? db.from("agencia_contratacoes").select("servicos, quantidades").eq("id", p.contratacaoId).eq("cliente_id", p.clienteId).maybeSingle()
      : Promise.resolve({ data: null }),
    marcaDaSaida(null),
  ]);
  const c = (cliente ?? {}) as Record<string, string | null>;
  const k = contratacao as { servicos: string[]; quantidades: unknown } | null;
  // O endereço vem do formulário enviado, quando houver.
  const { data: form } = await db
    .from("agencia_formularios")
    .select("respostas")
    .eq("cliente_id", p.clienteId)
    .eq("situacao", "enviado")
    .order("enviado_em", { ascending: false })
    .limit(1)
    .maybeSingle();
  const empresas = ((form as { respostas?: { empresas?: Array<{ enderecos?: string[] }> } } | null)?.respostas?.empresas ?? []) as Array<{ enderecos?: string[] }>;
  const endereco = empresas[0]?.enderecos?.find((x) => x && x.trim()) ?? null;
  const quantidades = k ? lerQuantidades(k.quantidades) : {};

  return {
    "cliente.nome": c.nome ?? null,
    "cliente.razao_social": c.razao_social || c.nome || null,
    "cliente.cnpj": c.documento ?? null,
    "cliente.endereco": endereco,
    "cliente.cidade": c.cidade ?? null,
    "cliente.responsavel": c.responsavel_nome ?? null,
    "cliente.email": c.email ?? null,
    "cliente.whatsapp": c.whatsapp ?? null,
    "contratacao.servicos": k?.servicos.length ? k.servicos.map((s) => ROTULO_DO_SERVICO[s as Servico] ?? s).join(", ") : null,
    "contratacao.quantidades":
      QUANTIDADES.filter((q) => quantidades[q] !== undefined)
        .map((q) => `${quantidades[q]} ${ROTULO_DA_QUANTIDADE[q].toLowerCase()}`)
        .join(", ") || null,
    "contrato.valor_mensal": p.valorMensalCents > 0 ? formatCentsBRL(p.valorMensalCents) : null,
    "contrato.forma_pagamento": p.formaPagamento,
    "contrato.dia_vencimento": p.diaVencimento ? String(p.diaVencimento) : null,
    "contrato.prazo_meses": String(p.prazoMeses),
    "contrato.data": dataPorExtenso(p.fechamento),
    "contrato.validade": dataPorExtenso(p.validoAte),
    "agencia.nome": marca.nome,
  };
}
