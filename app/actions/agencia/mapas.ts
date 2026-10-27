"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao, type ContextoDaAgencia } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarAlcance, podeVerCliente } from "@/lib/agencia/clientes/visibilidade";
import { ACOES_DA_IA } from "@/lib/agencia/ia/catalogo";
import { ESPECIES, especieDe } from "@/lib/agencia/mapas/blocos";
import { blocosDoModelo, MODELOS_DE_MAPA } from "@/lib/agencia/mapas/modelos";
import { concluirMarcoDoMapa, lerMapa, publicarMapa } from "@/lib/agencia/mapas/motor";
import { problemaNoMapa } from "@/lib/agencia/mapas/regras";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * O mapa mental (docs/agencia/SPEC-mapa-mental.md). Criar, editar, ligar e
 * publicar exigem `mapa.editar` e alcançar o cliente do mapa (M6). As setas só
 * mudam em rascunho (M3).
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

/** O mapa, se a pessoa alcança o cliente dele. */
async function mapaPermitido(ctx: ContextoDaAgencia, mapaId: string) {
  if (!idSchema.safeParse(mapaId).success) return null;
  const { data } = await createAdminClient().from("agencia_mapas").select("id, cliente_id, situacao").eq("id", mapaId).maybeSingle();
  const m = data as { id: string; cliente_id: string; situacao: "rascunho" | "publicado" | "arquivado" } | null;
  return m && podeVerCliente(await carregarAlcance(ctx), m.cliente_id) ? m : null;
}

async function mapaDoBloco(ctx: ContextoDaAgencia, blocoId: string) {
  if (!idSchema.safeParse(blocoId).success) return null;
  const { data } = await createAdminClient().from("agencia_mapa_blocos").select("mapa_id").eq("id", blocoId).maybeSingle();
  const mapaId = (data as { mapa_id?: string } | null)?.mapa_id;
  return mapaId ? mapaPermitido(ctx, mapaId) : null;
}

function revalidar(mapaId: string) {
  revalidatePath(`/agencia/mapas/${mapaId}`);
  revalidatePath("/agencia/mapas");
}

export async function criarMapa(clienteId: string, titulo: string, modelo: string | null = null): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const t = z.string().trim().min(2, "Dê um nome ao mapa.").max(120).safeParse(titulo);
    if (!t.success) return { ok: false as const, erro: primeiroErro(t.error) };
    if (!idSchema.safeParse(clienteId).success || !podeVerCliente(await carregarAlcance(ctx), clienteId)) return { ok: false as const, erro: "Cliente não encontrado." };
    const { data, error } = await createAdminClient().from("agencia_mapas").insert({ cliente_id: clienteId, titulo: t.data, criado_por: ctx.user.id }).select("id").single();
    if (error || !data) return { ok: false as const, erro: "Não deu para criar o mapa." };
    const id = (data as { id: string }).id;
    // Mapa pronto para começar (plano de 27/10, item 5): os blocos e as setas do modelo.
    if (modelo && MODELOS_DE_MAPA.some((m) => m.id === modelo)) {
      const { blocos, setas } = blocosDoModelo(modelo);
      const db = createAdminClient();
      const { data: criados } = await db
        .from("agencia_mapa_blocos")
        .insert(blocos.map((b) => ({ ...b.linha, mapa_id: id })))
        .select("id");
      const idDe = new Map(blocos.map((b, i) => [b.chave, (criados?.[i] as { id: string } | undefined)?.id]));
      const ligacoes = setas
        .map(([de, para]) => ({ mapa_id: id, de_id: idDe.get(de), para_id: idDe.get(para) }))
        .filter((l): l is { mapa_id: string; de_id: string; para_id: string } => !!l.de_id && !!l.para_id);
      if (ligacoes.length) await db.from("agencia_mapa_ligacoes").insert(ligacoes);
    }
    await auditarAgencia("agencia.mapa_criado", ctx.user.id, { tipo: "agencia_mapa", id }, { cliente_id: clienteId, modelo });
    revalidatePath("/agencia/mapas");
    return { ok: true as const, dados: { id } };
  });
}

