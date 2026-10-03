/**
 * O bloco de CSS do tema de EXTENSÃO da organização.
 *
 * Duas diferenças em relação ao `EstiloDaMarcaDaOrganizacao`:
 *
 *  - A própria presença do bloco É a escolha: `null` (quem não escolheu tema)
 *    devolve `null` (nada muda, byte a byte). O que faz o escopo
 *    `body:has([data-tema-extensao])` casar é o marcador abaixo, e ele só
 *    existe dentro deste fragmento — sem tema escolhido, não há marcador e não
 *    há bloco.
 *
 *  - `dangerouslySetInnerHTML` é seguro porque o texto já passou pela allowlist
 *    de forma e pela rede de `<`/`;}` de `cssDaExtensaoDeTema`
 *    (`lib/extensions/tema.ts`), o mesmo contrato do bloco da marca.
 */
export function EstiloDoTemaDaExtensao({ css }: { css: string | null }) {
  if (!css) return null;
  return (
    <div data-tema-extensao="" className="contents">
      <style id="tema-extensao" dangerouslySetInnerHTML={{ __html: css }} />
    </div>
  );
}