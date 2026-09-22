import { redirect } from "next/navigation";

import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { createClient } from "@/lib/supabase/server";
import { FUSO_PADRAO, diaNoFuso } from "@/lib/comercial/inteligencia";
import { carregarJanelaDeVendas } from "@/lib/comercial/janela";
import { cicloMedioDias, situacaoDaCarteira } from "@/lib/comercial/carteira";

import { CarteiraClient, type LinhaCarteira } from "./_client";

export const dynamic = "force-dynamic";

function fusoValido(fuso: string | null): string {
  if (!fuso) return FUSO_PADRAO;
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: fuso });
    return fuso;
  } catch {
    return FUSO_PADRAO;
  }
}

/**
 * CARTEIRA — o "detalhar carteira" do Mercos: cada cliente na sua situação
 * (ativo, inativo recente, inativo antigo, prospect), com última compra e
 * dias parado. A régua é o ciclo médio real da loja, não um número mágico.
 */
export default async function CarteiraPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");

  const supabase = await createClient();
  const agoraMs = new Date().getTime();
  const { data: org } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", activeOrg.orgId)
    .maybeSingle();
  const fuso = fusoValido((org as unknown as { timezone?: string | null } | null)?.timezone ?? null);
  const hoje = new Intl.DateTimeFormat("en-CA", { timeZone: fuso, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(agoraMs),
  );

  const { linhas: vendasCruas } = await carregarJanelaDeVendas(
    supabase,
    activeOrg.orgId,
    "2000-01-01",
  );
  const vendas: { contact_id: string | null; total_cents: number; status: string; dia: string }[] =
    vendasCruas.map((p) => ({
      contact_id: p.contact_id,
      total_cents: p.total_cents,
      status: p.status,
      dia: diaNoFuso(p.created_at, fuso),
    }));

  const { data: contatos } = await supabase
    .from("contacts")
    .select("id, display_name, name, phone_number")
    .eq("organization_id", activeOrg.orgId)
    .limit(10000);
  const nomes = new Map(
    ((contatos ?? []) as { id: string; display_name: string | null; name: string | null; phone_number: string | null }[]).map(
      (c) => [c.id, { nome: c.display_name ?? c.name ?? "—", fone: c.phone_number }],
    ),
  );

  const ciclo = cicloMedioDias(vendas);
  const resumo = situacaoDaCarteira({
    pedidos: vendas,
    totalContatos: nomes.size,
    hoje,
    cicloDias: ciclo,
  });

  const ultima = new Map<string, { dia: string; total: number }>();
  const somaHistorico = new Map<string, number>();
  for (const v of vendas) {
    if (!v.contact_id) continue;
    const atual = ultima.get(v.contact_id);
    if (!atual || atual.dia < v.dia) ultima.set(v.contact_id, { dia: v.dia, total: v.total_cents });
    somaHistorico.set(v.contact_id, (somaHistorico.get(v.contact_id) ?? 0) + v.total_cents);
  }
  const paraDias = (dia: string): number =>
    Math.round((new Date(`${hoje}T12:00:00Z`).getTime() - new Date(`${dia}T12:00:00Z`).getTime()) / 86400000);

  const linhas: LinhaCarteira[] = [...nomes.entries()].map(([id, c]) => {
    const u = ultima.get(id);
    const parados = u ? paraDias(u.dia) : null;
    const situacao = !u
      ? ("prospect" as const)
      : parados != null && parados <= ciclo
        ? ("ativo" as const)
        : parados != null && parados <= ciclo * 2
          ? ("inativo_recente" as const)
          : ("inativo_antigo" as const);
    return {
      contact_id: id,
      nome: c.nome,
      fone: c.fone,
      situacao,
      ultima_compra: u?.dia ?? null,
      dias_parado: parados,
      total_historico: somaHistorico.get(id) ?? 0,
    };
  });
  linhas.sort((a, b) => (a.dias_parado ?? 999999) - (b.dias_parado ?? 999999));

  return <CarteiraClient linhas={linhas} resumo={resumo} total={nomes.size} />;
}
