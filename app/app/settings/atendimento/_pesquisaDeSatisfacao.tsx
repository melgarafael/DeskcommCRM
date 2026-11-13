"use client";

/**
 * A PORTA DA PESQUISA DE SATISFAÇÃO (#4023): ligar e ver o resultado.
 *
 * Salva no clique, como as outras opções desta tela. Ligar é de quem administra
 * (o PATCH de `/api/v1/settings/atendimento` cobra `admin`); ver o resultado é
 * de quem gerencia, que é o piso da própria tela.
 *
 * O resultado chega pronto do servidor (`page.tsx`), lido pela mesma função da
 * rota de métricas: a tela não pode mostrar uma conta que a API não faz.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import type { ResumoDaSatisfacao } from "@/lib/atendimento/satisfacao";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export function PesquisaDeSatisfacao({
  ligada,
  janelaHoras,
  resumo,
  idioma,
  podeMudar,
}: {
  ligada: boolean;
  janelaHoras: number;
  /** `null` quando a leitura falhou: a tela diz isso em vez de mostrar zero. */
  resumo: ResumoDaSatisfacao | null;
  idioma: Idioma;
  /** Espelha o `admin` que a rota cobra. Cortesia, não autorização. */
  podeMudar: boolean;
}) {
  const t = (texto: string) => traduzir(texto, idioma);
  const router = useRouter();
  const [valor, setValor] = useState(ligada);
  const [isPending, startTransition] = useTransition();

  function mudar(novo: boolean) {
    setValor(novo);
    startTransition(async () => {
      try {
        await apiClient.patch("/api/v1/settings/atendimento", { ligado: novo });
        toast.success(t("Opção salva."));
        router.refresh();
      } catch (err) {
        setValor(!novo);
        toast.error(err instanceof Error ? t(err.message) : t("Não consegui salvar agora."));
      }
    });
  }

  const maiorContagem = resumo ? Math.max(1, ...Object.values(resumo.notas).map(Number)) : 1;

  return (
    <Card className="p-6" data-testid="pesquisa-de-satisfacao">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="pesquisa_de_satisfacao">{t("Pesquisa de satisfação ao encerrar")}</Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Ligada, quem tem o atendimento encerrado recebe uma pergunta: de 1 a 5, como avalia o atendimento. A resposta vira nota só se vier logo em seguida: se a equipe ou a IA voltar a falar com o cliente, um número que ele mande é conversa normal. Não sai para contato bloqueado ou pessoal, nem fora do horário de envio do número.",
            )}
          </p>
          <p className="max-w-2xl text-xs" data-testid="pesquisa-de-satisfacao-estado">
            {valor
              ? t("Ligada: a pergunta sai ao encerrar o atendimento.")
              : t("Desligada: nenhuma pergunta sai ao encerrar.")}
          </p>
          {!podeMudar && (
            <p className="text-xs text-muted-foreground">
              {t("Só um administrador da organização pode mudar esta opção.")}
            </p>
          )}
        </div>
        <Switch
          id="pesquisa_de_satisfacao"
          checked={valor}
          disabled={isPending || !podeMudar}
          onCheckedChange={mudar}
        />
      </div>

      <div className="mt-6 border-t pt-4" data-testid="pesquisa-de-satisfacao-resultado">
        <h3 className="text-sm font-semibold">{t("Resultado dos últimos 30 dias")}</h3>
        {resumo === null ? (
          <p className="mt-2 text-xs text-muted-foreground">{t("Não foi possível calcular a satisfação.")}</p>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div>
                <dt className="text-xs text-muted-foreground">{t("Média")}</dt>
                <dd className="text-2xl font-semibold tabular-nums" data-testid="pesquisa-de-satisfacao-media">
                  {resumo.media === null ? "—" : resumo.media.toLocaleString(idioma, { maximumFractionDigits: 2 })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("Respostas")}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{resumo.respostas}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("Perguntas feitas")}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{resumo.pedidos}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("Sem resposta")}</dt>
                <dd className="text-2xl font-semibold tabular-nums">{resumo.sem_nota}</dd>
              </div>
            </dl>
            <ul className="mt-4 flex max-w-md flex-col gap-1">
              {[5, 4, 3, 2, 1].map((nota) => {
                const quantidade = Number(resumo.notas[String(nota)] ?? 0);
                return (
                  <li key={nota} className="flex items-center gap-2 text-xs">
                    <span className="w-3 tabular-nums">{nota}</span>
                    <span className="h-2 flex-1 rounded bg-muted">
                      <span
                        className="block h-2 rounded bg-primary"
                        style={{ width: `${(quantidade / maiorContagem) * 100}%` }}
                      />
                    </span>
                    <span className="w-8 text-right tabular-nums">{quantidade}</span>
                  </li>
                );
              })}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              {t(
                "Quem não respondeu conta em \"Sem resposta\", nunca como nota baixa. A média usa só as respostas.",
              )}{" "}
              {resumo.aguardando > 0
                ? t("Há perguntas ainda esperando resposta.")
                : null}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("Prazo para o cliente responder:")} {janelaHoras} h
            </p>
          </>
        )}
      </div>
    </Card>
  );
}
