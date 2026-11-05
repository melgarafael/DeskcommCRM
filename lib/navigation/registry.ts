import type { Icon as PhosphorIcon } from "@phosphor-icons/react";

import { type Role } from "@/lib/auth/types";
import {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  DeviceMobile,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  PaperPlaneTilt,
  Phone,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  Tag,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
} from "@/lib/ui/icons";

import {
  NAV_CATALOG,
  NAV_GROUPS,
  type NavMetadata,
  type NavGroup,
  type NavGroupId,
  sobeAoMenuLateral,
} from "./catalogo";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import type { CapacidadeDaOrganizacao } from "@/lib/organizacao/capacidades";
import type { ModuloNaTela } from "@/lib/extensions/modulos-na-tela";

import { destinosDaInterface, type InterfaceSettings } from "./interface";
export { NAV_GROUPS, GRUPO_NO_RODAPE } from "./catalogo";
export type { NavGroup, NavGroupId } from "./catalogo";
const ICONS = {
  Bell,
  BookOpen,
  Brain,
  Buildings,
  CalendarBlank,
  ChartBar,
  ChartLineUp,
  ClipboardText,
  ClockCountdown,
  ClockCounterClockwise,
  DeviceMobile,
  FileText,
  Flag,
  FlowArrow,
  Funnel,
  Gauge,
  Inbox,
  Kanban,
  Key,
  Lightbulb,
  ListChecks,
  Lock,
  Megaphone,
  Palette,
  PaperPlaneTilt,
  Phone,
  Plugs,
  PlugsConnected,
  PuzzlePiece,
  Receipt,
  Robot,
  ScalesSimple,
  ShieldCheck,
  Signpost,
  Storefront,
  Tag,
  UserCircle,
  Users,
  UsersThree,
  WebhooksLogo,
};
export interface NavDestination extends Omit<NavMetadata, "icon"> {
  icon: PhosphorIcon;
}
export const NAV_DESTINATIONS: NavDestination[] = NAV_CATALOG.map((d) => ({
  ...d,
  icon: ICONS[d.icon],
}));
/**
 * Único ponto de decisão de permissão da navegação.
 *
 * É o que dispensa os sete `usePermission()` que o Sidebar chamava em sequência
 * — hooks não rodam em laço condicional, então cada permissão exigia sua linha.
 * Como função pura, um `.filter()` resolve todas.
 */
export { canSee } from "./interface";

/**
 * O que o menu precisa saber de um módulo conectado: só o endereço da tela e o rótulo. O endereço
 * do serviço e o id da instalação ficam fora de propósito (não precisam descer ao menu).
 */
export type ModuloConectadoNoMenu = Pick<ModuloNaTela, "slug" | "titulo">;

/** Grupo GERADO (não está em `NAV_GROUPS`): existe só enquanto há módulo conectado ativo. */
export const GRUPO_DOS_MODULOS: NavGroup = { id: "modulos", label: "Módulos" };

const SLUG_DE_MODULO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Um destino `/app/m/<slug>` por módulo conectado. Slug fora de `[a-z0-9-]` é descartado (nunca
 * vira link), repetido vale uma vez. Visível a qualquer membro: quem decide se o módulo existe
 * para a organização é `modulosNaTela`, e a rota recusa o que não for dela (404). Lista vazia ou
 * ausente devolve `[]`, e é isso que mantém a saída das projeções idêntica à de antes.
 */
export function destinosDosModulosConectados(
  modulosConectados?: readonly ModuloConectadoNoMenu[],
): NavDestination[] {
  const vistos = new Set<string>();
  const destinos: NavDestination[] = [];
  for (const m of modulosConectados ?? []) {
    if (typeof m?.slug !== "string" || !SLUG_DE_MODULO.test(m.slug) || vistos.has(m.slug)) continue;
    vistos.add(m.slug);
    const titulo = typeof m.titulo === "string" ? m.titulo.trim() : "";
    destinos.push({
      href: `/app/m/${m.slug}`,
      label: titulo !== "" ? titulo : m.slug,
      description: "Módulo conectado",
      icon: ICONS.PuzzlePiece,
      group: GRUPO_DOS_MODULOS.id,
      sidebar: true,
    });
  }
  return destinos;
}

/** Projeção do sidebar: só o uso diário, agrupado, sem grupo vazio. */
export function sidebarGroups(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  modulos?: readonly ModuloOpcional[],
  capacidades?: readonly CapacidadeDaOrganizacao[],
  modulosConectados?: readonly ModuloConectadoNoMenu[],
): Array<{ group: NavGroup; items: NavDestination[] }> {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role, modulos, capacidades).map((d) => d.href),
  );
  const grupos = NAV_GROUPS.map((group) => ({
    group,
    items: NAV_DESTINATIONS.filter(
      (d) =>
        d.group === group.id &&
        sobeAoMenuLateral(d, !!settings?.destinos) &&
        visible.has(d.href),
    ),
  })).filter(
    (g) =>
      g.items.length > 0 ||
      (g.group.hub && NAV_DESTINATIONS.some((d) => d.group === g.group.id && visible.has(d.href))),
  );
  // Grupo gerado, no fim: sem módulo conectado nada é acrescentado e a saída é a de sempre.
  const itensDosModulos = destinosDosModulosConectados(modulosConectados);
  if (itensDosModulos.length > 0) grupos.push({ group: GRUPO_DOS_MODULOS, items: itensDosModulos });
  return grupos;
}

/**
 * Projeção do hub: TODAS as telas do grupo — inclusive as que já estão no
 * sidebar. O hub é inventário, não sobra; é onde se descobre o que existe.
 *
 * A ordem das seções é a de primeira aparição no registro, então reordenar a
 * jornada é reordenar o array — não há uma segunda lista para manter em sincronia.
 */
export function hubSections(
  group: NavGroupId,
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  modulos?: readonly ModuloOpcional[],
  capacidades?: readonly CapacidadeDaOrganizacao[],
): Array<{ section: string; items: NavDestination[] }> {
  const porSecao = new Map<string, NavDestination[]>();
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role, modulos, capacidades).map((d) => d.href),
  );
  for (const d of NAV_DESTINATIONS) {
    if (d.group !== group || !visible.has(d.href)) continue;
    const secao = d.section ?? "";
    const atual = porSecao.get(secao);
    if (atual) atual.push(d);
    else porSecao.set(secao, [d]);
  }
  return [...porSecao.entries()].map(([section, items]) => ({ section, items }));
}

/** Projeção do ⌘K: todo destino visível, do sidebar ou não. */
export function searchable(
  isPlatformAdmin: boolean,
  role: Role | null,
  settings?: InterfaceSettings,
  modulos?: readonly ModuloOpcional[],
  capacidades?: readonly CapacidadeDaOrganizacao[],
  modulosConectados?: readonly ModuloConectadoNoMenu[],
): NavDestination[] {
  const visible = new Set<string>(
    destinosDaInterface(settings, isPlatformAdmin, role, modulos, capacidades).map((d) => d.href),
  );
  const base = NAV_DESTINATIONS.filter((d) => visible.has(d.href));
  const itensDosModulos = destinosDosModulosConectados(modulosConectados);
  return itensDosModulos.length > 0 ? [...base, ...itensDosModulos] : base;
}