const blocoSchema = z.object({
  id: z.string().uuid().optional(),
  mapaId: z.string().uuid(),
  titulo: z.string().trim().min(1, "Dê um título ao bloco.").max(200),
  descricao: z.string().trim().max(4000).nullable(),
  cor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  x: z.number().finite().min(-20_000).max(20_000),
  y: z.number().finite().min(-20_000).max(20_000),
  /** A espécie da paleta; o efeito no motor (tipo) sai dela (lib/agencia/mapas/blocos.ts). */
  especie: z.string().refine((e) => ESPECIES.includes(e), "Bloco desconhecido.").prefault("tarefa"),
  /** Configuração por espécie: texto do aviso; rede e formato do post. */
  config: z
    .object({
      texto: z.string().trim().max(4000).optional(),
      rede: z.enum(["instagram", "facebook", "tiktok", "youtube", "outra"]).optional(),
      formato: z.enum(["feed", "reels", "story", "carrossel", "video"]).optional(),
    })
    .prefault({}),
  funcaoId: z.string().uuid().nullable(),
  responsavelId: z.string().uuid().nullable(),
  prazo: z.string().datetime({ offset: true }).nullable(),
  checklist: z.array(z.string().trim().min(1).max(300)).max(50),
  links: z.array(z.string().trim().max(2000).refine((u) => /^https?:\/\//i.test(u), "Link precisa começar com http.")).max(20),
  executor: z.enum(["humano", "ia"]),
  /** O que a IA faz quando o bloco é dela (SPEC-ia-da-agencia, I4). */
  acaoIa: z.enum(ACOES_DA_IA).nullable().prefault(null),
  /** Os blocos de que este depende (as setas que chegam nele). Só vale em rascunho. */
  dependeDe: z.array(z.string().uuid()).max(30),
});
export type EntradaDoBloco = z.input<typeof blocoSchema>;

export async function salvarBloco(entrada: EntradaDoBloco): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const p = blocoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    const m = await mapaPermitido(ctx, d.mapaId);
    if (!m || m.situacao === "arquivado") return { ok: false as const, erro: "Mapa não encontrado." };
    if (!d.id && m.situacao !== "rascunho") return { ok: false as const, erro: "Mapa publicado: o caminho não muda. Crie um mapa novo para o próximo plano." };
    const db = createAdminClient();
    const linha = {
      titulo: d.titulo,
      descricao: d.descricao || null,
      cor: d.cor,
      x: d.x,
      y: d.y,
      especie: d.especie,
      tipo: especieDe(d.especie).tipo,
      config: d.config,
      funcao_id: d.funcaoId,
      responsavel_id: d.responsavelId,
      prazo: d.prazo,
      checklist: d.checklist,
      links: d.links,
      executor: d.executor,
      acao_ia: d.executor === "ia" ? (d.acaoIa ?? "roteiro") : null,
    };
    let id = d.id;
    if (id) {
      const { data, error } = await db.from("agencia_mapa_blocos").update(linha).eq("id", id).eq("mapa_id", d.mapaId).select("id");
      if (error || !data?.length) return { ok: false as const, erro: "Não deu para salvar o bloco." };
    } else {
      const { data, error } = await db.from("agencia_mapa_blocos").insert({ ...linha, mapa_id: d.mapaId }).select("id").single();
      if (error || !data) return { ok: false as const, erro: "Não deu para criar o bloco." };
      id = (data as { id: string }).id;
    }
    // As setas que chegam no bloco, em rascunho: troca o conjunto, conferindo círculo.
    if (m.situacao === "rascunho") {
      const lido = await lerMapa(d.mapaId);
      if (lido) {
        const outras = lido.ligacoes.filter((l) => l.para_id !== id);
        const novas = d.dependeDe.filter((de) => de !== id && lido.blocos.some((b) => b.id === de)).map((de) => ({ de_id: de, para_id: id! }));
        const problema = problemaNoMapa(lido.blocos.map((b) => ({ id: b.id, titulo: b.titulo || "x" })), [...outras, ...novas]);
        if (problema?.includes("círculo")) return { ok: false as const, erro: problema };
        await db.from("agencia_mapa_ligacoes").delete().eq("mapa_id", d.mapaId).eq("para_id", id!);
        if (novas.length) await db.from("agencia_mapa_ligacoes").insert(novas.map((l) => ({ ...l, mapa_id: d.mapaId })));
      }
    }
    revalidar(d.mapaId);
    return { ok: true as const, dados: { id: id! } };
  });
}

/** Arrastar o bloco: só posição, vale em rascunho e publicado. */
export async function moverBloco(id: string, x: number, y: number): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const pos = z.object({ x: z.number().finite().min(-20_000).max(20_000), y: z.number().finite().min(-20_000).max(20_000) }).safeParse({ x, y });
    if (!pos.success) return { ok: false as const, erro: "Posição inválida." };
    const m = await mapaDoBloco(ctx, id);
    if (!m) return { ok: false as const, erro: "Bloco não encontrado." };
    await createAdminClient().from("agencia_mapa_blocos").update({ x: Math.round(pos.data.x), y: Math.round(pos.data.y) }).eq("id", id);
    return { ok: true as const };
  });
}

export async function excluirBloco(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const m = await mapaDoBloco(ctx, id);
    if (!m) return { ok: false as const, erro: "Bloco não encontrado." };
    if (m.situacao !== "rascunho") return { ok: false as const, erro: "Mapa publicado: o caminho não muda." };
    await createAdminClient().from("agencia_mapa_blocos").delete().eq("id", id);
    revalidar(m.id);
    return { ok: true as const };
  });
}

