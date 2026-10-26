/**
 * Assinado E pago (docs/agencia/SPEC-contratos.md, K5): o que a agência fazia à
 * mão passa a acontecer sozinho, UMA vez — a troca de situação para `concluido`
 * é atômica e só quem a fizer segue para os efeitos.
 *
 * Cada efeito é independente: se o grupo não pôde ser criado, o formulário e a
 * trilha seguem, e a agência é avisada do que ficou para fazer à mão.
 */
import { audit } from "@/lib/audit";
import { marcaDaSaida } from "@/lib/branding/saida";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { criarAviso } from "../avisos/criar";
import { diaDe } from "../calendario/regras";
import { normalizarWhatsapp } from "../convite";
import { gerarFormulario } from "../formulario/gerar";
import { concluirPasso } from "../trilhas/motor";
import { CHAVE_ASSINOU_PAGOU } from "../trilhas/vocabulario";
import { criarGrupoPelaAgencia } from "../whatsapp/grupo";
import { dataDeAssinadoEPago, idDoWhatsapp, nomeDoGrupo } from "./regras";

export interface EfeitosDaConclusao {
  concluiu: boolean;
  trilha: boolean;
  formulario: string | null;
  grupo: string | null;
  pendencias: string[];
}

export async function concluirSeAssinadoEPago(contratoId: string, userId: string | null): Promise<EfeitosDaConclusao> {
  const nada: EfeitosDaConclusao = { concluiu: false, trilha: false, formulario: null, grupo: null, pendencias: [] };
  const db = createAdminClient();
  const { data } = await db
    .from("agencia_contratos")
    .select("id, cliente_id, situacao, assinado_em, pago_em, agencia_clientes(nome, whatsapp)")
    .eq("id", contratoId)
    .maybeSingle();
  const c = data as {
    id: string;
    cliente_id: string;
    situacao: string;
    assinado_em: string | null;
    pago_em: string | null;
    agencia_clientes: { nome: string; whatsapp: string | null } | null;
  } | null;
  if (!c || c.situacao === "concluido" || c.situacao === "cancelado" || c.situacao === "recusado") return nada;
  const quando = dataDeAssinadoEPago(c.assinado_em, c.pago_em);
  if (!quando) return nada;

  // A troca atômica: dois avisos ao mesmo tempo (webhook + botão), só um segue.
  const { data: trocou } = await db
    .from("agencia_contratos")
    .update({ situacao: "concluido", concluido_em: quando, atualizado_em: new Date().toISOString() })
    .eq("id", contratoId)
    .not("situacao", "in", "(concluido,cancelado,recusado)")
    .select("id");
  if (!trocou?.length) return nada;

  const efeitos: EfeitosDaConclusao = { ...nada, concluiu: true };
  const empresa = c.agencia_clientes?.nome ?? "Cliente";

  // 1. Cliente ativo.
  await db.from("agencia_clientes").update({ situacao: "ativo", atualizado_em: new Date().toISOString() }).eq("id", c.cliente_id);

  // 2. Trilha: conclui o marco (regra do dia 15) se ele está liberado.
  const { data: passo } = await db
    .from("agencia_trilha_passos")
    .select("id, situacao, agencia_trilhas!inner(cliente_id, situacao)")
    .eq("chave", CHAVE_ASSINOU_PAGOU)
    .eq("agencia_trilhas.cliente_id", c.cliente_id)
    .eq("agencia_trilhas.situacao", "ativa")
    .maybeSingle();
  const p = passo as { id: string; situacao: string } | null;
  if (p && (p.situacao === "liberado" || p.situacao === "em_andamento")) {
    const r = await concluirPasso(p.id, diaDe(quando), userId);
    efeitos.trilha = r.ok;
    if (!r.ok) efeitos.pendencias.push(`marcar "Contrato assinado e pago" na trilha (${r.erro})`);
  } else if (p && p.situacao === "bloqueado") {
    efeitos.pendencias.push('a trilha ainda não chegou em "Contrato assinado e pago" — conclua os passos anteriores');
  }

  // 3. Formulário de acesso pelo WhatsApp do responsável.
  const f = await gerarFormulario({ clienteId: c.cliente_id, userId, enviarNoWhatsapp: true }).catch(() => null);
  if (f?.ok) {
    efeitos.formulario = f.whatsapp;
    if (f.whatsapp !== "enviado") efeitos.pendencias.push("mandar o link do formulário ao cliente (está na aba Acessos)");
  } else efeitos.pendencias.push("gerar o link do formulário (aba Acessos)");

  // 4. O grupo "Em Movimento - <Empresa>" com o cliente e a equipe dele.
  const { data: equipe } = await db
    .from("agencia_clientes_membros")
    .select("agencia_membros!inner(whatsapp, situacao)")
    .eq("cliente_id", c.cliente_id)
    .eq("agencia_membros.situacao", "ativo");
  const telefones = [
    c.agencia_clientes?.whatsapp ? normalizarWhatsapp(c.agencia_clientes.whatsapp) : null,
    ...((equipe ?? []) as unknown as Array<{ agencia_membros: { whatsapp: string } }>).map((m) => m.agencia_membros.whatsapp),
  ]
    .map((t) => (t ? idDoWhatsapp(t) : null))
    .filter((x): x is string => !!x);
  const agencia = (await marcaDaSaida(null)).nome;
  const grupo = await criarGrupoPelaAgencia(nomeDoGrupo(agencia, empresa), [...new Set(telefones)]);
  if (grupo.ok) {
    efeitos.grupo = grupo.chatId;
    await db.from("agencia_contratos").update({ grupo_chat_id: grupo.chatId }).eq("id", contratoId);
  } else efeitos.pendencias.push(`criar o grupo "${nomeDoGrupo(agencia, empresa)}" à mão — ${grupo.motivo}`);

  // 5. Aviso para quem cuida dos avisos gerais.
  await criarAviso({
    alvo: { tipo: "gerais" },
    tipo: "contrato_concluido",
    titulo: `Contrato assinado e pago — ${empresa}`,
    corpo: efeitos.pendencias.length ? `Falta: ${efeitos.pendencias.join("; ")}.` : "Trilha, formulário e grupo prontos.",
    link: `/agencia/clientes/${c.cliente_id}?aba=contratos`,
    referenciaId: contratoId,
  }).catch((e) => logger.warn("agência: aviso do contrato concluído falhou", { detalhe: e instanceof Error ? e.message : String(e) }));

  void audit({
    action: "agencia.contrato_concluido",
    actorUserId: userId,
    organizationId: null,
    resourceType: "agencia_contrato",
    resourceId: contratoId,
    metadata: { trilha: efeitos.trilha, formulario: efeitos.formulario, grupo: !!efeitos.grupo, pendencias: efeitos.pendencias.length },
  });
  return efeitos;
}
