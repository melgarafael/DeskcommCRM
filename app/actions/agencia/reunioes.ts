"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { exigirPermissao } from "@/lib/agencia/acesso";
import { auditarAgencia, erroDeAcesso, type ResultadoDaAcao } from "@/lib/agencia/auditoria";
import { carregarQuemOlhaAgenda, carregarReuniao, type ReuniaoDaAgenda } from "@/lib/agencia/calendario/consultas";
import { avisarAEquipe, avisarOCliente, sincronizarComOGoogle, tirarDoGoogle } from "@/lib/agencia/calendario/efeitos";
import { fechamentoUmaSemanaDepois, tituloSugerido } from "@/lib/agencia/calendario/regras";
import { FORMATOS, MARCOS_DE_LEMBRETE, SITUACOES_DA_REUNIAO, TIPOS_DE_REUNIAO } from "@/lib/agencia/calendario/vocabulario";
import { normalizarWhatsapp } from "@/lib/agencia/convite";
import { idSchema, primeiroErro } from "@/lib/agencia/schemas";
import { aoMudarReuniao, lerPasso, ligarAoPassoDaTrilha, ligarFechamentoAutomatico, ligarReuniao } from "@/lib/agencia/trilhas/motor";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Reuniões da agência (docs/agencia/SPEC-calendario.md). Marcar, mudar e
 * cancelar exigem `calendario.gerenciar` (K9), e o servidor confere de novo se
 * a pessoa alcança o cliente — o botão escondido na tela não é a garantia.
 */