/** Liga A → B (B depende de A). Só em rascunho; recusa círculo. */
export async function ligarBlocos(mapaId: string, deId: string, paraId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const m = await mapaPermitido(ctx, mapaId);
    if (!m) return { ok: false as const, erro: "Mapa não encontrado." };
    if (m.situacao !== "rascunho") return { ok: false as const, erro: "Mapa publicado: o caminho não muda." };
    if (deId === paraId) return { ok: false as const, erro: "Um bloco não depende de si mesmo." };
    const lido = await lerMapa(mapaId);
    if (!lido || !lido.blocos.some((b) => b.id === deId) || !lido.blocos.some((b) => b.id === paraId)) return { ok: false as const, erro: "Bloco não encontrado." };
    const problema = problemaNoMapa(
      lido.blocos.map((b) => ({ id: b.id, titulo: b.titulo || "x" })),
      [...lido.ligacoes, { de_id: deId, para_id: paraId }],
    );
    if (problema?.includes("círculo")) return { ok: false as const, erro: "Essa seta fecharia um círculo." };
    const { error } = await createAdminClient().from("agencia_mapa_ligacoes").insert({ mapa_id: mapaId, de_id: deId, para_id: paraId });
    if (error && error.code !== "23505") return { ok: false as const, erro: "Não deu para ligar." };
    revalidar(mapaId);
    return { ok: true as const };
  });
}

export async function desligarBlocos(mapaId: string, deId: string, paraId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const m = await mapaPermitido(ctx, mapaId);
    if (!m || m.situacao !== "rascunho") return { ok: false as const, erro: "Só dá para tirar setas em rascunho." };
    await createAdminClient().from("agencia_mapa_ligacoes").delete().eq("mapa_id", mapaId).eq("de_id", deId).eq("para_id", paraId);
    revalidar(mapaId);
    return { ok: true as const };
  });
}

export async function publicarOMapa(mapaId: string): Promise<ResultadoDaAcao<{ liberados: number }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const m = await mapaPermitido(ctx, mapaId);
    if (!m) return { ok: false as const, erro: "Mapa não encontrado." };
    const r = await publicarMapa(mapaId);
    if (!r.ok) return r;
    await auditarAgencia("agencia.mapa_publicado", ctx.user.id, { tipo: "agencia_mapa", id: mapaId }, { liberados: r.liberados });
    revalidar(mapaId);
    revalidatePath("/agencia/tarefas");
    return { ok: true as const, dados: { liberados: r.liberados } };
  });
}

export async function arquivarMapa(mapaId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const m = await mapaPermitido(ctx, mapaId);
    if (!m) return { ok: false as const, erro: "Mapa não encontrado." };
    await createAdminClient().from("agencia_mapas").update({ situacao: "arquivado", atualizado_em: new Date().toISOString() }).eq("id", mapaId);
    await auditarAgencia("agencia.mapa_arquivado", ctx.user.id, { tipo: "agencia_mapa", id: mapaId });
    revalidar(mapaId);
    return { ok: true as const };
  });
}

export async function concluirMarco(blocoId: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const m = await mapaDoBloco(ctx, blocoId);
    if (!m) return { ok: false as const, erro: "Bloco não encontrado." };
    const r = await concluirMarcoDoMapa(blocoId);
    if (!r.ok) return r;
    revalidar(m.id);
    return { ok: true as const };
  });
}

/**
 * Acrescenta um bloco da paleta (plano de 27/10, item 5), já com o título, a cor
 * e o checklist da espécie — e, quando vem do "+" de outro bloco, já ligado a ele.
 */
export async function adicionarBloco(mapaId: string, especie: string, x: number, y: number, depoisDe: string | null = null): Promise<ResultadoDaAcao<{ id: string }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("mapa.editar");
    const m = await mapaPermitido(ctx, mapaId);
    if (!m || m.situacao !== "rascunho") return { ok: false as const, erro: "Só se acrescenta bloco em mapa em Criação." };
    if (!ESPECIES.includes(especie)) return { ok: false as const, erro: "Bloco desconhecido." };
    const e = especieDe(especie);
    const db = createAdminClient();
    const { data, error } = await db
      .from("agencia_mapa_blocos")
      .insert({
        mapa_id: mapaId,
        especie,
        tipo: e.tipo,
        titulo: e.titulo || e.rotulo,
        cor: e.cor,
        x: Math.max(-20_000, Math.min(20_000, Math.round(x))),
        y: Math.max(-20_000, Math.min(20_000, Math.round(y))),
        checklist: e.checklist ?? [],
        executor: e.executor ?? "humano",
        acao_ia: e.executor === "ia" ? (e.acaoIa ?? null) : null,
      })
      .select("id")
      .single();
    if (error || !data) return { ok: false as const, erro: "Não deu para acrescentar o bloco." };
    const id = (data as { id: string }).id;
    if (depoisDe && idSchema.safeParse(depoisDe).success && e.tipo !== "nota") {
      const { data: de } = await db.from("agencia_mapa_blocos").select("id").eq("id", depoisDe).eq("mapa_id", mapaId).maybeSingle();
      if (de) await db.from("agencia_mapa_ligacoes").insert({ mapa_id: mapaId, de_id: depoisDe, para_id: id });
    }
    revalidar(mapaId);
    return { ok: true as const, dados: { id } };
  });
}
