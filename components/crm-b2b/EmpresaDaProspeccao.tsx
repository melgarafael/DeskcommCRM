"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { mensagemDeErro } from "@/components/crm-b2b/BuscarEEscolher";
import { useT } from "@/hooks/i18n/useT";

interface Estado {
  elegivel: boolean;
  empresa: { id: string; nome: string | null } | null;
}

/**
 * "Transformar em empresa" (issue #3198, fatia 3): o contato que a prospecção
 * criou ganha a Empresa do módulo "Empresas e pessoas", com os dados que o Maps
 * entregou. Só existe com o módulo ligado: a ficha decide no servidor e,
 * desligado, este cartão não é montado — nenhum botão, nenhuma chamada.
 *
 * O cartão só aparece quando há o que dizer: o botão (contato da prospecção,
 * ainda sem empresa) ou a Empresa já ligada (`contacts.company_id`), venha o
 * contato de onde vier. Sem uma coisa nem outra, não há cartão.
 */
export function EmpresaDaProspeccao({
  contactId,
  podeCriar,
}: {
  contactId: string;
  /** O piso do POST é `agent`, o mesmo de criar empresa e pessoa pela tela. */
  podeCriar: boolean;
}) {
  const t = useT();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [enviando, setEnviando] = useState(false);

  const carregar = useCallback(async () => {
    const res = await fetch(`/api/v1/contacts/${contactId}/empresa-da-prospeccao`);
    const json = await res.json().catch(() => null);
    if (res.ok) setEstado(json.data as Estado);
  }, [contactId]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  async function transformar() {
    setErro(null);
    setEnviando(true);
    try {
      const res = await fetch(`/api/v1/contacts/${contactId}/empresa-da-prospeccao`, {
        method: "POST",
      });
      const falha = await mensagemDeErro(res, t("Não foi possível criar a empresa."));
      if (falha) setErro(falha);
      await carregar();
    } finally {
      setEnviando(false);
    }
  }

  if (!estado || (!estado.elegivel && !estado.empresa)) return null;

  return (
    <Card className="space-y-2 p-4">
      <h2 className="font-medium">{estado.empresa ? t("Empresa") : t("Empresa da prospecção")}</h2>
      {estado.empresa ? (
        <Link href={`/app/companies/${estado.empresa.id}`} className="text-sm font-medium hover:underline">
          {estado.empresa.nome || estado.empresa.id}
        </Link>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("Este contato veio da prospecção. Crie a empresa dele com o site, o endereço e o link do Maps.")}
          </p>
          {podeCriar ? (
            <Button size="sm" variant="outline" disabled={enviando} onClick={() => void transformar()}>
              {t("Transformar em empresa")}
            </Button>
          ) : null}
        </>
      )}
      {erro ? <p className="text-sm text-destructive">{erro}</p> : null}
    </Card>
  );
}
