import "server-only";

import { criarAviso } from "@/lib/agencia/avisos/criar";
import { aoPublicarPostDoMapa } from "@/lib/agencia/mapas/motor";
import { logger } from "@/lib/logger";
import { lerConexaoSocial } from "@/lib/social-insights/meta-client";
import { createAdminClient } from "@/lib/supabase/admin";

import { publicarNaMeta, type ResultadoDaMeta } from "./meta";
import type { Formato, Rede } from "./regras";

/**
 * O motor das publicações (docs/agencia/SPEC-publicacoes.md): o que acontece
 * quando o cliente responde (P3) e a rodada do relógio que publica (P6).
 */

/** P3: a publicação acompanha a resposta do cliente à aprovação ligada a ela. */
export async function aoResponderAprovacaoDaPublicacao(publicacaoId: string, decisao: "aprovado" | "ajustes", comentario: string | null): Promise<void> {
  const db = createAdminClient();
  await db
    .from("agencia_publicacoes")
    .update(
      decisao === "aprovado"
        ? { situacao: "aprovada", comentario: null, atualizado_em: new Date().toISOString() }
        : { situacao: "rascunho", comentario, atualizado_em: new Date().toISOString() },
    )
    .eq("id", publicacaoId)
    .eq("situacao", "em_aprovacao");
}

interface Agendada {
  id: string;
  titulo: string;
  rede: Rede;
  formato: Formato;
  midia_url: string | null;
  legenda: string | null;
  responsavel_id: string | null;
  cliente_id: string;
  agencia_clientes: { nome: string; organization_id: string | null } | null;
}

async function publicarUma(p: Agendada): Promise<ResultadoDaMeta> {
  const orgId = p.agencia_clientes?.organization_id;
  if (!orgId) return { ok: false, erro: "O cliente não está ligado a uma organização do CRM." };
  if (!p.midia_url) return { ok: false, erro: "Falta o link da mídia." };
  const db = createAdminClient();
  const c = await lerConexaoSocial(db, orgId);
  if (!c.ok || !c.conexao) return { ok: false, erro: "A organização do cliente não tem a Meta conectada (Insights › Redes sociais)." };
  if (!c.token) return { ok: false, erro: "A conexão Meta do cliente está sem token: conecte de novo." };
  return publicarNaMeta(
    { facebookPageId: c.conexao.facebook_page_id, instagramBusinessId: c.conexao.instagram_business_id, token: c.token },
    { rede: p.rede, formato: p.formato, midiaUrl: p.midia_url, legenda: p.legenda },
  );
}

/**
 * P6: publica as agendadas com "publicar sozinho" cuja hora chegou. Cada uma é
 * TOMADA por uma rodada só (agendada → publicando no mesmo UPDATE); nunca tenta
 * de novo sozinha. Uma que ficou "publicando" por mais de 15 min (rodada morta)
 * vira "falhou" para alguém olhar — sem repetir, porque post em dobro é pior.
 */
export async function publicarAgendadas(agora = new Date()): Promise<{ publicadas: number; falharam: number }> {
  const db = createAdminClient();
  const travadas = await db
    .from("agencia_publicacoes")
    .update({ situacao: "falhou", erro: "A rodada que publicava parou no meio. Confira na rede antes de agendar de novo.", atualizado_em: agora.toISOString() })
    .eq("situacao", "publicando")
    .lt("atualizado_em", new Date(agora.getTime() - 15 * 60_000).toISOString())
    .select("id");
  let falharam = travadas.data?.length ?? 0;

  const { data: vez } = await db
    .from("agencia_publicacoes")
    .select("id")
    .eq("situacao", "agendada")
    .eq("auto_publicar", true)
    .lte("quando", agora.toISOString())
    .order("quando")
    .limit(10);
  const ids = ((vez ?? []) as Array<{ id: string }>).map((v) => v.id);
  if (ids.length === 0) return { publicadas: 0, falharam };
  // O `eq('situacao','agendada')` no UPDATE é a trava: duas rodadas não tomam a mesma.
  const { data } = await db
    .from("agencia_publicacoes")
    .update({ situacao: "publicando", atualizado_em: agora.toISOString() })
    .in("id", ids)
    .eq("situacao", "agendada")
    .select("id, titulo, rede, formato, midia_url, legenda, responsavel_id, cliente_id, agencia_clientes(nome, organization_id)");
  let publicadas = 0;
  for (const p of (data ?? []) as unknown as Agendada[]) {
    const r = await publicarUma(p);
    const fim = new Date().toISOString();
    if (r.ok) {
      publicadas++;
      await db
        .from("agencia_publicacoes")
        .update({ situacao: "publicada", post_id: r.postId, post_url: r.postUrl, erro: null, publicada_em: fim, atualizado_em: fim })
        .eq("id", p.id);
      await aoPublicarPostDoMapa(p.id);
    } else {
      falharam++;
      await db.from("agencia_publicacoes").update({ situacao: "falhou", erro: r.erro, atualizado_em: fim }).eq("id", p.id);
    }
    try {
      await criarAviso({
        alvo: p.responsavel_id ? { tipo: "membros", ids: [p.responsavel_id] } : { tipo: "gerais" },
        tipo: r.ok ? "publicacao_feita" : "publicacao_falhou",
        titulo: `${r.ok ? "No ar" : "Não publicou"}: ${p.titulo} — ${p.agencia_clientes?.nome ?? "Cliente"}`,
        corpo: r.ok ? r.postUrl : r.erro,
        link: `/agencia/publicacoes?abrir=${p.id}`,
        referenciaId: p.id,
      });
    } catch (e) {
      logger.warn("agência: publicação feita/falhou, aviso não saiu", { detalhe: e instanceof Error ? e.message : String(e) });
    }
  }
  return { publicadas, falharam };
}
