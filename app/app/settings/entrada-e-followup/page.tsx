/**
 * CONFIGURAÇÕES → ENTRADA E FOLLOW-UP (#3603, fatia 3) — a TELA.
 *
 * ─── Por que ela existe ────────────────────────────────────────────────────
 *
 * As duas decisões desta página existiam inteiras no backend e não tinham UMA
 * superfície: o funil e a etapa da entrada automática (fatia 1) moravam em
 * `organizations.settings.entrada_automatica_no_funil` e só se escreviam por
 * server action; o acompanhamento por etapa (fatia 2) só se montava no construtor
 * de fluxos. Num produto self-host isso é o mesmo que não existir: a única forma
 * de configurar era `UPDATE` à mão no Postgres — o anti-exemplo literal de "toda
 * configuração tem superfície" (`docs/doctrine/restricao-de-canal.md`).
 *
 * ─── Duas seções, duas gravações, NENHUMA duplicada ────────────────────────
 *
 * 1. **Entrada automática no funil** — a tela CHAMA
 *    `definirEntradaAutomaticaNoFunil`, a server action da fatia 1. Uma segunda
 *    action para a mesma chave divergiria no primeiro ajuste.
 * 2. **Follow-up por etapa** — `definirFollowupPorEtapa` grava
 *    `settings.followup_por_etapa`, o contrato de `lib/schemas/settings.ts`.
 *
 * ─── Gate: manager+ ───────────────────────────────────────────────────────
 *
 * A mesma linha da matriz da spec 13 §4 que cobre "atendimento/routing" e a
 * entrada no funil: quem monta a régua comercial da empresa é o gerente. Quem
 * está abaixo disso cai em /403 — a tela não é oferecida, e as DUAS actions
 * recusam por conta própria (a cortesia da tela não é autorização).
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import {
  entradaAutomaticaNoFunilDeclarada,
  followupPorEtapaDeclarado,
} from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";
import { EntradaNoFunilForm } from "./_entrada";
import { FollowupPorEtapaForm } from "./_followup";
import type { FunilDaTela } from "./_tipos";

export const dynamic = "force-dynamic";

interface FunilRow {
  id: string;
  name: string;
}

interface EtapaRow {
  id: string;
  name: string;
  pipeline_id: string;
  position: number;
}

export default async function EntradaEFollowupPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.manager) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const settings = (data?.settings ?? null) as unknown;

  // As duas chaves lidas pelas MESMAS funções que o serviço usa: a tela não pode
  // mostrar uma etapa marcada que o motor lê como desligada (nem o contrário).
  const entrada = entradaAutomaticaNoFunilDeclarada(settings);
  const followup = followupPorEtapaDeclarado(settings);

  // Funis e etapas abertos, na ordem do quadro. A RLS decide o que aparece; o
  // filtro de arquivado/ganho/perdido é o MESMO das duas gravações — oferecer uma
  // etapa que a action recusaria seria um formulário que só falha no salvar.
  const [{ data: funis }, { data: etapas }] = await Promise.all([
    supabase
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", activeOrg.orgId)
      .eq("is_archived", false)
      .order("position"),
    supabase
      .from("crm_stages")
      .select("id, name, pipeline_id, position")
      .eq("organization_id", activeOrg.orgId)
      .eq("is_archived", false)
      .eq("is_won", false)
      .eq("is_lost", false)
      .order("position"),
  ]);

  const porFunil = new Map<string, Array<{ id: string; name: string }>>();
  for (const etapa of (etapas ?? []) as EtapaRow[]) {
    porFunil.set(etapa.pipeline_id, [
      ...(porFunil.get(etapa.pipeline_id) ?? []),
      { id: etapa.id, name: etapa.name },
    ]);
  }
  const catalogo: FunilDaTela[] = ((funis ?? []) as FunilRow[]).map((funil) => ({
    id: funil.id,
    name: funil.name,
    etapas: porFunil.get(funil.id) ?? [],
  }));

  const idioma = user.idioma;

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {traduzir("Entrada e follow-up", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "O que acontece sozinho quando uma conversa nova chega, e o que a operação espera de cada etapa do funil depois disso.",
            idioma,
          )}
        </p>
      </header>

      <EntradaNoFunilForm
        inicial={{
          ativa: entrada.ativa,
          pipeline_id: entrada.pipeline_id,
          stage_id: entrada.stage_id,
        }}
        funis={catalogo}
        idioma={idioma}
      />

      <FollowupPorEtapaForm inicial={followup} funis={catalogo} idioma={idioma} />
    </div>
  );
}
