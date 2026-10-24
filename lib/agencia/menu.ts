import type { EntradaDaCasca } from "@/components/agencia/CascaDaAgencia";

import type { PermissaoDaAgencia } from "./permissoes";

/**
 * As entradas do menu da área da agência e a permissão que cada uma exige.
 * Uma lista só: o menu lateral, a barra do celular e o teste leem daqui.
 * Entrada sem `exige` é de todo membro ativo. A ordem é a da barra do celular,
 * que mostra as quatro primeiras.
 */
export const MENU_DA_AGENCIA: ReadonlyArray<EntradaDaCasca & { exige?: PermissaoDaAgencia }> = [
  { href: "/agencia", rotulo: "Início", icone: "inicio" },
  { href: "/agencia/tarefas", rotulo: "Tarefas", icone: "tarefas" },
  { href: "/agencia/calendario", rotulo: "Calendário", icone: "calendario" },
  { href: "/agencia/clientes", rotulo: "Clientes", icone: "clientes" },
  { href: "/agencia/equipe", rotulo: "Equipe", icone: "equipe", exige: "equipe.gerenciar" },
  { href: "/agencia/configuracoes", rotulo: "Configurações", icone: "configuracoes", exige: "configuracoes.gerenciar" },
  { href: "/agencia/perfil", rotulo: "Perfil", icone: "perfil" },
];

export function entradasPermitidas(permissoes: ReadonlySet<PermissaoDaAgencia>): EntradaDaCasca[] {
  return MENU_DA_AGENCIA.filter((e) => !e.exige || permissoes.has(e.exige)).map(({ href, rotulo, icone }) => ({
    href,
    rotulo,
    icone,
  }));
}
