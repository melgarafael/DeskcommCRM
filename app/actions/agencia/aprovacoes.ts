"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { avisarClienteDaAprovacao, ligarAprovacoesNaOrganizacao } from "@/lib/agencia/aprovacoes/servico";
import { TIPOS_DE_APROVACAO } from "@/lib/agencia/aprovacoes/vocabulario";
import { apagarObjetos, conferirObjeto } from "@/lib/agencia/envios/armazenamento";
import { FORMAS_DO_TIPO, caminhoEhDoCliente, problemaNoArquivo } from "@/lib/agencia/envios/regras";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Pedir aprovação ao cliente (docs/agencia/SPEC-aprovacoes.md) — do lado da
 * agência. Quem cria tarefa pode pedir aprovação do que fez, para os clientes
 * que atende.
 */

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

const pedidoSchema = z
  .object({
    clienteId: z.string().uuid(),
    tipo: z.enum(TIPOS_DE_APROVACAO),
    titulo: z.string().trim().min(2, "Dê um título ao que vai para aprovação.").max(200),
    descricao: z.string().trim().max(4000).nullable(),
    link: z
      .string()
      .trim()
      .max(2000)
      .nullable()
      .refine((v) => !v || /^https:\/\//i.test(v), "O link precisa começar com https://."),
    arquivoId: z.string().uuid().nullable(),
    tarefaId: z.string().uuid().nullable(),
    origemId: z.string().uuid().nullable(),
    /** Roteiro, estratégia ou aviso escritos na própria tela (SPEC-envios, E2). */
    texto: z.string().trim().max(20000).nullable().prefault(null),
    /** Arquivo que o navegador já mandou ao bucket `agencia-envios` (E3). */
    envio: z
      .object({ caminho: z.string().max(200), nome: z.string().trim().min(1).max(200), mime: z.string().max(100), bytes: z.number().int().positive() })
      .nullable()
      .prefault(null),
  })
  .refine((p) => !!p.link || !!p.arquivoId || !!p.texto || !!p.envio, "Mande o arquivo, escreva o texto ou cole o link.")
  .refine((p) => (p.tipo === "aviso" ? !!p.texto && !p.envio && !p.link && !p.arquivoId : true), "O aviso é só texto.")
  .refine((p) => !p.texto || FORMAS_DO_TIPO[p.tipo].includes("texto"), "Este tipo de envio não leva texto: mande o arquivo.")
  .refine((p) => !p.envio || FORMAS_DO_TIPO[p.tipo].includes("arquivo"), "Este tipo de envio não leva arquivo.");
export type PedidoDeAprovacao = z.input<typeof pedidoSchema>;

export async function pedirAprovacao(entrada: PedidoDeAprovacao): Promise<ResultadoDaAcao<{ id: string; aviso: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    const p = pedidoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    if (!podeVerCliente(await carregarAlcance(ctx), d.clienteId)) return { ok: false as const, erro: "Você não atende esse cliente." };
    const db = createAdminClient();
    const { data: cliente } = await db.from("agencia_clientes").select("organization_id").eq("id", d.clienteId).maybeSingle();
    const organizationId = (cliente as { organization_id?: string | null } | null)?.organization_id;
    if (!organizationId) return { ok: false as const, erro: "Ligue o cliente a uma organização do CRM primeiro (ficha › Dados)." };

    // Link do arquivo do acervo, quando escolhido: tem de ser deste cliente.
    let link = d.link;
    if (d.arquivoId) {
      const { data: arq } = await db.from("agencia_arquivos").select("link, cliente_id").eq("id", d.arquivoId).maybeSingle();
      const a = arq as { link: string; cliente_id: string | null } | null;
      if (!a || a.cliente_id !== d.clienteId) return { ok: false as const, erro: "Arquivo não encontrado no acervo deste cliente." };
      link = link ?? a.link;
    }
    // E3: o arquivo tem de estar no bucket, na pasta DESTE cliente, com o tamanho e o tipo declarados.
    if (d.envio) {
      if (!caminhoEhDoCliente(d.envio.caminho, d.clienteId)) return { ok: false as const, erro: "Arquivo inválido." };
      const problema = problemaNoArquivo(d.tipo, d.envio.mime, d.envio.bytes);
      if (problema) return { ok: false as const, erro: problema };
      const obj = await conferirObjeto(d.envio.caminho);
      if (!obj || obj.bytes !== d.envio.bytes) return { ok: false as const, erro: "O arquivo não terminou de subir. Envie de novo." };
    }
    if (d.tarefaId) {
      const { data: t } = await db.from("agencia_tarefas").select("cliente_id").eq("id", d.tarefaId).maybeSingle();
      if ((t as { cliente_id?: string | null } | null)?.cliente_id !== d.clienteId) return { ok: false as const, erro: "A tarefa não é deste cliente." };
    }
    let versao = 1;
    if (d.origemId) {
      const { data: o } = await db.from("agencia_aprovacoes").select("versao, cliente_id").eq("id", d.origemId).maybeSingle();
      const origem = o as { versao: number; cliente_id: string } | null;
      if (!origem || origem.cliente_id !== d.clienteId) return { ok: false as const, erro: "Versão anterior não encontrada." };
      versao = Math.min(origem.versao + 1, 99);
    }

    const { data, error } = await db
      .from("agencia_aprovacoes")
      .insert({
        organization_id: organizationId,
        cliente_id: d.clienteId,
        tipo: d.tipo,
        titulo: d.titulo,
        descricao: d.descricao || null,
        link,
        arquivo_id: d.arquivoId,
        tarefa_id: d.tarefaId,
        versao,
        origem_id: d.origemId,
        pedido_por: ctx.user.id,
        texto: d.texto || null,
        arquivo_caminho: d.envio?.caminho ?? null,
        arquivo_nome: d.envio?.nome ?? null,
        arquivo_mime: d.envio?.mime ?? null,
        arquivo_bytes: d.envio?.bytes ?? null,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false as const, erro: "Não deu para pedir a aprovação." };
    const id = (data as { id: string }).id;

    await ligarAprovacoesNaOrganizacao(organizationId);
    // A tarefa ligada fica em Revisão enquanto o cliente olha (o aviso não pede revisão).
    if (d.tarefaId && d.tipo !== "aviso") {
      await db.from("agencia_tarefas").update({ coluna: "revisao", concluida_em: null, atualizada_em: new Date().toISOString() }).eq("id", d.tarefaId).neq("coluna", "concluido");
    }
    const destino = await avisarClienteDaAprovacao({ aprovacaoId: id, clienteId: d.clienteId, tipo: d.tipo, titulo: d.titulo, versao }).catch(() => "sem_whatsapp" as const);
    await auditarAgencia("agencia.aprovacao_pedida", ctx.user.id, { tipo: "agencia_aprovacao", id }, { tipo: d.tipo, versao, aviso: destino });
    revalidatePath(`/agencia/clientes/${d.clienteId}`);
    revalidatePath("/agencia/envios");
    const aviso = {
      grupo: "O grupo do cliente foi avisado.",
      responsavel: "O responsável foi avisado no WhatsApp.",
      sem_destino: "O cadastro não tem WhatsApp do cliente nem grupo: avise você.",
      sem_whatsapp: "O WhatsApp da agência não está configurado: avise você.",
    }[destino];
    return { ok: true as const, dados: { id, aviso } };
  });
}

