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
};

interface Props {
  readonly tons: readonly string[];
  readonly legenda: readonly ItemDaLegenda[];
}

export function TiraDeTons({ tons, legenda }: Props) {
  const marcados = new Set(
    legenda.map((item) => item.indice).filter((i): i is number => i !== null),
  );

  return (
    <div className="space-y-3">
      <div
        role="img"
        aria-label={
          `Escala de ${tons.length} tons gerada a partir da sua cor, do mais claro ao mais ` +
          `escuro. Os tons em uso estão descritos na lista abaixo.`
        }
        className="flex overflow-hidden rounded-lg border border-border"
      >
        {tons.map((hex, i) => (
          <div
            key={`${i}-${hex}`}
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
