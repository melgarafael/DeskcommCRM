import Link from "next/link";

import { Card } from "@/components/ui/card";
import type { Role } from "@/lib/auth/types";
import { traduzir } from "@/lib/i18n/dicionario";
import { IDIOMA_PADRAO, type Idioma } from "@/lib/i18n/idiomas";
import { hubSections, type NavGroupId } from "@/lib/navigation/registry";

interface NavHubProps {
  group: NavGroupId;
  isPlatformAdmin: boolean;
  role: Role | null;
  title: string;
  subtitle: string;
  /**
   * Idioma da interface. `traduzir` é pura — roda em Server Component sem
   * provider. O default mantém os demais hubs (ex.: /app/ai) como estão até
   * que a página deles passe o locale; o que não tem entrada no dicionário
   * degrada para pt-BR, que é o comportamento de antes.
   */
  locale?: Idioma;
}

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

export function NavHub({ group, isPlatformAdmin, role, title, subtitle, locale = IDIOMA_PADRAO }: NavHubProps) {
  const secoes = hubSections(group, isPlatformAdmin, role);

  return (
    <div className="flex h-full flex-col gap-8 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{traduzir(title, locale)}</h1>
        {subtitle && <p className="text-sm text-muted-foreground">{traduzir(subtitle, locale)}</p>}
      </header>

      {secoes.map(({ section, items }) => (
        <section key={section} aria-labelledby={`hub-${group}-${slug(section)}`} className="space-y-3">
          <h2
            id={`hub-${group}-${slug(section)}`}
            className="text-xs font-medium uppercase tracking-wider text-muted-foreground"
          >
            {traduzir(section, locale)}
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <Link key={item.href} href={item.href} className="block">
                  <Card className="flex h-full gap-3 p-4 transition-colors hover:border-border-strong">
                    <Icon size={20} weight="regular" aria-hidden className="mt-0.5 shrink-0 text-muted-foreground" />
                    <div>
                      <h3 className="text-sm font-semibold">{traduzir(item.label, locale)}</h3>
                      <p className="mt-1 text-xs text-muted-foreground">{traduzir(item.description, locale)}</p>
                    </div>
                  </Card>
                </Link>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
