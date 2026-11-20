import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";
import {
  ROTULO_DE_QUEM_DECIDE,
  ROTULO_DO_PADRAO,
  type EstadoDoRecurso,
  type RecursoOpcional,
} from "@/lib/recursos-opcionais/catalogo";

const VARIANTE: Record<EstadoDoRecurso, "success" | "neutral" | "info" | "warning"> = {
  ligado: "success",
  desligado: "neutral",
  varia: "info",
  nao_verificado: "info",
  nao_lido: "warning",
};

/**
 * Uma linha do mapa de recursos opcionais. Só LEITURA: o botão leva à tela onde
 * a chave mora, e é lá que se liga — nunca aqui (doc 80).
 */
export function LinhaDoRecurso({
  recurso,
  estado,
  rotuloDoEstado,
  ajustar,
  idioma,
}: {
  recurso: RecursoOpcional;
  estado: EstadoDoRecurso;
  /** Já traduzido — cada tela escolhe a voz (ex.: "Disponível nesta instalação"). */
  rotuloDoEstado: string;
  /** `null` = sem botão (não há tela, ou quem vê não pode abri-la). */
  ajustar: string | null;
  idioma: Idioma;
}) {
  return (
    <li
      className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-start sm:justify-between"
      data-recurso={recurso.id}
    >
      <div className="min-w-0 space-y-1">
        <p className="font-medium">{traduzir(recurso.nome, idioma)}</p>
        <p className="text-sm text-muted-foreground">{traduzir(recurso.oQueFaz, idioma)}</p>
        {recurso.comoLigar && (
          <p className="text-sm text-muted-foreground">{traduzir(recurso.comoLigar, idioma)}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {traduzir(ROTULO_DE_QUEM_DECIDE[recurso.quemDecide], idioma)} ·{" "}
          {traduzir(ROTULO_DO_PADRAO[recurso.padrao], idioma)}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Badge variant={VARIANTE[estado]}>{rotuloDoEstado}</Badge>
        {ajustar && (
          <Button asChild size="sm" variant="outline">
            <Link href={ajustar} aria-label={`${traduzir("Ajustar", idioma)}: ${traduzir(recurso.nome, idioma)}`}>
              {traduzir("Ajustar", idioma)}
            </Link>
          </Button>
        )}
      </div>
    </li>
  );
}
