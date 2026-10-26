"use server";

import { headers } from "next/headers";
import { z } from "zod";

import { buscarArquivo, estadoDoDrive, iniciarEnvio } from "@/lib/agencia/acervo/drive";
import { garantirPastasDoCliente } from "@/lib/agencia/acervo/pastas";
import { concluirFormulario } from "@/lib/agencia/formulario/envio";
import { FRASE_DO_LINK, lerFormularioPorToken, type FormularioAberto } from "@/lib/agencia/formulario/link";
import { pendenciasDoEnvio, respostasSchema, semSenhas, type EntradaDasRespostas } from "@/lib/agencia/formulario/perguntas";
import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { env } from "@/lib/env";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * As ações do formulário PÚBLICO (docs/agencia/SPEC-cofre-e-formulario.md). Quem
 * chama não tem conta: o token do link é a única credencial, conferido aqui pelo
 * hash a cada chamada, com limite de tentativas por endereço e por link (F10).
 */
type Resposta<T = undefined> = ({ ok: true } & (T extends undefined ? object : { dados: T })) | { ok: false; erro: string };

const TETO_POR_IP = 120;
const TETO_POR_LINK = 120;
const JANELA_S = 600;

async function formularioValido(token: string): Promise<FormularioAberto | { ok: false; erro: string }> {
  if (!(await moduloLigado(createAdminClient(), "agencia"))) return { ok: false, erro: FRASE_DO_LINK.inexistente };
  const ip = ipDoCliente(await headers()) ?? "sem-ip";
  const porIp = await checkRateLimit(`agencia-formulario-ip:${ip}`, TETO_POR_IP, JANELA_S);
  if (!porIp.allowed) return { ok: false, erro: "Muitas tentativas seguidas. Espere alguns minutos e tente de novo." };
  const f = await lerFormularioPorToken(token);
  if (!f) return { ok: false, erro: FRASE_DO_LINK.inexistente };
  const porLink = await checkRateLimit(`agencia-formulario-link:${f.id}`, TETO_POR_LINK, JANELA_S);
  if (!porLink.allowed) return { ok: false, erro: "Muitas tentativas seguidas. Espere alguns minutos e tente de novo." };
  if (f.situacao !== "valido") return { ok: false, erro: FRASE_DO_LINK[f.situacao] };
  return f;
}

/** Guarda o rascunho — SEM as senhas (F3). */
export async function salvarRascunho(token: string, entrada: EntradaDasRespostas): Promise<Resposta> {
  const f = await formularioValido(token);
  if ("ok" in f) return f;
  const p = respostasSchema.safeParse(entrada);
  if (!p.success) return { ok: false, erro: "Algum campo passou do tamanho. Confira e tente de novo." };
  const { error } = await createAdminClient()
    .from("agencia_formularios")
    .update({ rascunho: semSenhas(p.data) })
    .eq("id", f.id)
    .eq("situacao", "aberto");
  return error ? { ok: false, erro: "Não deu para salvar agora. Tente de novo." } : { ok: true };
}

export async function enviarFormulario(token: string, entrada: EntradaDasRespostas): Promise<Resposta> {
  const f = await formularioValido(token);
  if ("ok" in f) return f;
  const p = respostasSchema.safeParse(entrada);
  if (!p.success) return { ok: false, erro: "Algum campo passou do tamanho. Confira e tente de novo." };
  const falta = pendenciasDoEnvio(p.data);
  if (falta.length) return { ok: false, erro: `Falta preencher: ${falta.join(", ")}.` };
  return concluirFormulario(f, p.data);
}

const SUBPASTA_DA_CATEGORIA = { identidade: "04 Identidade visual", fotos: "05 Captações" } as const;
const categoriaSchema = z.enum(["identidade", "fotos"]);

async function pastaDoEnvio(f: FormularioAberto, categoria: keyof typeof SUBPASTA_DA_CATEGORIA): Promise<string | null> {
  if (!(await estadoDoDrive()).conectado) return null;
  await garantirPastasDoCliente(f.clienteId, { renomear: false });
  const { data } = await createAdminClient().from("agencia_clientes").select("drive_subpastas").eq("id", f.clienteId).maybeSingle();
  return (data as { drive_subpastas?: Record<string, string> } | null)?.drive_subpastas?.[SUBPASTA_DA_CATEGORIA[categoria]] ?? null;
}

/** Abre a sessão de envio direto ao Drive da agência (F8). */
export async function iniciarEnvioPublico(
  token: string,
  arquivo: { nome: string; mime: string; tamanho: number; categoria: string },
): Promise<Resposta<{ urlDeEnvio: string }>> {
  const f = await formularioValido(token);
  if ("ok" in f) return f;
  const c = categoriaSchema.safeParse(arquivo.categoria);
  const nome = z.string().trim().min(1).max(250).safeParse(arquivo.nome);
  const tamanho = z.number().int().min(1).max(20 * 1024 ** 3).safeParse(arquivo.tamanho);
  if (!c.success || !nome.success || !tamanho.success) return { ok: false, erro: "Arquivo inválido (até 20 GB)." };
  const pastaId = await pastaDoEnvio(f, c.data);
  if (!pastaId) return { ok: false, erro: "O envio de arquivos não está disponível agora. A agência vai pedir os arquivos depois." };
  const origem = (await headers()).get("origin") || new URL(env.NEXT_PUBLIC_APP_URL).origin;
  const s = await iniciarEnvio({ nome: nome.data, mime: arquivo.mime || "application/octet-stream", tamanho: tamanho.data, pastaId, origem });
  return s.ok ? { ok: true, dados: { urlDeEnvio: s.valor.urlDeEnvio } } : { ok: false, erro: s.erro };
}

/** Confere que o arquivo caiu na pasta certa e registra na ficha. */
export async function confirmarEnvioPublico(token: string, driveFileId: string, categoria: string): Promise<Resposta> {
  const f = await formularioValido(token);
  if ("ok" in f) return f;
  const c = categoriaSchema.safeParse(categoria);
  if (!c.success || !/^[A-Za-z0-9_-]{10,200}$/.test(driveFileId)) return { ok: false, erro: "Envio inválido." };
  const pastaId = await pastaDoEnvio(f, c.data);
  const arq = await buscarArquivo(driveFileId);
  if (!pastaId || !arq.ok || !arq.valor.parents?.includes(pastaId)) return { ok: false, erro: "O arquivo não chegou na pasta certa." };
  const { error } = await createAdminClient().from("agencia_arquivos").insert({
    cliente_id: f.clienteId,
    subpasta: SUBPASTA_DA_CATEGORIA[c.data],
    drive_file_id: arq.valor.id,
    nome: arq.valor.name,
    mime: arq.valor.mimeType ?? null,
    tamanho_bytes: arq.valor.size ? Number(arq.valor.size) : null,
    link: arq.valor.webViewLink,
  });
  if (error && error.code !== "23505") return { ok: false, erro: "O arquivo subiu, mas não deu para registrar." };
  return { ok: true };
}
