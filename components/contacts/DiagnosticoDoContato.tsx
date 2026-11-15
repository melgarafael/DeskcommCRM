"use client";

import { useState, type FormEvent } from "react";
import { format } from "date-fns";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ListaDeLinks } from "@/components/contacts/ListaDeLinks";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import {
  autoriaDoUsuario,
  cnpjInvalido,
  diagnosticoVazio,
  escritoPelaIA,
  gravacaoDaAba,
  lerDiagnostico,
  TETO_DO_DIAGNOSTICO,
  textosDoDiagnostico,
  type CampoDeTexto,
  type TextosDoDiagnostico,
} from "@/lib/contacts/diagnostico-do-contato";
import {
  EXEMPLO_DE_LINK,
  lerLinks,
  linksParaExibir,
  tiposInvalidos,
  TIPOS_DE_LINK,
  TAMANHO_MAXIMO_DO_LINK,
  type LinksDoContato,
  type TipoDeLink,
} from "@/lib/leads/links-de-contato";
import type { Contact } from "@/lib/types/contacts";

interface Props {
  contato: Contact;
  /** `agent` ou acima, fora do suporte só-leitura e com o contato não anonimizado. */
  podeEditar: boolean;
  /** Quem está logado: vira `usuario:<id>` em `diag_por` quando o diagnóstico muda. */
  usuarioId: string;
}

/**
 * A aba Diagnóstico da ficha: os dados da EMPRESA que a prospecção usa.
 *
 * Nada aqui lê `custom_fields` pelo nome da chave: a leitura e a escrita são
 * do esquema central (`lib/contacts/diagnostico-do-contato.ts`) e dos links
 * (`lib/leads/links-de-contato.ts`). O PATCH SUBSTITUI o `custom_fields`
 * inteiro e não confere versão, então salvar RELÊ a ficha antes e manda o
 * objeto relido com só as chaves que a pessoa mudou (`gravacaoDaAba`): o que
 * outro caminho gravou enquanto ela escrevia, e os campos da organização que
 * esta aba não mostra, voltam como estão no servidor.
 *
 * A `key` no pai remonta o formulário quando a TELA relê o contato (depois de
 * salvar, por exemplo). Ela não protege contra gravação concorrente: quem
 * protege é a releitura no `salvar`.
 */
export function DiagnosticoDoContato({ contato, podeEditar, usuarioId }: Props) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const diagnostico = lerDiagnostico(contato.custom_fields);
  const links = linksParaExibir(contato.custom_fields);
  const daIA = escritoPelaIA(diagnostico);

  const cabecalho = (
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="text-lg font-semibold">{t("Diagnóstico da empresa")}</h2>
      {daIA && <Badge variant="secondary">{t("Escrito pela IA")}</Badge>}
      {diagnostico.em && (
        <span className="text-xs text-muted-foreground">
          {t("Atualizado em")}{" "}
          {format(new Date(diagnostico.em), "dd/MM/yyyy HH:mm", { locale: localeDaData })}
        </span>
      )}
    </div>
  );

  if (!podeEditar) {
    const vazio = diagnosticoVazio(diagnostico) && links.length === 0;
    return (
      <Card className="space-y-4 p-4" data-testid="diagnostico-do-contato">
        {cabecalho}
        {vazio ? (
          <p className="text-sm text-muted-foreground">{t("Nada preenchido ainda.")}</p>
        ) : (
          <dl className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
            <Linha rotulo={t("Segmento")} valor={diagnostico.segmento} />
            <Linha rotulo={t("CNPJ")} valor={textosDoDiagnostico(diagnostico).cnpj} />
            <Linha rotulo={t("Diagnóstico")} valor={diagnostico.resumo} largo />
            <Linha rotulo={t("Oferta sugerida")} valor={diagnostico.oferta} largo />
            <Linha rotulo={t("Observações da equipe")} valor={diagnostico.observacoes} largo />
            {links.length > 0 && (
              <div className="md:col-span-2">
                <dt className="text-xs uppercase text-muted-foreground">{t("Links")}</dt>
                <dd className="mt-1">
                  <ListaDeLinks links={links} />
                </dd>
              </div>
            )}
          </dl>
        )}
      </Card>
    );
  }

  return (
    <Card className="space-y-4 p-4" data-testid="diagnostico-do-contato">
      {cabecalho}
      {daIA && (
        <p className="text-sm text-muted-foreground">
          {t("Revise antes de usar. O selo da IA sai quando você salva uma mudança no diagnóstico ou na oferta.")}
        </p>
      )}
      <FormularioDoDiagnostico contato={contato} usuarioId={usuarioId} />
    </Card>
  );
}

function Linha({ rotulo, valor, largo }: { rotulo: string; valor?: string; largo?: boolean }) {
  if (!valor) return null;
  return (
    <div className={largo ? "md:col-span-2" : undefined}>
      <dt className="text-xs uppercase text-muted-foreground">{rotulo}</dt>
      <dd className="mt-1 whitespace-pre-wrap break-words">{valor}</dd>
    </div>
  );
}

