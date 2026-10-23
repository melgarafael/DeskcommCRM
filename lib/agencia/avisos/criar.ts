/**
 * `criarAviso` — a ÚNICA porta das notificações da agência (SPEC-avisos › Limites).
 *
 * Um aviso, dois caminhos (A1): a linha do sininho é a verdade; o WhatsApp é
 * cópia, para quem aceita recebê-lo (A2). Nunca lança por causa do WhatsApp: o
 * sininho já registrou, e a falha aparece em "Últimos envios".
 */
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

import { enfileirarWhatsappDaAgencia } from "../whatsapp/enfileirar";
import { destinatariosDoAviso, type AlvoDoAviso, type MembroCandidato } from "./destinatarios";
import { textoDoAviso } from "./texto";
import type { TipoDeAviso } from "./tipos";

export interface NovoAviso {
  alvo: AlvoDoAviso;
  tipo: TipoDeAviso;
  titulo: string;
  corpo?: string | null;
  /** Caminho interno, ex.: `/agencia/tarefas/<id>`. */
  link?: string | null;
  referenciaId?: string | null;
}

interface LinhaDoMembro {
  id: string;
  user_id: string | null;
  situacao: string;
  whatsapp: string;
  recebe_whatsapp: boolean;
  agencia_membros_funcoes: Array<{
    agencia_funcoes: { ativa: boolean; permissoes: string[] } | Array<{ ativa: boolean; permissoes: string[] }> | null;
  }> | null;
}

function funcoes(l: LinhaDoMembro): MembroCandidato["funcoes"] {
  return (l.agencia_membros_funcoes ?? []).flatMap((v) => {
    const f = v.agencia_funcoes;
    return !f ? [] : Array.isArray(f) ? f : [f];
  });
}

/** Devolve quantos membros receberam o aviso no sininho. */
export async function criarAviso(aviso: NovoAviso): Promise<number> {
  const db = createAdminClient();

  let consulta = db
    .from("agencia_membros")
    .select("id, user_id, situacao, whatsapp, recebe_whatsapp, agencia_membros_funcoes(agencia_funcoes(ativa, permissoes))")
    .eq("situacao", "ativo");
  if (aviso.alvo.tipo === "membros") consulta = consulta.in("id", [...aviso.alvo.ids]);
  const { data, error } = await consulta;
  if (error) {
    logger.error("agência: não deu para ler os destinatários do aviso", { codigo: error.code, tipo: aviso.tipo });
    return 0;
  }
  const linhas = (data ?? []) as LinhaDoMembro[];

  let donos = new Set<string>();
  if (aviso.alvo.tipo === "gerais") {
    const { data: admins } = await db.from("platform_admins").select("user_id").eq("scope", "full").is("revoked_at", null);
    donos = new Set(((admins ?? []) as Array<{ user_id: string }>).map((a) => a.user_id));
  }

  const ids = new Set(
    destinatariosDoAviso(
      aviso.alvo,
      linhas.map((l) => ({ id: l.id, user_id: l.user_id, situacao: l.situacao, funcoes: funcoes(l) })),
      donos,
    ),
  );
  const alvos = linhas.filter((l) => ids.has(l.id));
  if (alvos.length === 0) return 0;

  const { error: erroDoSininho } = await db.from("agencia_avisos").insert(
    alvos.map((l) => ({
      membro_id: l.id,
      tipo: aviso.tipo,
      titulo: aviso.titulo,
      corpo: aviso.corpo ?? null,
      link: aviso.link ?? null,
      referencia_id: aviso.referenciaId ?? null,
    })),
  );
  if (erroDoSininho) {
    logger.error("agência: não deu para gravar o aviso", { codigo: erroDoSininho.code, tipo: aviso.tipo });
    return 0;
  }

  for (const l of alvos.filter((x) => x.recebe_whatsapp)) {
    try {
      await copiarNoWhatsapp(l.whatsapp, aviso);
    } catch (e) {
      logger.warn("agência: aviso gravado, cópia no WhatsApp falhou", {
        tipo: aviso.tipo,
        detalhe: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return alvos.length;
}

/**
 * Agrupa com o envio PENDENTE do mesmo tipo para o mesmo número (A4); senão
 * enfileira um novo. O envio de aviso espera `AGRUPAMENTO_MS` antes de sair
 * (`lib/agencia/whatsapp/regra.ts`) justamente para esta junção acontecer.
 */
async function copiarNoWhatsapp(telefone: string, aviso: NovoAviso): Promise<void> {
  const db = createAdminClient();
  const base = env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "");
  const url = `${base}${aviso.link ?? "/agencia"}`;

  const { data: pendente } = await db
    .from("agencia_envios_whatsapp")
    .select("id, titulos")
    .eq("situacao", "pendente")
    .eq("motivo", "aviso")
    .eq("telefone", telefone)
    .eq("grupo", aviso.tipo)
    .order("criado_em", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (pendente) {
    const p = pendente as { id: string; titulos: string[] };
    const titulos = [...p.titulos, aviso.titulo];
    // Vários avisos juntos apontam para a área, não para um item só.
    const corpo = textoDoAviso({ tipo: aviso.tipo, titulos, url: `${base}/agencia` });
    await db.from("agencia_envios_whatsapp").update({ titulos, corpo }).eq("id", p.id).eq("situacao", "pendente");
    return;
  }

  await enfileirarWhatsappDaAgencia({
    motivo: "aviso",
    referenciaId: aviso.referenciaId ?? null,
    telefone,
    corpo: textoDoAviso({ tipo: aviso.tipo, titulos: [aviso.titulo], corpo: aviso.corpo, url }),
    grupo: aviso.tipo,
    titulos: [aviso.titulo],
  });
}
