/**
 * Quem é o cliente do pedido (spec §5.3).
 *
 * Telefone → e-mail → CPF, nessa ordem, e o primeiro acerto vence: WhatsApp é o
 * canal primário. Contato achado só ganha campo VAZIO; nada é sobrescrito, e
 * `is_blocked` (STOP) nunca é tocado. Sem chave nenhuma, o pedido fica sem
 * contato — inventar alguém seria pior.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { encontrarContatoPorTelefoneComNome } from "@/lib/channels/contato-por-telefone";
import { camposCpfParaGravar, hashCpf, normalizeCpf } from "@/lib/contacts/cpf";
import { logger } from "@/lib/logger";
import { normalizePhoneBR } from "@/lib/webhooks/inbound";
import type { PedidoNuvemshop } from "./pedido-nuvemshop";

export interface ChavesDoContato {
  telefone: string | null;
  email: string | null;
  cpf: string | null;
  nome: string | null;
}

export interface CandidatoDeContato {
  id: string;
  name: string | null;
  email: string | null;
  cpf_hash: string | null;
  via: "telefone" | "email" | "cpf";
}

export type DecisaoDeContato =
  | { acao: "sem_chave" }
  | { acao: "usar"; contatoId: string; completar: { name?: string; email?: string; cpf?: string } }
  | { acao: "criar"; dados: { name: string; phone_number: string | null; email: string | null; cpf: string | null } };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PRIORIDADE: Record<CandidatoDeContato["via"], number> = { telefone: 0, email: 1, cpf: 2 };

function vazio(v: string | null | undefined): boolean {
  return v === null || v === undefined || v.trim() === "";
}

export function extrairChaves(p: PedidoNuvemshop): ChavesDoContato {
  const telefoneBruto = p.contact_phone ?? p.customer?.phone ?? p.customer?.billing_phone ?? null;
  const emailBruto = (p.contact_email ?? p.customer?.email ?? "").trim().toLowerCase();
  const cpfBruto = normalizeCpf(p.contact_identification ?? p.customer?.identification ?? "");
  const nome = (p.contact_name ?? p.customer?.name ?? "").trim();
  return {
    telefone: normalizePhoneBR(telefoneBruto),
    email: EMAIL.test(emailBruto) ? emailBruto : null,
    cpf: cpfBruto.length === 11 ? cpfBruto : null,
    nome: nome || null,
  };
}

export function decidirContato(chaves: ChavesDoContato, candidatos: CandidatoDeContato[]): DecisaoDeContato {
  if (!chaves.telefone && !chaves.email && !chaves.cpf) return { acao: "sem_chave" };
  const [escolhido] = [...candidatos].sort((a, b) => PRIORIDADE[a.via] - PRIORIDADE[b.via]);
  if (escolhido) {
    const completar: { name?: string; email?: string; cpf?: string } = {};
    if (vazio(escolhido.name) && chaves.nome) completar.name = chaves.nome;
    if (vazio(escolhido.email) && chaves.email) completar.email = chaves.email;
    if (vazio(escolhido.cpf_hash) && chaves.cpf) completar.cpf = chaves.cpf;
    return { acao: "usar", contatoId: escolhido.id, completar };
  }
  return {
    acao: "criar",
    dados: {
      name: chaves.nome ?? chaves.telefone ?? chaves.email ?? "Cliente Nuvemshop",
      phone_number: chaves.telefone,
      email: chaves.email,
      cpf: chaves.cpf,
    },
  };
}

const COLUNAS = "id, name, email, cpf_hash";

async function ativoPorId(admin: SupabaseClient, orgId: string, id: string) {
  const { data } = await admin
    .from("contacts")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .eq("id", id)
    .is("is_merged_into", null)
    .eq("is_anonymized", false)
    .maybeSingle();
  return data as Omit<CandidatoDeContato, "via"> | null;
}

/** Busca na ordem da precedência e para no primeiro acerto. */
async function buscarCandidato(
  admin: SupabaseClient,
  orgId: string,
  chaves: ChavesDoContato,
): Promise<CandidatoDeContato | null> {
  if (chaves.telefone) {
    const porTelefone = await encontrarContatoPorTelefoneComNome(admin, orgId, chaves.telefone);
    const ativo = porTelefone ? await ativoPorId(admin, orgId, porTelefone.id) : null;
    if (ativo) return { ...ativo, via: "telefone" };
  }
  if (chaves.email) {
    const { data } = await admin
      .from("contacts")
      .select(COLUNAS)
      .eq("organization_id", orgId)
      .eq("email_normalized", chaves.email)
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .maybeSingle();
    if (data) return { ...(data as Omit<CandidatoDeContato, "via">), via: "email" };
  }
  if (chaves.cpf) {
    const { data } = await admin
      .from("contacts")
      .select(COLUNAS)
      .eq("organization_id", orgId)
      .eq("cpf_hash", hashCpf(chaves.cpf))
      .is("is_merged_into", null)
      .eq("is_anonymized", false)
      .maybeSingle();
    if (data) return { ...(data as Omit<CandidatoDeContato, "via">), via: "cpf" };
  }
  return null;
}

export async function resolverContatoDoPedido(
  admin: SupabaseClient,
  ctx: { orgId: string; storeId: string; customerId: string | null },
  chaves: ChavesDoContato,
): Promise<string | null> {
  const candidato = await buscarCandidato(admin, ctx.orgId, chaves);
  const decisao = decidirContato(chaves, candidato ? [candidato] : []);

  if (decisao.acao === "sem_chave") return null;

  if (decisao.acao === "usar") {
    const { name, email, cpf } = decisao.completar;
    const patch: Record<string, unknown> = {};
    if (name) patch.name = name;
    if (email) patch.email = email;
    if (cpf) Object.assign(patch, await camposCpfParaGravar(admin, cpf));
    if (Object.keys(patch).length > 0) {
      const { error } = await admin
        .from("contacts")
        .update(patch)
        .eq("organization_id", ctx.orgId)
        .eq("id", decisao.contatoId);
      // 23505 = e-mail/CPF já é de OUTRO contato ativo: enriquecer é opcional.
      if (error && error.code !== "23505") {
        logger.warn("[nuvemshop.sync] completar contato falhou", { code: error.code, contact_id: decisao.contatoId });
      }
    }
    return decisao.contatoId;
  }

  const { data, error } = await admin
    .from("contacts")
    .insert({
      organization_id: ctx.orgId,
      name: decisao.dados.name,
      phone_number: decisao.dados.phone_number,
      email: decisao.dados.email,
      ...(decisao.dados.cpf ? await camposCpfParaGravar(admin, decisao.dados.cpf) : {}),
      source: "nuvemshop",
      source_metadata: { store_id: ctx.storeId, customer_id: ctx.customerId },
    })
    .select("id")
    .maybeSingle();
  if (!error) return (data?.id as string | undefined) ?? null;
  if (error.code !== "23505") throw new Error(`contato_nao_criado:${error.code ?? "sem_code"}`);
  // Corrida: outro evento criou o mesmo cliente. Re-seleciona o vencedor.
  return (await buscarCandidato(admin, ctx.orgId, chaves))?.id ?? null;
}