function FormularioDoDiagnostico({ contato, usuarioId }: { contato: Contact; usuarioId: string }) {
  const t = useT();
  const atualizar = useUpdateContact(contato.id);
  const [inicial] = useState<TextosDoDiagnostico>(() =>
    textosDoDiagnostico(lerDiagnostico(contato.custom_fields)),
  );
  const [textos, setTextos] = useState<TextosDoDiagnostico>(inicial);
  const [linksIniciais] = useState<LinksDoContato>(() => lerLinks(contato.custom_fields));
  const [links, setLinks] = useState<LinksDoContato>(linksIniciais);
  // O erro só aparece DEPOIS da primeira tentativa de salvar, como no
  // formulário de links do funil: CNPJ pela metade não é erro de quem digita.
  const [tentouSalvar, setTentouSalvar] = useState(false);
  const [relendo, setRelendo] = useState(false);
  const ocupado = relendo || atualizar.isPending;
  const linksInvalidos = new Set<TipoDeLink>(tiposInvalidos(links));
  const cnpjRecusado = cnpjInvalido(textos.cnpj);

  function definir(campo: CampoDeTexto, valor: string) {
    setTextos((atual) => ({ ...atual, [campo]: valor }));
  }

  async function salvar(e: FormEvent) {
    e.preventDefault();
    setTentouSalvar(true);
    if (cnpjRecusado) {
      toast.error(t("O CNPJ digitado não é válido. Confira e salve de novo."));
      return;
    }
    if (linksInvalidos.size > 0) {
      toast.error(t("Confira os links marcados: só endereços http(s) valem."));
      return;
    }
    setRelendo(true);
    try {
      // A ficha RELIDA agora, não a cópia de quando a aba abriu: o PATCH troca
      // o objeto inteiro, e o que outra pessoa (ou a campanha) gravou nesse
      // meio-tempo não pode sumir. Só as chaves que esta pessoa mudou são tocadas.
      let relido: Contact;
      try {
        relido = (await apiClient.get<{ data: Contact }>(`/api/v1/contacts/${contato.id}`)).data;
      } catch (err) {
        showApiError(err);
        return;
      }
      await atualizar.mutateAsync({
        custom_fields: gravacaoDaAba(relido.custom_fields, {
          inicial,
          editado: textos,
          linksIniciais,
          linksEditados: links,
          autor: autoriaDoUsuario(usuarioId),
        }),
      });
      toast.success(t("Diagnóstico salvo."));
    } catch {
      // `useUpdateContact` já mostra o erro da API.
    } finally {
      setRelendo(false);
    }
  }

  return (
    <form onSubmit={salvar} className="space-y-4" data-testid="formulario-do-diagnostico">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="diag-segmento" className="text-xs">
            {t("Segmento")}
          </Label>
          <Input
            id="diag-segmento"
            value={textos.segmento}
            onChange={(e) => definir("segmento", e.target.value)}
            maxLength={TETO_DO_DIAGNOSTICO.segmento}
            placeholder={t("Ex.: clínica odontológica")}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="diag-cnpj" className="text-xs">
            {t("CNPJ")}
          </Label>
          <Input
            id="diag-cnpj"
            value={textos.cnpj}
            onChange={(e) => definir("cnpj", e.target.value)}
            maxLength={TETO_DO_DIAGNOSTICO.cnpj}
            inputMode="text"
            autoComplete="off"
            aria-invalid={(tentouSalvar && cnpjRecusado) || undefined}
          />
          {tentouSalvar && cnpjRecusado && (
            <p className="text-[11px] text-destructive">{t("CNPJ inválido.")}</p>
          )}
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor="diag-resumo" className="text-xs">
          {t("Diagnóstico")}
        </Label>
        <Textarea
          id="diag-resumo"
          value={textos.resumo}
          onChange={(e) => definir("resumo", e.target.value)}
          maxLength={TETO_DO_DIAGNOSTICO.resumo}
          placeholder={t("O que a empresa faz, o que falta e onde podemos ajudar")}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="diag-oferta" className="text-xs">
          {t("Oferta sugerida")}
        </Label>
        <Textarea
          id="diag-oferta"
          value={textos.oferta}
          onChange={(e) => definir("oferta", e.target.value)}
          maxLength={TETO_DO_DIAGNOSTICO.oferta}
          placeholder={t("O que oferecer e por quê")}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="diag-observacoes" className="text-xs">
          {t("Observações da equipe")}
        </Label>
        <Textarea
          id="diag-observacoes"
          value={textos.observacoes}
          onChange={(e) => definir("observacoes", e.target.value)}
          maxLength={TETO_DO_DIAGNOSTICO.observacoes}
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-xs uppercase text-muted-foreground">{t("Links")}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {TIPOS_DE_LINK.map((tipo) => {
            const erro = tentouSalvar && linksInvalidos.has(tipo.id);
            return (
              <div key={tipo.id} className="space-y-1">
                <Label htmlFor={`diag-link-${tipo.id}`} className="text-xs">
                  {t(tipo.rotulo)}
                </Label>
                <Input
                  id={`diag-link-${tipo.id}`}
                  value={links[tipo.id] ?? ""}
                  onChange={(e) => setLinks((atual) => ({ ...atual, [tipo.id]: e.target.value }))}
                  maxLength={TAMANHO_MAXIMO_DO_LINK}
                  placeholder={EXEMPLO_DE_LINK}
                  aria-invalid={erro || undefined}
                />
                {erro && <p className="text-[11px] text-destructive">{t("Endereço inválido.")}</p>}
              </div>
            );
          })}
        </div>
      </fieldset>
      <Button type="submit" size="sm" disabled={ocupado}>
        {ocupado ? t("Salvando…") : t("Salvar diagnóstico")}
      </Button>
    </form>
  );
}
