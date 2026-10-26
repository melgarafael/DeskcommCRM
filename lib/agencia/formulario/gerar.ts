/**
 * Gerar o link do formulário de acesso e, se pedido, mandar no WhatsApp do
 * responsável (docs/agencia/SPEC-cofre-e-formulario.md, F2/F9). Uma porta só,
 * usada pela ficha (botão) e pelo contrato assinado e pago (SPEC-contratos, K5).
 */
import { marcaDaSaida } from "@/lib/branding/saida";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

import { normalizarWhatsapp } from "../convite";
import { enfileirarWhatsappDaAgencia } from "../whatsapp/enfileirar";
import { linkDoFormulario, novoToken, VALIDADE_DO_FORMULARIO_MS } from "./link";

export type ResultadoDoWhatsapp = "enviado" | "sem_numero" | "sem_whatsapp" | "nao_pedido";

export async function gerarFormulario(p: {
  clienteId: string;
  userId: string | null;
  enviarNoWhatsapp: boolean;
}): Promise<{ ok: true; formularioId: string; link: string; whatsapp: ResultadoDoWhatsapp } | { ok: false; erro: string }> {
  const db = createAdminClient();
  const { data: cliente } = await db.from("agencia_clientes").select("nome, responsavel_nome, whatsapp").eq("id", p.clienteId).maybeSingle();
  const c = cliente as { nome: string; responsavel_nome: string | null; whatsapp: string | null } | null;
  if (!c) return { ok: false, erro: "Cliente não encontrado." };

  // Um link aberto por cliente: o novo substitui o anterior (F2).
  await db.from("agencia_formularios").update({ situacao: "cancelado" }).eq("cliente_id", p.clienteId).eq("situacao", "aberto");
  const { token, hash } = novoToken();
  const { data, error } = await db
    .from("agencia_formularios")
    .insert({ cliente_id: p.clienteId, token_hash: hash, expira_em: new Date(Date.now() + VALIDADE_DO_FORMULARIO_MS).toISOString(), criado_por: p.userId })
    .select("id")
    .single();
  if (error || !data) return { ok: false, erro: "Não deu para gerar o link." };
  const formularioId = (data as { id: string }).id;
  const link = linkDoFormulario(env.NEXT_PUBLIC_APP_URL, token);

  let whatsapp: ResultadoDoWhatsapp = "nao_pedido";
  if (p.enviarNoWhatsapp) {
    const telefone = c.whatsapp ? normalizarWhatsapp(c.whatsapp) : null;
    if (!telefone) whatsapp = "sem_numero";
    else {
      const agencia = (await marcaDaSaida(null)).nome;
      const nome = (c.responsavel_nome ?? "").trim().split(/\s+/)[0];
      const fila = await enfileirarWhatsappDaAgencia({
        motivo: "formulario",
        referenciaId: formularioId,
        telefone,
        corpo: [
          `Olá${nome ? `, ${nome}` : ""}! Para começarmos, preencha o formulário de acesso da ${c.nome}:`,
          link,
          "O link vale 72 horas. Use só contas e senhas corporativas da empresa.",
          agencia,
        ].join("\n\n"),
      });
      whatsapp = fila.enfileirado ? "enviado" : "sem_whatsapp";
    }
  }
  return { ok: true, formularioId, link, whatsapp };
}
