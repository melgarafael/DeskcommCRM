"use client";

import { useT } from "@/hooks/i18n/useT";
import { MapPin } from "@/lib/ui/icons";
import { textoDoEnderecoAproximado } from "@/lib/mapas/geocodificacao";
import { linkDoMapa, type Localizacao } from "@/lib/messaging/localizacao";

/**
 * Pino compartilhado pelo cliente. Toque abre o ponto no mapa (no celular, o
 * app de mapas) — é o que quem monta a entrega precisa, e o texto cru com as
 * coordenadas não é clicável.
 *
 * Com a chave de Mapas da organização, o pino chega com rua, cidade e região
 * aproximados: a equipe vê onde é sem abrir o mapa. Nome e endereço que o
 * próprio cliente escolheu no WhatsApp vêm antes — são exatos.
 */
export function LocationCard({ localizacao }: { localizacao: Localizacao }) {
  const t = useT();
  const aproximado = localizacao.aproximado ? textoDoEnderecoAproximado(localizacao.aproximado) : "";
  const detalhe =
    [localizacao.nome, localizacao.endereco].filter(Boolean).join(" — ") ||
    (aproximado ? `${aproximado} (${t("aprox.")})` : "");
  return (
    <a
      href={linkDoMapa(localizacao)}
      target="_blank"
      rel="noopener noreferrer"
      className="flex max-w-[260px] items-center gap-2 rounded-lg border border-current/20 bg-background/10 px-2 py-2 text-left transition-colors hover:bg-background/20"
    >
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-background/20">
        <MapPin size={24} weight="duotone" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium" title={detalhe || undefined} data-testid="pino-detalhe">
          {detalhe || t("Localização compartilhada")}
        </span>
        <span className="block truncate text-xs underline opacity-80">{t("Abrir no mapa")}</span>
      </span>
    </a>
  );
}
