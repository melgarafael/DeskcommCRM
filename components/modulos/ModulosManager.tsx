"use client";

import { useCallback, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { requestExtensionApi } from "@/components/extensions/api-client";
import { randomId } from "@/lib/random-id";

interface ModuloCatalogo {
  slug: string;
  nome: string;
  descricao: string;
}

interface ModuloInstalado {
  modulo: string;
  estado: "ativo" | "suspenso";
  instalado_em: string;
  reaplicado_em: string | null;
  motivo_suspensao: string | null;
}

interface ListagemDeModulos {
  disponiveis: readonly ModuloCatalogo[];
  instalados: readonly ModuloInstalado[];
}

/**
 * Instalar um módulo NA INSTÂNCIA (ADR-0002, D3). Sem catálogo remoto, sem versão para
 * escolher — é o botão mais simples que existe: o slug já vem fixo do catálogo declarado no
 * servidor, e o único estado possível depois de instalar é "ativo" ou, numa atualização
 * futura que falhe, "suspenso" (D6). Por isso este componente não repete a máquina de estados
 * de `ExtensionsManager` (catálogo remoto, versões, reverter) — nada disso existe para módulo.
 */
export function ModulosManager({ inicial }: { inicial: ListagemDeModulos }) {
  const [estado, setEstado] = useState(inicial);
  const [instalando, setInstalando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);

  const instalar = useCallback(async (slug: string) => {
    setInstalando(slug);
    setErro(null);
    const idempotencyKey = randomId();
    const resultado = await requestExtensionApi<{ operationId: string; appliedNow: boolean }>(
      "/api/v1/modulos/instalar",
      {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ modulo: slug }),
      },
    );
    if (!resultado.ok) {
      setErro(resultado.error.message);
      setInstalando(null);
      return;
    }
    const recarregado = await requestExtensionApi<ListagemDeModulos>("/api/v1/modulos");
    if (recarregado.ok) setEstado(recarregado.data);
    setInstalando(null);
  }, []);

  const instaladoPorSlug = new Map(estado.instalados.map((m) => [m.modulo, m]));

  return (
    <div className="space-y-4">
      {erro ? (
        <p role="alert" className="text-sm text-destructive" data-testid="modulos-erro">
          {erro}
        </p>
      ) : null}
      {estado.disponiveis.map((modulo) => {
        const instalado = instaladoPorSlug.get(modulo.slug);
        return (
          <Card key={modulo.slug} className="p-5" data-testid={`modulo-${modulo.slug}`}>
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">{modulo.nome}</h3>
                  {instalado ? (
                    <Badge variant={instalado.estado === "ativo" ? "success" : "destructive"}>
                      {instalado.estado === "ativo" ? "Instalado" : "Suspenso"}
                    </Badge>
                  ) : null}
                </div>
                <p className="mt-1 max-w-xl text-sm text-text-muted">{modulo.descricao}</p>
                {instalado?.motivo_suspensao ? (
                  <p className="mt-1 text-xs text-destructive">
                    Suspenso: {instalado.motivo_suspensao}
                  </p>
                ) : null}
              </div>
              {instalado ? null : (
                <Button
                  size="sm"
                  onClick={() => void instalar(modulo.slug)}
                  disabled={instalando === modulo.slug}
                  data-testid={`instalar-${modulo.slug}`}
                >
                  {instalando === modulo.slug ? "Instalando…" : "Instalar"}
                </Button>
              )}
            </div>
          </Card>
        );
      })}
    </div>
  );
}
