"use client";

/**
 * O INTERRUPTOR DA #2593 (item 1 do CR): o telefone de uma ficha SEM número
 * entra sozinho, ou espera uma pessoa.
 *
 * Salva no clique — é uma chave só, sem formulário em volta, e nada de dado é
 * reescrito em nenhum dos dois sentidos (a regra é lida NO ATO, na hora da
 * conversa). Por isso não há diálogo de confirmação, ao contrário do
 * `ClientePelaAgenda`, cuja ligação etiqueta o histórico inteiro de uma vez.
 *
 * ⚠️ O TEXTO DIZ O QUE NÃO ACONTECE, e não é enfeite: quem liga isto precisa
 * saber, ANTES, que (a) a opção não troca o número de quem já tem, (b) não
 * abre os outros campos e (c) o que entrar sozinho fica visível na linha do
 * tempo. Uma frase a menos em cada uma dessas três e o interruptor vira uma
 * aposta sobre o que ele faz.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { definirTelefoneDeFichaVazia } from "@/app/actions/settings/definirTelefoneDeFichaVazia";
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

export function TelefoneDeFichaVazia({
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
      const r = await definirTelefoneDeFichaVazia(novo);
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
          <Label htmlFor="telefone_de_ficha_vazia">
            {t("Telefone informado pelo cliente entra sozinho na ficha sem número")}
          </Label>
          <p className="max-w-2xl text-xs text-muted-foreground">
            {t(
              "Quando o cliente diz o telefone numa conversa e a ficha do contato está SEM número, o número é gravado na hora, em formato internacional (E.164), sem esperar alguém confirmar — e aparece na linha do tempo do contato quando ele tem um negócio aberto. Nunca troca o número de quem já tem um: isso continua exigindo uma pessoa, como o e-mail, o nome e a data de nascimento. Vem desligada.",
            )}
          </p>
          <p className="max-w-2xl text-xs" data-testid="telefone-de-ficha-vazia-estado">
            {valor
              ? t("Ligado: o telefone de um cadastro sem número entra sozinho, e fica registrado na linha do tempo quando o contato tem um negócio aberto.")
              : t("Desligado: todo telefone informado vira proposta, como o resto do dado ouvido na conversa.")}
          </p>
          {!podeMudar && (
            <p className="text-xs text-muted-foreground">
              {t("Só um administrador da organização pode mudar esta opção.")}
            </p>
          )}
        </div>
        <Switch
          id="telefone_de_ficha_vazia"
          checked={valor}
          disabled={isPending || !podeMudar}
          onCheckedChange={mudar}
        />
      </div>
    </Card>
  );
}
