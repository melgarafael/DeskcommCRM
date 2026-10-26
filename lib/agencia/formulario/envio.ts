/**
 * O que acontece quando o cliente envia o formulário
 * (docs/agencia/SPEC-cofre-e-formulario.md, F4): respostas na ficha, senhas no
 * cofre, cópia legível sem senhas no Drive e aviso para a agência.
 *
 * O fechamento do formulário é atômico (`situacao = 'aberto'` e dentro da
 * validade no mesmo UPDATE): dois envios juntos, só um passa.
 */
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { enviarTexto, estadoDoDrive } from "../acervo/drive";
import { garantirPastasDoCliente } from "../acervo/pastas";
import { criarAviso } from "../avisos/criar";
import { gravarAcessosDoFormulario } from "../cofre/cofre";
import { normalizarWhatsapp } from "../convite";
import { semSenhas, textoLegivel, type Respostas } from "./perguntas";

/** Preenche só o que o cadastro ainda não tem — nunca sobrescreve o que a agência digitou. */
async function preencherFicha(clienteId: string, r: Respostas): Promise<void> {
  const db = createAdminClient();
  const { data } = await db
    .from("agencia_clientes")
    .select("razao_social, documento, site, whatsapp, email, instagram, responsavel_nome, cidade")
    .eq("id", clienteId)
    .maybeSingle();
  const atual = (data ?? {}) as Record<string, string | null>;
  const principal = r.empresas[0];
  const candidatos: Record<string, string | null> = {
    razao_social: principal?.nome || null,
    documento: principal?.cnpj || null,
    site: principal?.site || null,
    whatsapp: principal?.whatsapp ? (normalizarWhatsapp(principal.whatsapp) ?? principal.whatsapp) : null,
    email: principal?.email || null,
    instagram: r.acessos.instagram.naoTem ? null : r.acessos.instagram.login || null,
    responsavel_nome: r.responsaveis.find((x) => x.nome)?.nome ?? null,
  };
  const patch = Object.fromEntries(Object.entries(candidatos).filter(([k, v]) => v && !atual[k]));
  if (Object.keys(patch).length) {
    await db.from("agencia_clientes").update({ ...patch, atualizado_em: new Date().toISOString() }).eq("id", clienteId);
  }
  const { count } = await db.from("agencia_clientes_empresas").select("id", { count: "exact", head: true }).eq("cliente_id", clienteId);
  const empresas = r.empresas.filter((e) => e.nome);
  if (!count && empresas.length > 1) {
    await db
      .from("agencia_clientes_empresas")
      .insert(empresas.map((e, ordem) => ({ cliente_id: clienteId, nome: e.nome, documento: e.cnpj || null, ordem })));
  }
}

async function copiarNoDrive(clienteId: string, clienteNome: string, r: Respostas, quando: Date): Promise<boolean> {
  if (!(await estadoDoDrive()).conectado) return false;
  await garantirPastasDoCliente(clienteId, { renomear: false });
  const { data } = await createAdminClient().from("agencia_clientes").select("drive_subpastas").eq("id", clienteId).maybeSingle();
  const pasta = (data as { drive_subpastas?: Record<string, string> } | null)?.drive_subpastas?.["01 Formulário"];
  if (!pasta) return false;
  const dia = quando.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const ok = await enviarTexto({ nome: `Formulário de acesso ${dia}.txt`, conteudo: textoLegivel(r, clienteNome, quando), pastaId: pasta });
  if (!ok.ok) logger.warn("agência: cópia do formulário não foi para o Drive", { erro: ok.erro });
  return ok.ok;
}

export async function concluirFormulario(
  f: { id: string; clienteId: string; clienteNome: string },
  r: Respostas,
): Promise<{ ok: true } | { ok: false; erro: string }> {
  const db = createAdminClient();
  const agora = new Date();
  const { data, error } = await db
    .from("agencia_formularios")
    .update({ situacao: "enviado", respostas: semSenhas(r), rascunho: {}, enviado_em: agora.toISOString() })
    .eq("id", f.id)
    .eq("situacao", "aberto")
    .gt("expira_em", agora.toISOString())
    .select("id");
  if (error || !data?.length) return { ok: false, erro: "Este link não aceita mais envios. Peça um novo à agência." };

  const acessos = await gravarAcessosDoFormulario(f.clienteId, f.id, r.acessos);
  await preencherFicha(f.clienteId, r).catch((e) =>
    logger.warn("agência: ficha não recebeu as respostas do formulário", { detalhe: e instanceof Error ? e.message : String(e) }),
  );
  const noDrive = await copiarNoDrive(f.clienteId, f.clienteNome, r, agora).catch(() => false);
  await criarAviso({
    alvo: { tipo: "gerais" },
    tipo: "formulario_enviado",
    titulo: `Formulário preenchido — ${f.clienteNome}`,
    corpo: acessos ? `${acessos} acesso(s) no cofre.` : null,
    link: `/agencia/clientes/${f.clienteId}?aba=acessos`,
    referenciaId: f.id,
  }).catch(() => 0);
  void audit({
    action: "agencia.formulario_enviado",
    organizationId: null,
    resourceType: "agencia_formulario",
    resourceId: f.id,
    metadata: { cliente_id: f.clienteId, acessos, copia_no_drive: noDrive },
  });
  return { ok: true };
}
