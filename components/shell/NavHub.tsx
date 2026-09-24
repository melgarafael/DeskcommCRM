import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import type { InterfaceSettings } from "@/lib/navigation/interface";
import Link from "next/link";

import { Card } from "@/components/ui/card";
import type { Role } from "@/lib/auth/types";
import { permissaoDaCapacidade } from "@/lib/extensions/capacidades";
import { portasLegiveis } from "@/lib/extensions/portas-legiveis";
import { localize, type ExtensionManifest } from "@/lib/extensions/manifest";
import type { ExtensionGuideView } from "@/lib/extensions/view";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { hubSections, type NavGroupId } from "@/lib/navigation/registry";
import { BookOpen, Lightbulb, ListChecks, Warning } from "@/lib/ui/icons";

interface NavHubProps {
  interfaceSettings?: InterfaceSettings;
  /** Módulos opcionais ligados na instalação. Ausente = o hub não filtra por módulo. */
  modulosLigados?: readonly ModuloOpcional[];
  group: NavGroupId;
  isPlatformAdmin: boolean;
  role: Role | null;
  title: string;
  subtitle: string;
  extensionGuides?: ExtensionGuideView[];
  extensionsUnavailable?: boolean;
  /**
   * Idioma da interface. `traduzir` é pura — roda em Server Component sem
   * provider. O default mantém os demais hubs (ex.: /app/ai) como estão até
   * que a página deles passe o locale; o que não tem entrada no dicionário
   * degrada para pt-BR, que é o comportamento de antes.
   */
  locale?: Idioma;
}

const EXTENSION_ICONS: Record<ExtensionManifest["display"]["icon"], typeof ListChecks> = {
  ListChecks,
  BookOpen,
  Lightbulb,
};

/**
 * Vitrine de um grupo do registro de navegação.
 *
 * O sidebar carrega o uso diário; o hub carrega o inventário — todas as telas
 * do grupo, cada uma com a frase que explica para que serve. Era isso que
 * faltava: telas como Conhecimento e Credenciais existiam só como aba dentro de
 * `/app/ai`, invisíveis para quem ainda não estava lá.
 *
 * As seções vêm do campo `section` do registro e são a JORNADA de quem usa o
 * grupo (montar → ensinar → acompanhar), não uma taxonomia técnica. Reordenar a
 * jornada é reordenar o array do registro.
 */
/**
 * `aria-labelledby` separa múltiplos ids por ESPAÇO — então um id com espaço
 * ("hub-ia-Ensinar o agente") vira três referências quebradas e a seção fica sem
 * rótulo acessível. O slug é o que mantém a região anunciável.
 */
function slug(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function NavHub({
  group,
  isPlatformAdmin,
  role,
  title,
  subtitle,
  interfaceSettings,
  modulosLigados,
  locale = IDIOMA_PADRAO,
  extensionGuides = [],
  extensionsUnavailable = false,
}: NavHubProps) {
  const secoes = hubSections(group, isPlatformAdmin, role, interfaceSettings, modulosLigados);

  return (
    <div className="flex h-full flex-col gap-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir(title, locale)}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{traduzir(subtitle, locale)}</p>}
      </header>

      {secoes.map(({ section, items }) => (
        <section
          key={section}
          aria-labelledby={`hub-${group}-${slug(section)}`}
          className="space-y-3"
        >
          <h2
            id={`hub-${group}-${slug(section)}`}
            className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
          >
            {traduzir(section, locale)}
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className="block">
                  <Card className="flex h-full gap-3 p-4 transition-colors hover:border-border-strong">
                    <Icon
                      size={20}
                      weight="regular"
                      aria-hidden
                      className="mt-0.5 shrink-0 text-muted-foreground"
                    />
                    <div>
                      <h3 className="text-sm font-semibold">{traduzir(item.label, locale)}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {traduzir(item.description, locale)}
                      </p>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ))}

      {group === "crm" && (extensionGuides.length > 0 || extensionsUnavailable) ? (
        <section aria-labelledby="hub-crm-orientacoes-instaladas" className="space-y-3">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <h2
                id="hub-crm-orientacoes-instaladas"
                className="text-xs font-medium tracking-wider text-muted-foreground uppercase"
              >
                {traduzir("Orientações instaladas", locale)}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {traduzir(
                  "Guias adicionados depois da instalação, sem acesso aos dados do CRM.",
                  locale,
                )}
              </p>
            </div>
            <Link
              href="/app/extensions"
              className="text-xs font-medium text-accent underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:outline-hidden"
            >
              {traduzir("Gerenciar extensões", locale)}
            </Link>
          </div>

          {extensionsUnavailable ? (
            <Card className="flex gap-3 border-warning/40 bg-warning-bg p-4">
              <Warning
                size={20}
                weight="duotone"
                aria-hidden
                className="mt-0.5 shrink-0 text-warning-fg"
              />
              <div>
                <h3 className="text-sm font-semibold">
                  {traduzir("Não foi possível conferir as orientações instaladas", locale)}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {traduzir(
                    "Abra Extensões para tentar novamente e ver o estado registrado no servidor.",
                    locale,
                  )}
                </p>
              </div>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
              {extensionGuides.flatMap((guide) =>
                guide.manifest.contributions.crm_cards.map((contribution) => {
                  const Icon = EXTENSION_ICONS[contribution.icon];
                  const compact = guide.configuration.density === "compact";
                  return (
                    <Link
                      key={`${guide.installation_id}:${contribution.id}`}
                      href={`/app/extensions/${encodeURIComponent(guide.installation_id)}?card=${encodeURIComponent(contribution.id)}`}
                      data-testid={`extension-contribution-${guide.installation_id}-${contribution.id}`}
                      className="block rounded-lg focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 focus-visible:outline-hidden"
                    >
                      <Card
                        className={`flex h-full gap-3 transition-colors hover:border-border-strong ${compact ? "p-3" : "p-4"}`}
                      >
                        <Icon
                          size={20}
                          weight="duotone"
                          aria-hidden
                          className="mt-0.5 shrink-0 text-accent"
                        />
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                            {localize(guide.manifest.display.title, locale).text}
                          </p>
                          <h3 className="mt-0.5 text-sm font-semibold">
                            {localize(contribution.title, locale).text}
                          </h3>
                          {guide.configuration.show_description ? (
                            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                              {localize(contribution.description, locale).text}
                            </p>
                          ) : null}
                          {localize(contribution.title, locale).fallback ||
                          (guide.configuration.show_description &&
                            localize(contribution.description, locale).fallback) ? (
                            <p className="mt-1 text-[11px] text-warning-fg">
                              {traduzir("Texto disponível em português.", locale)}
                            </p>
                          ) : null}
                          <p className="mt-2 text-[11px] text-text-subtle">
                            {portasLegiveis(
                              [permissaoDaCapacidade(contribution.action.capability)],
                              (texto) => traduzir(texto, locale),
                            )}
                          </p>
                        </div>
                      </Card>
                    </Link>
                  );
                }),
              )}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
