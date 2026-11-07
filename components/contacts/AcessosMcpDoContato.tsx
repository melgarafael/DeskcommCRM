"use client";
/**
 * Os acessos que o contato deu a servidores MCP externos (OAuth por contato,
 * migration 9095): servidor, escopos, desde quando e último uso, com
 * "Revogar". O token nunca aparece. Só `admin` da organização — para os demais
 * a action recusa e o cartão não aparece.
 */
import { format } from "date-fns";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { listarAcessosMcpDoContato, revogarAcessoMcpDoContato } from "@/app/actions/agents/acessosMcpDoContato";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import type { AcessoDoContato } from "@/lib/mcp/servidor-externo/do-agente/credencial";

export function AcessosMcpDoContato({ contactId }: { contactId: string }) {
  const t = useT();
  const [acessos, setAcessos] = useState<AcessoDoContato[] | null>(null);
  const [visivel, setVisivel] = useState(true);
  const [revogando, setRevogando] = useState<string | null>(null);

  const carregar = useCallback(async () => {
    const r = await listarAcessosMcpDoContato(contactId).catch(() => ({ ok: false as const }));
    if (!r.ok) {
      setVisivel(false);
      return;
    }
    setAcessos(r.data);
  }, [contactId]);

  useEffect(() => {
    // Carga inicial a partir de server action (sistema externo ao React).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void carregar();
  }, [carregar]);

  async function revogar(id: string) {
    setRevogando(id);
    try {
      const r = await revogarAcessoMcpDoContato(contactId, id);
      if (!r.ok) {
        toast.error(t("Não foi possível revogar o acesso."));
        return;
      }
      toast.success(
        r.data.revogadaNoTerceiro
          ? t("Acesso revogado no sistema externo e apagado daqui.")
          : t("Acesso apagado daqui. O sistema externo não confirmou a revogação."),
      );
      await carregar();
    } finally {
      setRevogando(null);
    }
  }

  if (!visivel) return null;
  return (
    <Card className="space-y-3 p-4" data-testid="acessos-mcp-do-contato">
      <div>
        <h2 className="text-lg font-semibold">{t("Acessos a sistemas externos")}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("Contas de outros sistemas que este cliente autorizou o agente a acessar pela conversa.")}
        </p>
      </div>
      {acessos === null ? <p className="text-sm text-muted-foreground">{t("Carregando…")}</p> : null}
      {acessos !== null && acessos.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="sem-acessos-mcp">
          {t("Nenhum acesso ativo.")}
        </p>
      ) : null}
      {acessos && acessos.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {acessos.map((a) => (
            <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 rounded-md border border-border p-3" data-testid={`acesso-mcp-${a.id}`}>
              <div className="space-y-0.5 text-sm">
                <p className="font-medium">{a.servidorNome}</p>
                <p className="text-xs text-muted-foreground">
                  {t("Desde")} {format(new Date(a.desde), "dd/MM/yyyy HH:mm")}
                  {a.ultimoUso ? ` · ${t("último uso")} ${format(new Date(a.ultimoUso), "dd/MM/yyyy HH:mm")}` : ""}
                  {a.revogarApos ? ` · ${t("revogação agendada")} ${format(new Date(a.revogarApos), "dd/MM/yyyy HH:mm")}` : ""}
                </p>
                {a.escopos.length > 0 ? (
                  <p className="text-xs text-muted-foreground">
                    {t("Escopos")}: <code>{a.escopos.join(" ")}</code>
                  </p>
                ) : null}
              </div>
              <Button size="sm" variant="destructive" disabled={revogando !== null} onClick={() => void revogar(a.id)} data-testid={`revogar-acesso-${a.id}`}>
                {revogando === a.id ? t("Revogando…") : t("Revogar")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </Card>
  );
}
