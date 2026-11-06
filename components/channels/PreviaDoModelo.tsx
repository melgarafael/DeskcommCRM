"use client";
/**
 * A prévia de um modelo aprovado — cabeçalho, corpo, rodapé, botões e carrossel.
 *
 * Nasceu dentro do aviso de janela fechada do inbox (`JanelaFechadaAviso`) e
 * saiu daqui quando a campanha com modelo (#1330, fatia 4) precisou da MESMA
 * prévia: duas cópias do desenho divergiriam na primeira mudança, e o operador
 * aprende a ler a prévia uma vez só.
 *
 * Os textos vêm de `renderTemplatePreview`, o MESMO núcleo de
 * `renderTemplateBody` — a função que monta o texto do envio. Prévia e mensagem
 * enviada não têm como divergir: não há duas rotinas de substituição.
 *
 * `tom`: `aviso` é o âmbar do inbox, dentro de um aviso; `neutro` é a bolha
 * que a campanha mostra ao lado do formulário, fora de qualquer alerta.
 */
import { useT } from "@/hooks/i18n/useT";
import type { BlocoDaPrevia, PreviaDaMensagem } from "@/lib/channels/meta/render-template";

type Tom = "aviso" | "neutro";

const CORES: Record<
  Tom,
  { moldura: string; rotulo: string; texto: string; borda: string; tracejado: string }
> = {
  aviso: {
    moldura: "border-amber-300/70 bg-background/60 dark:border-amber-800/70 dark:bg-black/25",
    rotulo: "text-amber-900/70 dark:text-amber-200/70",
    texto: "text-amber-900 dark:text-amber-200",
    borda: "border-amber-300/60 dark:border-amber-800/60",
    tracejado: "border-amber-300/70 dark:border-amber-800/70",
  },
  neutro: {
    moldura: "border-border bg-muted/40",
    rotulo: "text-muted-foreground",
    texto: "text-foreground",
    borda: "border-border",
    tracejado: "border-border",
  },
};

/**
 * Um trecho do texto da prévia — com cada `{{n}}` SEM valor destacado.
 *
 * O placeholder não some quando o campo está vazio: ele é a metade visual do
 * contrato "campo vazio continua aparecendo como `{{n}}` destacado" (#2446).
 * Sumir com ele deixaria a prévia parecer pronta enquanto o envio seria recusado
 * por `missingSlots` — a mesma mentira que este painel já pagou em 21/09/2026.
 *
 * O chip é o MESMO desenho que a tela Conexões → Templates usa para marcar os
 * `{{n}}` do texto aprovado: o operador aprende a marca uma vez e a reconhece
 * nas duas telas.
 */
function Trecho({ texto }: { texto: string }) {
  const partes = texto.split(/(\{\{\w+\}\})/g);
  return (
    <>
      {partes.map((parte, i) =>
        /^\{\{\w+\}\}$/.test(parte) ? (
          <span
            key={i}
            data-testid="parametro-em-falta"
            className="rounded-md bg-primary/10 px-1 py-0.5 font-mono text-[11px] font-medium text-primary ring-1 ring-primary/20"
          >
            {parte}
          </span>
        ) : (
          <span key={i}>{parte}</span>
        ),
      )}
    </>
  );
}

