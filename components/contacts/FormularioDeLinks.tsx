"use client";

/**
 * O formulário de links do contato dentro do funil (#5128).
 *
 * ── Por que ele saiu de `ContatoDoNegocio.tsx` ──────────────────────────────
 *
 * A lista de campos deixou de ser fixa: a organização escolhe quais tipos
 * aparecem (`settings.links_de_contato`). Para testar essa regra sem montar o
 * dossiê inteiro — negócio, contato, rodapé do vínculo — o formulário virou
 * componente próprio, com o mesmo comportamento de antes para quem não ajustou
 * nada.
 *
 * ── O SALVAR não pode apagar o que está escondido ───────────────────────────
 *
 * `aplicarLinks` regrava o catálogo INTEIRO a partir do formulário: um tipo que
 * a tela não mostra chegaria vazio e a chave `link_<tipo>` seria APAGADA no
 * `custom_fields` (o PATCH troca o objeto inteiro). Por isso aqui usamos
 * `aplicarLinksAlterados`, que toca só o link cujo texto mudou — um valor
 * escondido continua gravado, e volta a aparecer se a empresa marcar o tipo de
 * novo. É a mesma função que a aba Diagnóstico já usa.
 *
 * `tiposPermitidos` vem de fora (o hook lê a escolha da organização): assim o
 * componente também é testável sem rede.
 */
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useT } from "@/hooks/i18n/useT";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import {
  aplicarLinksAlterados,
  EXEMPLO_DE_LINK,
  lerLinks,
  normalizarLink,
  TIPOS_DE_LINK,
  tiposInvalidos,
  type LinksDoContato,
  type TipoDeLink,
} from "@/lib/leads/links-de-contato";
import type { Contact } from "@/lib/types/contacts";

interface Props {
  contato: Contact;
  pipelineId: string;
  /**
   * Os tipos que a organização escolheu mostrar, na ordem do catálogo. Ausente =
   * catálogo inteiro (o comportamento de quem nunca ajustou).
   */
  tiposPermitidos?: readonly TipoDeLink[];
}

/** Os tipos que ESTA tela edita, na ordem do catálogo. */
function tiposVisiveis(
  tiposPermitidos?: readonly TipoDeLink[],
): readonly (typeof TIPOS_DE_LINK)[number][] {
  if (!tiposPermitidos) return TIPOS_DE_LINK;
  return TIPOS_DE_LINK.filter(({ id }) => tiposPermitidos.includes(id));
}

export function FormularioDeLinks({ contato, pipelineId, tiposPermitidos }: Props) {
  const t = useT();
  const qc = useQueryClient();
  const atualizar = useUpdateContact(contato.id);
  const visiveis = tiposVisiveis(tiposPermitidos);
  // `inicial` é a fotografia COMPLETA do que veio do servidor (inclusive os
  // tipos escondidos): é a régua para saber o que esta pessoa REALMENTE mudou.
  const [inicial] = useState<LinksDoContato>(() => lerLinks(contato.custom_fields));
  // `valores` só carrega os tipos da TELA. Se ele carregasse os escondidos, um
  // salvamento por `aplicarLinks` (que regrava o catálogo inteiro a partir daqui)
  // os apagaria — e é justamente isso que o teste da #5128 proíbe.
  const [valores, setValores] = useState<LinksDoContato>(() => {
    const lidos = lerLinks(contato.custom_fields);
    const daTela: LinksDoContato = {};
    for (const { id } of visiveis) {
      if (lidos[id] !== undefined) daTela[id] = lidos[id];
    }
    return daTela;
  });
  // O erro só aparece DEPOIS da primeira tentativa de salvar: "exemplo" ainda
  // sem ".com" não é um erro de quem está no meio da digitação.
  const [tentouSalvar, setTentouSalvar] = useState(false);
  // `valores` só tem a tela, então um tipo escondido nem entra nesta conta — ele
  // não pode travar um salvamento que a pessoa não tem como consertar.
  const invalidos = new Set(tiposInvalidos(valores));

  function definir(tipo: TipoDeLink, valor: string) {
    setValores((atual) => ({ ...atual, [tipo]: valor }));
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setTentouSalvar(true);
    if (invalidos.size > 0) {
      toast.error(t("Confira os links marcados: só endereços http(s) valem."));
      return;
    }
    try {
      // `aplicarLinksAlterados` devolve o `custom_fields` completo, tocando só o
      // que mudou. O `...inicial` devolve à régua os tipos que a tela não mostra:
      // eles voltam iguais e a chave `link_<tipo>` deles fica intacta.
      await atualizar.mutateAsync({
        custom_fields: aplicarLinksAlterados(contato.custom_fields, inicial, {
          ...inicial,
          ...valores,
        }),
      });
      // O card do funil lê estes links do quadro, não do contato: sem reler o
      // quadro, salvar aqui pareceria "não fez nada" no card.
      await qc.invalidateQueries({ queryKey: chaveDoQuadro(pipelineId) });
      toast.success(t("Links salvos."));
    } catch {
      // `useUpdateContact` já mostra o erro da API; aqui só não deixar a
      // rejeição escapar como erro não tratado.
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-3" data-testid="formulario-de-links">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {visiveis.map((tipo) => {
          const id = tipo.id;
          const href = normalizarLink(valores[id]);
          const erro = tentouSalvar && invalidos.has(id);
          return (
            <div key={id} className="space-y-1">
              <Label htmlFor={`link-${id}`} className="text-xs">
                {t(tipo.rotulo)}
              </Label>
              <div className="flex gap-1">
                <Input
                  id={`link-${id}`}
                  value={valores[id] ?? ""}
                  onChange={(e) => definir(id, e.target.value)}
                  maxLength={1000}
                  placeholder={EXEMPLO_DE_LINK}
                  aria-invalid={erro || undefined}
                  className={erro ? "border-destructive" : undefined}
                />
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label={`${t("Abrir")} ${t(tipo.rotulo)}`}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-border text-text-muted hover:text-text"
                  >
                    ↗
                  </a>
                )}
              </div>
              {erro && <p className="text-[11px] text-destructive">{t("Endereço inválido.")}</p>}
            </div>
          );
        })}
      </div>
      <Button type="submit" size="sm" disabled={atualizar.isPending}>
        {atualizar.isPending ? t("Salvando…") : t("Salvar links")}
      </Button>
    </form>
  );
}
