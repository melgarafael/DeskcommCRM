"use client";
import { useT } from "@/hooks/i18n/useT";
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
 * O rótulo de quem não tem `full_name` no cadastro.
 *
 * É o MESMO arranjo do ReassignDialog (`t("Atendente")` + o começo do id): se
 * o nome não existe, a lista não pode some a pessoa — ela é justamente quem
 * precisa poder ser mencionada. O id nunca aparece inteiro: o rótulo vira
 * `@Asesor 2f9c1d80` na nota, legível e único sem expor o uuid inteiro.
 */
export function rotuloSemNome(user_id: string, padrao: string): string {
  return `${padrao} ${user_id.slice(0, 8)}`;
}

/** Lista filtrada pela query, já com o rótulo de cada um (puro, testável). */
export function opcoesDeMencao(
  membros: readonly MembroDeMencao[],
  query: string,
  padrao: string,
): OpcaoDeMencao[] {
  const q = query.trim().toLowerCase();
  return membros
    .map((membro) => ({
      membro,
      rotulo: membro.full_name?.trim() || rotuloSemNome(membro.user_id, padrao),
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
