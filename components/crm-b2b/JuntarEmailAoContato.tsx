"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { mensagemDeErro } from "@/components/crm-b2b/BuscarEEscolher";
import { useT } from "@/hooks/i18n/useT";

export interface ContatoSemEmail {
  id: string;
  rotulo: string;
}

/**
 * O e-mail que está só na ficha da PESSOA não é um contato: não abre ficha e
 * não recebe mensagem. "Juntar ao contato" grava esse e-mail no contato do
 * telefone dela (PATCH contacts/:id, piso `agent`), e a pessoa fica com um
 * contato só, com os dois (issue #3198).
 *
 * - Um telefone sem e-mail: junta direto nele.
 * - Mais de um: pergunta em qual.
 * - Nenhum: oferece criar o contato com o e-mail (`onCriarContato`).
 */
export function JuntarEmailAoContato({
  email,
  candidatos,
  onFeito,
  onCriarContato,
  onErro,
}: {
  email: string;
  candidatos: ContatoSemEmail[];
  onFeito: () => void;
  onCriarContato: () => void;
  onErro: (mensagem: string | null) => void;
}) {
  const t = useT();
  const [escolhendo, setEscolhendo] = useState(false);
  const [salvando, setSalvando] = useState(false);

  async function juntar(contatoId: string) {
    setSalvando(true);
    onErro(null);
    const res = await fetch(`/api/v1/contacts/${contatoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const falha = await mensagemDeErro(res, t("Não foi possível salvar."));
    setSalvando(false);
    setEscolhendo(false);
    if (falha) {
      onErro(falha);
      return;
    }
    onFeito();
  }

  if (candidatos.length === 0) {
    return (
      <Button size="sm" variant="ghost" onClick={onCriarContato}>
        {t("Criar contato")}
      </Button>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        disabled={salvando}
        onClick={() =>
          candidatos.length === 1 ? void juntar(candidatos[0]!.id) : setEscolhendo(true)
        }
      >
        {salvando ? t("Salvando…") : t("Juntar ao contato")}
      </Button>
      <Dialog open={escolhendo} onOpenChange={setEscolhendo}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Juntar o e-mail a qual contato?")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">{email}</p>
          <ul className="space-y-1">
            {candidatos.map((c) => (
              <li key={c.id}>
                <Button
                  variant="outline"
                  className="w-full justify-start font-mono"
                  disabled={salvando}
                  onClick={() => void juntar(c.id)}
                >
                  {c.rotulo}
                </Button>
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEscolhendo(false)}>
              {t("Cancelar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
