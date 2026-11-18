/**
 * CONFIGURAÇÕES → FOLLOW-UP POR ETAPA (#3603) — a TELA.
 *
 * ─── O que esta tela é ─────────────────────────────────────────────────────
 *
 * O prazo de cada fluxo de "negócio parado na mesma etapa" já se editava no
 * construtor, mas só fluxo por fluxo: nenhuma tela mostrava, etapa por etapa,
 * quais desses fluxos alcançam cada uma e com que prazo.
 *
 * A tela mostra, para cada etapa aberta do funil, TODOS os fluxos de "negócio
 * parado na mesma etapa" que alcançam aquela etapa — com o prazo de cada um — e
 * grava o prazo NO PRÓPRIO FLUXO (`automation_rules.trigger_config.dias`).
 *
 * ─── O desenho que foi recusado, e por que ele morreu ──────────────────────
 *
 * A primeira versão guardava o prazo em `settings.followup_por_etapa` e a
 * varredura passou a obedecê-lo no lugar das regras. Dois donos para o mesmo
 * prazo: dois lembretes saíam juntos, um fluxo de 30 dias disparava em 6 h, e a
 * tela podia dizer o contrário do que acontecia. A decisão de quem mantém o
 * produto foi clara — um lugar só guarda o prazo —, e é a razão de esta página
 * LER `automation_rules` em vez de `organizations.settings`.
 *
 * O que continua fora daqui, de propósito: o TEXTO da mensagem. Ele vive na ação
 * `send_whatsapp_message`/`send_ai_message` do fluxo, onde uma pessoa o revisa
 * antes de sair; esta tela linka o construtor do fluxo em vez de abrir um campo
 * paralelo.
 *
 * ─── Gate: manager+ ────────────────────────────────────────────────────────
 *
 * A mesma linha da matriz da spec 13 §4 que cobre "atendimento/routing": quem
 * monta a régua comercial da empresa é o gerente. Quem está abaixo disso cai em
 * /403. A gravação também cobra esse papel por conta própria
 * (`PATCH /api/v1/automation-rules/[id]` exige `manager`) — a cortesia da tela
 * não é autorização.
 */
import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { GATILHO_ETAPA_PARADA } from "@/lib/automation/gatilhos-de-tempo";
import {
  fluxosDaEtapaParada,
  type RegraDeEtapaParadaCrua,
} from "@/lib/automation/prazos-da-etapa-parada";
import { traduzir } from "@/lib/i18n/dicionario";
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
  // Os FLUXOS, não um mapa de configuração: `automation_rules` é o único lugar em
  // que o prazo existe. `configDaEtapaParada` (a mesma função do editor e da
  // varredura) interpreta o `trigger_config` — a tela não tem um segundo leitor.
  const [{ data: regras }, { data: funis }, { data: etapas }] = await Promise.all([
    supabase
      .from("automation_rules")
      .select("id, name, trigger_config, is_active, actions")
      .eq("organization_id", activeOrg.orgId)
      .eq("trigger_event", GATILHO_ETAPA_PARADA)
      .order("created_at", { ascending: true }),
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

  const fluxos = fluxosDaEtapaParada((regras ?? []) as RegraDeEtapaParadaCrua[]);

  // Funis e etapas abertos, na ordem do quadro. A RLS decide o que aparece; o
  // filtro de arquivado/ganho/perdido é o MESMO do construtor de fluxos —
  // oferecer etapa que o gatilho não alcança seria um formulário que só mente.
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
      <CabecalhoDaSubTela titulo={traduzir("Follow-up por etapa", idioma)} idioma={idioma}>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "O que a operação espera de cada etapa do funil depois que a conversa chega.",
            idioma,
          )}
        </p>
      </CabecalhoDaSubTela>

      <FollowupPorEtapaForm fluxos={fluxos} funis={catalogo} idioma={idioma} />
    </div>
  );
}