const convidadoSchema = z.object({
  nome: z.string().trim().min(1, "Dê o nome do convidado.").max(120),
  whatsapp: z
    .string()
    .trim()
    .max(30)
    .transform((v, ctx) => {
      if (!v) return "";
      const n = normalizarWhatsapp(v);
      if (!n) {
        ctx.addIssue({ code: "custom", message: `WhatsApp inválido: ${v}. Use DDD + número.` });
        return z.NEVER;
      }
      return n;
    }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(200)
    .refine((v) => !v || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "E-mail de convidado inválido."),
});

const reuniaoSchema = z
  .object({
    id: z.string().uuid().optional(),
    tipo: z.enum(TIPOS_DE_REUNIAO),
    titulo: z.string().trim().min(2, "Dê um título à reunião.").max(200),
    clienteId: z.string().uuid().nullable(),
    inicio: z.string().datetime({ offset: true }),
    fim: z.string().datetime({ offset: true }),
    formato: z.enum(FORMATOS),
    local: z.string().trim().max(300).nullable(),
    pauta: z.string().trim().max(10_000).nullable(),
    membros: z.array(z.string().uuid()).max(30),
    convidados: z.array(convidadoSchema).max(20),
    avisarCliente: z.boolean(),
    marcarFechamento: z.boolean(),
    /** Marcada pelo botão de um passo da trilha (SPEC-trilhas). */
    trilhaPassoId: z.string().uuid().nullable().optional(),
  })
  .refine((r) => new Date(r.fim).getTime() > new Date(r.inicio).getTime(), "O fim tem de ser depois do início.")
  .refine((r) => r.formato !== "presencial" || !!r.local, "Informe o endereço da reunião presencial.");
export type EntradaDaReuniao = z.input<typeof reuniaoSchema>;

async function seguro<T>(acao: () => Promise<T>): Promise<T | { ok: false; erro: string }> {
  try {
    return await acao();
  } catch (e) {
    const negado = erroDeAcesso(e);
    if (negado) return negado;
    throw e;
  }
}

function revalidar(clienteId: string | null) {
  revalidatePath("/agencia/calendario");
  revalidatePath("/agencia");
  if (clienteId) revalidatePath(`/agencia/clientes/${clienteId}`);
}

async function eventIdDe(id: string): Promise<string | null> {
  const { data } = await createAdminClient().from("agencia_reunioes").select("google_event_id").eq("id", id).maybeSingle();
  return (data as { google_event_id: string | null } | null)?.google_event_id ?? null;
}

async function gravarParticipantes(id: string, membros: readonly string[], convidados: z.infer<typeof convidadoSchema>[]) {
  const db = createAdminClient();
  await db.from("agencia_reunioes_membros").delete().eq("reuniao_id", id);
  await db.from("agencia_reunioes_convidados").delete().eq("reuniao_id", id);
  if (membros.length) await db.from("agencia_reunioes_membros").insert(membros.map((membro_id) => ({ reuniao_id: id, membro_id })));
  if (convidados.length) {
    await db.from("agencia_reunioes_convidados").insert(
      convidados.map((c, ordem) => ({ reuniao_id: id, nome: c.nome, whatsapp: c.whatsapp || null, email: c.email || null, ordem })),
    );
  }
}

export async function salvarReuniao(entrada: EntradaDaReuniao): Promise<ResultadoDaAcao<{ id: string; fechamentoId: string | null }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("calendario.gerenciar");
    const p = reuniaoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const d = p.data;
    const quem = await carregarQuemOlhaAgenda(ctx);
    if (d.clienteId && !quem.alcance.todos && !quem.alcance.ids.has(d.clienteId)) {
      return { ok: false as const, erro: "Você não atende esse cliente." };
    }
    const membrosValidos = await membrosAtivos(d.membros);
    const db = createAdminClient();
    const agora = new Date().toISOString();
    const linha = {
      tipo: d.tipo,
      titulo: d.titulo,
      cliente_id: d.clienteId,
      inicio: d.inicio,
      fim: d.fim,
      formato: d.formato,
      local: d.formato === "presencial" ? d.local : null,
      pauta: d.pauta || null,
      avisar_cliente: d.avisarCliente,
      atualizada_em: agora,
    };

    // ── Mudança ──
    if (d.id) {
      const antes = await carregarReuniao(d.id, quem);
      if (!antes) return { ok: false as const, erro: "Reunião não encontrada." };
      if (antes.situacao === "cancelada") return { ok: false as const, erro: "Esta reunião foi cancelada. Marque uma nova." };
      const mudouHorario =
        new Date(antes.inicio).getTime() !== new Date(d.inicio).getTime() || new Date(antes.fim).getTime() !== new Date(d.fim).getTime();
      const { error } = await db
        .from("agencia_reunioes")
        .update({
          ...linha,
          ...(mudouHorario ? { horario_em: agora } : {}),
          // Deixou de ser online: o link antigo não vale mais.
          ...(d.formato !== "online" ? { meet_url: null } : {}),
        })
        .eq("id", d.id);
      if (error) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
      // Horário novo, lembretes do zero.
      if (mudouHorario) await db.from("agencia_lembretes_de_reuniao").delete().eq("reuniao_id", d.id);
      await gravarParticipantes(d.id, membrosValidos, d.convidados);

      const depois = await carregarReuniao(d.id, quem);
      if (depois) {
        const sincronizada = await sincronizarComOGoogle(depois, await eventIdDe(d.id));
        if (mudouHorario) {
          await avisarOCliente(sincronizada, "remarcada");
          await avisarAEquipe(sincronizada, "reuniao_alterada", membrosValidos, ctx.membro?.id ?? null, "Novo horário: ");
        }
        const novos = membrosValidos.filter((m) => !antes.membros.includes(m));
        if (!mudouHorario && novos.length) await avisarAEquipe(sincronizada, "reuniao_marcada", novos, ctx.membro?.id ?? null);
        // Remarcar a Apresentação arrasta o Fechamento marcado junto (SPEC-trilhas, R9).
        if (mudouHorario && d.tipo === "apresentacao") {
          await arrastarSeguintes(d.id, new Date(d.inicio).getTime() - new Date(antes.inicio).getTime(), quem, ctx.membro?.id ?? null);
        }
      }
      await aoMudarReuniao(d.id);
      await auditarAgencia("agencia.reuniao_alterada", ctx.user.id, { tipo: "agencia_reuniao", id: d.id }, { mudou_horario: mudouHorario });
      revalidar(d.clienteId);
      return { ok: true as const, dados: { id: d.id, fechamentoId: null } };
    }

    // ── Nova ──
    const nova = await inserir(linha, ctx.user.id, null, membrosValidos, d.convidados);
    if (!nova) return { ok: false as const, erro: "Não deu para marcar. Tente de novo." };

    // K5: a Apresentação já deixa o Fechamento marcado uma semana depois.
    let fechamento: ReuniaoDaAgenda | null = null;
    if (d.tipo === "apresentacao" && d.marcarFechamento) {
      const h = fechamentoUmaSemanaDepois(d.inicio, d.fim);
      const clienteNome = nova.clienteNome;
      fechamento = await inserir(
        { ...linha, tipo: "fechamento", titulo: tituloSugerido("fechamento", clienteNome), inicio: h.inicio, fim: h.fim, pauta: null },
        ctx.user.id,
        nova.id,
        membrosValidos,
        d.convidados,
      );
    }

    const apresentada = await sincronizarComOGoogle(nova, null);
    const fechamentoSinc = fechamento ? await sincronizarComOGoogle(fechamento, null) : null;
    await avisarOCliente(apresentada, "marcada", fechamentoSinc ? { tipo: "fechamento", inicio: fechamentoSinc.inicio } : null);
    await avisarAEquipe(apresentada, "reuniao_marcada", membrosValidos, ctx.membro?.id ?? null);
    if (fechamentoSinc) await avisarAEquipe(fechamentoSinc, "reuniao_marcada", membrosValidos, ctx.membro?.id ?? null);

    // A trilha do cliente fica sabendo da reunião: pelo passo que pediu, ou pelo primeiro passo desse tipo em aberto.
    if (d.clienteId) {
      let passoId: string | null = null;
      if (d.trilhaPassoId) {
        const passo = await lerPasso(d.trilhaPassoId);
        if (passo && passo.cliente_id === d.clienteId && passo.tipo === "reuniao") passoId = passo.id;
      }
      if (passoId && fechamento) await ligarFechamentoAutomatico(passoId, fechamento.id);
      if (passoId) await ligarReuniao(passoId, nova.id);
      else {
        const ligado = await ligarAoPassoDaTrilha(d.clienteId, d.tipo, nova.id);
        if (ligado && fechamento) await ligarFechamentoAutomatico(ligado, fechamento.id);
      }
    }

    await auditarAgencia("agencia.reuniao_marcada", ctx.user.id, { tipo: "agencia_reuniao", id: nova.id }, {
      tipo: d.tipo,
      formato: d.formato,
      fechamento_id: fechamento?.id ?? null,
    });
    revalidar(d.clienteId);
    return { ok: true as const, dados: { id: nova.id, fechamentoId: fechamento?.id ?? null } };
  });
}