export async function cancelarAprovacao(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("tarefas.criar");
    if (!idSchema.safeParse(id).success) return { ok: false as const, erro: "Aprovação inválida." };
    const db = createAdminClient();
    const { data } = await db.from("agencia_aprovacoes").select("cliente_id, arquivo_caminho, arquivo_apagado_em").eq("id", id).maybeSingle();
    const linha = data as { cliente_id?: string; arquivo_caminho: string | null; arquivo_apagado_em: string | null } | null;
    const clienteId = linha?.cliente_id;
    if (!clienteId || !podeVerCliente(await carregarAlcance(ctx), clienteId)) return { ok: false as const, erro: "Aprovação não encontrada." };
    const { data: cancelada } = await db.from("agencia_aprovacoes").update({ situacao: "cancelado" }).eq("id", id).eq("situacao", "pendente").select("id");
    if (cancelada?.length && linha?.arquivo_caminho && !linha.arquivo_apagado_em && (await apagarObjetos([linha.arquivo_caminho]))) {
      await db.from("agencia_aprovacoes").update({ arquivo_apagado_em: new Date().toISOString() }).eq("id", id);
    }
    await auditarAgencia("agencia.aprovacao_cancelada", ctx.user.id, { tipo: "agencia_aprovacao", id });
    revalidatePath(`/agencia/clientes/${clienteId}`);
    revalidatePath("/agencia/envios");
    return { ok: true as const };
  });
}
