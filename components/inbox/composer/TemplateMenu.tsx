"use client";
import { useT } from "@/hooks/i18n/useT";
import type { GrupoDeRespostas, MessageTemplate } from "@/hooks/inbox/useMessageTemplates";
import { grupoDaResposta } from "@/lib/templates/grupos";

/** Estado do slash-menu a partir do texto do composer. Puro (testável). */
export function resolveSlash(text: string): { open: boolean; query: string } {
  if (!text.startsWith("/")) return { open: false, query: "" };
  const rest = text.slice(1);
  if (/\s/.test(rest)) return { open: false, query: "" };
  return { open: true, query: rest };
}

/**
 * AS RESPOSTAS QUE O SLASH-MENU MOSTRA para a consulta digitada (#3245).
 *
 * ─── A busca ATRAVESSA os grupos ────────────────────────────────────────────
 *
 * Este filtro percorre a lista INTEIRA de respostas, nunca "o grupo aberto":
 * quem digita `prazo` tem de achar a resposta mesmo sem lembrar em que etapa
 * ela foi cadastrada. Agrupar é organização da TELA, não um escopo de busca — e
 * é por isso que o filtro continua num único laço, como antes dos grupos.
 *
 * O NOME DO GRUPO entra como campo de busca de propósito: quem lembra da etapa
 * ("negociação") e não do título acha pelas duas portas. `shortcut` e `title`
 * continuam valendo — a assinatura de antes.
 *
 * Função pura e exportada porque é ELA que o teste prende: o filtro não pode
 * morar dentro do JSX sem um lugar único onde a sabotagem o desligue.
 */
export function filtrarRespostas(
  templates: readonly MessageTemplate[],
  query: string,
  grupos: readonly GrupoDeRespostas[] = [],
): MessageTemplate[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...templates];
  return templates.filter((template) => {
    if (template.title.toLowerCase().includes(q)) return true;
    if ((template.shortcut ?? "").toLowerCase().includes(q)) return true;
    const grupo = grupoDaResposta(template, grupos);
    return grupo ? grupo.name.toLowerCase().includes(q) : false;
  });
}

interface Props {
  open: boolean;
  query: string;
  templates: MessageTemplate[];
  /** Os grupos (#3245) — vazio = sem grupo, e o menu é o de antes. */
  grupos?: GrupoDeRespostas[] | null;
  onPick: (t: MessageTemplate) => void;
  onClose: () => void;
}

export function TemplateMenu({ open, query, templates, grupos = [], onPick, onClose: _onClose }: Props) {
  const t = useT();
  if (!open) return null;
  const filtered = filtrarRespostas(templates, query, grupos ?? []);
  return (
    <div
      className="absolute bottom-14 left-3 z-20 max-h-64 w-80 overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-lg"
      role="listbox"
      aria-label={t("Templates de script")}
    >
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">{t("Nenhum template. Crie em Configurações.")}</div>
      ) : (
        filtered.map((tpl) => {
          // O grupo aparece como DICA ao lado do título: quem procura "prazo"
          // acha em qualquer etapa, e vê a que etapa a resposta pertence antes
          // de escolher. Sem grupo (ou com vínculo velho) não há dica nenhuma.
          const grupo = grupoDaResposta(tpl, grupos);
          return (
            <button
              key={tpl.id}
              type="button"
              className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left hover:bg-muted"
              onClick={() => onPick(tpl)}
            >
              <span className="flex w-full items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{tpl.title}</span>
                {grupo && (
                  <span
                    data-grupo-da-resposta={grupo.id}
                    className="shrink-0 text-[11px] text-muted-foreground"
                  >
                    {grupo.name}
                  </span>
                )}
              </span>
              <span className="line-clamp-1 text-xs text-muted-foreground">{tpl.body}</span>
            </button>
          );
        })
      )}
    </div>
  );
}