/**
 * Desloca as reuniões marcadas a partir desta (o Fechamento da Apresentação, K5)
 * pelo mesmo tanto que ela andou — só as que ainda não aconteceram.
 */
async function arrastarSeguintes(origemId: string, deltaMs: number, quem: Awaited<ReturnType<typeof carregarQuemOlhaAgenda>>, quemFez: string | null) {
  if (deltaMs === 0) return;
  const db = createAdminClient();
  const { data } = await db
    .from("agencia_reunioes")
    .select("id, inicio, fim, google_event_id")
    .eq("origem_id", origemId)
    .eq("situacao", "marcada")
    .gt("inicio", new Date().toISOString());
  for (const s of (data ?? []) as Array<{ id: string; inicio: string; fim: string; google_event_id: string | null }>) {
    const inicio = new Date(new Date(s.inicio).getTime() + deltaMs).toISOString();
    const fim = new Date(new Date(s.fim).getTime() + deltaMs).toISOString();
    await db.from("agencia_reunioes").update({ inicio, fim, horario_em: new Date().toISOString(), atualizada_em: new Date().toISOString() }).eq("id", s.id);
    await db.from("agencia_lembretes_de_reuniao").delete().eq("reuniao_id", s.id);
    const depois = await carregarReuniao(s.id, quem);
    if (!depois) continue;
    const sincronizada = await sincronizarComOGoogle(depois, s.google_event_id);
    await avisarOCliente(sincronizada, "remarcada");
    await avisarAEquipe(sincronizada, "reuniao_alterada", sincronizada.membros, quemFez, "Novo horário: ");
    await aoMudarReuniao(s.id);
  }
}

async function membrosAtivos(ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data } = await createAdminClient().from("agencia_membros").select("id").in("id", [...ids]).eq("situacao", "ativo");
  return ((data ?? []) as Array<{ id: string }>).map((m) => m.id);
}

async function inserir(
  linha: Record<string, unknown>,
  userId: string,
  origemId: string | null,
  membros: readonly string[],
  convidados: z.infer<typeof convidadoSchema>[],
): Promise<ReuniaoDaAgenda | null> {
  const db = createAdminClient();
  const { data, error } = await db
    .from("agencia_reunioes")
    .insert({ ...linha, origem_id: origemId, criada_por: userId })
    .select("id")
    .single();
  if (error || !data) return null;
  const id = (data as { id: string }).id;
  await gravarParticipantes(id, membros, convidados);
  // Quem marcou pode ver; a releitura completa traz o nome do cliente e os participantes.
  return carregarReuniao(id, { gerencia: true, membroId: null, alcance: { todos: true } });
}

export async function cancelarReuniao(id: string): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("calendario.gerenciar");
    if (!idSchema.safeParse(id).success) return { ok: false as const, erro: "Reunião inválida." };
    const quem = await carregarQuemOlhaAgenda(ctx);
    const r = await carregarReuniao(id, quem);
    if (!r) return { ok: false as const, erro: "Reunião não encontrada." };
    if (r.situacao === "cancelada") return { ok: true as const };
    const { error } = await createAdminClient()
      .from("agencia_reunioes")
      .update({ situacao: "cancelada", atualizada_em: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false as const, erro: "Não deu para cancelar. Tente de novo." };
    await tirarDoGoogle(id, await eventIdDe(id));
    if (new Date(r.inicio).getTime() > Date.now()) {
      await avisarOCliente(r, "cancelada");
      await avisarAEquipe(r, "reuniao_alterada", r.membros, ctx.membro?.id ?? null, "Cancelada: ");
    }
    await aoMudarReuniao(id);
    await auditarAgencia("agencia.reuniao_cancelada", ctx.user.id, { tipo: "agencia_reuniao", id });
    revalidar(r.clienteId);
    return { ok: true as const };
  });
}

