"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useAdicionarTelefone } from "@/hooks/contacts/useAdicionarTelefone";
import { useEditarTelefone } from "@/hooks/contacts/useEditarTelefone";
import { useEditarTelefonePrincipal } from "@/hooks/contacts/useEditarTelefonePrincipal";
import { useRemoverTelefone } from "@/hooks/contacts/useRemoverTelefone";
import { useTornarTelefonePrincipal } from "@/hooks/contacts/useTornarTelefonePrincipal";
import { ApiError } from "@/lib/api/types";
import { phoneForDisplay } from "@/lib/channels/phone-variants";
import type {
  Contact,
  TelefoneExtra,
  TipoDeTelefone,
  WhatsappDoTelefone,
} from "@/lib/types/contacts";

/**
 * Um extra como a API o devolve no GET da ficha, com o `id` que as rotas de
 * editar, remover e tornar principal usam no caminho.
 */
export type TelefoneExtraDaFicha = TelefoneExtra & { id: string };

/**
 * Rótulos do tipo e do WhatsApp de um telefone (Spec 31, B1). Cada ramo traz o
 * `t("...")` LITERAL: o guardião de espanhol só enxerga texto escrito na tela, e
 * `t(variavel)` escapa dele.
 */
export function textoDoTipoDoTelefone(
  tipo: string | null | undefined,
  t: (texto: string) => string,
): string | null {
  if (tipo === "fixo") return t("Fixo");
  if (tipo === "celular") return t("Celular");
  if (tipo === "outro") return t("Outro");
  return null;
}

export function textoDoWhatsappDoTelefone(
  whatsapp: string | null | undefined,
  t: (texto: string) => string,
): string | null {
  if (whatsapp === "sim") return t("Tem WhatsApp");
  if (whatsapp === "nao") return t("Sem WhatsApp");
  if (whatsapp === "nao_sei") return t("WhatsApp: não sabemos");
  return null;
}

/**
 * A mensagem que a API manda, na tela. Os códigos que a tela conhece ganham frase
 * LITERAL (para o guardião de espanhol enxergar); o resto passa pelo `t()` como
 * a tela inteira já faz com o texto de `fail()`.
 */
function mensagemDeErro(err: unknown, t: (texto: string) => string): string {
  if (err instanceof ApiError) {
    if (err.code === "phone_in_use") return t("Este número já está em outra ficha.");
    if (err.code === "primary_phone_has_extras")
      return t("Torne outro número principal antes de remover este.");
    if (err.code === "invalid_phone") return t("Número inválido. Confira o DDD e tente de novo.");
    return t(err.message);
  }
  return t("Erro inesperado. Tente novamente.");
}

type Edicao = { modo: "adicionar" } | { modo: "principal" } | { modo: "extra"; id: string };

interface Rascunho {
  numero: string;
  tipo: TipoDeTelefone;
  whatsapp: WhatsappDoTelefone;
  rotulo: string;
}

const RASCUNHO_VAZIO: Rascunho = { numero: "", tipo: "celular", whatsapp: "nao_sei", rotulo: "" };

