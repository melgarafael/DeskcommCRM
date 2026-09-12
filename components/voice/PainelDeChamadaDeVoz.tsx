"use client";
/**
 * O INTERRUPTOR DA CHAMADA DE VOZ — e o aviso que vem ANTES dele.
 *
 * ═══ POR QUE ESTE PAINEL VIVE EM CONFIGURAÇÕES › SEGURANÇA ═══
 *
 * O que se liga aqui não é um recurso: é uma ACEITAÇÃO DE RISCO. A chamada de
 * voz vincula um segundo aparelho ao mesmo número de WhatsApp que a empresa usa
 * para vender, por um caminho que não é o oficial — e o que o WhatsApp pode
 * bloquear é a CONTA, não o aparelho.
 *
 * Esta tela já é onde mora a outra decisão de risco da organização ("exigir
 * verificação em duas etapas de quem administra"), e é a única do produto onde
 * um admin espera encontrar esse tipo de escolha. A aba "Chamada de voz" em
 * Conexões é onde se PAREIA — ela lê este estado, não o define.
 *
 * ═══ O AVISO É TEXTO, NÃO ÍCONE ═══
 *
 * Escrito para quem não é técnico, e dito ANTES do controle, não num tooltip
 * depois: quem só olha o interruptor precisa ter lido o risco para chegar até
 * ele. E o botão de ligar só faz efeito com a caixa de aceite marcada — a
 * mesma condição que o PUT cobra do outro lado, para que a tela e a rota não
 * discordem.
 *
 * ═══ A ORDEM QUE ESTE ARQUIVO RESPEITA ═══
 *
 * Motor primeiro, tela depois. `org_voice_calls` (migration 0234), a regra de
 * precedência (`lib/voice/opt-in.ts`), a recusa das rotas (`lib/voice/guarda.ts`)
 * e o desparear de verdade (`lib/voice/desparear.ts`) existem ANTES deste
 * componente. Um interruptor que grava o que o resto ignora é controle
 * decorativo — pior que controle ausente, porque ensina que a decisão foi
 * tomada.
 */
import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";

type Estado = {
  ligada: boolean;
  instalacaoOferece: boolean;
  motivo: "ligada" | "instalacao_nao_oferece" | "organizacao_nao_ligou";
  riscoAceitoEm: string | null;
  podeEditar: boolean;
};

