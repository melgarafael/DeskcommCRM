/**
 * Fixture VERDE da chave construída em runtime (#603) — os desenhos que
 * passam, e só eles:
 *
 *   1. `t("literal")` — texto escrito no código, é para isso que existe `t()`;
 *   2. `t(ROTULO_FIXO)` — É uma variável, e é justamente o caso que tem de
 *      passar: `const` de topo com literal, o passo 1 resolve e cobra o
 *      espanhol dela. Sem este caso a regra reprovaria toda variável e viraria
 *      imposto;
 *   3. `t(ROTULOS[estado])` — conjunto fechado por índice, passo 1;
 *   4. `tDireto`, o wrapper passa-adireto do cego C: o parâmetro é dele, e
 *      quem chama é coberto no ponto de chamada.
 *
 * Zero sítios sem cobertura. Provar o verde sem o vermelho ao lado seria
 * provar vacuidade — o vermelho está em `../chave-de-runtime-vermelha`.
 */
const t = (texto: string) => texto;

const ROTULO_FIXO = "Fila do dia";
const ROTULOS = { aberta: "Aberta" } as const;

export const tDireto = (texto: string) => t(texto);

export function PainelDoDia({ estado }: { estado: keyof typeof ROTULOS }) {
  return (
    <div>
      <p>{t("Fila atualizada")}</p>
      <p>{t(ROTULO_FIXO)}</p>
      <p>{t(ROTULOS[estado])}</p>
      <p>{tDireto("sem chave nenhuma")}</p>
    </div>
  );
}
