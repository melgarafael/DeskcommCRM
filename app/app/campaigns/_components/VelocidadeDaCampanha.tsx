"use client";

/**
 * A VELOCIDADE DA CAMPANHA (migration 0711): gradual ou rápida.
 *
 * Só o número oficial oferece a escolha — por QR, rajada é banimento, e a tela
 * diz isso em vez de esconder a opção sem explicar. Os números da frase saem do
 * despacho (`RAJADA` em `lib/campanhas/rajada.ts`), não de um texto solto que
 * envelhece quando alguém muda o ritmo.
 */
import { useT } from "@/hooks/i18n/useT";
import { RAJADA } from "@/lib/campanhas/rajada";

export type Velocidade = "gradual" | "rapida";

/** Mensagens por segundo da rajada, para a frase da tela. */
export const POR_SEGUNDO_NA_RAPIDA = Math.round(1000 / RAJADA.intervaloEntreIniciosMs);

/**
 * Quanto tempo a lista leva, em minutos inteiros (no mínimo 1): na rápida, o
 * que cabe em cada rodada de um minuto; na gradual, uma por minuto.
 */
export function minutosParaEnviar(pessoas: number, velocidade: Velocidade): number {
  if (pessoas <= 0) return 0;
  if (velocidade === "gradual") return pessoas;
  const porRodada = Math.floor(RAJADA.prazoMs / RAJADA.intervaloEntreIniciosMs);
  return Math.max(1, Math.ceil(pessoas / porRodada));
}

export function VelocidadeDaCampanha({
  valor,
  onChange,
  ehOficial,
  nome = "velocidade",
  desabilitado = false,
}: {
  valor: Velocidade;
  onChange: (v: Velocidade) => void;
  ehOficial: boolean;
  nome?: string;
  desabilitado?: boolean;
}) {
  const t = useT();
  if (!ehOficial) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="velocidade-so-gradual">
        {t("Número por QR envia uma mensagem por minuto: é a proteção contra banimento. O envio rápido é do número oficial.")}
      </p>
    );
  }
  const opcoes: Array<{ v: Velocidade; titulo: string; texto: string }> = [
    {
      v: "gradual",
      titulo: t("Gradual"),
      texto: t(
        "Uma mensagem por minuto. O mais seguro para a qualidade do número: se a plataforma recusar o modelo, a campanha para antes de chegar a todos.",
      ),
    },
    {
      v: "rapida",
      titulo: t("Rápido"),
      texto: t(
        "Tudo de uma vez: cerca de {n} por segundo (500 pessoas em 2 a 3 minutos). As respostas chegam juntas, e o agente atende algumas de cada vez.",
      ).replace("{n}", String(POR_SEGUNDO_NA_RAPIDA)),
    },
  ];
  return (
    <fieldset className="space-y-2" data-testid="velocidade-da-campanha" disabled={desabilitado}>
      <legend className="text-sm font-medium">{t("Velocidade de envio")}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {opcoes.map((o) => (
          <label
            key={o.v}
            className={`flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm ${
              valor === o.v ? "border-primary bg-primary/5" : "border-border"
            }`}
          >
            <input
              type="radio"
              name={nome}
              value={o.v}
              checked={valor === o.v}
              onChange={() => onChange(o.v)}
              className="mt-1"
              aria-label={o.titulo}
            />
            <span className="space-y-1">
              <span className="block font-medium">{o.titulo}</span>
              <span className="block text-muted-foreground">{o.texto}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
