/**
 * O AVISO das duas metades da #2335 — leitura (o `InterfaceRefresh` viu a
 * sessão mudar em outra aba) e escrita (o servidor recusou a mutação com
 * `org_divergente`). As duas portas chamam ESTA função, então a pessoa vê a
 * mesma janela, com o mesmo texto e o mesmo botão, venha o aviso de onde
 * vier.
 *
 * Por que não recarregar sozinho: trocar o documento sem o usuário pedir apaga
 * formulário em edição e a URL aberta (#2313). O aviso PERMANECE (o polling de
 * 30 s o reexibe com o mesmo `id`, sem empilhar) até a decisão — e a recarga
 * acontece só no clique.
 */
import { toast } from "sonner";

import { ID_DO_AVISO_ORG_DIVERGENTE } from "@/lib/auth/org-da-aba";
import { recarregarAba } from "@/lib/auth/recarregar-aba";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export interface AvisoOrgDivergente {
  /** Nome (ou id, quando o servidor não devolveu nome) da organização DA ABA. */
  daAba?: string | null;
  /** Nome da organização que a SESSÃO (cookie) resolve agora. */
  daSessao?: string | null;
  /** O `t()` da tela, quando quem chama é um componente com provider de idioma. */
  traduzir?: (texto: string) => string;
  /** Sem `t()` na mão (apiClient), o idioma vem do registro da própria aba. */
  idioma?: Idioma | null;
}

export function mostrarAvisoOrgDivergente(info: AvisoOrgDivergente = {}): void {
  const idioma = info.idioma ?? "pt-BR";
  // Literal em cada ramo, sem `traduzir(frase)` com parâmetro livre: o guarda
  // `i18n-espanhol-cobre-a-tela` reprova traduzir dado do operador — e um
  // texto que muda quando traduzido não é o mesmo aviso nas duas portas.
  const aviso = info.traduzir
    ? info.traduzir("Esta aba está numa organização diferente da sessão. Recarregar?")
    : traduzir("Esta aba está numa organização diferente da sessão. Recarregar?", idioma);
  const rotulo = info.traduzir
    ? info.traduzir("Recarregar")
    : traduzir("Recarregar", idioma);
  // `t()` não interpola (a chave é a frase inteira), então os dois nomes entram
  // como DADO depois da frase traduzida — "A → B" é leitura, não prosa.
  const nomes = info.daAba && info.daSessao ? ` (${info.daAba} → ${info.daSessao})` : "";
  toast.warning(`${aviso}${nomes}`, {
    id: ID_DO_AVISO_ORG_DIVERGENTE,
    // Sem prazo: enquanto a divergência durar, o aviso continua na tela.
    duration: Number.POSITIVE_INFINITY,
    action: { label: rotulo, onClick: () => recarregarAba() },
  });
}
