/** Apresentação por vínculo. Nunca é autorização de página, API ou ação. */
import { z } from "zod";
import { ROLE_RANK, type Role } from "@/lib/auth/types";
import type { ModuloOpcional } from "@/lib/instalacao/modulos";
import { NAV_CATALOG, type NavMetadata, type NavDestinationId } from "./catalogo";

const ids = NAV_CATALOG.map((d) => d.href);
export const interfaceSettingsSchema = z
  .object({
    preset: z.enum(["completa", "simplificada"]),
    destinos: z
      .array(z.enum(ids as [NavDestinationId, ...NavDestinationId[]]))
      .min(1)
      .max(ids.length)
      .transform((values) => ids.filter((id) => values.includes(id)))
      .optional(),
  })
  .strict();
export type InterfaceSettings = z.infer<typeof interfaceSettingsSchema>;
export const INTERFACE_COMPLETA: InterfaceSettings = { preset: "completa" };
const SIMPLIFICADA: readonly NavDestinationId[] = [
  "/app/inbox",
  "/app/agenda",
  "/app/kanban",
  "/app/contacts",
  "/app/tasks",
  "/app/connections",
];
/** Portas pessoais e recuperação administrativa não são removíveis. Atualização
 * e administração de plataforma têm consumidores próprios com seus gates atuais.
 *
 * `/app/settings/tenant` está aqui porque é a tela que HOSPEDA esta escolha. Sem
 * ela na lista, uma organização que a ocultasse se trancava do lado de fora: a
 * porta que desfaz a decisão desaparece junto com as outras, e não há caminho de
 * volta pela tela — só por banco. Quem administra tem de poder desfazer o que
 * escolheu, sempre.
 */
export const PORTAS_ESSENCIAIS = [
  "/app/settings/profile",
  "/app/settings/security",
  "/app/team",
  "/app/settings/tenant",
] as const;

/**
 * As essenciais que só valem para quem administra — as outras são pessoais e
 * valem para todo vínculo. `canSee` continua decidindo depois, pelo `minRole`:
 * estar aqui impede a organização de ESCONDER, nunca concede acesso a quem o
 * papel não dá.
 */
const ESSENCIAIS_DE_ADMIN: readonly string[] = ["/app/team", "/app/settings/tenant"];

export function essencial(d: NavMetadata, role: Role | null, platform = false): boolean {
  // Por PERTENCIMENTO à lista, nunca por índice: a versão anterior enumerava
  // `[0]`, `[1]` e `[2]`, então acrescentar uma quarta porta não teria efeito
  // nenhum e a lista passaria a mentir sobre o que ela garante.
  if (!(PORTAS_ESSENCIAIS as readonly string[]).includes(d.href)) return false;
  return ESSENCIAIS_DE_ADMIN.includes(d.href) ? platform || role === "admin" : true;
}
export function canSee(
  d: Pick<NavMetadata, "href" | "minRole">,
  platform: boolean,
  role: Role | null,
): boolean {
  return platform || (!!role && ROLE_RANK[role] >= ROLE_RANK[d.minRole ?? "viewer"]);
}
/**
 * `modulos` são os módulos opcionais LIGADOS na instalação. Ausente = não filtra
 * por módulo: quem desenha menu (sidebar, hub, ⌘K) passa a lista; quem só
 * pergunta "sobra alguma porta?" não precisa.
 */
