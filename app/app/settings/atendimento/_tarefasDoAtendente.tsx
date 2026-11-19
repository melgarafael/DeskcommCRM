"use client";

/**
 * O INTERRUPTOR DA #4737 (parte 2): "Atendente vê só as próprias tarefas".
 *
 * Salva no clique — é uma chave só, sem formulário em volta, e nada de dado é
 * reescrito em nenhum dos dois sentidos: a regra é lida NO ATO, na consulta da
 * lista (`app/api/v1/tasks/route.ts`).
 *
 * ⚠️ O TEXTO DIZ O QUE A OPÇÃO FAZ E O QUE ELA **NÃO** FAZ, e não é enfeite:
 * quem liga precisa saber, ANTES, que (a) a restrição vale na API, não só na
 * tela — esconder o seletor não seria restrição nenhuma; (b) tarefa sem
 * responsável continua visível, porque é a fila que o atendente pode assumir;
 * (c) gerente e administrador não são afetados — eles precisam da lista
 * inteira para distribuir.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirEscopoTarefasDoAtendente } from "@/app/actions/settings/definirEscopoTarefasDoAtendente";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

const ERRO: Record<string, string> = {
  unauthenticated: "Sua sessão expirou. Entre de novo.",
  forbidden_tenant: "Você não está em nenhuma organização ativa.",
  forbidden_role: "Só um administrador da organização pode mudar esta opção.",
  mfa_required: "Confirme o segundo fator para salvar esta mudança.",
};

export function TarefasDoAtendente({
  ligada,
  idioma,
  podeMudar,
}: {
  ligada: boolean;
  idioma: Idioma;
  /** Espelha o `admin` que a action cobra. Cortesia, não autorização. */
  podeMudar: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligada);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      const r = await definirEscopoTarefasDoAtendente(novo);
      if (r.ok) {
        setValor(r.ligado);
        toast.success(t("Opção salva."));
        router.refresh();
        return;
      }
      setValor(!novo);
      toast.error(t(ERRO[r.error] ?? "Não consegui salvar agora."));
    });
  }

  return (
    <Card className="p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="atendente_ve_so_as_proprias">
            {t("Atendente vê só as próprias tarefas (e as sem responsável)")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Ligada, quem tem papel de atendente vê, abre e altera apenas as tarefas atribuídas a si e as que ainda não têm responsável — na tela e na API, inclusive quando a lista é pedida direto. Tarefa de outro atendente é recusada com a mensagem de que é de outra pessoa, em vez de sumir da lista. Gerente e administrador continuam vendo as tarefas de todos: é assim que distribuem o trabalho. Vem desligada, e desligada tudo funciona como hoje.",
            )}
          </p>
          <p className="max-w-2xl text-xs" data-testid="tarefas-do-atendente-estado">
            {valor
              ? t("Ligada: o atendente vê as tarefas dele e as sem responsável.")
              : t("Desligada: o atendente vê as tarefas da equipe inteira, como hoje.")}
          </p>
          {!podeMudar && (
            <p className="text-xs text-muted-foreground">
              {t("Só um administrador da organização pode mudar esta opção.")}
            </p>
          )}
        </div>
        <Switch
          id="atendente_ve_so_as_proprias"
          checked={valor}
          disabled={isPending || !podeMudar}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
