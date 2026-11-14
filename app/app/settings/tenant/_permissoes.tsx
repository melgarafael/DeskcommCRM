"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useT } from "@/hooks/i18n/useT";
import { definirPerfisDoTextoRetido } from "@/app/actions/settings/definirPerfisDoTextoRetido";
import { PERFIS_AUTORIZAVEIS } from "@/lib/messaging/texto-retido";
import { ROTULO_DO_PAPEL, type Role } from "@/lib/auth/types";

/**
 * Configurações › Organização › Permissões — quem pode ver o texto que o
 * contato apagou (#4500).
 *
 * Duas coisas nesta tela são o desenho de segurança, não enfeite:
 *
 *   1. Ela abre com a lista VAZIA quando ninguém configurou. Nenhum perfil vem
 *      marcado — nem Administrador. É o que faz a feature nascer sem tirar
 *      acesso de ninguém, e o que obriga uma decisão explícita.
 *   2. A lista é da ORGANIZAÇÃO ATIVA: a action grava na linha da org resolvida
 *      pelo servidor, nunca num id que veio da tela. Duas empresas na mesma
 *      instalação configuram separado.
 *
 * O texto explicativo diz o que o clique faz (auditoria de cada acesso), porque
 * quem marca "Gerente" está autorizando leitura de conteúdo que o cliente
 * apagou — e isso precisa estar dito na tela, não só no código.
 */
export function PerfisDoTextoRetidoForm({ inicial }: { inicial: Role[] }) {
  const t = useT();
  const [perfis, setPerfis] = useState<Role[]>(inicial);
  const [isPending, startTransition] = useTransition();

  function alternar(papel: Role, marcado: boolean) {
    setPerfis((atual) => (marcado ? [...atual, papel] : atual.filter((p) => p !== papel)));
  }

  function salvar() {
    startTransition(async () => {
      const resultado = await definirPerfisDoTextoRetido(perfis);
      if (resultado.ok) {
        toast.success(t("Permissões salvas."));
        return;
      }
      toast.error(t("Não foi possível salvar as permissões."));
    });
  }

  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-sm font-medium">{t("Permissões")}</h2>
      <div className="space-y-1">
        <p className="text-sm">{t("Ver o texto de mensagens apagadas pelo contato")}</p>
        <p className="text-xs text-muted-foreground">
          {t(
            "Quando o contato apaga uma mensagem, o texto fica guardado e escondido. Marque os perfis que podem revelá-lo na conversa. Cada clique é registrado na auditoria, inclusive quando é negado. Sem nenhum perfil marcado, ninguém vê o texto.",
          )}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        {PERFIS_AUTORIZAVEIS.map((papel) => (
          <label key={papel} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={perfis.includes(papel)}
              onChange={(e) => alternar(papel, e.target.checked)}
              data-testid={`texto-retido-perfil-${papel}`}
            />
            <span>{t(ROTULO_DO_PAPEL[papel])}</span>
          </label>
        ))}
      </div>
      {perfis.length === 0 && (
        <p className="text-xs text-muted-foreground" data-testid="texto-retido-vazio">
          {t("Nenhum perfil autorizado.")}
        </p>
      )}
      <Button type="button" size="sm" disabled={isPending} onClick={salvar} data-testid="texto-retido-salvar">
        {t("Salvar permissões")}
      </Button>
    </Card>
  );
}
