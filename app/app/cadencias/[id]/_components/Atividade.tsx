"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
type Negocio = { id: string; title: string; status: string };
type Inscricao = { id: string; status: string; motivo_parada: string | null; emails_enviados: number; aberturas: number; rastreio_consentido: boolean; ultimo_erro: string | null; created_at: string; proximo_em: string; crm_leads: { title: string } | null };
type Evento = { id: string; enrollment_id: string; tipo: string; passo_id: string | null; created_at: string };
type Pagina<T> = { data: T[]; meta: { cursor: string | null } };
const ROTULOS_EVENTO: Record<string, string> = { inscrito: "Inscrição criada.", email_enviado: "E-mail enviado", aberto: "Abertura registrada", tarefa_criada: "Tarefa criada", parada: "Inscrição parada", concluida: "Inscrição concluída", descadastrou: "Destinatário se descadastrou", limite_diario_atingido: "Limite diário atingido", email_falhou: "Falha no passo", reinscrito: "Nova inscrição", clicado: "Clique registrado", ramo_sim: "Ramo: sim", ramo_nao: "Ramo: não" };
export function Atividade({ id, ativa }: { id: string; ativa: boolean }) {
  const t = useT();
  const idioma = useTagDeIdioma();
  const instante = (valor: string) => new Date(valor).toLocaleString(idioma);
  const [cursor, setCursor] = useState<string | null>(null);
  const [maisOcupado, setMaisOcupado] = useState(false);
  const [erroMais, setErroMais] = useState(false);
  const [historico, setHistorico] = useState<string | null>(null);
  const [eventos, setEventos] = useState<Evento[]>([]);
  const [cursorEventos, setCursorEventos] = useState<string | null>(null);
  const [erroEventos, setErroEventos] = useState(false);
  const [eventosOcupado, setEventosOcupado] = useState(false);
  const consultaHistorico = useRef(0);
  const [linhas, setLinhas] = useState<Inscricao[]>([]);
  const [negocios, setNegocios] = useState<Negocio[]>([]);
  const [termo, setTermo] = useState("");
  const [leadId, setLeadId] = useState("");
  const [consentido, setConsentido] = useState(false);
  const [erro, setErro] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const carregar = useCallback(async () => {
    try {
      const res = await fetch(`/api/v1/cadencias/${id}/inscricoes?limit=50`);
      if (!res.ok) throw new Error();
      const corpo = await res.json() as Pagina<Inscricao>;
      setLinhas(corpo.data); setCursor(corpo.meta.cursor); setErro(false); setErroMais(false);
    } catch { setErro(true); }
  }, [id]);
  useEffect(() => {
    let vivo = true;
    void fetch(`/api/v1/cadencias/${id}/inscricoes?limit=50`).then(async (res) => {
      if (!res.ok) throw new Error();
      const corpo = await res.json() as Pagina<Inscricao>;
      if (vivo) { setLinhas(corpo.data); setCursor(corpo.meta.cursor); setErro(false); setErroMais(false); }
    }).catch(() => { if (vivo) setErro(true); });
    return () => { vivo = false; };
  }, [id]);
  async function maisInscricoes() {
    if (!cursor || maisOcupado) return;
    setMaisOcupado(true);
    try {
      const res = await fetch(`/api/v1/cadencias/${id}/inscricoes?limit=50&cursor=${encodeURIComponent(cursor)}`);
      if (!res.ok) throw new Error();
      const corpo = await res.json() as Pagina<Inscricao>;
      setLinhas((atual) => [...atual, ...corpo.data.filter((l) => !atual.some((a) => a.id === l.id))]);
      setCursor(corpo.meta.cursor); setErroMais(false);
    } catch { setErroMais(true); }
    finally { setMaisOcupado(false); }
  }
  async function carregarEventos(inscricao: string, depois?: string) {
    const revisao = ++consultaHistorico.current;
    setHistorico(inscricao); setEventosOcupado(true);
    if (!depois) { setEventos([]); setCursorEventos(null); }
    try {
      const res = await fetch(`/api/v1/cadencias/${id}/eventos?enrollment_id=${encodeURIComponent(inscricao)}${depois ? `&cursor=${encodeURIComponent(depois)}` : ""}`);
      if (!res.ok) throw new Error();
      const corpo = await res.json() as Pagina<Evento>;
      if (revisao !== consultaHistorico.current) return;
      setEventos((atuais) => depois ? [...atuais, ...corpo.data.filter((e) => !atuais.some((a) => a.id === e.id))] : corpo.data);
      setCursorEventos(corpo.meta.cursor); setErroEventos(false);
    } catch { if (revisao === consultaHistorico.current) setErroEventos(true); }
    finally { if (revisao === consultaHistorico.current) setEventosOcupado(false); }
  }
  async function buscar() {
    setOcupado(true);
    try {
      const res = await fetch(`/api/v1/cadencias/negocios?q=${encodeURIComponent(termo)}`);
      if (!res.ok) throw new Error();
      const corpo = await res.json() as { data: Negocio[] };
      setNegocios(corpo.data); setLeadId("");
    } catch { toast.error(t("Não foi possível buscar os negócios.")); }
    finally { setOcupado(false); }
  }
  async function inscrever() {
    if (!leadId) return;
    setOcupado(true);
    try {
      const res = await fetch(`/api/v1/cadencias/${id}/inscricoes`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lead_id: leadId, rastreio_consentido: consentido }) });
      if (!res.ok) { const corpo = await res.json() as { error?: { message?: string } }; toast.error(corpo.error?.message ?? t("Não foi possível inscrever o negócio.")); return; }
      setLeadId(""); setConsentido(false); await carregar(); toast.success(t("Inscrição criada."));
    } catch { toast.error(t("Não foi possível inscrever o negócio.")); }
    finally { setOcupado(false); }
  }
  async function retirar(inscricaoId: string) {
    setOcupado(true);
    try {
      const res = await fetch(`/api/v1/cadencias/${id}/inscricoes/${inscricaoId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      await carregar();
    } catch { toast.error(t("Não foi possível retirar a inscrição.")); }
    finally { setOcupado(false); }
  }
  return <div className="w-full space-y-5 overflow-y-auto p-6">
    <Card className="space-y-4 p-5">
      <h2 className="font-semibold">{t("Inscrever negócio")}</h2>
      {!ativa && <p className="text-sm text-text-muted">{t("Ative a cadência para aceitar novas inscrições.")}</p>}
      <div className="flex gap-2"><Input aria-label={t("Buscar negócio pelo título")} value={termo} onChange={(e) => setTermo(e.target.value)} /><Button variant="outline" onClick={() => void buscar()} disabled={ocupado}>{t("Buscar")}</Button></div>
      <Label htmlFor="negocio-cadencia">{t("Negócio")}</Label>
      <select id="negocio-cadencia" value={leadId} onChange={(e) => setLeadId(e.target.value)} className="w-full rounded-md border border-border bg-surface p-2"><option value="">{t("Selecione um negócio")}</option>{negocios.map((n) => <option key={n.id} value={n.id}>{n.title}</option>)}</select>
      <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={consentido} onChange={(e) => setConsentido(e.target.checked)} /><span>{t("O destinatário autorizou o rastreio de abertura. Sem esta autorização, os e-mails não incluem pixel e os ramos de abertura não recebem sinal.")}</span></label>
      <Button disabled={!ativa || !leadId || ocupado} onClick={() => void inscrever()}>{t("Inscrever")}</Button>
    </Card>
    <div className="flex items-center justify-between"><h2 className="font-semibold">{t("Inscrições e atividade")}</h2><Button variant="outline" disabled={ocupado} onClick={() => void carregar()}>{t("Atualizar")}</Button></div>
    {erro ? <p role="alert">{t("Não foi possível carregar as inscrições.")}</p> : linhas.length === 0 ? <p className="text-sm text-text-muted">{t("Nenhuma inscrição nesta cadência.")}</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>{[t("Negócio"), t("Estado"), t("Enviados"), t("Aberturas"), t("Próximo passo"), t("Ações")].map((rotulo) => <th key={rotulo} className="p-2">{rotulo}</th>)}</tr></thead><tbody>{linhas.map((l) => <tr key={l.id} className="border-t border-border"><td className="p-2">{l.crm_leads?.title ?? t("Negócio indisponível")}</td><td className="p-2">{t(l.status)}{l.motivo_parada && <span className="block text-xs text-text-muted">{t(l.motivo_parada)}</span>}{l.ultimo_erro && <span className="block max-w-sm text-xs text-destructive">{t(l.ultimo_erro === "cadencia_delivery_unconfirmed" ? "O provedor pode ter aceitado este e-mail. O envio não foi confirmado e a inscrição parou para evitar duplicação. Confira o provedor antes de iniciar outro envio." : "O passo falhou. Confira a configuração antes de continuar.")}</span>}</td><td className="p-2 tabular-nums">{l.emails_enviados}</td><td className="p-2 tabular-nums">{l.rastreio_consentido ? l.aberturas : t("Sem autorização")}</td><td className="p-2">{l.status === "ativa" ? <time dateTime={l.proximo_em}>{instante(l.proximo_em)}</time> : "—"}</td><td className="space-x-2 p-2"><Button variant="outline" size="sm" onClick={() => void carregarEventos(l.id)}>{t("Ver histórico")}</Button>{l.status === "ativa" && <Button variant="outline" size="sm" disabled={ocupado} onClick={() => void retirar(l.id)}>{t("Retirar")}</Button>}</td></tr>)}</tbody></table></div>}
    {erroMais && <p role="alert">{t("Não foi possível carregar mais inscrições.")}</p>}
    {cursor && <Button variant="outline" disabled={maisOcupado} onClick={() => void maisInscricoes()}>{t("Carregar mais inscrições")}</Button>}
    {historico && <Card className="space-y-3 p-4" aria-label={t("Histórico da inscrição")}>
      <div className="flex items-center justify-between"><h3 className="font-semibold">{t("Histórico da inscrição")}</h3><Button variant="ghost" onClick={() => { ++consultaHistorico.current; setHistorico(null); }}>{t("Fechar")}</Button></div>
      {erroEventos && <p role="alert">{t("Não foi possível carregar os eventos.")}</p>}
      {eventos.length === 0 && !eventosOcupado && !erroEventos && <p>{t("Nenhum evento nesta inscrição.")}</p>}
      <ol className="space-y-2">{eventos.map((e) => <li key={e.id} className="flex flex-wrap gap-x-3 text-sm"><time dateTime={e.created_at}>{instante(e.created_at)}</time><span>{t(ROTULOS_EVENTO[e.tipo] ?? e.tipo)}</span>{e.passo_id && <span className="text-text-muted">{e.passo_id}</span>}</li>)}</ol>
      {erroEventos && <Button variant="outline" disabled={eventosOcupado} onClick={() => void carregarEventos(historico, cursorEventos ?? undefined)}>{t("Tentar novamente")}</Button>}
      {cursorEventos && !erroEventos && <Button variant="outline" disabled={eventosOcupado} onClick={() => void carregarEventos(historico, cursorEventos)}>{t("Carregar mais eventos")}</Button>}
      {eventosOcupado && <p role="status">{t("Carregando histórico…")}</p>}
    </Card>}
    <p className="text-xs text-text-muted">{t("Aberturas podem incluir buscas automáticas do provedor. Este módulo não mede cliques, respostas ou devoluções.")}</p>
  </div>;
}
