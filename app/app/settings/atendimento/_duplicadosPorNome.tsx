"use client";

/**
 * O INTERRUPTOR DA #4138: a tela Contatos › Duplicados também sugere pares pelo
 * NOME, ou mostra só os motivos fortes?
 *
 * Salva no clique — é uma chave só, sem formulário em volta, e nada é resscrito
 * em nenhum sentido: a leitura acontece na varredura, na hora em que a tela de
 * duplicados abre. Por isso não há diálogo de confirmação.
 *
 * ⚠️ O TEXTO DIZ OS DOIS LADOS, e não é enfeite: quem liga precisa saber que a
 * seção "Parecidos — confira" volta e que ela é SUGESTÃO (o nome não prova nada,
 * e nada é fundido sozinho); quem deixa desligado precisa saber o que perde — em
 * base de empresa, o mesmo nome com dois telefones é o único caminho medido.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirDuplicadosPorNome } from "@/app/actions/settings/definirDuplicadosPorNome";
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

export function DuplicadosPorNome({
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
      const r = await definirDuplicadosPorNome(novo);
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
          <Label htmlFor="duplicados_por_nome">
            {t("Sugerir contatos duplicados pelo nome")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Ligada, a tela Contatos › Duplicados mostra a seção \"Parecidos — confira\": fichas cujo NOME se parece o bastante para valer uma conferência, com os dados lado a lado. É sugestão, não prova: nada é juntado sozinho, e juntar continua sendo um clique de gestor. Nunca aparece o par com CPFs diferentes. Vem desligada porque, em base de pessoa física, o nome repete e a sugestão vira ruído.",
            )}
          </p>
          <p className="max-w-2xl text-xs" data-testid="duplicados-por-nome-estado">
            {valor
              ? t("Ligado: a seção \"Parecidos — confira\" aparece na tela de duplicados, depois dos motivos fortes.")
              : t("Desligado: a tela de duplicados mostra só os motivos fortes — telefone, e-mail e CPF.")}
          </p>
          {!podeMudar && (
            <p className="text-xs text-muted-foreground">
              {t("Só um administrador da organização pode mudar esta opção.")}
            </p>
          )}
        </div>
        <Switch
          id="duplicados_por_nome"
          checked={valor}
          disabled={isPending || !podeMudar}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
