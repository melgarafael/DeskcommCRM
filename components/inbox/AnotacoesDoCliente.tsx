"use client";

/**
 * ANOTAÇÕES DO CLIENTE — o bloco de notas da equipe, na lateral do Inbox.
 *
 * O texto livre que a equipe quer ter à mão durante a conversa: dados da
 * empresa do cliente, combinados, preferências de entrega. Sem tela nova e
 * sem tabela nova: é o MESMO campo "Observações da equipe" da aba Diagnóstico
 * da ficha (`diag_observacoes`, `lib/contacts/diagnostico-do-contato.ts`).
 * Escrever aqui aparece lá, e vice-versa — uma fonte só.
 *
 * Esse campo é o recado DA EQUIPE: a ferramenta do agente não o escreve
 * (`CAMPOS_DO_AGENTE`), então a IA nunca apaga a anotação de uma pessoa.
 *
 * Salvar RELÊ a ficha e troca só esta chave (`aplicarDiagnostico`): o PATCH do
 * contato substitui o `custom_fields` inteiro, e o que outra pessoa gravou
 * nesse meio-tempo nos outros campos não pode sumir.
 */
import { useState } from "react";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useContact } from "@/hooks/contacts/useContact";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import {
  aplicarDiagnostico,
  autoriaDoUsuario,
  lerDiagnostico,
  TETO_DO_DIAGNOSTICO,
  textosDoDiagnostico,
} from "@/lib/contacts/diagnostico-do-contato";
import type { Contact } from "@/lib/types/contacts";
import { PencilSimple as Pencil, Plus } from "@/lib/ui/icons";

interface Props {
  contactId: string;
  usuarioId: string;
  /** Atendente ou acima, fora do suporte só-leitura e com o contato não anonimizado. */
  podeEditar: boolean;
}

export function AnotacoesDoCliente({ contactId, usuarioId, podeEditar }: Props) {
  const t = useT();
  const { data, isLoading } = useContact(contactId);
  const atualizar = useUpdateContact(contactId);
  const [editando, setEditando] = useState(false);
  const [texto, setTexto] = useState("");
  const [salvando, setSalvando] = useState(false);

  const anotacao = lerDiagnostico(data?.data?.custom_fields).observacoes ?? "";

  function abrir() {
    setTexto(anotacao);
    setEditando(true);
  }

  async function salvar() {
    setSalvando(true);
    try {
      let relido: Contact;
      try {
        relido = (await apiClient.get<{ data: Contact }>(`/api/v1/contacts/${contactId}`)).data;
      } catch (err) {
        showApiError(err);
        return;
      }
      const atuais = textosDoDiagnostico(lerDiagnostico(relido.custom_fields));
      await atualizar.mutateAsync({
        custom_fields: aplicarDiagnostico(
          relido.custom_fields,
          atuais,
          { ...atuais, observacoes: texto },
          autoriaDoUsuario(usuarioId),
        ),
      });
      toast.success(t("Anotação salva."));
      setEditando(false);
    } catch {
      // `useUpdateContact` já mostrou o erro da API.
    } finally {
      setSalvando(false);
    }
  }

  return (
    <section data-testid="inbox-anotacoes" className="min-w-0">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-semibold text-text">{t("Anotações do cliente")}</h3>
        {podeEditar && !editando && anotacao && (
          <button
            type="button"
            onClick={abrir}
            title={t("Editar anotação")}
            aria-label={t("Editar anotação")}
            data-testid="editar-anotacao"
            className="rounded-md p-1 text-text-muted hover:bg-surface-elevated hover:text-text"
          >
            <Pencil className="size-3.5" />
          </button>
        )}
      </div>

      {isLoading ? (
        <Skeleton className="mt-2 h-14 w-full" />
      ) : editando ? (
        <div className="mt-2 space-y-2">
          <Textarea
            autoFocus
            rows={5}
            value={texto}
            maxLength={TETO_DO_DIAGNOSTICO.observacoes}
            onChange={(e) => setTexto(e.target.value)}
            placeholder={t("Ex.: empresa de enxoval em Recife, compra no atacado todo mês, entregar à tarde.")}
            aria-label={t("Anotações do cliente")}
            data-testid="texto-da-anotacao"
            className="text-xs"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-text-muted">
              {texto.length}/{TETO_DO_DIAGNOSTICO.observacoes}
            </span>
            <div className="flex gap-1">
              <Button size="sm" variant="outline" onClick={() => setEditando(false)} disabled={salvando}>
                {t("Cancelar")}
              </Button>
              <Button size="sm" onClick={() => void salvar()} disabled={salvando} data-testid="salvar-anotacao">
                {t("Salvar")}
              </Button>
            </div>
          </div>
        </div>
      ) : anotacao ? (
        <p
          className="mt-2 rounded-md border border-warning/40 bg-warning-bg p-2 text-xs whitespace-pre-wrap wrap-anywhere text-warning-fg"
          data-testid="anotacao-do-cliente"
        >
          {anotacao}
        </p>
      ) : podeEditar ? (
        <Button
          size="sm"
          variant="outline"
          className="mt-2 w-full text-xs"
          onClick={abrir}
          data-testid="adicionar-anotacao"
        >
          <Plus className="mr-1 size-3.5" />
          {t("Adicionar anotação")}
        </Button>
      ) : (
        <p className="mt-2 text-xs text-text-muted">{t("Nenhuma anotação sobre este cliente.")}</p>
      )}
    </section>
  );
}
