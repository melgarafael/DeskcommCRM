import type { Idioma } from "@/lib/i18n/idiomas";
import { tagDeIdioma } from "@/lib/i18n/datas";
import { traduzir } from "@/lib/i18n/dicionario";
import type { ResumoDoSync } from "@/lib/nuvemshop/sync/resumo";
import { SyncNowButton } from "./SyncNowButton";

function situacao(r: ResumoDoSync, idioma: Idioma): string {
  switch (r.situacao) {
    case "importando":
      return `${traduzir("Importando: mês", idioma)} ${r.mes} ${traduzir("de", idioma)} 12`;
    case "sincronizando":
      return traduzir("Sincronizando…", idioma);
    case "em_dia":
      return traduzir("Em dia", idioma);
    case "erro":
      return `${traduzir("Erro:", idioma)} ${traduzir(r.erro ?? "", idioma)}`;
    default:
      return traduzir("Aguardando a primeira sincronização", idioma);
  }
}

export function PedidosDaLoja({ resumo, idioma, isAdmin }: { resumo: ResumoDoSync; idioma: Idioma; isAdmin: boolean }) {
  return (
    <section aria-labelledby="pedidos-da-loja" className="space-y-2 border-t border-border pt-3">
      <div className="flex items-center justify-between gap-3">
        <h2 id="pedidos-da-loja" className="font-medium">{traduzir("Pedidos", idioma)}</h2>
        {isAdmin ? <SyncNowButton /> : null}
      </div>
      <p data-testid="nuvemshop-pedidos-total">
        {traduzir("Pedidos sincronizados:", idioma)} {resumo.totalPedidos}
      </p>
      <p className="text-muted-foreground">
        {traduzir("Última sincronização:", idioma)}{" "}
        {resumo.ultimaSync ? new Date(resumo.ultimaSync).toLocaleString(tagDeIdioma(idioma)) : "—"}
      </p>
      <p data-testid="nuvemshop-pedidos-situacao">{situacao(resumo, idioma)}</p>
      {resumo.situacao === "em_dia" && resumo.pedidosComErro > 0 ? (
        <p className="text-muted-foreground">
          {resumo.pedidosComErro} {traduzir("pedidos não puderam ser importados na última sincronização.", idioma)}
        </p>
      ) : null}
    </section>
  );
}