export function PainelDeChamadaDeVoz() {
  const t = useT();
  const tagDeIdioma = useTagDeIdioma();
  const [estado, setEstado] = React.useState<Estado | null>(null);
  const [ilegivel, setIlegivel] = React.useState(false);
  const [carregando, setCarregando] = React.useState(true);
  const [aceitou, setAceitou] = React.useState(false);
  const [salvando, setSalvando] = React.useState(false);

  const carregar = React.useCallback(async () => {
    try {
      const res = await fetch("/api/v1/voice/opt-in", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) {
        // Quem não pode ver, não vê — e isso não é falha, é a resposta certa.
        setEstado(null);
        setIlegivel(false);
        return;
      }
      if (!res.ok) {
        // ⚠️ FALHAR ABERTO NA INFORMAÇÃO. Sumir com o painel diria, em silêncio,
        // que esta organização não tem a feature — e "não sei" tem exatamente a
        // mesma cara de "está desligada" para quem só olha a tela. Quem precisa
        // conferir se o segundo aparelho está ou não vinculado ao número não
        // pode receber essa ambiguidade de graça.
        setEstado(null);
        setIlegivel(true);
        return;
      }
      const json = (await res.json()) as { data: Estado };
      setEstado(json.data);
      setIlegivel(false);
    } catch {
      setEstado(null);
      setIlegivel(true);
    } finally {
      setCarregando(false);
    }
  }, []);

  React.useEffect(() => {
    void carregar();
  }, [carregar]);

  async function mudar(ligar: boolean) {
    setSalvando(true);
    try {
      const res = await fetch("/api/v1/voice/opt-in", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: ligar, riscoAceito: ligar ? aceitou : undefined }),
      });
      const json = (await res.json().catch(() => null)) as
        | { error?: { message?: string }; data?: { aparelhoDesconectado?: boolean } }
        | null;
      if (!res.ok) {
        toast.error(json?.error?.message ?? t("Não foi possível salvar."));
        return;
      }
      // A frase diz o que ACONTECEU, não o que foi gravado — e por isso vem do
      // que a rota RESPONDEU. Afirmar "aparelho desconectado" quando não havia
      // nada pareado (ou nenhum serviço a quem pedir o logout) seria uma frase
      // tranquilizadora sobre algo que não aconteceu, num assunto que é risco.
      toast.success(
        ligar
          ? t("Chamada de voz ligada.")
          : json?.data?.aparelhoDesconectado
            ? t("Chamada de voz desligada e aparelho desconectado.")
            : t("Chamada de voz desligada."),
      );
      setAceitou(false);
      await carregar();
    } finally {
      setSalvando(false);
    }
  }

  if (carregando) return null;

  if (ilegivel) {
    return (
      <Card className="space-y-2 p-6">
        <h2 className="text-sm font-semibold">{t("Chamada de voz pelo WhatsApp")}</h2>
        <p className="text-sm text-muted-foreground">
          {t(
            "Não consegui verificar se a chamada de voz está ligada nesta empresa. Recarregue a página; se continuar, avise quem cuida da instalação.",
          )}
        </p>
      </Card>
    );
  }

  if (!estado) return null;

  return (
    // `data-testid` para o e2e conseguir ISOLAR este painel e medir o texto
    // dele — a tela de Segurança tem outros cartões, e uma varredura de
    // qualidade que pegasse a página inteira acusaria o vizinho.
    <Card className="space-y-4 p-6" data-testid="painel-voz">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">{t("Chamada de voz pelo WhatsApp")}</h2>
        <p className="text-sm text-muted-foreground">
          {estado.ligada
            ? t("Ligada. Sua equipe pode ligar e receber chamadas pelo número conectado.")
            : t("Desligada. Ninguém consegue ligar nem receber chamadas por aqui.")}
        </p>
      </div>

      {/* O RISCO, ANTES DO CONTROLE. Sem jargão: quem lê é dono de negócio. */}
      <div className="rounded-md border border-amber-300/60 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-100">
        <p className="font-medium">{t("Leia antes de ligar")}</p>
        <p className="mt-1">
          {t(
            "Para fazer chamadas, o sistema precisa conectar um segundo aparelho ao mesmo número de WhatsApp que você já usa para atender. Essa conexão não é feita pelo caminho oficial do WhatsApp.",
          )}
        </p>
        <p className="mt-2">
          {t(
            "O WhatsApp pode entender isso como uso indevido e bloquear a CONTA — não só a chamada. Se isso acontecer, você perde também as mensagens desse número, e recuperar depende do WhatsApp, não de nós.",
          )}
        </p>
        <p className="mt-2">
          {t(
            "Ligue apenas se a chamada de voz valer esse risco para o seu negócio. Você pode desligar a qualquer momento aqui mesmo — e o aparelho é desconectado na hora.",
          )}
        </p>
      </div>

      {estado.motivo === "instalacao_nao_oferece" ? (
        // Frase diferente de propósito: aqui nenhum clique nesta tela resolve, e
        // oferecer o botão faria a pessoa tentar, falhar e não saber por quê.
        <p className="text-sm text-muted-foreground">
          {t(
            "Este servidor não tem a chamada de voz instalada. Quem cuida da instalação precisa ligá-la antes — depois esta opção fica disponível aqui.",
          )}
        </p>
      ) : !estado.podeEditar ? (
        <p className="text-sm text-muted-foreground">
          {t("Só quem é administrador desta empresa pode mudar isto.")}
        </p>
      ) : estado.ligada ? (
        <div className="space-y-2">
          {estado.riscoAceitoEm ? (
            <p className="text-xs text-muted-foreground">
              {t("Risco aceito em")} {new Date(estado.riscoAceitoEm).toLocaleString(tagDeIdioma)}
            </p>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={salvando}
            onClick={() => void mudar(false)}
          >
            {salvando ? t("Desligando…") : t("Desligar e desconectar o aparelho")}
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={aceitou}
              disabled={salvando}
              onChange={(e) => setAceitou(e.target.checked)}
            />
            <span>
              {t(
                "Eu li o aviso acima e aceito o risco de o WhatsApp bloquear esta conta.",
              )}
            </span>
          </label>
          <Button
            size="sm"
            // Cinza por FALTA DE ACEITE, que é uma condição visível na tela e
            // explicada logo acima — nunca por falta de fiação. O gate de
            // controle decorativo existe para a segunda hipótese.
            disabled={salvando || !aceitou}
            onClick={() => void mudar(true)}
          >
            {salvando ? t("Ligando…") : t("Ligar chamada de voz")}
          </Button>
        </div>
      )}
    </Card>
  );
}
