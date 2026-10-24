"use server";

import { revalidatePath } from "next/cache";

import { emitirEstado } from "@/lib/agenda/google/estado";
import { exigirPermissao } from "@/lib/agencia/acesso";
import { desconectarDrive, urlDeConsentimentoDoDrive } from "@/lib/agencia/acervo/drive";
import { garantirPastasDeTodos, sincronizarCompartilhamento } from "@/lib/agencia/acervo/pastas";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { env } from "@/lib/env";

/**
 * O Google Drive da agência (docs/agencia/SPEC-acervo.md). Só quem tem
 * `configuracoes.gerenciar`. O `state` é o mesmo formato assinado da Agenda,
 * com a "organização" literal `agencia` — a conexão é da instalação.
 */
const ORGANIZACAO_DO_STATE = "agencia";

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

export async function iniciarConexaoDoDrive(): Promise<ResultadoDaAcao<{ url: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("configuracoes.gerenciar");
    let state: string;
    try {
      state = emitirEstado({ organizationId: ORGANIZACAO_DO_STATE, userId: ctx.user.id }, { segredo: env.INTERNAL_SECRET, agora: new Date() });
    } catch {
      return { ok: false as const, erro: "A instalação está sem INTERNAL_SECRET; sem ele a volta do Google não é verificável." };
    }
    const url = await urlDeConsentimentoDoDrive(state);
    if (!url) return { ok: false as const, erro: "Configure primeiro o app do Google em Admin › Google Agenda." };
    return { ok: true as const, dados: { url } };
  });
}

export async function desconectarODrive(): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("configuracoes.gerenciar");
    await desconectarDrive();
    await auditarAgencia("agencia.drive_desconectado", ctx.user.id, null);
    revalidatePath("/agencia/configuracoes");
    return { ok: true as const };
  });
}

export async function criarPastasQueFaltam(): Promise<ResultadoDaAcao<{ prontos: number; falharam: number }>> {
  return seguro(async () => {
    await exigirPermissao("configuracoes.gerenciar");
    const r = await garantirPastasDeTodos();
    await sincronizarCompartilhamento();
    revalidatePath("/agencia/configuracoes");
    return { ok: true as const, dados: r };
  });
}
