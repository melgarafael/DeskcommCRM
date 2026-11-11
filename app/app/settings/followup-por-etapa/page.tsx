/**
 * CONFIGURAÇÕES → FOLLOW-UP POR ETAPA (#3603, fatia 3) — a TELA.
 *
 * ─── O que esta tela é (e o que ela deixou de ser) ─────────────────────────
 *
 * O acompanhamento por etapa existia inteiro no backend e só se montava no
 * construtor de fluxos: num produto self-host isso é o mesmo que não existir —
 * a única forma de configurar era `UPDATE` à mão no Postgres, o anti-exemplo de
 * "toda configuração tem superfície" (`docs/doctrine/restricao-de-canal.md`).
 *
 * A ENTRADA AUTOMÁTICA NO FUNIL saiu desta tela: ela vive na `main` como um
 * interruptor (`settings.entrada_automatica_no_funil.ativa`), por decisão de
 * quem mantém o produto — a escolha de funil e etapa foi retirada da action
 * (`definirEntradaAutomaticaNoFunil` recebe só `ativa`). Uma tela que
 * oferecesse funil e etapa gravaria um valor que ninguém lê.
 *
 * ─── Uma seção, uma gravação ───────────────────────────────────────────────
 *
 * `definirFollowupPorEtapa` grava `settings.followup_por_etapa`, o contrato de
 * `lib/schemas/settings.ts`. Um salvar para a seção inteira: gravar por linha
 * faria uma escrita de jsonb por etapa, e a segunda poderia falhar deixando a
 * tela pela metade sem ninguém ver.
 *
 * ─── Gate: manager+ ────────────────────────────────────────────────────────
 *
 * A mesma linha da matriz da spec 13 §4 que cobre "atendimento/routing": quem
 * monta a régua comercial da empresa é o gerente. Quem está abaixo disso cai em
 * /403 — a tela não é oferecida, e a action recusa por conta própria (a cortesia
 * da tela não é autorização).
 */
import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { followupPorEtapaDeclarado } from "@/lib/schemas/settings";
import { createClient } from "@/lib/supabase/server";
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

export default async function FollowupPorEtapaPage() {
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

  // A chave lida pela MESMA função que o serviço usa: a tela não pode mostrar
  // uma etapa marcada que o motor lê como desligada (nem o contrário).
  const followup = followupPorEtapaDeclarado(settings);

  // Funis e etapas abertos, na ordem do quadro. A RLS decide o que aparece; o
  // filtro de arquivado/ganho/perdido é o MESMO da gravação — oferecer uma etapa
  // que a action recusaria seria um formulário que só falha no salvar.
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
          {traduzir("Follow-up por etapa", idioma)}
        </h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "O que a operação espera de cada etapa do funil depois que a conversa chega.",
            idioma,
          )}
        </p>
      </header>

      <FollowupPorEtapaForm inicial={followup} funis={catalogo} idioma={idioma} />
    </div>
  );
}
