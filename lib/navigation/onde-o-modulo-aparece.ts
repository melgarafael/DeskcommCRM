/**
 * ONDE UM MÓDULO OPCIONAL APARECE depois de ligado.
 *
 * ─── O defeito que isto fecha ───────────────────────────────────────────────
 *
 * Quem administra a instalação liga um módulo em Recursos opcionais
 * (`/admin/sistema`) e a tela não diz o que mudou. O operador vai ao CRM, não
 * acha nada e conclui que o interruptor não funcionou — às vezes com razão
 * (dois módulos não criam porta nenhuma), às vezes sem (a porta existe e está
 * dentro de Configurações, onde ele não procurou).
 *
 * A informação já existia no produto, com UM consumidor só: a tela da EMPRESA
 * (`/app/settings/recursos`) mostra a porta via `portaDoModuloNaEmpresa()`. A
 * tela de quem LIGA não a tinha.
 *
 * ─── Por que aqui, e lido do menu ───────────────────────────────────────────
 *
 * Módulo puro, sem dependência de servidor: a tela do interruptor é um
 * componente de cliente, e qualquer coisa que arraste `logger`/Supabase para
 * dentro dela não compilaria. `ModuloOpcional` entra como importação de TIPO,
 * que é apagada na transpilação.
 *
 * As portas saem de `NAV_CATALOG` e o nome do grupo de `NAV_GROUPS` — nunca de
 * uma segunda lista escrita à mão, que divergiria na primeira tela que mudasse
 * de grupo. Vigiado em `tests/unit/porta-do-modulo-ligado.test.tsx`.
 */
import type { ModuloOpcional } from "@/lib/instalacao/modulos";

import {
  GRUPO_NO_RODAPE,
  NAV_CATALOG,
  NAV_GROUPS,
  sobeAoMenuLateral,
  type NavMetadata,
} from "./catalogo";

export interface PortaDoModulo {
  href: string;
  /** Rótulo da porta, como o menu a escreve. */
  label: string;
  /** Primeiro passo: o GRUPO do menu ("CRM", "Agente de IA", "Configurações"…). */
  grupo: string;
  /**
   * Passo DO MEIO, quando a porta não sobe ao menu lateral e só se alcança pelo hub do grupo
   * ("Ver tudo em CRM"). Ausente = o grupo leva direto à porta.
   *
   * Os campos são separados, e não um array de passos, por causa da catraca do espanhol: ela
   * resolve `t(porta.campo)` sobre o parâmetro de iteração e NÃO resolve `t(passo)` sobre elemento
   * de array (viraria "parâmetro livre"). Então a forma do dado é escolhida para que cada passo
   * possa ser traduzido no sítio da chamada.
   */
  hub?: string;
}

/**
 * O nome do grupo COMO O OPERADOR O LÊ no menu — e isso não é sempre
 * `group.label`.
 *
 * `GRUPO_NO_RODAPE` (`organizacao`) é a exceção medida: o `Sidebar` o desenha no
 * rodapé fixo mostrando só o `hub` dele, então na tela está escrito
 * "Configurações" e o rótulo "Organização" não aparece em lugar nenhum. Mandar
 * procurar em "Organização" seria o mesmo defeito que este arquivo conserta, um
 * nível acima: instrução tirada do modelo de dados em vez do que está na tela —
 * e uma instrução errada com ar de certeza gasta mais tempo que o silêncio.
 */
const GRUPO: ReadonlyMap<string, string> = new Map(
  NAV_GROUPS.map((g) => [g.id, (g.id === GRUPO_NO_RODAPE && g.hub?.label) || g.label]),
);

/**
 * Todas as portas do menu que este módulo acende, na ordem do menu. Vazio = o
 * módulo não cria porta — e vazio é a resposta honesta, não um palpite: mandar
 * o operador procurar no lugar errado é pior que dizer que não há lugar.
 */
/**
 * O caminho até QUALQUER porta do catálogo, derivado — nunca escrito à mão.
 *
 * Existe porque eu escrevi um à mão e errei: o texto de `login_codex` dizia
 * "Agente de IA › Credenciais", e `/app/ai/credentials` também é só-no-hub, então o caminho real
 * tem o passo "Ver tudo em IA". Era o mesmo defeito que esta feature conserta, reproduzido na
 * prosa, e nenhuma guarda lia aquele campo. Hoje `foraDoMenu` é proibido de conter `›`
 * (`tests/unit/porta-do-modulo-ligado.test.tsx`) e quem precisa de caminho chama isto.
 *
 * `null` quando o `href` não está no catálogo — por exemplo uma tela de `/admin`, que tem
 * navegação própria (`components/admin/AdminSidebar.tsx`) e não passa por aqui.
 */
export function caminhoDaPorta(href: string): PortaDoModulo | null {
  const d = (NAV_CATALOG as readonly NavMetadata[]).find((x) => x.href === href);
  return d ? caminhoDe(d) : null;
}

function caminhoDe(d: NavMetadata): PortaDoModulo {
  {
      const grupo = NAV_GROUPS.find((g) => g.id === d.group);
      /**
       * ⚠️ O PASSO DO HUB. `sidebar` ausente significa "só no hub"
       * (`NavMetadata.sidebar`), e o filtro do menu lateral é
       * `d.sidebar || (!group.hub && settings?.destinos)` — então porta de módulo não aparece no
       * menu diário, só dentro de "Ver tudo em CRM". Era exatamente essa a causa do relato
       * "liguei e não aparece no CRM", e o texto anterior ("CRM › Empresas") mandava procurar no
       * menu lateral, onde ela não está.
       *
       * O grupo do RODAPÉ é a exceção: o `Sidebar` o desenha mostrando só o hub dele, então
       * "Configurações" já é o primeiro passo e não há um segundo — anunciar
       * "Configurações › Configurações › Dados externos" inventaria um clique.
       */
      const noRodape = d.group === GRUPO_NO_RODAPE;
      // LÊ a regra do menu lateral (`sobeAoMenuLateral`), em vez de copiar a condição dela — era
      // cópia antes, e cópia de regra diverge sem avisar. `false` em `temEscolhaExplicita` porque
      // esta função não conhece a empresa: para porta de módulo a resposta não muda, e um caso de
      // teste garante que todo grupo com porta de módulo TEM hub (que é o que torna isso válido).
      const precisaDoHub = !sobeAoMenuLateral(d, false) && !!grupo?.hub && !noRodape;
      return {
        href: d.href,
        label: d.label,
        grupo: GRUPO.get(d.group) ?? d.group,
        ...(precisaDoHub ? { hub: grupo!.hub!.label } : {}),
      };
  }
}

export function ondeOModuloAparece(modulo: ModuloOpcional): PortaDoModulo[] {
  return (NAV_CATALOG as readonly NavMetadata[]).filter((d) => d.modulo === modulo).map(caminhoDe);
}