/** Mídia do cabeçalho, corpo e cabeçalho de UM bloco — o de cima ou o de um card. */
function Bloco({ bloco, prefixo, tom }: { bloco: BlocoDaPrevia; prefixo: string; tom: Tom }) {
  const t = useT();
  const cor = CORES[tom];
  return (
    <>
      {bloco.midia && (
        <div data-testid={`${prefixo}midia`} className="min-w-0">
          {bloco.midia.link ? (
            bloco.midia.formato === "image" ? (
              <img
                src={bloco.midia.link}
                alt={t("Prévia da mídia do cabeçalho")}
                className={`max-h-36 w-full rounded-md border object-cover ${cor.borda}`}
              />
            ) : bloco.midia.formato === "video" ? (
              <video
                src={bloco.midia.link}
                controls
                preload="metadata"
                className={`max-h-36 w-full rounded-md border ${cor.borda}`}
              />
            ) : (
              <a
                href={bloco.midia.link}
                target="_blank"
                rel="noreferrer"
                className="block truncate rounded-md border border-input bg-background px-2 py-1 text-xs underline"
              >
                {bloco.midia.link}
              </a>
            )
          ) : (
            // Sem link não há o que desenhar. Dizer isso é melhor que um
            // retângulo de imagem quebrada — e o campo acima é onde ele entra.
            <p className={`text-xs ${cor.rotulo}`}>
              {t("Cole o link da mídia para ver a prévia aqui.")}
            </p>
          )}
        </div>
      )}

      {bloco.cabecalho && (
        <p
          data-testid={`${prefixo}cabecalho`}
          className={`text-sm font-semibold wrap-anywhere ${cor.texto}`}
        >
          <Trecho texto={bloco.cabecalho} />
        </p>
      )}

      {bloco.corpo && (
        <p
          data-testid={`${prefixo}corpo`}
          className={`text-sm leading-relaxed wrap-anywhere whitespace-pre-wrap ${cor.texto}`}
        >
          <Trecho texto={bloco.corpo} />
        </p>
      )}
    </>
  );
}

/** Os botões do bloco, na ordem da definição — é o cliente quem escolhe um deles. */
function Botoes({ bloco, prefixo, tom }: { bloco: BlocoDaPrevia; prefixo: string; tom: Tom }) {
  if (bloco.botoes.length === 0) return null;
  return (
    <div
      data-testid={`${prefixo}botoes`}
      className={`flex flex-col gap-1 border-t pt-1.5 ${CORES[tom].borda}`}
    >
      {bloco.botoes.map((botao, i) => (
        <div
          key={`${botao.tipo}:${i}`}
          className="flex items-center justify-between gap-2 rounded-md border border-input bg-background px-2 py-1 text-xs"
        >
          <span className="font-medium">
            <Trecho texto={botao.texto} />
          </span>
          {botao.url && (
            <span className="min-w-0 truncate text-muted-foreground">
              <Trecho texto={botao.url} />
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

/**
 * A prévia da mensagem COMPLETA. Quem preenche a olha ENQUANTO preenche: é ela
 * que responde "como vai ficar para o cliente?", antes do envio.
 */
export function PreviaDoModelo({ previa, tom = "aviso" }: { previa: PreviaDaMensagem; tom?: Tom }) {
  const t = useT();
  const cor = CORES[tom];
  return (
    <div
      data-testid="previa-modelo"
      role="group"
      aria-label={t("Prévia da mensagem")}
      className={`mt-2 flex flex-col gap-1.5 rounded-md border p-2.5 ${cor.moldura}`}
    >
      <span className={`text-[10px] font-medium tracking-wide uppercase ${cor.rotulo}`}>
        {t("Prévia da mensagem")}
      </span>

      <Bloco bloco={previa} prefixo="previa-" tom={tom} />

      {previa.rodape && (
        <p data-testid="previa-rodape" className={`text-[11px] ${cor.rotulo}`}>
          {previa.rodape}
        </p>
      )}

      <Botoes bloco={previa} prefixo="previa-" tom={tom} />

      {previa.cards.map((card) => (
        <div
          key={card.indice}
          className={`flex flex-col gap-1.5 rounded-md border border-dashed p-1.5 ${cor.tracejado}`}
        >
          <span className={`text-[10px] font-medium tracking-wide uppercase ${cor.rotulo}`}>
            {t("Item do carrossel")} {card.indice + 1}
          </span>
          <Bloco bloco={card} prefixo={`previa-card-${card.indice}-`} tom={tom} />
          <Botoes bloco={card} prefixo={`previa-card-${card.indice}-`} tom={tom} />
        </div>
      ))}
    </div>
  );
}
