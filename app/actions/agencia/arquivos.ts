"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { buscarArquivo, iniciarEnvio } from "@/lib/agencia/acervo/drive";
import { ehSubpasta, garantirPastasDoCliente, SUBPASTAS } from "@/lib/agencia/acervo/pastas";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { carregarQuemOlha, carregarTarefa } from "@/lib/agencia/tarefas/consultas";
import { env } from "@/lib/env";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Anexos no Google Drive (docs/agencia/SPEC-acervo.md, A5): o navegador envia
 * direto ao Google pela sessão que o servidor abre; depois o servidor confirma
 * que o arquivo caiu na subpasta certa do cliente e grava a linha.
 */

const pedidoSchema = z.object({
  clienteId: z.string().uuid(),
  tarefaId: z.string().uuid().nullable(),
  subpasta: z.string().refine(ehSubpasta, "Subpasta inválida."),
  nome: z.string().trim().min(1).max(250),
  mime: z.string().max(200),
  tamanho: z.number().int().min(1).max(50 * 1024 ** 3),
});

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

/** Confere que a pessoa alcança o cliente (e a tarefa, quando há) e devolve o id da subpasta. */
async function pastaPermitida(p: { clienteId: string; tarefaId: string | null; subpasta: string }) {
  const ctx = await exigirPermissao("tarefas.criar");
  const quem = await carregarQuemOlha(ctx);
  if (!podeVerCliente(quem.alcance, p.clienteId)) return { ctx, erro: "Você não atende esse cliente." };
  if (p.tarefaId) {
    const t = await carregarTarefa(p.tarefaId, quem);
    if (!t || t.clienteId !== p.clienteId) return { ctx, erro: "Tarefa não encontrada para esse cliente." };
  }
  await garantirPastasDoCliente(p.clienteId, { renomear: false });
  const { data } = await createAdminClient().from("agencia_clientes").select("drive_subpastas").eq("id", p.clienteId).maybeSingle();
  const pastaId = (data as { drive_subpastas?: Record<string, string> } | null)?.drive_subpastas?.[p.subpasta];
  if (!pastaId) return { ctx, erro: "O Google Drive não está conectado. Conecte em Configurações." };
  return { ctx, pastaId };
}

export async function iniciarEnvioDeArquivo(
  entrada: z.input<typeof pedidoSchema>,
): Promise<ResultadoDaAcao<{ urlDeEnvio: string }>> {
  return seguro(async () => {
    const p = pedidoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: p.error.issues[0]?.message ?? "Arquivo inválido." };
    const r = await pastaPermitida(p.data);
    if ("erro" in r && r.erro) return { ok: false as const, erro: r.erro };
    const hdrs = await headers();
    const origem = hdrs.get("origin") || new URL(env.NEXT_PUBLIC_APP_URL).origin;
    const s = await iniciarEnvio({ nome: p.data.nome, mime: p.data.mime, tamanho: p.data.tamanho, pastaId: r.pastaId!, origem });
    if (!s.ok) return { ok: false as const, erro: s.erro };
    return { ok: true as const, dados: { urlDeEnvio: s.valor.urlDeEnvio } };
  });
}

export async function confirmarEnvioDeArquivo(entrada: {
  clienteId: string;
  tarefaId: string | null;
  subpasta: string;
  driveFileId: string;
}): Promise<ResultadoDaAcao<{ link: string }>> {
  return seguro(async () => {
    const p = z
      .object({
        clienteId: z.string().uuid(),
        tarefaId: z.string().uuid().nullable(),
        subpasta: z.string().refine(ehSubpasta),
        driveFileId: z.string().regex(/^[A-Za-z0-9_-]{10,200}$/),
      })
      .safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: "Envio inválido." };
    const r = await pastaPermitida(p.data);
    if ("erro" in r && r.erro) return { ok: false as const, erro: r.erro };
    const arq = await buscarArquivo(p.data.driveFileId);
    if (!arq.ok) return { ok: false as const, erro: arq.erro };
    // O arquivo tem de estar na subpasta que o servidor abriu — nunca num lugar que a tela escolheu.
    if (!arq.valor.parents?.includes(r.pastaId!)) return { ok: false as const, erro: "O arquivo não está na pasta do cliente." };
    const { error } = await createAdminClient().from("agencia_arquivos").insert({
      cliente_id: p.data.clienteId,
      tarefa_id: p.data.tarefaId,
      subpasta: p.data.subpasta,
      drive_file_id: arq.valor.id,
      nome: arq.valor.name,
      mime: arq.valor.mimeType ?? null,
      tamanho_bytes: arq.valor.size ? Number(arq.valor.size) : null,
      link: arq.valor.webViewLink,
      enviado_por: r.ctx.user.id,
    });
    if (error && error.code !== "23505") return { ok: false as const, erro: "O arquivo subiu, mas não deu para registrar." };
    await auditarAgencia("agencia.arquivo_enviado", r.ctx.user.id, { tipo: "agencia_cliente", id: p.data.clienteId }, {
      subpasta: p.data.subpasta,
      tarefa_id: p.data.tarefaId,
    });
    revalidatePath(`/agencia/clientes/${p.data.clienteId}`);
    return { ok: true as const, dados: { link: arq.valor.webViewLink } };
  });
}

export async function subpastasDoAcervo(): Promise<readonly string[]> {
  return SUBPASTAS;
}
