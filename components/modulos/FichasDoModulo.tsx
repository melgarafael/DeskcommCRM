"use client";

import { useEffect, useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { useIdioma } from "@/lib/i18n/IdiomaProvider";

/**
 * O que um módulo de dados guarda sobre ESTE contato, na ficha dele.
 *
 * O painel mostra o que o AUTOR declarou — o rótulo do objeto e o nome de cada campo —, nunca o slug
 * nem a coluna. Mostrar `valor_cents` seria mostrar o banco por dentro.
 *
 * E ele falha PARA DENTRO: módulo fora do ar, módulo removido ou leitura recusada viram uma frase
 * neste cartão, e o resto da ficha do contato segue inteiro. É o não-negociável 1 da doutrina de
 * extensões — nenhuma jornada do núcleo depende de extensão ativa — aplicado no lugar onde ele seria
 * furado primeiro: uma tela do núcleo que quebra porque um módulo de terceiro respondeu errado.
 */

type Tipo = "texto" | "texto_longo" | "inteiro" | "booleano" | "data" | "data_hora" | "dinheiro";
interface Campo {
  slug: string;
  tipo: Tipo;
}
interface Resposta {
  rotulo: Record<string, string>;
  campos: Campo[];
  fichas: Record<string, unknown>[];
}

/** Dinheiro é guardado em centavos + moeda (a régua do projeto); a tela mostra o valor. */
function valorDoCampo(ficha: Record<string, unknown>, campo: Campo, idioma: string): string {
  if (campo.tipo === "dinheiro") {
    const centavos = ficha[`${campo.slug}_cents`];
    if (typeof centavos !== "number") return "—";
    const moeda = String(ficha[`${campo.slug}_moeda`] ?? "BRL");
    return new Intl.NumberFormat(idioma, { style: "currency", currency: moeda }).format(centavos / 100);
  }
  const bruto = ficha[campo.slug];
  if (bruto === null || bruto === undefined || bruto === "") return "—";
  if (campo.tipo === "booleano") return bruto ? "Sim" : "Não";
  if (campo.tipo === "data" || campo.tipo === "data_hora") {
    const d = new Date(String(bruto));
    return Number.isNaN(d.getTime()) ? String(bruto) : d.toLocaleDateString(idioma);
  }
  return String(bruto);
}

function rotuloDoCampo(slug: string): string {
  const s = slug.replaceAll("_", " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function FichasDoModulo({
  modulo,
  objeto,
  contatoId,
}: {
  modulo: string;
  objeto: string;
  contatoId: string;
}) {
  const t = useT();
  const idioma = useIdioma();
  const [dados, setDados] = useState<Resposta | null>(null);
  const [falhou, setFalhou] = useState(false);

  useEffect(() => {
    let vivo = true;
    // A organização NÃO vai no pedido: ela é da sessão. Se a tela a mandasse, a rota teria de
    // escolher em quem confiar.
    const url = `/api/v1/modulos/${encodeURIComponent(modulo)}/${encodeURIComponent(objeto)}?contato=${encodeURIComponent(contatoId)}`;
    void (async () => {
      try {
        const r = await fetch(url);
        /**
         * ⚠️ 404 É SILÊNCIO, NÃO AVISO DE FALHA.
         *
         * A rota responde o MESMO 404 para "módulo não instalado" e para "esta empresa não tem
         * nenhuma ficha". Traduzir isso em "Não foi possível carregar o que este módulo guarda"
         * apontaria defeito onde não há nenhum: o painel estaria dizendo que falhou quando a
         * resposta correta é que não há nada para mostrar.
         *
         * Qualquer OUTRA falha (rede, 5xx) continua avisando — aí há algo quebrado de verdade, e
         * calar seria esconder defeito de quem opera.
         */
        if (r.status === 404) return;
        const corpo = (await r.json()) as { data?: Resposta };
        if (!vivo) return;
        if (!r.ok || !corpo.data) {
          setFalhou(true);
          return;
        }
        setDados(corpo.data);
      } catch {
        if (vivo) setFalhou(true);
      }
    })();
    return () => {
      vivo = false;
    };
  }, [modulo, objeto, contatoId]);

  if (falhou) {
    return (
      <Card>
        <CardContent className="py-4 text-sm text-muted-foreground">
          {t("Não foi possível carregar o que este módulo guarda. O resto da ficha segue normal.")}
        </CardContent>
      </Card>
    );
  }

  if (!dados) return null;

  /**
   * PAINEL SEM FICHA NÃO É DESENHADO.
   *
   * O módulo de dados é instalado para a INSTALAÇÃO inteira (ADR-0002 D3: "o corte é por
   * instalação"), e não por empresa. O painel, portanto, só aparece onde existe dado da própria
   * empresa — e não onde o módulo meramente existe.
   *
   * ⚠️ ANTES DE MUDAR ESTA GUARDA, leia os dois:
   *
   *   - o caso "sem nenhuma ficha, o painel NÃO é desenhado" em `FichasDoModulo.test.tsx`, que é
   *     o que de fato impede a volta do painel vazio;
   *   - o cabeçalho da migration `0611`, seção "Por que o corte é por INSTALAÇÃO".
   *
   * Ela precisa ser revista quando a ESCRITA pela tela entrar: hoje a rota é só leitura, então
   * painel vazio não oferece nada; com escrita, não haveria como criar a primeira ficha.
   */
  if (dados.fichas.length === 0) return null;

  const titulo = dados.rotulo[idioma] ?? dados.rotulo["pt-BR"] ?? modulo;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{titulo}</CardTitle>
      </CardHeader>
      <CardContent>
        {dados.fichas.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nada guardado aqui ainda.")}</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                {dados.campos.map((c) => (
                  <th key={c.slug} className="pb-1 pr-4 font-medium">
                    {/*
                      SEM `t()`: o nome do campo é do AUTOR do módulo, não do produto. Passá-lo pelo
                      dicionário procuraria uma chave que nunca existirá, e a frase montada em tempo
                      de execução também escaparia do gate de tradução — que foi o que me fez olhar.
                      Internacionalizar rótulo de terceiro pede `rotulo` por idioma no manifesto, o
                      que a onda 1 ainda não tem.
                    */}
                    {rotuloDoCampo(c.slug)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dados.fichas.map((f) => (
                <tr key={String(f.id)} className="border-t">
                  {dados.campos.map((c) => (
                    <td key={c.slug} className="py-1 pr-4">
                      {valorDoCampo(f, c, idioma)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
