"use server";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { TIPOS_DE_APROVACAO } from "@/lib/agencia/aprovacoes/vocabulario";
import { erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { assinarEnvio } from "@/lib/agencia/envios/armazenamento";
import { BUCKET_DOS_ENVIOS, PARTE_DO_ENVIO, caminhoDoEnvio, problemaNoArquivo } from "@/lib/agencia/envios/regras";
import { primeiroErro } from "@/lib/agencia/schemas";
import { env } from "@/lib/env";

/**
 * Envios (docs/agencia/SPEC-envios.md, E3): a permissão para o navegador mandar
 * UM arquivo ao bucket privado, em partes. Quem pede aprovação depois é
 * `pedirAprovacao`, que confere o objeto que chegou.
 */

const pedidoSchema = z.object({
  clienteId: z.string().uuid(),
  tipo: z.enum(TIPOS_DE_APROVACAO),
  nome: z.string().trim().min(1).max(200),
  mime: z.string().max(100),
  bytes: z.number().int().positive(),
});

export interface PermissaoDeEnvio {
  endpoint: string;
  assinatura: string;
  /** A chave pública (anon) do Supabase: o gateway pede `apikey`; não dá poder nenhum sem a assinatura. */
  chavePublica: string;
  bucket: string;
  caminho: string;
  parte: number;
}

export async function prepararEnvioDeArquivo(entrada: z.input<typeof pedidoSchema>): Promise<ResultadoDaAcao<PermissaoDeEnvio>> {
  try {
    const ctx = await exigirPermissao("tarefas.criar");
    const p = pedidoSchema.safeParse(entrada);
    if (!p.success) return { ok: false, erro: primeiroErro(p.error) };
    const d = p.data;
    if (!podeVerCliente(await carregarAlcance(ctx), d.clienteId)) return { ok: false, erro: "Você não atende esse cliente." };
    const problema = problemaNoArquivo(d.tipo, d.mime, d.bytes);
    if (problema) return { ok: false, erro: problema };
    const caminho = caminhoDoEnvio(d.clienteId, randomUUID(), d.mime);
    const assinado = await assinarEnvio(caminho);
    if (!assinado) return { ok: false, erro: "O armazenamento não liberou o envio agora. Tente de novo." };
    return {
      ok: true,
      dados: { ...assinado, chavePublica: env.NEXT_PUBLIC_SUPABASE_ANON_KEY, bucket: BUCKET_DOS_ENVIOS, caminho, parte: PARTE_DO_ENVIO },
    };
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}
