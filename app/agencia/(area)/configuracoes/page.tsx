import { ConfiguracoesCliente, type CanalDaLista, type EnvioDaLista } from "@/components/agencia/ConfiguracoesCliente";
import { LembretesDeReuniao } from "@/components/agencia/calendario/LembretesDeReuniao";
import { SecaoDoDrive } from "@/components/agencia/SecaoDoDrive";
import { estadoDoDrive, retornoDoDrive } from "@/lib/agencia/acervo/drive";
import { requirePermissaoNaPagina } from "@/lib/agencia/acesso";
import { mascararTelefone } from "@/lib/agencia/whatsapp/regra";
import { createAdminClient } from "@/lib/supabase/admin";

export const metadata = { title: "Configurações · Agência" };
export const dynamic = "force-dynamic";

/** WhatsApp da agência, horário e antecedência dos avisos, lembretes de reunião e a conexão Google. */
export default async function PaginaDeConfiguracoes({ searchParams }: { searchParams: Promise<{ drive?: string }> }) {
  await requirePermissaoNaPagina("configuracoes.gerenciar");
  const db = createAdminClient();
  const [{ drive: resultadoDoDrive }, estadoDrive] = await Promise.all([searchParams, estadoDoDrive()]);

  const [config, canais, envios] = await Promise.all([
    db
      .from("agencia_config")
      .select("canal_session_id, janela_inicio, janela_fim, avisos_antecedencia, reunioes_lembretes")
      .eq("id", true)
      .maybeSingle(),
    db
      .from("channel_sessions")
      .select("id, display_name, phone_number, status, organization_id, organizations(display_name)")
      .is("archived_at", null)
      .order("created_at"),
    db
      .from("agencia_envios_whatsapp")
      .select("id, motivo, telefone, situacao, erro_codigo, criado_em, enviado_em")
      .order("criado_em", { ascending: false })
      .limit(20),
  ]);

  const c = config.data as {
    canal_session_id: string | null;
    janela_inicio: string;
    janela_fim: string;
    avisos_antecedencia: number[];
    reunioes_lembretes: number[] | null;
  } | null;

  const listaDeCanais: CanalDaLista[] = (
    (canais.data ?? []) as Array<{
      id: string;
      display_name: string | null;
      phone_number: string | null;
      status: string;
      organizations: { display_name: string | null } | Array<{ display_name: string | null }> | null;
    }>
  ).map((x) => {
    const org = Array.isArray(x.organizations) ? x.organizations[0] : x.organizations;
    return {
      id: x.id,
      rotulo: [org?.display_name, x.display_name ?? x.phone_number].filter(Boolean).join(" · ") || "WhatsApp",
      conectado: x.status === "WORKING",
    };
  });

  const ultimos: EnvioDaLista[] = (
    (envios.data ?? []) as Array<{
      id: string;
      motivo: string;
      telefone: string;
      situacao: string;
      erro_codigo: string | null;
      criado_em: string;
      enviado_em: string | null;
    }>
  ).map((e) => ({ ...e, telefone: mascararTelefone(e.telefone) }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Configurações</h1>
        <p className="text-sm text-muted-foreground">O WhatsApp que fala pela agência e quando os avisos saem.</p>
      </div>
      <ConfiguracoesCliente
        canais={listaDeCanais}
        inicial={{
          canalId: c?.canal_session_id ?? null,
          janelaInicio: (c?.janela_inicio ?? "07:00").slice(0, 5),
          janelaFim: (c?.janela_fim ?? "22:00").slice(0, 5),
          antecedencia: c?.avisos_antecedencia ?? [2, 1],
        }}
        envios={ultimos}
      />
      <LembretesDeReuniao inicial={c?.reunioes_lembretes ?? [1440, 60]} />
      <SecaoDoDrive estado={estadoDrive} enderecoDeRetorno={retornoDoDrive()} resultado={resultadoDoDrive ?? null} />
    </div>
  );
}
