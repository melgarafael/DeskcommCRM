import type { NextRequest } from "next/server";

import { apenasDeMembrosAtivos } from "@/lib/agenda/google/membros";
import { janelaDaRodada, LOTE_DE_CONEXOES } from "@/lib/agenda/google/rodizio-de-conexoes";
import { configuracaoDaMicrosoft } from "@/lib/agenda/microsoft/config";
import { COLUNAS_DA_CONEXAO, sincronizarConexao, type ConexaoDaMicrosoft } from "@/lib/agenda/microsoft/sync";
import { PROVEDOR_MICROSOFT } from "@/lib/agenda/tipos";
import { comIdDaRequisicao, fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { recursoOcioso } from "@/lib/cron/piso-ocioso";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * O que roda depois do portão do piso ocioso — a saída antecipada é da rota
 * inteira (`tests/unit/cron-passa-pelo-portao.test.ts`).
 */
const PASSOS_DEPOIS_DO_PORTAO = [
  "const app",
  "if (!app)",
  "const db",
  "const {count}",
  "const elegiveis",
  "const janela",
  "const {data, error}",
  "if (error)",
  "const conexoes",
  "const efeitos",
  "for (conexao of conexoes)",
  "for ([organizationId, efeito] of efeitos)",
  "return",
] as const;
void PASSOS_DEPOIS_DO_PORTAO;

async function executar(req: NextRequest) {
  if (!autorizaCron(req))
    return comIdDaRequisicao(fail("unauthenticated", "cron secret inválido", 401), req);
  // Instalação sem conta Microsoft conectada não gasta consulta por minuto.
  if (await recursoOcioso("agenda_microsoft")) return ok({ pulado: "recurso_ocioso" });
  const app = await configuracaoDaMicrosoft();
  if (!app) return ok({ pulado: "sem_aplicativo" });

  const db = createAdminClient();
  const { count } = await db
    .from("calendar_connections")
    .select("id", { count: "exact", head: true })
    .eq("status", "healthy")
    .eq("provider", PROVEDOR_MICROSOFT);
  const elegiveis = () =>
    db
      .from("calendar_connections")
      .select(COLUNAS_DA_CONEXAO)
      .eq("status", "healthy")
      .eq("provider", PROVEDOR_MICROSOFT)
      .order("id");
  const janela = janelaDaRodada(count, new Date());
  const { data, error } = janela
    ? await elegiveis().range(janela.inicio, janela.fim)
    : await elegiveis().limit(LOTE_DE_CONEXOES);
  if (error)
    return comIdDaRequisicao(fail("internal_error", "Não foi possível ler as conexões do Outlook.", 500), req);

  // Quem saiu da empresa para de ter a agenda lida.
  const conexoes = await apenasDeMembrosAtivos(db, (data ?? []) as unknown as ConexaoDaMicrosoft[]);
  const efeitos = new Map<string, { calendarios: number; falhas: number }>();
  for (const conexao of conexoes) {
    const r = await sincronizarConexao(db, app, conexao);
    if (r.lidas === 0 && r.falhas === 0) continue;
    const total = efeitos.get(conexao.organization_id) ?? { calendarios: 0, falhas: 0 };
    efeitos.set(conexao.organization_id, {
      calendarios: total.calendarios + r.lidas,
      falhas: total.falhas + r.falhas,
    });
  }
  for (const [organizationId, efeito] of efeitos) {
    if (efeito.calendarios > 0 || efeito.falhas > 0)
      await audit({ action: "agenda.microsoft.sync_executado", organizationId, metadata: efeito });
  }
  return ok({ conexoes: conexoes.length, organizacoes: efeitos.size });
}

export const GET = executar;
export const POST = executar;
