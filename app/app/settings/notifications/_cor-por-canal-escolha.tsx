"use client";

import * as React from "react";
import { toast } from "sonner";

import { definirCorPorCanal, type ErroCorPorCanal } from "@/app/actions/settings/definirCorPorCanal";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/hooks/i18n/useT";
import { CANAIS_NA_PALETA, marcaDoCanal } from "@/lib/channels/marca-do-canal";

/** Os mesmos motivos de recusa da opção vizinha (`_tela-bloqueada-escolha`). */
const ERROS: Record<ErroCorPorCanal, string> = {
  invalido: "Opção inválida.",
  sessao: "Sua sessão expirou. Entre de novo.",
  somente_leitura: "Acompanhamento somente leitura ou encerrado.",
  sem_empresa: "Nenhuma empresa ativa.",
  sem_permissao: "Só um administrador pode mudar essa regra.",
  mfa: "Confirme a verificação em duas etapas nesta sessão.",
  falha: "Não consegui salvar essa mudança agora.",
};

/**
 * A seção da EMPRESA: o aviso de mensagem nova sai na cor do canal ou no neutro
 * de sempre (#4094).
 *
 * A paleta aparece aqui, e não escondida atrás do interruptor, por um motivo
 * prático: quem desliga a cor costuma estar decidindo entre "colorido ajuda" e
 * "colorido atrapalha", e ver as seis cores na tela é a informação que falta
 * para escolher. Cada pastilha carrega o NOME em texto — cor sozinha não é
 * informação para quem não a distingue.
 */
export function EscolhaDaCorPorCanal({
  valorInicial,
  podeEditar,
}: {
  valorInicial: boolean;
  podeEditar: boolean;
}) {
  const t = useT();
  const [valor, setValor] = React.useState(valorInicial);
  const [salvando, startTransition] = React.useTransition();

  function alternar(novo: boolean) {
    const anterior = valor;
    setValor(novo);
    startTransition(async () => {
      const r = await definirCorPorCanal(novo);
      if (r.ok) {
        toast.success(t("Salvo"));
      } else {
        setValor(anterior);
        toast.error(t(ERROS[r.erro]));
      }
    });
  }

  return (
    <Card className="p-4" data-testid="cor-por-canal">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">{t("Cor por canal no aviso de mensagem")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "Com a cor ligada, o aviso de mensagem nova mostra uma faixa e o logo da rede na cor dela — WhatsApp verde, Telegram azul —, e o nome do canal abre o texto. Desligada, o aviso volta ao neutro de sempre.",
            )}
          </p>
        </div>
        <Switch
          checked={valor}
          onCheckedChange={alternar}
          disabled={!podeEditar || salvando}
          aria-label={t("Cor por canal no aviso de mensagem")}
          data-testid="cor-por-canal-interruptor"
        />
      </div>

      <ul className="mt-3 flex flex-wrap gap-2" aria-hidden={!valor}>
        {CANAIS_NA_PALETA.map((canal) => {
          const marca = marcaDoCanal(canal);
          const nome = t(marca.rotulo);
          return (
            <li
              key={canal}
              data-testid={`cor-por-canal-${canal}`}
              className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
              style={{ borderColor: valor ? marca.cor : undefined }}
            >
              <span
                aria-hidden
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: valor ? marca.cor : "var(--color-text-muted)" }}
              />
              <span className={valor ? "font-medium" : "text-muted-foreground"}>{nome}</span>
            </li>
          );
        })}
        <li
          data-testid="cor-por-canal-outros"
          className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs"
        >
          <span aria-hidden className="inline-block size-2 rounded-full bg-[var(--color-text-muted)]" />
          <span className="text-muted-foreground">{t("Demais canais: neutro")}</span>
        </li>
      </ul>

      {!podeEditar ? (
        // Texto PRÓPRIO, e não o "Quem decide é um administrador." da seção
        // vizinha: as duas cartas vivem na MESMA tela e, com a frase repetida
        // ao pé da letra, o nome acessível das duas fica ambíguo — quem lê a
        // tela não sabe a qual carta o aviso pertence, e um seletor por texto
        // passou a casar com dois parágrafos (spec do aviso com a tela
        // bloqueada, `notificacoes-tela-bloqueada.spec.ts`). A frase diz o que
        // ESTA carta decide (#4094).
        <p className="mt-3 text-xs text-muted-foreground">
          {t("Só um administrador liga ou desliga a cor do aviso.")}
        </p>
      ) : null}
    </Card>
  );
}
