"use client";

/**
 * A VELOCIDADE DA CAMPANHA (migrations 0711 e 0712): gradual, rápida ou
 * broadcast.
 *
 * Só o número oficial oferece a escolha — por QR, rajada é banimento, e a tela
 * diz isso em vez de esconder a opção sem explicar. Os números da frase saem do
 * despacho (`RAJADA` em `lib/campanhas/rajada.ts`), não de um texto solto que
 * envelhece quando alguém muda o ritmo.
 *
 * O broadcast só aparece quando o provedor do número o faz, e só pode ser
 * escolhido quando toda variável do modelo é texto fixo: o provedor manda o
 * mesmo valor a todos. Com variável por pessoa a opção fica à vista, travada,
 * com o motivo — a mesma regra que a rota cobra (`decidirVelocidade`).
 */
import { useT } from "@/hooks/i18n/useT";
import { RAJADA } from "@/lib/campanhas/rajada";

export type Velocidade = "gradual" | "rapida" | "transmissao";

/** Uma variável do modelo escolhido, com a origem que a campanha deu a ela. */
export interface VariavelParaOBroadcast {
  rotulo: string;
  /** `fixed` = texto fixo; o resto muda de pessoa para pessoa; `null` = sem origem ainda. */
  kind: string | null;
  valor: string | null;
}

/** As variáveis do modelo escolhido, cada uma com a origem que a campanha deu a ela. */
export function variaveisParaOBroadcast(
  modelo: { variaveis: Array<{ chave: string; rotulo: string }> } | null | undefined,
  fontes: Record<string, unknown> | null | undefined,
): VariavelParaOBroadcast[] {
  return (modelo?.variaveis ?? []).map((v) => {
    const fonte = (fontes ?? {})[v.chave] as { kind?: unknown; value?: unknown } | undefined;
    return {
      rotulo: v.rotulo,
      kind: typeof fonte?.kind === "string" ? fonte.kind : null,
      valor: typeof fonte?.value === "string" ? fonte.value : null,
    };
  });
}

/** As variáveis que impedem o broadcast: as que mudam de pessoa para pessoa. */
export function variaveisQueImpedemOBroadcast(variaveis: VariavelParaOBroadcast[]): VariavelParaOBroadcast[] {
  return variaveis.filter((v) => v.kind !== null && v.kind !== "fixed");
}

/** Mensagens por segundo da rajada, para a frase da tela. */
export const POR_SEGUNDO_NA_RAPIDA = Math.round(1000 / RAJADA.intervaloEntreIniciosMs);

/**
 * Quanto tempo a lista leva, em minutos inteiros (no mínimo 1): na rápida, o
 * que cabe em cada rodada de um minuto; na gradual, uma por minuto.
 */
export function minutosParaEnviar(pessoas: number, velocidade: Velocidade): number {
  if (pessoas <= 0) return 0;
  if (velocidade === "gradual") return pessoas;
  // O provedor recebe a lista numa chamada e manda em segundos (2 em 1 a 3 s,
  // medido em 16/10/2026); a primeira rodada do cron é o que mais pesa.
  if (velocidade === "transmissao") return 1;
  const porRodada = Math.floor(RAJADA.prazoMs / RAJADA.intervaloEntreIniciosMs);
  return Math.max(1, Math.ceil(pessoas / porRodada));
}

export function VelocidadeDaCampanha({
  valor,
  onChange,
  ehOficial,
  nome = "velocidade",
  desabilitado = false,
  transmissao,
}: {
  valor: Velocidade;
  onChange: (v: Velocidade) => void;
  ehOficial: boolean;
  nome?: string;
  desabilitado?: boolean;
  /** Presente quando o provedor do número faz broadcast, com as variáveis do modelo. */
  transmissao?: { variaveis: VariavelParaOBroadcast[] } | null;
}) {
  const t = useT();
  const impedem = transmissao ? variaveisQueImpedemOBroadcast(transmissao.variaveis) : [];
  const fixas = transmissao ? transmissao.variaveis.filter((v) => v.kind === "fixed") : [];
  if (!ehOficial) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="velocidade-so-gradual">
        {t("Número por QR envia uma mensagem por minuto: é a proteção contra banimento. O envio rápido é do número oficial.")}
      </p>
    );
  }
  const opcoes: Array<{ v: Velocidade; titulo: string; texto: string; travada?: boolean }> = [
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
    ...(transmissao
      ? [
          {
            v: "transmissao" as const,
            titulo: t("Broadcast"),
            texto: t(
              "A lista inteira vai para o provedor numa chamada e sai em segundos. Você acompanha também no painel de broadcasts dele, com o estado de cada pessoa. O texto é o mesmo para todos.",
            ),
            travada: impedem.length > 0,
          },
        ]
      : []),
  ];
  return (
    <fieldset className="space-y-2" data-testid="velocidade-da-campanha" disabled={desabilitado}>
      <legend className="text-sm font-medium">{t("Velocidade de envio")}</legend>
      <div className={`grid gap-2 ${opcoes.length > 2 ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
        {opcoes.map((o) => (
          <label
            key={o.v}
            className={`flex items-start gap-2 rounded-md border p-3 text-sm ${
              o.travada ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            } ${valor === o.v ? "border-primary bg-primary/5" : "border-border"}`}
          >
            <input
              type="radio"
              name={nome}
              value={o.v}
              checked={valor === o.v}
              disabled={o.travada}
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
      {transmissao && impedem.length > 0 && (
        <p className="text-sm text-warning-fg" data-testid="broadcast-travado">
          {t(
            "Broadcast indisponível com este modelo: ele usa dados de cada pessoa ({variaveis}), e o broadcast manda o mesmo texto a todos. Ponha texto fixo nessas variáveis ou use o envio rápido.",
          ).replace("{variaveis}", impedem.map((v) => v.rotulo).join(", "))}
        </p>
      )}
      {valor === "transmissao" && impedem.length === 0 && fixas.length > 0 && (
        <p className="text-sm text-muted-foreground" data-testid="broadcast-texto-fixo">
          {t("No broadcast, as variáveis saem iguais para todos:")}{" "}
          {fixas.map((v) => `${v.rotulo} = «${v.valor ?? ""}»`).join(" · ")}
        </p>
      )}
      {valor === "transmissao" && (
        <p className="text-sm text-muted-foreground">
          {t(
            "No broadcast vale a janela de horário; o máximo por dia e por hora não, porque a lista sai inteira. O limite diário quem põe é a plataforma, pelo nível do número.",
          )}
        </p>
      )}
    </fieldset>
  );
}
