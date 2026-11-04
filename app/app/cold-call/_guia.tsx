"use client";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useT } from "@/hooks/i18n/useT";
import { useVoiceSessionStatus } from "@/hooks/voice/useVoiceSessionStatus";

const CHAVE_DO_GUIA = "cold-call-guia-visto";

/** Conveniência de quem está vendo: sem armazenamento, o guia só volta a abrir sozinho. */
export function guiaJaVisto(): boolean {
  try {
    return window.localStorage.getItem(CHAVE_DO_GUIA) === "1";
  } catch {
    return false;
  }
}

function marcarGuiaComoVisto(): void {
  try {
    window.localStorage.setItem(CHAVE_DO_GUIA, "1");
  } catch {
    // Sem armazenamento o guia só abre de novo na próxima visita.
  }
}

const PASSOS: readonly { titulo: string; texto: string; link?: { href: string; rotulo: string } }[] = [
  {
    titulo: "Conecte o canal de voz",
    texto: "Em Conexões, na aba de voz, leia o QR Code com o WhatsApp do número que vai ligar. Sem isso, o botão Ligar abre o discador do seu aparelho.",
    link: { href: "/app/connections", rotulo: "Abrir Conexões" },
  },
  {
    titulo: "Libere o microfone",
    texto: "Na primeira ligação pelo CRM, o navegador pergunta se pode usar o microfone. Clique em Permitir.",
  },
  {
    titulo: "Importe a lista e comece",
    texto: "Em Importar planilha, suba os leads. Depois clique em Vamos começar, ligue, marque o resultado e vá para o próximo.",
  },
];

export function GuiaDoColdCall({ aoFechar }: { aoFechar: () => void }) {
  const t = useT();
  const { data: voz } = useVoiceSessionStatus();
  const conectado = !!voz?.configured && !!voz.paired;

  const fechar = () => {
    marcarGuiaComoVisto();
    aoFechar();
  };

  return (
    <Dialog open onOpenChange={(aberto) => !aberto && fechar()}>
      <DialogContent className="max-h-[90dvh] max-w-xl overflow-y-auto" data-testid="guia-do-cold-call">
        <DialogHeader>
          <DialogTitle>{t("Como deixar o Cold Call funcionando")}</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-text-muted">{t("São poucos passos, e você só faz uma vez em cada aparelho.")}</p>

        <ol className="flex flex-col gap-3">
          {PASSOS.map((passo, i) => (
            <li key={passo.titulo} className="flex gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-bold text-accent-foreground">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <h3 className="text-sm font-semibold text-text">{t(passo.titulo)}</h3>
                <p className="mt-0.5 text-sm leading-relaxed text-text-muted">{t(passo.texto)}</p>
                {passo.link && (
                  <a
                    href={passo.link.href}
                                        className="mt-1 inline-block text-sm font-medium text-accent hover:underline"
                  >
                    {t(passo.link.rotulo)}
                  </a>
                )}
              </div>
            </li>
          ))}
        </ol>

        <p
          className="rounded-xl border border-border/70 bg-surface px-3 py-2 text-sm text-text"
          data-testid="status-do-canal-de-voz"
        >
          {t("Canal de voz")}:{" "}
          <strong className={conectado ? "text-accent" : "text-warning"}>
            {conectado ? t("conectado") : t("aguardando o número ser conectado")}
          </strong>
        </p>

        <p className="text-xs leading-relaxed text-text-muted">
          {t("Todos ligam pelo mesmo número, então conte com uma ligação por vez.")}
        </p>

        <div className="flex justify-end">
          <Button onClick={fechar} data-testid="guia-entendi">
            {t("Entendi")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
