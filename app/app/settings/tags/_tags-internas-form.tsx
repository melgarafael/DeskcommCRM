"use client";

/**
 * AS DUAS LISTAS DE ETIQUETAS DE CONTATO NA TELA DE TAGS — interna (#2353) e da
 * EQUIPE (#3534).
 *
 * ─── Por que moram nesta tela, e não numa tela de "atendimento" ──────────────
 *
 * A pergunta que o operador faz aqui já é sobre ETIQUETA: "esta marca é de
 * contato interno?", "esta é da equipe?". A tela de Tags é a que arruma o
 * vocabulário — e as listas são vocabulário, só que o das etiquetas que dizem
 * "não é negócio" e "é time, mas continua sendo atendido".
 *
 * ─── Os dois significados, que o texto na tela tem de deixar claros ─────────
 *
 * A decisão é invisível no dia a dia, e as duas listas NÃO fazem a mesma coisa:
 *
 *   - interna → o contato não vira card E a IA não responde;
 *   - equipe  → o contato não vira card, mas a IA ATENDE; o que ele não tem é
 *               repasse automático por clima (nada de silenciar o sócio que
 *               testa o agente e cobra a resposta).
 *
 * Sem essa frase, quem marcasse o sócio na lista errada procuraria o card — ou
 * estranharia o agente parar de responder — e concluiria que o sistema falhou.
 *
 * ─── Um componente, dois destinos ───────────────────────────────────────────
 *
 * O formulário é o mesmo; o que muda é a chave gravada, a ação de servidor e o
 * texto. Duplicar a tela inteira para acrescentar a segunda lista faria as duas
 * divergirem na primeira correção de mensagem de erro.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirTagsDaEquipe } from "@/app/actions/settings/definirTagsDaEquipe";
import { definirTagsDeContatoInterno } from "@/app/actions/settings/definirTagsDeContatoInterno";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  validation_failed: "Confira a lista: alguma etiqueta passou do tamanho ou do limite.",
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um gerente ou administrador pode mudar esta lista.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
  erro_ao_gravar: "Não consegui gravar agora. Tente de novo em instantes.",
};

type Variante = "interna" | "equipe";

const TEXTOS: Record<
  Variante,
  { titulo: string; descricao: string; vazio: string; exemplo: string }
> = {
  interna: {
    titulo: "Etiquetas de contato interno",
    descricao:
      "Contato marcado com uma destas etiquetas não vira card no funil e não recebe resposta da IA — equipe, sócio, família, fornecedor. A conversa continua normal na Inbox, inclusive para envio manual. Uma etiqueta por linha.",
    vazio: "Deixe em branco para nenhum contato ser interno — o comportamento de antes.",
    exemplo: "interno\nequipe\nfamilia",
  },
  equipe: {
    titulo: "Etiquetas de contato da equipe",
    descricao:
      "Contato marcado com uma destas etiquetas continua sendo atendido pela IA, é medido pelo clima e não é passado a uma pessoa nem silenciado por isso — o sócio que testa o agente e pede informação a qualquer hora. Também não vira card no funil. Uma etiqueta por linha.",
    vazio: "Deixe em branco para nenhum contato ser da equipe — o comportamento de antes.",
    exemplo: "socio\nequipe",
  },
};

export function TagsInternasForm({
  tags,
  idioma,
  variante = "interna",
}: {
  tags: string[];
  idioma: Idioma;
  /** `interna` (padrão, #2353) ou `equipe` (#3534). */
  variante?: Variante;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [texto, setTexto] = useState(tags.join("\n"));
  const [isPending, startTransition] = useTransition();
  const textos = TEXTOS[variante];

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    // Uma etiqueta por linha; vírgula também separa, para quem cola uma lista.
    const lista = texto
      .split(/[\n,]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
    startTransition(async () => {
      const r =
        variante === "equipe"
          ? await definirTagsDaEquipe({ tags: lista })
          : await definirTagsDeContatoInterno({ tags: lista });
      if (r.ok) {
        // Espelha o que o servidor normalizou (minúscula, sem repetição).
        setTexto(r.tags.join("\n"));
        toast.success(t("Lista salva."));
        router.refresh();
        return;
      }
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="p-6">
      <form onSubmit={salvar} className="flex flex-col gap-5">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{t(textos.titulo)}</h3>
          <p className="max-w-2xl text-xs text-muted-foreground">{t(textos.descricao)}</p>
        </div>

        <div className="flex flex-col gap-2">
          <Textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={4}
            placeholder={textos.exemplo}
            aria-label={t(textos.titulo)}
          />
          <p className="text-xs text-muted-foreground">{t(textos.vazio)}</p>
        </div>

        <div>
          <Button type="submit" disabled={isPending}>
            {isPending ? t("Salvando…") : t("Salvar")}
          </Button>
        </div>
      </form>
    </Card>
  );
}
