/**
 * Configurações → Aparência. O template visual da organização e os ajustes por
 * cima dele — só estética: nenhuma regra, rota, dado ou permissão muda.
 *
 * ── Ao lado da Marca, e não dentro dela ─────────────────────────────────────
 *
 * A Marca é a IDENTIDADE da empresa (nome, cor principal, logo) e tem escritor
 * próprio. A Aparência é o design do sistema em volta dela. Separadas, trocar
 * de template nunca apaga a identidade: a cor da Marca continua vencendo a cor
 * de ação do template (`cssDaAparenciaDaOrganizacao`).
 *
 * ── Papel mínimo `admin` ────────────────────────────────────────────────────
 *
 * O mesmo da Marca, pelo mesmo motivo: o visual vale para todos da empresa. O
 * gate daqui protege a rota; quem defende o dado é
 * `fn_definir_aparencia_da_organizacao`, que re-resolve o papel no banco.
 *
 * ── O CSS de prévia ─────────────────────────────────────────────────────────
 *
 * Esta tela emite o CSS dos DEZ templates — escopado pelo id, então só pinta
 * quando o marcador de `/app` carrega aquele id (é o que o botão Visualizar
 * troca, no navegador de quem está olhando) — e o das miniaturas da galeria.
 * Fora desta tela, o layout de `/app` emite só o template escolhido.
 */
import { redirect } from "next/navigation";

import { CabecalhoDaSubTela } from "@/components/settings/CabecalhoDaSubTela";
import { aparenciaDeSettings } from "@/lib/aparencia/ajustes";
import { TEMPLATES } from "@/lib/aparencia/catalogo";
import { cssDoTemplate, escopoDaAmostra, escopoDoTemplate } from "@/lib/aparencia/css";
import { requireAuth, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { marcaDaInstalacao } from "@/lib/branding/instalacao";
import { resolverMarcaDaOrganizacao } from "@/lib/branding/organizacao";
import { env } from "@/lib/env";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

import { GaleriaDeAparencia } from "./_galeria";

export const metadata = { title: "Aparência" };
export const dynamic = "force-dynamic";

export default async function AparenciaDaOrganizacaoPage() {
  const user = await requireAuth();
  const activeOrg = await resolveActiveOrg(user);
  if (!activeOrg) redirect("/app");
  if (!(user.is_platform_admin && !user.support) && ROLE_RANK[activeOrg.role] < ROLE_RANK.admin) {
    redirect("/403");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", activeOrg.orgId)
    .maybeSingle();

  const settings = data?.settings ?? null;
  const gravada = aparenciaDeSettings(settings);
  const marca = resolverMarcaDaOrganizacao(settings, await marcaDaInstalacao(), env);
  const temCorPropria = marca.origens.cor === "organizacao";
  const idioma = user.idioma;

  // A cor da Marca vence a do template: com cor própria, nem a prévia nem a
  // miniatura declaram a cor de ação, e herdam a da empresa do `<body>`.
  const cssDasPrevias = TEMPLATES.flatMap((t) => [
    cssDoTemplate(t, { escopo: escopoDoTemplate(t.id), incluirAcento: !temCorPropria }),
    cssDoTemplate(t, { escopo: escopoDaAmostra(t.id), incluirAcento: !temCorPropria }),
  ])
    .filter((css): css is string => Boolean(css))
    .join("\n");

  return (
    <div className="flex h-full flex-col gap-6 overflow-y-auto p-6">
      {cssDasPrevias ? (
        <style id="aparencia-previas" dangerouslySetInnerHTML={{ __html: cssDasPrevias }} />
      ) : null}
      <CabecalhoDaSubTela titulo={traduzir("Aparência", idioma)} idioma={idioma}>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {traduzir(
            "Escolha o visual do sistema para toda a sua equipe. O template muda só a aparência: nenhuma tela, regra ou dado muda.",
            idioma,
          )}
        </p>
      </CabecalhoDaSubTela>

      <GaleriaDeAparencia
        gravada={gravada}
        corDaMarca={temCorPropria ? (marca.cor?.semente ?? null) : null}
      />
    </div>
  );
}