export function permitidos(
  platform: boolean,
  role: Role | null,
  modulos?: readonly ModuloOpcional[],
): NavMetadata[] {
  return (NAV_CATALOG as readonly NavMetadata[]).filter(
    (d) => canSee(d, platform, role) && (!modulos || !d.modulo || modulos.includes(d.modulo)),
  );
}
/** Leitura tolera versões antigas/removidas sem lançar no layout. */
export function lerInterface(raw: unknown): {
  settings: InterfaceSettings;
  needsAdjustment: boolean;
} {
  if (raw == null) return { settings: INTERFACE_COMPLETA, needsAdjustment: false };
  if (typeof raw !== "object") return { settings: INTERFACE_COMPLETA, needsAdjustment: true };
  const value = raw as Record<string, unknown>;
  const destinos = Array.isArray(value.destinos)
    ? ids.filter((id) => (value.destinos as unknown[]).includes(id))
    : undefined;
  const parsed = interfaceSettingsSchema.safeParse({
    preset: value.preset,
    ...(destinos ? { destinos } : {}),
  });
  if (!parsed.success) return { settings: INTERFACE_COMPLETA, needsAdjustment: true };
  return {
    settings: parsed.data,
    needsAdjustment: !!destinos && destinos.length !== (value.destinos as unknown[]).length,
  };
}
export function destinosDaInterface(
  raw: unknown,
  platform: boolean,
  role: Role | null,
  modulos?: readonly ModuloOpcional[],
): NavMetadata[] {
  const { settings } = lerInterface(raw);
  const allowed = permitidos(platform, role, modulos);
  const chosen =
    settings.destinos ?? (settings.preset === "simplificada" ? SIMPLIFICADA : undefined);
  return allowed.filter(
    (d) => essencial(d, role, platform) || !chosen || chosen.includes(d.href as NavDestinationId),
  );
}
export function interfaceTemDestino(
  settings: InterfaceSettings,
  role: Role,
  platform = false,
): boolean {
  return destinosDaInterface(settings, platform, role).some((d) => !essencial(d, role, platform));
}
export function homeDaInterface(raw: unknown, platform: boolean, role: Role | null): string {
  const visible = destinosDaInterface(raw, platform, role);
  return (
    visible.find((d) => d.href === "/app/inbox")?.href ??
    visible.find((d) => !essencial(d, role, platform))?.href ??
    "/app/settings/profile"
  );
}

/**
 * O conjunto de portas que uma escolha REALMENTE significa.
 *
 * `destinos` e `preset: simplificada` são duas formas de dizer a mesma coisa —
 * uma lista explícita e um punhado fixo. Tratar as duas como conjuntos é o que
 * permite combinar escolhas sem uma tabela de casos.
 */
function conjuntoEscolhido(s: InterfaceSettings): readonly NavDestinationId[] | undefined {
  return s.destinos ?? (s.preset === "simplificada" ? SIMPLIFICADA : undefined);
}

/** Portas essenciais que o catálogo conhece — o que sobra quando não há interseção. */
const SO_O_ESSENCIAL: readonly NavDestinationId[] = ids.filter((id) =>
  (PORTAS_ESSENCIAIS as readonly string[]).includes(id),
);

/**
 * As portas da EMPRESA ∩ as portas do VÍNCULO (migration 0367).
 *
 * A empresa escolhe o universo de portas da instalação; o vínculo escolhe menos
 * dentro dele — nunca mais. A ordem importa: quem administra a organização não
 * pode abrir para alguém uma porta que esse alguém já tinha dispensado, e quem
 * escolhe a própria interface não pode furar a escolha da empresa. Por isso a
 * combinação é INTERSEÇÃO nos dois eixos, e `simplificada` — que também é um
 * limite, não um enfeite — sobrevive vindo de qualquer um dos lados.
 *
 * Isto é APRESENTAÇÃO, como as duas entradas: o resultado alimenta sidebar, hub,
 * ⌘K e as telas. Autorização continua sendo `canSee` sobre o papel, aplicada
 * depois, sobre o conjunto já estreitado. Nenhuma escolha da empresa nega
 * página, API ou ação.
 *
 * E não abre por acidente: sem escolha de nenhum dos lados o resultado é a
 * interface completa e o papel decide. Com escolha de pelo menos um lado, o
 * resultado é sempre subconjunto — inclusive no caso sem interseção, onde
 * sobram só as portas essenciais. Devolver `destinos: []` seria recusado pelo
 * schema, e `lerInterface` converte valor recusado em interface COMPLETA: uma
 * falha ABERTA, exatamente o oposto do pretendido aqui.
 */
export function combinarInterfaces(daEmpresa: unknown, doVinculo: unknown): InterfaceSettings {
  const empresa = conjuntoEscolhido(lerInterface(daEmpresa).settings);
  const vinculo = conjuntoEscolhido(lerInterface(doVinculo).settings);
  if (!empresa && !vinculo) return INTERFACE_COMPLETA;
  const soUm = empresa ?? vinculo;
  if (!empresa || !vinculo) return { preset: "completa", destinos: [...(soUm as readonly NavDestinationId[])] };
  const comuns = empresa.filter((id) => vinculo.includes(id));
  return { preset: "completa", destinos: [...(comuns.length > 0 ? comuns : SO_O_ESSENCIAL)] };
}