function SeletorDeTipo({
  id,
  valor,
  onChange,
}: {
  id: string;
  valor: TipoDeTelefone;
  onChange: (v: TipoDeTelefone) => void;
}) {
  const t = useT();
  return (
    <Select value={valor} onValueChange={(v) => onChange(v as TipoDeTelefone)}>
      <SelectTrigger id={id} aria-label={t("Tipo")} className="w-full sm:w-36">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="celular">{t("Celular")}</SelectItem>
        <SelectItem value="fixo">{t("Fixo")}</SelectItem>
        <SelectItem value="outro">{t("Outro")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function SeletorDeWhatsapp({
  id,
  valor,
  onChange,
}: {
  id: string;
  valor: WhatsappDoTelefone;
  onChange: (v: WhatsappDoTelefone) => void;
}) {
  const t = useT();
  return (
    <Select value={valor} onValueChange={(v) => onChange(v as WhatsappDoTelefone)}>
      <SelectTrigger id={id} aria-label={t("WhatsApp")} className="w-full sm:w-52">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="sim">{t("Tem WhatsApp")}</SelectItem>
        <SelectItem value="nao">{t("Sem WhatsApp")}</SelectItem>
        <SelectItem value="nao_sei">{t("WhatsApp: não sabemos")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * O bloco de telefones da ficha (Spec 31, B2, tela). Sem extra mostra a linha
 * "Telefone" de sempre, com o tipo ao lado do número; com extra, "Telefones" com
 * o principal e cada extra. Quem tem papel `agent` ou acima edita: adiciona,
 * muda tipo/WhatsApp/rótulo, remove e torna principal. Quem só lê vê a lista.
 */
export function TelefonesDaFicha({
  contato,
  podeEditar,
}: {
  contato: Contact;
  podeEditar: boolean;
}) {
  const t = useT();
  const contactId = contato.id;
  const extras = (contato.additional_phones ?? []) as TelefoneExtraDaFicha[];
  const temExtra = extras.length > 0;

  const adicionar = useAdicionarTelefone(contactId);
  const editarExtra = useEditarTelefone(contactId);
  const editarPrincipal = useEditarTelefonePrincipal(contactId);
  const removerExtra = useRemoverTelefone(contactId);
  const tornarPrincipal = useTornarTelefonePrincipal(contactId);

  const [edicao, setEdicao] = useState<Edicao | null>(null);
  const [rascunho, setRascunho] = useState<Rascunho>(RASCUNHO_VAZIO);
  const [erro, setErro] = useState<string | null>(null);

  const ocupado =
    adicionar.isPending ||
    editarExtra.isPending ||
    editarPrincipal.isPending ||
    removerExtra.isPending ||
    tornarPrincipal.isPending;

  function fecharEdicao() {
    setEdicao(null);
    setRascunho(RASCUNHO_VAZIO);
    setErro(null);
  }

  function abrirAdicionar() {
    setErro(null);
    setRascunho(RASCUNHO_VAZIO);
    setEdicao({ modo: "adicionar" });
  }

  function abrirEdicaoDoPrincipal() {
    setErro(null);
    setRascunho({
      numero: "",
      tipo: (contato.phone_type ?? "celular") as TipoDeTelefone,
      whatsapp: (contato.phone_whatsapp ?? "nao_sei") as WhatsappDoTelefone,
      rotulo: "",
    });
    setEdicao({ modo: "principal" });
  }

  function abrirEdicaoDoExtra(extra: TelefoneExtraDaFicha) {
    setErro(null);
    setRascunho({
      numero: "",
      tipo: extra.type,
      whatsapp: extra.whatsapp,
      rotulo: extra.label ?? "",
    });
    setEdicao({ modo: "extra", id: extra.id });
  }

  async function salvar() {
    if (!edicao) return;
    setErro(null);
    try {
      if (edicao.modo === "adicionar") {
        if (!rascunho.numero.trim()) {
          setErro(t("Digite o número do telefone."));
          return;
        }
        await adicionar.mutateAsync({
          phone_number: rascunho.numero.trim(),
          type: rascunho.tipo,
          whatsapp: rascunho.whatsapp,
          label: rascunho.rotulo.trim() || undefined,
        });
      } else if (edicao.modo === "extra") {
        await editarExtra.mutateAsync({
          phoneId: edicao.id,
          type: rascunho.tipo,
          whatsapp: rascunho.whatsapp,
          label: rascunho.rotulo.trim() || null,
        });
      } else {
        await editarPrincipal.mutateAsync({
          phone_type: rascunho.tipo,
          phone_whatsapp: rascunho.whatsapp,
        });
      }
      fecharEdicao();
    } catch (err) {
      setErro(mensagemDeErro(err, t));
    }
  }

  async function remover(id: string) {
    setErro(null);
    try {
      await removerExtra.mutateAsync(id);
    } catch (err) {
      setErro(mensagemDeErro(err, t));
    }
  }

  async function tornarPrincipalDoExtra(id: string) {
    setErro(null);
    try {
      await tornarPrincipal.mutateAsync(id);
    } catch (err) {
      setErro(mensagemDeErro(err, t));
    }
  }

  function formulario(modo: Edicao["modo"]) {
    const comRotulo = modo !== "principal";
    return (
      <div className="mt-2 flex w-full flex-col gap-3 rounded-md border border-border p-3">
        {modo === "adicionar" && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="telefone-novo-numero">{t("Número")}</Label>
            <Input
              id="telefone-novo-numero"
              type="tel"
              autoComplete="tel"
              value={rascunho.numero}
              onChange={(e) => setRascunho({ ...rascunho, numero: e.target.value })}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="telefone-tipo">{t("Tipo")}</Label>
            <SeletorDeTipo
              id="telefone-tipo"
              valor={rascunho.tipo}
              onChange={(tipo) => setRascunho({ ...rascunho, tipo })}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="telefone-whatsapp">{t("WhatsApp")}</Label>
            <SeletorDeWhatsapp
              id="telefone-whatsapp"
              valor={rascunho.whatsapp}
              onChange={(whatsapp) => setRascunho({ ...rascunho, whatsapp })}
            />
          </div>
        </div>
        {comRotulo && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="telefone-rotulo">{t("Rótulo (opcional)")}</Label>
            <Input
              id="telefone-rotulo"
              maxLength={60}
              value={rascunho.rotulo}
              onChange={(e) => setRascunho({ ...rascunho, rotulo: e.target.value })}
            />
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" onClick={salvar} disabled={ocupado}>
            {t("Salvar")}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={fecharEdicao} disabled={ocupado}>
            {t("Cancelar")}
          </Button>
        </div>
      </div>
    );
  }

  const tituloDoBloco = temExtra ? t("Telefones") : t("Telefone");

  return (
    <div className="md:col-span-2">
      <dt className="text-xs uppercase text-muted-foreground">{tituloDoBloco}</dt>
      <dd className="mt-1">
        <ul className="flex flex-col gap-2">
          {contato.phone_number && (
            <li className="flex flex-wrap items-center gap-2">
              <span>{phoneForDisplay(contato.phone_number)}</span>
              {temExtra && <Badge variant="secondary">{t("Principal")}</Badge>}
              {textoDoTipoDoTelefone(contato.phone_type, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoTipoDoTelefone(contato.phone_type, t)}
                </span>
              )}
              {textoDoWhatsappDoTelefone(contato.phone_whatsapp, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoWhatsappDoTelefone(contato.phone_whatsapp, t)}
                </span>
              )}
              {podeEditar && edicao?.modo !== "principal" && (
                <Button type="button" size="sm" variant="ghost" onClick={abrirEdicaoDoPrincipal} disabled={ocupado}>
                  {t("Editar")}
                </Button>
              )}
              {podeEditar && temExtra && (
                <>
                  <Button type="button" size="sm" variant="outline" disabled>
                    {t("Remover")}
                  </Button>
                  <p className="w-full text-xs text-muted-foreground">
                    {t("Torne outro número principal antes de remover este.")}
                  </p>
                </>
              )}
              {edicao?.modo === "principal" && formulario("principal")}
            </li>
          )}
          {extras.map((extra) => (
            <li key={extra.id} className="flex flex-wrap items-center gap-2">
              <span>{phoneForDisplay(extra.phone_number)}</span>
              {textoDoTipoDoTelefone(extra.type, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoTipoDoTelefone(extra.type, t)}
                </span>
              )}
              {textoDoWhatsappDoTelefone(extra.whatsapp, t) && (
                <span className="text-xs text-muted-foreground">
                  {textoDoWhatsappDoTelefone(extra.whatsapp, t)}
                </span>
              )}
              {extra.label && <span className="text-xs text-muted-foreground">{extra.label}</span>}
              {extra.origin === "fusao" && (
                <span className="text-xs text-muted-foreground">{t("Veio da junção de fichas")}</span>
              )}
              {podeEditar && edicao?.modo !== "extra" && (
                <>
                  <Button type="button" size="sm" variant="ghost" onClick={() => abrirEdicaoDoExtra(extra)} disabled={ocupado}>
                    {t("Editar")}
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={() => tornarPrincipalDoExtra(extra.id)} disabled={ocupado}>
                    {t("Tornar principal")}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" onClick={() => remover(extra.id)} disabled={ocupado}>
                    {t("Remover")}
                  </Button>
                </>
              )}
              {edicao?.modo === "extra" && edicao.id === extra.id && formulario("extra")}
            </li>
          ))}
        </ul>
        {!contato.phone_number && !temExtra && <span>—</span>}

        {podeEditar && edicao?.modo !== "adicionar" && (
          <Button type="button" size="sm" variant="outline" className="mt-2" onClick={abrirAdicionar} disabled={ocupado}>
            {t("Adicionar telefone")}
          </Button>
        )}
        {edicao?.modo === "adicionar" && formulario("adicionar")}

        {erro && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {erro}
          </p>
        )}
      </dd>
    </div>
  );
}
