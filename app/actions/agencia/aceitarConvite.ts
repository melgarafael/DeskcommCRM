"use server";

import { redirect } from "next/navigation";
import { z } from "zod";

import { fecharConvite, lerConvite, type ConviteAberto } from "@/lib/agencia/aceite";
import { auditarAgencia } from "@/lib/agencia/auditoria";
import { criarAviso } from "@/lib/agencia/avisos/criar";
import { FRASE_DA_SITUACAO, mesmoEmail } from "@/lib/agencia/convite";
import { moduloLigado } from "@/lib/instalacao/modulos";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * Aceite do convite da agência (SPEC-equipe › Convite, passo 4).
 *
 * Três caminhos, todos terminando em `concluir`:
 *  - quem já está logado com o e-mail do convite só confirma;
 *  - quem não tem conta cria a senha aqui (a conta nasce com o e-mail
 *    confirmado: o convite chegou pelo WhatsApp ou pelas mãos de quem
 *    administra, e é ele que prova o vínculo);
 *  - quem já tem conta entra com a senha que tem.
 */
export type ResultadoDoAceite = { ok: false; erro: string; jaTemConta?: boolean };

const senhaSchema = z.string().min(8, "A senha precisa ter pelo menos 8 caracteres.").max(72);

async function conviteValido(token: string): Promise<ConviteAberto | ResultadoDoAceite> {
  if (!(await moduloLigado(createAdminClient(), "agencia"))) return { ok: false, erro: "Convite indisponível." };
  const convite = await lerConvite(token);
  if (!convite) return { ok: false, erro: FRASE_DA_SITUACAO.inexistente };
  if (convite.situacao !== "valido") return { ok: false, erro: FRASE_DA_SITUACAO[convite.situacao] };
  return convite;
}

async function concluir(convite: ConviteAberto, userId: string): Promise<ResultadoDoAceite> {
  if (!(await fecharConvite(convite, userId))) return { ok: false, erro: FRASE_DA_SITUACAO.aceito };
  await auditarAgencia("agencia.membro_ativado", userId, { tipo: "agencia_membro", id: convite.membroId });
  try {
    await criarAviso({
      alvo: { tipo: "gerais" },
      tipo: "convite_aceito",
      titulo: `${convite.nome} entrou na equipe`,
      link: "/agencia/equipe",
      referenciaId: convite.membroId,
    });
  } catch (e) {
    logger.warn("agência: convite aceito, aviso ao dono falhou", { detalhe: e instanceof Error ? e.message : String(e) });
  }
  redirect("/agencia");
}

/** Já logado com o e-mail certo: só confirma. */
export async function aceitarLogado(token: string): Promise<ResultadoDoAceite> {
  const c = await conviteValido(token);
  if ("ok" in c) return c;
  const {
    data: { user },
  } = await (await createClient()).auth.getUser();
  if (!user) return { ok: false, erro: "Entre com a sua conta primeiro." };
  if (!mesmoEmail(user.email ?? "", c.email)) {
    return { ok: false, erro: `Este convite é para ${c.email}. Saia desta conta e abra o link de novo.` };
  }
  return concluir(c, user.id);
}

/** Sem conta: cria com a senha escolhida e entra. */
export async function criarContaPeloConvite(token: string, senha: string): Promise<ResultadoDoAceite> {
  const c = await conviteValido(token);
  if ("ok" in c) return c;
  const p = senhaSchema.safeParse(senha);
  if (!p.success) return { ok: false, erro: p.error.issues[0]?.message ?? "Senha inválida." };

  const { data, error } = await createAdminClient().auth.admin.createUser({
    email: c.email,
    password: p.data,
    email_confirm: true,
    user_metadata: { full_name: c.nome },
  });
  if (error || !data.user) {
    const jaExiste = /already|registered|exists/i.test(error?.message ?? "");
    if (jaExiste) return { ok: false, erro: "Você já tem uma conta com este e-mail. Entre com a sua senha.", jaTemConta: true };
    logger.error("agência: conta do convite não foi criada", { detalhe: error?.message });
    return { ok: false, erro: "Não deu para criar a conta. Tente de novo." };
  }

  const { error: erroDeEntrada } = await (await createClient()).auth.signInWithPassword({ email: c.email, password: p.data });
  if (erroDeEntrada) return { ok: false, erro: "Conta criada, mas a entrada falhou. Entre pela tela de login." };
  return concluir(c, data.user.id);
}

/** Já tem conta: entra com a senha que tem. */
export async function entrarPeloConvite(token: string, senha: string): Promise<ResultadoDoAceite> {
  const c = await conviteValido(token);
  if ("ok" in c) return c;
  const { data, error } = await (await createClient()).auth.signInWithPassword({ email: c.email, password: senha });
  if (error || !data.user) return { ok: false, erro: "Senha incorreta." };
  return concluir(c, data.user.id);
}
