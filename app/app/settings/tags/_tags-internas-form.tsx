"use client";

/**
 * A LISTA DE ETIQUETAS DE CONTATO INTERNO (#2353), na tela de Tags.
 *
 * ─── Por que mora nesta tela, e não numa tela de "atendimento" ───────────────
 *
 * A pergunta que o operador faz aqui já é sobre ETIQUETA: "esta marca é de
 * contato interno?". A tela de Tags é a que arruma o vocabulário — e a lista é
 * um vocabulário, só que o das etiquetas que dizem "não é negócio".
 *
 * ─── O contrato com o operador em três linhas ──────────────────────────────
 *
 * O texto abaixo do campo diz o que muda, porque a decisão é invisível no dia a
 * dia: o contato não vira card e a IA não responde, mas a conversa continua na
 * Inbox. Sem essa frase, quem marcou "fornecedor" procuraria o card e concluiria
 * que o sistema falhou.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

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

export function TagsInternasForm({ tags, idioma }: { tags: string[]; idioma: Idioma }) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [texto, setTexto] = useState(tags.join("\n"));
  const [isPending, startTransition] = useTransition();

  function salvar(evento: React.FormEvent) {
    evento.preventDefault();
    // Uma etiqueta por linha; vírgula também separa, para quem cola uma lista.
    const lista = texto
      .split(/[\n,]/)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== "");
    startTransition(async () => {
      const r = await definirTagsDeContatoInterno({ tags: lista });
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
          <h3 className="text-sm font-semibold">{t("Etiquetas de contato interno")}</h3>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Contato marcado com uma destas etiquetas não vira card no funil e não recebe resposta da IA — equipe, sócio, família, fornecedor. A conversa continua normal na Inbox, inclusive para envio manual. Uma etiqueta por linha.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-2">
          <Textarea
            value={texto}
            onChange={(e) => setTexto(e.target.value)}
            rows={4}
            placeholder={"interno\nequipe\nfamilia"}
            aria-label={t("Etiquetas de contato interno")}
          />
          <p className="text-xs text-muted-foreground">
            {t("Deixe em branco para nenhum contato ser interno — o comportamento de antes.")}
          </p>
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
