import { useT } from "@/hooks/i18n/useT";
import type { OrigemDoContato } from "@/lib/leads/origem-do-contato";

function NivelDaOrigem({ rotulo, valor }: { rotulo: string; valor: string | null }) {
  if (!valor) return null;
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{rotulo}</dt>
      <dd className="mt-1 break-words">{valor}</dd>
    </div>
  );
}

export function NiveisDaOrigem({ origem }: { origem: OrigemDoContato }) {
  const t = useT();
  return (
    <>
      <NivelDaOrigem rotulo={t("Campanha")} valor={origem.campanha} />
      <NivelDaOrigem
        rotulo={origem.googleAds ? t("Grupo de anúncios") : t("Conjunto")}
        valor={origem.conjunto}
      />
      <NivelDaOrigem rotulo={t("Anúncio")} valor={origem.anuncio} />
      <NivelDaOrigem rotulo={t("Palavra-chave")} valor={origem.palavraChave} />
      <NivelDaOrigem rotulo={t("Conta do Google Ads")} valor={origem.contaGoogle} />
      <NivelDaOrigem rotulo={t("Posicionamento")} valor={origem.posicionamento} />
      {origem.semPosicionamentoDeAnuncio && (
        <div>
          <dt className="text-xs uppercase text-muted-foreground">
            {t("Posicionamento")}
          </dt>
          <dd className="mt-1 text-sm text-muted-foreground">
            {t("A plataforma não informa o posicionamento de cada clique em anúncio.")}
          </dd>
        </div>
      )}
    </>
  );
}
