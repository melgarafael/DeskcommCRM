"use client";

import { useRef } from "react";

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
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";
import type {
  CondicaoDoRamo,
  Passo,
  PassoEmail,
  PassoRamo,
  PassoWhatsapp,
} from "@/lib/cadencias/tipos";
import {
  VARIAVEIS_DO_EMAIL,
  renderizarExemplo,
  variaveisDesconhecidas,
} from "@/lib/cadencias/variaveis";
import { Info, Trash, Warning, X } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { VISUAL_DO_PASSO } from "../../_components/visuais";

interface Props {
  passo: Passo;
  numero: number;
  erros: string[];
  podeResponderNaMesmaConversa: boolean;
  somenteLeitura: boolean;
  onMudar: (p: Passo) => void;
  onExcluir: () => void;
  onFechar: () => void;
}

export function PainelDoPasso(props: Props) {
  const t = useT();
  const { passo, numero, erros, onFechar, onExcluir, somenteLeitura } = props;
  const v = VISUAL_DO_PASSO[passo.tipo];
  const Icon = v.icon;

  return (
    <aside
      className="flex w-full max-w-[440px] shrink-0 flex-col border-l border-border bg-surface"
      data-testid="painel-do-passo"
    >
      <header className={cn("flex items-center gap-2 border-b px-4 py-3", v.cabecalho)}>
        <Icon size={18} aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">
          {numero}. {t(v.rotulo)}
        </h2>
        <button
          type="button"
          onClick={onFechar}
          aria-label={t("Fechar")}
          className="rounded-sm p-1 hover:bg-black/5"
        >
          <X size={16} aria-hidden />
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto p-4">
        {erros.length > 0 && (
          <div className="flex gap-2 rounded-md border border-error/30 bg-error-bg p-3 text-sm text-error-fg">
            <Warning size={16} aria-hidden className="mt-0.5 shrink-0" />
            <ul className="space-y-0.5">
              {erros.map((e) => (
                <li key={e}>{t(e)}</li>
              ))}
            </ul>
          </div>
        )}
        <fieldset disabled={somenteLeitura} className="space-y-5">
          {passo.tipo === "email" && <FormEmail {...props} passo={passo} />}
          {passo.tipo === "espera" && (
            <div className="space-y-2">
              <Label htmlFor="dias-uteis">{t("Aguardar quantos dias úteis?")}</Label>
              <Input
                id="dias-uteis"
                type="number"
                min={1}
                max={60}
                value={passo.diasUteis}
                onChange={(e) => props.onMudar({ ...passo, diasUteis: Number(e.target.value) })}
                className="w-32"
              />
              <p className="text-xs text-text-muted">
                {t("Sábados, domingos e feriados não contam. O próximo passo sai dentro da janela de horário da cadência.")}
              </p>
            </div>
          )}
          {passo.tipo === "ramo" && <FormRamo {...props} passo={passo} />}
          {passo.tipo === "whatsapp" && <FormWhatsapp {...props} passo={passo} />}
          {passo.tipo === "tarefa" && (
            <>
              <div className="space-y-2">
                <Label htmlFor="titulo-tarefa">{t("Título da tarefa")}</Label>
                <Input
                  id="titulo-tarefa"
                  value={passo.titulo}
                  placeholder={t("Ex.: Ligar para o lead")}
                  onChange={(e) => props.onMudar({ ...passo, titulo: e.target.value })}
                />
                <ChipsDeVariavel
                  onEscolher={(chave) => props.onMudar({ ...passo, titulo: `${passo.titulo}{{${chave}}}` })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="prazo-tarefa">{t("Prazo (dias úteis)")}</Label>
                <Input
                  id="prazo-tarefa"
                  type="number"
                  min={0}
                  max={30}
                  value={passo.prazoDias}
                  onChange={(e) => props.onMudar({ ...passo, prazoDias: Number(e.target.value) })}
                  className="w-32"
                />
                <p className="text-xs text-text-muted">
                  {t("A tarefa vai para o dono do lead. Sem dono, vai para quem administra a cadência.")}
                </p>
              </div>
            </>
          )}
        </fieldset>
      </div>

      {!somenteLeitura && (
        <footer className="flex justify-between border-t border-border px-4 py-3">
          <Button variant="ghost" className="text-error-fg" onClick={onExcluir}>
            <Trash size={14} aria-hidden className="mr-2" /> {t("Excluir passo")}
          </Button>
          <Button onClick={onFechar}>{t("Concluir")}</Button>
        </footer>
      )}
    </aside>
  );
}

function ChipsDeVariavel({ onEscolher }: { onEscolher: (chave: string) => void }) {
  const t = useT();
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-text-muted">{t("Inserir:")}</span>
      {VARIAVEIS_DO_EMAIL.map((v) => (
        <button
          key={v.chave}
          type="button"
          onClick={() => onEscolher(v.chave)}
          title={`{{${v.chave}}}`}
          className="rounded-full border border-border bg-surface-elevated px-2 py-0.5 text-xs text-text hover:border-accent hover:text-accent disabled:opacity-50"
        >
          {t(v.rotulo)}
        </button>
      ))}
    </div>
  );
}

