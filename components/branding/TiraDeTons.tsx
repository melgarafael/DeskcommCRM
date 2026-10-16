/**
 * A tira dos 11 tons — o controle PRINCIPAL da cor, e não um enfeite.
 *
 * ── Por que a tira, e não um seletor de cor ───────────────────────────────────
 *
 * O sistema não usa o hex do cliente cru: ele gera uma escada de 11 tons a
 * partir dele e escolhe, dentro dela, qual tom vira a cor dos botões — que pode
 * NÃO ser o tom que a pessoa colou (`escolherAccent`, em
 * `lib/branding/contraste.ts`, desliza a escada até o texto em cima dos botões
 * ficar legível). Sem ver a escada e as duas marcações, o operador cola um roxo,
 * vê um roxo mais escuro no botão e conclui que o produto errou a cor dele.
 *
 * Com a tira, a mesma informação vira uma frase óbvia sem precisar de frase: sua
 * cor está ali, o botão é aquele outro degrau, os dois são a mesma cor em
 * intensidades diferentes.
 *
 * ── Por que em `components/`, e não dentro da tela ────────────────────────────
 *
 * Nasceu em `app/admin/(protected)/marca/_tira.tsx`. A tela da marca por
 * ORGANIZAÇÃO precisa explicar exatamente a mesma coisa para o admin do tenant,
 * e duas tiras — uma por tela — divergiriam na primeira correção. O componente
 * não sabe de qual marca são os tons que recebe, e é por isso que serve às duas.
 *
 * ── Por que UMA TIRA POR ESCALA, e não uma tira só ────────────────────────────
 *
 * O degrau marcado só significa alguma coisa sobre a escala de onde ele veio. Com
 * o par de cores (#2482) o tema escuro deriva de uma SEGUNDA semente: o índice do
 * botão escuro aponta para a escala dela, não para a da cor principal. Desenhar
 * aquele degrau sobre a escala da primeira punha a marcação de uma cor por cima
 * da escada de outra — o número e o hex certos apontando para o lugar errado. Por
 * isso o item da legenda diz a que escala pertence (`escala`); sem escala
 * declarada, tudo cai na prop `tons` e o desenho é o de sempre: uma tira.
 *
 * ── Por que a marcação é desenhada com `melhorFrenteSobre` ────────────────────
 *
 * Uma borda de cor fixa some: branca desaparece nos tons claros da escada, preta
 * some nos escuros — e a escada tem as duas pontas por construção. A mesma
 * função que decide a cor do texto sobre o botão decide aqui a cor da marcação,
 * então ela é visível em qualquer marca. É o design system aplicado ao próprio
 * controle que o explica.
 */

import { melhorFrenteSobre } from "@/lib/branding/contraste";

/**
 * Um papel que a tira aponta. `indice` é o degrau da escada, ou `null` quando a
 * cor existe mas está FORA dela — o caso da marca neutra, em que a escada
 * mostrada é a do produto e a cor do cliente não tem degrau nenhum.
 */
export type ItemDaLegenda = {
  readonly rotulo: string;
  readonly hex: string;
  readonly indice: number | null;
  /** Observação curta, quando o papel precisa de uma ressalva. */
  readonly nota?: string;
  /**
   * A ESCALA a que `indice` pertence. Ausente = a escala da prop `tons`.
   *
   * Existe para o caso do par de cores (#2482): o tom do tema escuro sai da
   * segunda semente, e o índice dele não aponta para a escala da primeira.
   */
  readonly escala?: readonly string[];
};

interface Props {
  readonly tons: readonly string[];
  readonly legenda: readonly ItemDaLegenda[];
}

export function TiraDeTons({ tons, legenda }: Props) {
  // Uma tira por ESCALA distinta, na ordem em que a legenda as apresenta. Com uma
  // escala só — o caso comum, e o único quando não há segunda cor — sai uma tira.
  const escalas: (readonly string[])[] = [];
  for (const item of legenda) {
    const escala = item.escala ?? tons;
    if (!escalas.includes(escala)) escalas.push(escala);
  }
  if (escalas.length === 0) escalas.push(tons);

  return (
    <div className="space-y-3">
      {escalas.map((escala, e) => {
        const marcados = new Set(
          legenda
            .filter((item) => (item.escala ?? tons) === escala)
            .map((item) => item.indice)
            .filter((i): i is number => i !== null),
        );

        return (
          <div
            key={`escala-${e}`}
            role="img"
            aria-label={
              `Escala de ${escala.length} tons gerada a partir da sua cor, do mais claro ao mais ` +
              `escuro. Os tons em uso estão descritos na lista abaixo.`
            }
            className="flex overflow-hidden rounded-md border border-border"
          >
            {escala.map((hex, i) => (
              <div
                key={`${e}-${i}-${hex}`}
                title={hex}
                className="h-14 flex-1"
                style={{
                  backgroundColor: hex,
                  // `inset` em vez de `outline`: o contorno externo seria cortado
                  // pelo `overflow-hidden` que arredonda as pontas da tira.
                  boxShadow: marcados.has(i) ? `inset 0 0 0 3px ${melhorFrenteSobre(hex)}` : undefined,
                }}
              />
            ))}
          </div>
        );
      })}

      <ul className="flex flex-wrap gap-x-6 gap-y-2">
        {legenda.map((item) => (
          <li key={item.rotulo} className="flex items-center gap-2 text-xs">
            <span
              aria-hidden
              className="h-4 w-4 shrink-0 rounded-sm border border-border"
              style={{ backgroundColor: item.hex }}
            />
            <span className="text-text">{item.rotulo}</span>
            <span className="font-mono text-text-muted">{item.hex}</span>
            {item.nota ? <span className="text-text-muted">— {item.nota}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
