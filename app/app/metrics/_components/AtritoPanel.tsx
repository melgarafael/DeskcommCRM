"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useState } from "react";

import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAtritoMetrics, useSalvarReguaAbandono } from "@/hooks/metrics/useAtritoMetrics";
import { formatarMedida, type Medida, type Par } from "@/lib/metrics/atrito";

/**
 * Índice de Atrito (spec 17) — a medida do PROPÓSITO.
 *
 * Desenho imposto pela doutrina §3.3: eficiência e dano ficam no MESMO cartão,
 * lado a lado. Não é preferência estética — separados (abas, seções, telas), a
 * métrica de eficiência vence sempre, porque é a que sobe e a que alguém pede
 * para ver. O tipo `Par` torna impossível renderizar uma eficiência sozinha.
 *
 * Fica ACIMA do funil e da performance por atendente de propósito (§3.6): é o
 * número que pertence ao sistema inteiro, e ao qual as métricas de área se
 * subordinam. Embaixo, viraria rodapé.
 */

function MedidaLinha({ m }: { m: Medida }) {
  // Os rótulos do Atrito nascem em `lib/metrics/atrito.ts`, que é lógica pura e
  // não conhece idioma. Traduzir no PONTO DE RENDERIZAÇÃO é o padrão adotado no
  // resto do produto: o texto fixo casa no dicionário, e o que traz número
  // interpolado degrada para português sem quebrar nada.
  const t = useT();
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <div className="min-w-0">
        <p className="text-sm md:truncate">{t(m.rotulo)}</p>
        {m.nota ? <p className="mt-0.5 text-xs text-muted-foreground">{t(m.nota)}</p> : null}
      </div>
      <span className="shrink-0 text-sm font-medium tabular-nums">{formatarMedida(m)}</span>
    </div>
  );
}

function ParCard({ par }: { par: Par }) {
  const t = useT();
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-normal text-muted-foreground">{t(par.titulo)}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 sm:flex-row">
        {/* Eficiência — o que o sistema é empurrado a maximizar. */}
        <div className="sm:w-48 sm:shrink-0">
          <p className="text-2xl font-semibold tabular-nums">{formatarMedida(par.eficiencia)}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t(par.eficiencia.rotulo)}</p>
          {par.eficiencia.nota ? (
            <p className="mt-1 text-xs text-muted-foreground">{t(par.eficiencia.nota)}</p>
          ) : null}
        </div>

        {/* O custo disso. Mesmo cartão, sempre. */}
        <div className="min-w-0 flex-1 border-t pt-3 sm:border-l sm:border-t-0 sm:pl-6 sm:pt-0">
          <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
            {t("O que isso custou")}
          </p>
          {par.danos.map((d) => (
            <MedidaLinha key={d.chave} m={d} />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * A régua do abandono, VISÍVEL e editável ao lado do número que ela governa
 * (invariante 6: ver + mudar + falha visível; e cap. 3.4 regra 4: a régua viaja
 * com o número). Só manager+ edita — redefinir o que conta como perda é decisão
 * de quem responde pelo resultado, não de quem opera.
 */
function ReguaAbandono({ horas, padrao, podeEditar }: { horas: number; padrao: number; podeEditar: boolean }) {
  const t = useT();
  const [valor, setValor] = useState(String(horas));
  const salvar = useSalvarReguaAbandono();
  const n = Number(valor);
  const valido = Number.isInteger(n) && n >= 1 && n <= 24 * 90;
  const sujo = String(horas) !== valor.trim();

  if (!podeEditar) {
    return (
      <p className="text-xs text-muted-foreground">
        {t("Uma conversa conta como perdida no silêncio após")} <strong>{horas}h</strong>{" "}
        {t("sem resposta")}
        {horas === padrao ? ` ${t("(padrão do sistema)")}` : ""}.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <span>{t("Contar como perdida no silêncio após")}</span>
      <Input
        className="h-7 w-20 text-xs"
        value={valor}
        inputMode="numeric"
        aria-label={t("Horas de silêncio até considerar a conversa perdida")}
        onChange={(e) => setValor(e.target.value)}
      />
      <span>{t("horas sem resposta.")}</span>
      {sujo ? (
        <Button
          size="sm"
          variant="outline"
          className="md:h-7"
          disabled={!valido || salvar.isPending}
          onClick={() => salvar.mutate(n)}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar")}
        </Button>
      ) : null}
      {sujo && !valido ? (
        <span className="text-destructive">{t("Use um número inteiro entre 1 e 2160.")}</span>
      ) : null}
      {/* Falha VISÍVEL: sem isto, um erro de escrita deixaria a tela mostrando o
          valor digitado como se tivesse sido salvo. */}
      {salvar.isError ? (
        <span className="text-destructive">{t("Não foi possível salvar. Tente de novo.")}</span>
      ) : null}
      {horas === padrao && !sujo ? <span>{t("(padrão do sistema)")}</span> : null}
    </div>
  );
}

export function AtritoPanel({ podeEditarRegua }: { podeEditarRegua: boolean }) {
  const t = useT();
  const { data, isLoading, isError } = useAtritoMetrics();

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Carregando o índice de atrito…")}</p>;
  }
  // Falha aberta na informação: dizer que não carregou é melhor que sumir com a
  // seção — seção ausente lê-se como "não há atrito" (doutrina cap. 4.5).
  if (isError || !data) {
    return <p className="text-sm text-destructive">{t("Erro ao carregar o índice de atrito.")}</p>;
  }

  const { escopo, pares, regua } = data.data;
  const temMedidaAusente = pares.some(
    (p) => p.eficiencia.valor === null || p.danos.some((d) => d.valor === null),
  );

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-base font-medium">{t("Atrito")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("O que o resultado custou para os dois lados.")}{" "}
          {escopo.demandas === 0 ? (
            <>{t("Nenhuma demanda encerrada no período — os números abaixo ainda não têm base.")}</>
          ) : (
            <>
              {t("Base:")} {escopo.demandas}{" "}
              {escopo.demandas === 1 ? t("demanda encerrada") : t("demandas encerradas")}{" "}
              {t("nos últimos 30 dias, e")} {escopo.demandas_abertas} {t("ainda abertas.")}
            </>
          )}
        </p>
        {/* A régua fica AQUI, no cabeçalho, e não no rodapé da seção: o rótulo
            do dano interpola as horas ("após 72h") e quem lê o número precisa
            enxergar de onde ele veio sem rolar a tela (cap. 3.4, regra 4). */}
        <div className="mt-2">
          <ReguaAbandono
            horas={regua.abandono_horas}
            padrao={regua.default}
            podeEditar={podeEditarRegua}
          />
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {pares.map((p) => (
          <ParCard key={p.chave} par={p} />
        ))}
      </div>

      {/* A legenda só existe se houver o que legendar. Explicar um símbolo que
          não está na tela é ruído, e ruído compete com o que importava. */}
      {temMedidaAusente ? (
        <p className="text-xs text-muted-foreground">
          {t('"—" significa que não houve dado suficiente para medir, e não que o valor seja zero.')}
        </p>
      ) : null}
    </section>
  );
}