/** Insere o texto na posição do cursor, e devolve o cursor para depois dele. */
function inserirNoCursor(
  el: HTMLTextAreaElement | HTMLInputElement | null,
  atual: string,
  trecho: string,
  aplicar: (novo: string) => void,
) {
  if (!el) return aplicar(atual + trecho);
  const ini = el.selectionStart ?? atual.length;
  const fim = el.selectionEnd ?? atual.length;
  aplicar(atual.slice(0, ini) + trecho + atual.slice(fim));
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(ini + trecho.length, ini + trecho.length);
  });
}

function FormEmail({
  passo,
  podeResponderNaMesmaConversa,
  onMudar,
}: Props & { passo: PassoEmail }) {
  const t = useT();
  const assuntoRef = useRef<HTMLInputElement>(null);
  const corpoRef = useRef<HTMLTextAreaElement>(null);
  const ultimoFoco = useRef<"assunto" | "corpo">("corpo");
  const desconhecidas = variaveisDesconhecidas(`${passo.assunto}\n${passo.corpo}`);

  const inserir = (chave: string) => {
    const trecho = `{{${chave}}}`;
    if (ultimoFoco.current === "assunto" && !passo.mesmaConversa) {
      inserirNoCursor(assuntoRef.current, passo.assunto, trecho, (assunto) =>
        onMudar({ ...passo, assunto }),
      );
    } else {
      inserirNoCursor(corpoRef.current, passo.corpo, trecho, (corpo) => onMudar({ ...passo, corpo }));
    }
  };

  return (
    <>
      <div className="flex gap-2 rounded-md bg-info-bg p-3 text-xs text-info-fg">
        <Info size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>
          {t("Sai da caixa do dono do lead. Lead sem dono usa a caixa padrão da cadência.")}
        </span>
      </div>

      <div className="flex items-start justify-between gap-3">
        <div>
          <Label htmlFor="mesma-conversa">{t("Responder na mesma conversa")}</Label>
          <p className="text-xs text-text-muted">
            {podeResponderNaMesmaConversa
              ? t("Vai como resposta ao e-mail anterior (“Re:”), na mesma thread.")
              : t("Disponível a partir do segundo e-mail do caminho.")}
          </p>
        </div>
        <Switch
          id="mesma-conversa"
          checked={passo.mesmaConversa}
          disabled={!podeResponderNaMesmaConversa}
          onCheckedChange={(mesmaConversa) => onMudar({ ...passo, mesmaConversa })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="assunto">{t("Assunto")}</Label>
        <Input
          id="assunto"
          ref={assuntoRef}
          value={passo.mesmaConversa ? "" : passo.assunto}
          disabled={passo.mesmaConversa}
          placeholder={passo.mesmaConversa ? t("Re: assunto do e-mail anterior") : t("Ex.: {{primeiro_nome}}, uma ideia para a {{empresa}}")}
          onFocus={() => (ultimoFoco.current = "assunto")}
          onChange={(e) => onMudar({ ...passo, assunto: e.target.value })}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="corpo">{t("Mensagem")}</Label>
        <Textarea
          id="corpo"
          ref={corpoRef}
          rows={10}
          value={passo.corpo}
          placeholder={t("Oi {{primeiro_nome}}, ...")}
          onFocus={() => (ultimoFoco.current = "corpo")}
          onChange={(e) => onMudar({ ...passo, corpo: e.target.value })}
          className="font-[inherit] leading-relaxed"
        />
        <ChipsDeVariavel onEscolher={inserir} />
        {desconhecidas.length > 0 && (
          <p className="flex items-center gap-1 text-xs text-warning-fg">
            <Warning size={12} aria-hidden />
            {t("Variável que não existe:")} {desconhecidas.map((d) => `{{${d}}}`).join(", ")}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium uppercase tracking-wide text-text-muted">
          {t("Prévia com um lead de exemplo")}
        </p>
        <div className="rounded-md border border-border bg-bg p-3 text-sm" data-testid="previa-email">
          <p className="border-b border-border pb-2 font-medium">
            {passo.mesmaConversa ? t("Re: assunto do e-mail anterior") : renderizarExemplo(passo.assunto) || t("Sem assunto")}
          </p>
          <p className="whitespace-pre-wrap pt-2 text-text">
            {renderizarExemplo(passo.corpo) || <span className="text-text-muted">{t("Mensagem vazia")}</span>}
          </p>
          <p className="mt-3 border-t border-dashed border-border pt-2 text-xs text-text-muted">
            {t("Não quer mais receber estes e-mails? Descadastrar")}
          </p>
        </div>
        <p className="text-xs text-text-muted">
          {t("O link de descadastro entra automaticamente no fim de todo e-mail.")}
        </p>
      </div>
    </>
  );
}

function FormRamo({ passo, onMudar }: Props & { passo: PassoRamo }) {
  const t = useT();
  const c = passo.condicao;
  const mudar = (condicao: CondicaoDoRamo) => onMudar({ ...passo, condicao });
  return (
    <>
      <div className="space-y-2">
        <Label>{t("Verificar se o lead...")}</Label>
        <Select
          value={c.tipo}
          onValueChange={(tipo) => {
            if (tipo === "abriu") mudar({ tipo, vezes: 2, dentroDeDias: c.dentroDeDias });
            else mudar({ tipo: tipo as "clicou" | "respondeu", dentroDeDias: c.dentroDeDias });
          }}
        >
          <SelectTrigger data-testid="condicao-tipo">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="abriu">{t("Abriu o e-mail anterior")}</SelectItem>
            <SelectItem value="clicou">{t("Clicou em um link do e-mail anterior")}</SelectItem>
            <SelectItem value="respondeu">{t("Respondeu o e-mail")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {c.tipo === "abriu" && (
        <div className="space-y-2">
          <Label htmlFor="vezes">{t("Pelo menos quantas vezes?")}</Label>
          <Input
            id="vezes"
            type="number"
            min={1}
            max={20}
            value={c.vezes}
            onChange={(e) => mudar({ ...c, vezes: Number(e.target.value) })}
            className="w-32"
          />
          <p className="text-xs text-text-muted">
            {t("Aberturas com menos de 1 hora de intervalo contam como uma só — filtra as aberturas automáticas do Apple Mail e de filtros corporativos.")}
          </p>
        </div>
      )}
      <div className="space-y-2">
        <Label htmlFor="dentro-de">{t("Esperar a resposta por até (dias úteis)")}</Label>
        <Input
          id="dentro-de"
          type="number"
          min={1}
          max={30}
          value={c.dentroDeDias}
          onChange={(e) => mudar({ ...c, dentroDeDias: Number(e.target.value) })}
          className="w-32"
        />
        <p className="text-xs text-text-muted">
          {t("Assim que a condição acontecer, o lead segue pelo “Sim”. Se o prazo acabar antes, segue pelo “Não”.")}
        </p>
      </div>
    </>
  );
}

function FormWhatsapp({ passo, onMudar }: Props & { passo: PassoWhatsapp }) {
  const t = useT();
  const ref = useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <div className="flex gap-2 rounded-md border border-warning/30 bg-warning-bg p-3 text-xs text-warning-fg">
        <Warning size={14} aria-hidden className="mt-0.5 shrink-0" />
        <span>
          {t("Mensagem para quem nunca falou com o número é o cenário de maior risco de banimento. Sai pelo WhatsApp conectado, respeitando o ritmo, o horário e a lista de quem pediu para sair. Prefira um número secundário.")}
        </span>
      </div>
      <div className="space-y-2">
        <Label htmlFor="mensagem-wpp">{t("Mensagem")}</Label>
        <Textarea
          id="mensagem-wpp"
          ref={ref}
          rows={6}
          value={passo.mensagem}
          onChange={(e) => onMudar({ ...passo, mensagem: e.target.value })}
        />
        <ChipsDeVariavel
          onEscolher={(chave) =>
            inserirNoCursor(ref.current, passo.mensagem, `{{${chave}}}`, (mensagem) =>
              onMudar({ ...passo, mensagem }),
            )
          }
        />
        <p className="text-xs text-text-muted">
          {t("Só roda se o lead tiver telefone. Sem telefone, o passo é pulado e o lead segue o caminho.")}
        </p>
      </div>
      {passo.mensagem.trim() && (
        <div className="rounded-lg bg-success-bg/60 p-3">
          <p className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-surface px-3 py-2 text-sm shadow-xs">
            {renderizarExemplo(passo.mensagem)}
          </p>
        </div>
      )}
    </>
  );
}