const resultadoSchema = z.object({
  id: z.string().uuid(),
  situacao: z.enum(SITUACOES_DA_REUNIAO).exclude(["cancelada"]),
  ata: z.string().trim().max(20_000).nullable(),
  gravacaoUrl: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .refine((u) => !u || /^https:\/\//i.test(u), "O link da gravação precisa começar com https://."),
});

/** Depois da reunião (K8): situação, ata e gravação. */
export async function registrarResultado(entrada: z.input<typeof resultadoSchema>): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("calendario.gerenciar");
    const p = resultadoSchema.safeParse(entrada);
    if (!p.success) return { ok: false as const, erro: primeiroErro(p.error) };
    const quem = await carregarQuemOlhaAgenda(ctx);
    const r = await carregarReuniao(p.data.id, quem);
    if (!r) return { ok: false as const, erro: "Reunião não encontrada." };
    if (r.situacao === "cancelada") return { ok: false as const, erro: "Esta reunião foi cancelada." };
    const { error } = await createAdminClient()
      .from("agencia_reunioes")
      .update({
        situacao: p.data.situacao,
        ata: p.data.ata || null,
        gravacao_url: p.data.gravacaoUrl || null,
        atualizada_em: new Date().toISOString(),
      })
      .eq("id", p.data.id);
    if (error) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
    // Realizada conclui o passo da trilha e libera os seguintes (SPEC-trilhas, R4).
    await aoMudarReuniao(p.data.id);
    await auditarAgencia(
      p.data.situacao === "realizada" ? "agencia.reuniao_realizada" : "agencia.reuniao_alterada",
      ctx.user.id,
      { tipo: "agencia_reuniao", id: p.data.id },
      { situacao: p.data.situacao, tem_ata: !!p.data.ata, tem_gravacao: !!p.data.gravacaoUrl },
    );
    revalidar(r.clienteId);
    return { ok: true as const };
  });
}

const lembretesSchema = z.array(z.number().int().refine((n) => (MARCOS_DE_LEMBRETE as readonly number[]).includes(n))).max(7);

/** Os marcos de lembrete da equipe (K7), em Configurações. */
export async function salvarLembretesDeReuniao(marcos: number[]): Promise<ResultadoDaAcao> {
  return seguro(async () => {
    const ctx = await exigirPermissao("configuracoes.gerenciar");
    const p = lembretesSchema.safeParse(marcos);
    if (!p.success) return { ok: false as const, erro: "Escolha os lembretes da lista." };
    const unicos = [...new Set(p.data)].sort((a, b) => b - a);
    const { error } = await createAdminClient().from("agencia_config").update({ reunioes_lembretes: unicos }).eq("id", true);
    if (error) return { ok: false as const, erro: "Não deu para salvar. Tente de novo." };
    await auditarAgencia("agencia.lembretes_de_reuniao_configurados", ctx.user.id, null, { marcos: unicos });
    revalidatePath("/agencia/configuracoes");
    return { ok: true as const };
  });
}

/**
 * Arrastar ou esticar no calendário (plano de 27/10, item 3): muda SÓ o horário,
 * pelo mesmo caminho de `salvarReuniao` — Agenda Google, aviso ao cliente e à
 * equipe, Fechamento arrastado junto e trilha sabendo.
 */
export async function remarcarReuniao(id: string, inicio: string, fim: string): Promise<ResultadoDaAcao<{ id: string; fechamentoId: string | null }>> {
  return seguro(async () => {
    const ctx = await exigirPermissao("calendario.gerenciar");
    if (!idSchema.safeParse(id).success) return { ok: false as const, erro: "Reunião inválida." };
    const r = await carregarReuniao(id, await carregarQuemOlhaAgenda(ctx));
    if (!r) return { ok: false as const, erro: "Reunião não encontrada." };
    if (r.situacao !== "marcada") return { ok: false as const, erro: "Só reunião marcada muda de horário." };
    return salvarReuniao({
      id,
      tipo: r.tipo,
      titulo: r.titulo,
      clienteId: r.clienteId,
      inicio,
      fim,
      formato: r.formato,
      local: r.local,
      pauta: r.pauta,
      membros: r.membros,
      convidados: r.convidados.map((c) => ({ nome: c.nome, whatsapp: c.whatsapp, email: c.email })),
      avisarCliente: r.avisarCliente,
      marcarFechamento: false,
    });
  });
}
