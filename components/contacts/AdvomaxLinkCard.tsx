"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useT } from "@/hooks/i18n/useT";
import { advomaxProcessUrl } from "@/lib/advomax/navigation";

type LinkRow = { id: string; pessoa_codigo: number; status: "pending" | "linked" | "conflict" | "unlinked" };
type PessoaRow = { codigo: number; nome: string; tipoPessoa: string; email: string | null; telefone: string | null };
type ProcessoRow = { codigo: number; pasta: string | null; numero: string | null; status: number; ultimaMovimentacao: string | null; tribunal: string | null };
type ProcessoLinkRow = { id: string; processo_codigo: number; created_at: string; advomax_url: string | null };
type DocumentoRow = { codigo: number; nomeArquivo: string; descricao: string | null; data: string; tipo: string; origem: "whatsapp" | "advomax"; armazenadoNoDrive: boolean };

export function AdvomaxLinkCard({ contactId, canManage = false }: { contactId: string; canManage?: boolean }) {
  const t = useT();
  const [link, setLink] = useState<LinkRow | null>(null);
  const [codigo, setCodigo] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busca, setBusca] = useState("");
  const [sugestoes, setSugestoes] = useState<PessoaRow[]>([]);
  const [processos, setProcessos] = useState<ProcessoRow[]>([]);
  const [processoLinks, setProcessoLinks] = useState<ProcessoLinkRow[]>([]);
  const [novoProcessoCodigo, setNovoProcessoCodigo] = useState("");
  const [salvandoProcesso, setSalvandoProcesso] = useState(false);
  const [documentos, setDocumentos] = useState<DocumentoRow[]>([]);
  const [linkIndisponivel, setLinkIndisponivel] = useState(false);
  const [processosIndisponiveis, setProcessosIndisponiveis] = useState(false);
  const [processoLinksIndisponiveis, setProcessoLinksIndisponiveis] = useState(false);
  const [documentosIndisponiveis, setDocumentosIndisponiveis] = useState(false);
  const [tentativa, setTentativa] = useState(0);

  useEffect(() => {
    let ativo = true;
    setLinkIndisponivel(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link`).then(async (r) => {
      if (!r.ok) throw new Error("link indisponível");
      return r.json();
    }).then((body) => {
      if (!ativo) return;
      const value = body?.data as LinkRow | null | undefined;
      setLink(value ?? null);
      if (value) setCodigo(String(value.pessoa_codigo));
    }).catch(() => { if (ativo) setLinkIndisponivel(true); });
    return () => { ativo = false; };
  }, [contactId, tentativa]);

  useEffect(() => {
    if (link?.status !== "linked") return;
    let ativo = true;
    setProcessosIndisponiveis(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link/processos`).then(async (r) => {
      if (!r.ok) throw new Error("processos indisponíveis");
      return r.json();
    }).then((body) => {
      if (ativo) setProcessos(Array.isArray(body?.data) ? body.data as ProcessoRow[] : []);
    }).catch(() => { if (ativo) setProcessosIndisponiveis(true); });
    return () => { ativo = false; };
  }, [contactId, link?.status, tentativa]);

  useEffect(() => {
    if (link?.status !== "linked") { setProcessoLinks([]); setProcessoLinksIndisponiveis(false); return; }
    let ativo = true;
    setProcessoLinksIndisponiveis(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link/processo-links`).then(async (r) => {
      if (!r.ok) throw new Error("vínculos indisponíveis");
      return r.json();
    }).then((body) => {
      if (ativo) setProcessoLinks(Array.isArray(body?.data) ? body.data as ProcessoLinkRow[] : []);
    }).catch(() => { if (ativo) setProcessoLinksIndisponiveis(true); });
    return () => { ativo = false; };
  }, [contactId, link?.status, tentativa]);

  useEffect(() => {
    if (link?.status !== "linked") return;
    let ativo = true;
    setDocumentosIndisponiveis(false);
    void fetch(`/api/v1/contacts/${contactId}/advomax-link/documentos`).then(async (r) => {
      if (!r.ok) throw new Error("documentos indisponíveis");
      return r.json();
    }).then((body) => {
      if (ativo) setDocumentos(Array.isArray(body?.data) ? body.data as DocumentoRow[] : []);
    }).catch(() => { if (ativo) setDocumentosIndisponiveis(true); });
    return () => { ativo = false; };
  }, [contactId, link?.status, tentativa]);

  useEffect(() => {
    if (!canManage || link?.status === "linked" || busca.trim().length < 2) return;
    let ativo = true;
    const timer = window.setTimeout(() => {
      void fetch(`/api/v1/advomax/pessoas?nome=${encodeURIComponent(busca.trim())}`).then((r) => r.ok ? r.json() : null).then((body) => {
        if (ativo) setSugestoes(Array.isArray(body?.data) ? body.data as PessoaRow[] : []);
      }).catch(() => undefined);
    }, 250);
    return () => { ativo = false; window.clearTimeout(timer); };
  }, [busca, canManage, link?.status]);

  async function vincular() {
    const pessoa = Number(codigo);
    if (!Number.isInteger(pessoa) || pessoa <= 0) { setErro(t("Informe o código da Pessoa no Advomax.")); return; }
    setSaving(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pessoa_codigo: pessoa }) });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível criar o vínculo."));
      setLink(body.data as LinkRow);
      setSugestoes([]);
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível criar o vínculo.")); }
    finally { setSaving(false); }
  }

  async function desvincular() {
    if (!canManage || !window.confirm(t("Desfazer o vínculo com o cadastro jurídico?"))) return;
    setSaving(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link`, { method: "DELETE" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível desfazer o vínculo."));
      setLink(body.data as LinkRow | null);
      setProcessos([]);
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível desfazer o vínculo.")); }
    finally { setSaving(false); }
  }

  async function vincularProcesso() {
    const processo = Number(novoProcessoCodigo);
    if (!Number.isSafeInteger(processo) || processo <= 0) { setErro(t("Informe um código de processo válido.")); return; }
    setSalvandoProcesso(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/processo-links`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ processo_codigo: processo }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível vincular o processo."));
      setProcessoLinks((atual) => [body.data as ProcessoLinkRow, ...atual]);
      setNovoProcessoCodigo("");
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível vincular o processo.")); }
    finally { setSalvandoProcesso(false); }
  }

  async function desvincularProcesso(processoCodigo: number) {
    if (!canManage || !window.confirm(t("Remover este processo dos vínculos do CRM?"))) return;
    setSalvandoProcesso(true); setErro(null);
    try {
      const response = await fetch(`/api/v1/contacts/${contactId}/advomax-link/processo-links/${processoCodigo}`, { method: "DELETE" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(body?.error?.message || t("Não foi possível remover o vínculo."));
      setProcessoLinks((atual) => atual.filter((item) => item.processo_codigo !== processoCodigo));
    } catch (e) { setErro(e instanceof Error ? e.message : t("Não foi possível remover o vínculo.")); }
    finally { setSalvandoProcesso(false); }
  }

  return <Card className="space-y-3 p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="font-semibold">{t("Cadastro jurídico")}</h2><p className="text-sm text-muted-foreground">{t("Vincule este contato a uma Pessoa do Advomax para compartilhar contexto e documentos.")}</p></div>
      {link && <Badge variant={link.status === "linked" ? "success" : "warning"}>{link.status === "linked" ? t("Vinculado") : t("Aguardando confirmação")}</Badge>}
    </div>
    <div className="flex flex-col gap-2 sm:flex-row">
      <Input value={busca} onChange={(e) => { setBusca(e.target.value); if (e.target.value.trim().length < 2) setSugestoes([]); }} placeholder={t("Buscar Pessoa ou cliente") } aria-label={t("Buscar Pessoa ou cliente") } disabled={!canManage || link?.status === "linked"} />
      <Input inputMode="numeric" value={codigo} onChange={(e) => setCodigo(e.target.value)} placeholder={t("Código da Pessoa") } aria-label={t("Código da Pessoa") } disabled={!canManage} />
      <Button onClick={vincular} disabled={!canManage || saving}>{saving ? t("Salvando…") : t("Vincular Pessoa")}</Button>
      {link?.status === "linked" && canManage && <Button variant="outline" onClick={desvincular} disabled={saving}>{t("Desvincular")}</Button>}
    </div>
    {sugestoes.length > 0 && <div className="space-y-1 rounded border p-2 text-sm">{sugestoes.map((pessoa) => <button type="button" key={pessoa.codigo} className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted" onClick={() => { setCodigo(String(pessoa.codigo)); setBusca(pessoa.nome); setSugestoes([]); }}>
      <strong>{pessoa.nome}</strong><span className="ml-2 text-muted-foreground">#{pessoa.codigo}{pessoa.tipoPessoa && ` · ${pessoa.tipoPessoa}`}</span>
    </button>)}</div>}
    {!canManage && <p className="text-xs text-muted-foreground">{t("Somente gerentes podem confirmar este vínculo.")}</p>}
    {erro && <p role="alert" className="text-sm text-error-fg">{erro}</p>}
    {linkIndisponivel && <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      <span>{t("Não foi possível carregar o vínculo com o Advomax.")}</span>
      <Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button>
    </div>}
    {link?.status === "linked" && <div className="border-t pt-3">
      <h3 className="text-sm font-semibold">{t("Processos da Pessoa")}</h3>
      {processosIndisponiveis && <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{t("Os processos estão temporariamente indisponíveis.")}</span><Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button></div>}
      {!processosIndisponiveis && processos.length === 0 && <p className="mt-1 text-sm text-muted-foreground">{t("Nenhum processo ativo encontrado para esta Pessoa.")}</p>}
      {!processosIndisponiveis && processos.length > 0 && <ul className="mt-2 space-y-1 text-sm">{processos.map((processo) => <li key={processo.codigo} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5">
        <span><strong>{processo.pasta || processo.numero || `#${processo.codigo}`}</strong>{processo.tribunal && <span className="ml-2 text-muted-foreground">{processo.tribunal}</span>}</span>
        <a className="text-primary underline-offset-2 hover:underline" href={advomaxProcessUrl(processo.codigo)} target="_blank" rel="noreferrer">{t("Abrir ficha")}</a>
      </li>)}</ul>}
      <div className="mt-4 border-t pt-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("Vínculos fixados no CRM")}</h3>
          <span className="text-xs text-muted-foreground">{t("A ficha jurídica continua no Advomax")}</span>
        </div>
        {canManage && <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <Input inputMode="numeric" value={novoProcessoCodigo} onChange={(e) => setNovoProcessoCodigo(e.target.value)} placeholder={t("Código do processo")} aria-label={t("Código do processo")} />
          <Button variant="outline" onClick={vincularProcesso} disabled={salvandoProcesso}>{salvandoProcesso ? t("Salvando…") : t("Adicionar vínculo")}</Button>
        </div>}
        {processoLinksIndisponiveis && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{t("Os vínculos fixados estão temporariamente indisponíveis.")}</span><Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button></div>}
        {!processoLinksIndisponiveis && processoLinks.length === 0 && <p className="mt-2 text-sm text-muted-foreground">{t("Nenhum processo fixado neste contato.")}</p>}
        {!processoLinksIndisponiveis && processoLinks.length > 0 && <ul className="mt-2 space-y-1 text-sm">{processoLinks.map((processo) => <li key={processo.id} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5">
          <strong>#{processo.processo_codigo}</strong>
          <span className="flex items-center gap-2"><a className="text-primary underline-offset-2 hover:underline" href={processo.advomax_url || advomaxProcessUrl(processo.processo_codigo)} target="_blank" rel="noreferrer">{t("Abrir ficha")}</a>{canManage && <Button variant="ghost" size="sm" onClick={() => void desvincularProcesso(processo.processo_codigo)} disabled={salvandoProcesso}>{t("Remover")}</Button>}</span>
        </li>)}</ul>}
      </div>
      <h3 className="mt-4 text-sm font-semibold">{t("Documentos da Pessoa")}</h3>
      {documentosIndisponiveis && <div role="alert" className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted-foreground"><span>{t("Os documentos estão temporariamente indisponíveis.")}</span><Button variant="outline" size="sm" onClick={() => setTentativa((value) => value + 1)}>{t("Tentar novamente")}</Button></div>}
      {!documentosIndisponiveis && documentos.length === 0 && <p className="mt-1 text-sm text-muted-foreground">{t("Nenhum documento encontrado no Advomax.")}</p>}
      {!documentosIndisponiveis && documentos.length > 0 && <ul className="mt-2 space-y-1 text-sm">{documentos.slice(0, 8).map((documento) => <li key={documento.codigo} className="flex flex-wrap items-center justify-between gap-2 rounded border px-2 py-1.5">
        <span className="min-w-0"><strong className="block truncate">{documento.nomeArquivo}</strong><span className="text-xs text-muted-foreground">{documento.descricao || documento.data}{documento.origem === "whatsapp" ? ` · ${t("WhatsApp")}` : ""}</span></span>
        <Badge variant={documento.armazenadoNoDrive ? "success" : "secondary"}>{documento.armazenadoNoDrive ? t("No Drive") : t("No Advomax")}</Badge>
      </li>)}</ul>}
    </div>}
  </Card>;
}
