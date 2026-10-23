"use client";
import { useT } from "@/hooks/i18n/useT";
import { rotuloDoAtendente, type Tradutor } from "@/lib/users/rotulo-do-atendente";
import { cn } from "@/lib/utils";

/**
 * O autocompletar de menção de atendentes (#2372) — só em NOTA INTERNA.
 *
 * Ele existe para uma coisa: a menção deixar de ser texto que "lembra" alguém.
 * Quem clica na lista entrega o `user_id` na mão, e é esse id que vai gravado
 * no corpo (`lib/notifications/mentions.ts`) — duas Anas na organização não
 * viram mais duas notificações.
 *
 * O gatilho é um pedaço de texto antes do caret (`resolverMencao`), puro de
 * propósito: é ele que o teste digita, é ele que decide a posição de inserção,
 * e ele não precisa do DOM para existir.
 */
export interface MembroDeMencao {
  user_id: string;
  full_name: string | null;
}

export interface OpcaoDeMencao {
  membro: MembroDeMencao;
  /** O que a lista MOSTRA e o que o corpo GRAVA — o mesmo texto, sempre. */
  rotulo: string;
}

/**
 * O gatilho `@` a partir do texto e da posição do cursor (puro, testável).
 *
 * Exige início de frase ou separador antes do `@` — sem isso, `ana@clinica.com`
 * abriria lista no meio de um e-mail. Devolve de ONDE o `@` começa, que é o
 * trecho a trocar na inserção: `start` aponta para o `@`, não para a query.
 *
 * O token estrutural (`@[Ana…](mencao:…)`) NÃO reabre a lista: ele é seguido
 * de `[`, que o query não aceita, então `$` não casa.
 */
export function resolverMencao(texto: string, caret: number): { start: number; query: string } | null {
  const pos = Math.max(0, Math.min(caret, texto.length));
  const antes = texto.slice(0, pos);
  const gatilho = /(?:^|[\s([{])@([\p{L}\p{N}._-]*)$/u.exec(antes);
  if (!gatilho) return null;
  // O `@` é o último byte menos a query: `start` aponta para o ARROBA, nunca
  // para o separador antes dele — trocar o separador apagava o espaço que
  // separava a menção da palavra de trás ("fala com@Ana Lima").
  return { start: antes.length - (gatilho[1] ?? "").length - 1, query: gatilho[1] ?? "" };
}

/**
 * A lista de opções, já com o rótulo de cada um (puro, testável).
 *
 * O rótulo sai de `rotuloDoAtendente` (#3023) — a MESMA fonte do seletor de
 * transferência. Até então este arquivo tinha o seu próprio arranjo
 * (`t("Atendente")` + `user_id.slice(0, 8)`), gêmeo do do `ReassignDialog` e
 * igualmente errado: o `uuid8` não é nome de ninguém, e aqui ele ia além do
 * que a tela mostrava — entrava GRAVADO no corpo da nota (`@[Atendente
 * 4fa3a91c](mencao:…)`) e virava o texto que o colega mencionado lê na
 * notificação. Sem nome cadastrado, a linha mostra o rótulo genérico estável e
 * o `user_id` continua indo só no token, que é coisa de banco, nunca de tela.
 *
 * O filtro continua casando pelo rótulo exibido: quem digita `@ana` acha a
 * Ana; membro sem nome não é achável por um pedaço de id — de propósito.
 */
export function opcoesDeMencao(
  membros: readonly MembroDeMencao[],
  query: string,
  t: Tradutor,
): OpcaoDeMencao[] {
  const q = query.trim().toLowerCase();
  return membros
    .map((membro) => ({
      membro,
      rotulo: rotuloDoAtendente(membro.full_name, t),
    }))
    .filter((opcao) => opcao.rotulo.toLowerCase().includes(q));
}

interface Props {
  open: boolean;
  opcoes: OpcaoDeMencao[];
  indice: number;
  onPick: (opcao: OpcaoDeMencao) => void;
}

export function MentionMenu({ open, opcoes, indice, onPick }: Props) {
  const t = useT();
  if (!open) return null;
  return (
    <div
      role="listbox"
      aria-label={t("Atendentes para mencionar")}
      className="absolute bottom-14 left-3 z-30 max-h-64 w-72 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      {opcoes.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">{t("Nenhum atendente encontrado.")}</div>
      ) : (
        opcoes.map((opcao, i) => (
          <button
            key={opcao.membro.user_id}
            type="button"
            role="option"
            aria-selected={i === indice}
            className={cn(
              "flex w-full items-center rounded-md px-3 py-2 text-left text-sm hover:bg-muted",
              i === indice && "bg-muted",
            )}
            // `onClick`, e não `mousedown`: quem decide a posição de inserção é
            // o estado do React (`caret`), não a seleção viva do textarea — o
            // blur do clique não estraga nada, e o foco volta na inserção.
            onClick={() => onPick(opcao)}
          >
            <span className="truncate font-medium">{opcao.rotulo}</span>
          </button>
        ))
      )}
    </div>
  );
}
