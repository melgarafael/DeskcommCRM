"use client";

import Link from "next/link";
import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useContact } from "@/hooks/contacts/useContact";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import { useT } from "@/hooks/i18n/useT";
import { chaveDoQuadro } from "@/hooks/kanban/useBoard";
import { useContatosRelacionados } from "@/hooks/leads/useContatosRelacionados";
import { apiClient } from "@/lib/api/client";
import {
  aplicarLinks,
  EXEMPLO_DE_LINK,
  lerLinks,
  normalizarLink,
  TIPOS_DE_LINK,
  tiposInvalidos,
  type LinksDoContato,
  type TipoDeLink,
} from "@/lib/leads/links-de-contato";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import type { Contact } from "@/lib/types/contacts";
import { SeletorDeContato } from "./SeletorDeContato";

interface Props {
  contactId: string | null;
  pipelineId: string;
  /**
   * A âncora das pessoas relacionadas (#1506 F1). Opcional de propósito: quem
   * só tem o contato (card, testes do dossiê) não consulta rota nenhuma —
   * `useContatosRelacionados` segura a chamada sem `leadId`.
   */
  leadId?: string | null;
  podeEditarRelacionados?: boolean;
}

/**
 * Os dados do CLIENTE dentro do dossiê do negócio: telefone e e-mail numa aba,
 * links (Instagram, site, Google Meu Negócio…) na outra, e ABAIXO do principal
 * as outras pessoas do mesmo negócio (#1506 F1).
 *
 * Telefone e e-mail são LEITURA aqui, de propósito: o telefone exige E.164 e
 * passa por normalização e checagem de duplicidade no cadastro do contato, e
 * reimplementar isso num painel lateral seria uma segunda regra para divergir.
 * A ficha completa (`/app/contacts/[id]`) é um clique, e é onde essa regra mora.
 *
 * Os LINKS são editáveis aqui: não têm regra além de "ser um endereço http(s)",
 * e são o dado que o funil mais precisa preencher de passagem.
 *
 * As PESSOAS RELACIONADAS têm cadastro próprio e papel opcional. A conversa do
 * negócio continua ancorada no contato principal.
 */
export function ContatoDoNegocio({
  contactId,
  pipelineId,
  leadId,
  podeEditarRelacionados = false,
}: Props) {
  const t = useT();
  return (
    <>
      {contactId ? (
        <ContatoVinculado contactId={contactId} pipelineId={pipelineId} />
      ) : (
        <p className="text-xs text-text-muted">{t("Este negócio não tem contato vinculado.")}</p>
      )}
      <PessoasRelacionadas
        leadId={leadId ?? null}
        contactId={contactId}
        podeEditar={podeEditarRelacionados}
      />
    </>
  );
}

function ContatoVinculado({ contactId, pipelineId }: { contactId: string; pipelineId: string }) {
  const t = useT();
  const { data, isLoading, isError } = useContact(contactId);
  const contato = data?.data;

  if (isLoading) {
    return <p className="text-xs text-text-muted">{t("Carregando…")}</p>;
  }
  if (isError || !contato) {
    return <p className="text-xs text-text-muted">{t("Não consegui carregar o contato.")}</p>;
  }

  return (
    <Tabs defaultValue="dados" data-testid="contato-do-negocio">
      <TabsList>
        <TabsTrigger value="dados">{t("Dados")}</TabsTrigger>
        <TabsTrigger value="links">{t("Links")}</TabsTrigger>
      </TabsList>
      <TabsContent value="dados">
        <DadosDoContato contato={contato} />
      </TabsContent>
      <TabsContent value="links">
        {/* `key` = updated_at: quando o contato é relido depois de salvar (ou
            editado em outra tela), o formulário reinicia com o valor do
            servidor, sem um efeito de sincronização que pisaria no que a
            pessoa está digitando. */}
        <FormularioDeLinks key={contato.updated_at} contato={contato} pipelineId={pipelineId} />
      </TabsContent>
    </Tabs>
  );
}

/**
 * As outras pessoas do negócio (#1506): lista e edição abaixo do principal.
 *
 * Quem pode editar vê a porta de inclusão mesmo quando a lista está vazia.
 * Para quem só consulta, uma lista vazia continua sem ocupar espaço.
 *
 * O `papel` vem do `metadata` escrito pelo atendente (texto livre, F2 limita a
 * 40) e o nome vem do cadastro: dado de quem usou o produto, não frase de
 * interface, então os dois saem como vieram em qualquer idioma.
 */
function PessoasRelacionadas({
  leadId,
  contactId,
  podeEditar,
}: {
  leadId: string | null;
  contactId: string | null;
  podeEditar: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useContatosRelacionados(leadId);
  const [adicionando, setAdicionando] = useState(false);
  const [selecionado, setSelecionado] = useState<Contact | null>(null);
  const [papel, setPapel] = useState("");
  const [editando, setEditando] = useState<string | null>(null);
  const [papelEmEdicao, setPapelEmEdicao] = useState("");
  const [acaoEmCurso, setAcaoEmCurso] = useState<string | null>(null);

  async function aplicar(metodo: "post" | "patch" | "delete", contact_id: string, funcao?: string) {
    if (!leadId || acaoEmCurso) return;
    setAcaoEmCurso(`${metodo}:${contact_id}`);
    try {
      const caminho = `/api/v1/leads/${leadId}/contatos-relacionados`;
      const corpo = funcao === undefined ? { contact_id } : { contact_id, papel: funcao };
      await apiClient[metodo](caminho, corpo);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["contatos-relacionados", leadId] }),
        qc.invalidateQueries({ queryKey: ["timeline", leadId] }),
      ]);
      if (metodo === "post") {
        setAdicionando(false);
        setSelecionado(null);
        setPapel("");
        toast.success(t("Contato relacionado adicionado."));
      } else if (metodo === "patch") {
        setEditando(null);
        toast.success(t("Função atualizada."));
      } else {
        toast.success(t("Contato relacionado removido."));
      }
    } catch (err) {
      showApiError(err);
    } finally {
      setAcaoEmCurso(null);
    }
  }

  if (isError) {
    return (
      <p className="mt-2 text-xs text-destructive">
        {t("Não consegui carregar as pessoas relacionadas.")}
      </p>
    );
  }
  if (isLoading) return null;
  const pessoas = data?.data ?? [];
  if (!leadId || (pessoas.length === 0 && !podeEditar)) return null;
  return (
    <div className="mt-3 space-y-2" data-testid="pessoas-relacionadas">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium tracking-wide text-text-muted uppercase">
          {t("Pessoas relacionadas")}
        </p>
        {podeEditar && !adicionando && (
          <Button type="button" variant="outline" size="sm" onClick={() => setAdicionando(true)}>
            {t("Adicionar contato")}
          </Button>
        )}
      </div>
      {pessoas.length === 0 && (
        <p className="text-xs text-text-muted">{t("Nenhuma pessoa relacionada ainda.")}</p>
      )}
      <ul className="space-y-2">
        {pessoas.map((pessoa) => (
          <li
            key={pessoa.contact_id}
            className="rounded-md border border-border px-2 py-1.5 text-xs"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link
                href={`/app/contacts/${pessoa.contact_id}`}
                className="min-w-0 font-medium underline-offset-2 hover:underline"
              >
                {pessoa.nome ?? "—"}
              </Link>
              {pessoa.papel && <span className="text-text-muted">({pessoa.papel})</span>}
              {pessoa.anonimizado && <span className="text-text-muted">{t("Anonimizado")}</span>}
              {podeEditar && (
                <span className="ml-auto flex gap-2">
                  {!pessoa.anonimizado && (
                    <button
                      type="button"
                      className="text-text-muted hover:text-text"
                      onClick={() => {
                        setEditando(pessoa.contact_id);
                        setPapelEmEdicao(pessoa.papel ?? "");
                      }}
                      disabled={!!acaoEmCurso}
                    >
                      {t("Editar função")}
                    </button>
                  )}
                  <button
                    type="button"
                    className="text-destructive hover:underline"
                    onClick={() => void aplicar("delete", pessoa.vinculo_contact_id)}
                    disabled={!!acaoEmCurso}
                  >
                    {t("Remover")}
                  </button>
                </span>
              )}
            </div>
            {editando === pessoa.contact_id && (
              <form
                className="mt-2 space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void aplicar("patch", pessoa.vinculo_contact_id, papelEmEdicao);
                }}
              >
                <Input
                  aria-label={t("Função do contato")}
                  value={papelEmEdicao}
                  onChange={(e) => setPapelEmEdicao(e.target.value)}
                  maxLength={40}
                  placeholder={t("Ex.: responsável financeiro")}
                />
                <div className="flex gap-2">
                  <Button type="submit" size="sm" disabled={!!acaoEmCurso}>
                    {t("Salvar")}
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setEditando(null)}>
                    {t("Cancelar")}
                  </Button>
                </div>
              </form>
            )}
          </li>
        ))}
      </ul>
      {adicionando && (
        <form
          className="space-y-2 rounded-md border border-border p-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (selecionado) void aplicar("post", selecionado.id, papel);
          }}
        >
          <SeletorDeContato
            escolhido={selecionado}
            onEscolher={setSelecionado}
            excluirIds={[...(contactId ? [contactId] : []), ...pessoas.map((p) => p.contact_id)]}
          />
          <Label htmlFor="papel-do-contato-relacionado" className="text-xs">
            {t("Função no negócio (opcional)")}
          </Label>
          <Input
            id="papel-do-contato-relacionado"
            value={papel}
            onChange={(e) => setPapel(e.target.value)}
            maxLength={40}
            placeholder={t("Ex.: responsável financeiro")}
          />
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!selecionado || !!acaoEmCurso}>
              {t("Adicionar")}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                setAdicionando(false);
                setSelecionado(null);
                setPapel("");
              }}
            >
              {t("Cancelar")}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function DadosDoContato({ contato }: { contato: Contact }) {
  const t = useT();
  const nome = nomeDoContato(contato);
  const digitos = (contato.phone_number ?? "").replace(/\D/g, "");

  return (
    <div className="space-y-2 text-sm">
      <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-xs text-text-muted">{t("Nome")}</dt>
        <dd className="min-w-0 truncate">{nome ?? "—"}</dd>

        <dt className="text-xs text-text-muted">{t("Telefone")}</dt>
        <dd className="min-w-0 tabular-nums">
          {contato.phone_number ? (
            <span className="inline-flex flex-wrap items-center gap-x-2">
              {contato.phone_number}
              {digitos && (
                <a
                  href={`https://wa.me/${digitos}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent underline-offset-2 hover:underline"
                >
                  {t("Abrir no WhatsApp")}
                </a>
              )}
            </span>
          ) : (
            "—"
          )}
        </dd>

        <dt className="text-xs text-text-muted">{t("E-mail")}</dt>
        <dd className="min-w-0 truncate">
          {contato.email ? (
            <a href={`mailto:${contato.email}`} className="underline-offset-2 hover:underline">
              {contato.email}
            </a>
          ) : (
            "—"
          )}
        </dd>
      </dl>
      <Link
        href={`/app/contacts/${contato.id}`}
        className="inline-block text-xs text-text-muted underline-offset-2 hover:text-text hover:underline"
      >
        {t("Ver ficha completa do contato")}
      </Link>
    </div>
  );
}

function FormularioDeLinks({ contato, pipelineId }: { contato: Contact; pipelineId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const atualizar = useUpdateContact(contato.id);
  const [valores, setValores] = useState<LinksDoContato>(() => lerLinks(contato.custom_fields));
  // O erro só aparece DEPOIS da primeira tentativa de salvar: "exemplo" ainda
  // sem ".com" não é um erro de quem está no meio da digitação.
  const [tentouSalvar, setTentouSalvar] = useState(false);
  const invalidos = new Set<TipoDeLink>(tiposInvalidos(valores));

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
      // O PATCH troca o `custom_fields` INTEIRO — `aplicarLinks` devolve o
      // objeto completo, com os campos que não são link preservados.
      await atualizar.mutateAsync({
        custom_fields: aplicarLinks(contato.custom_fields, valores),
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
        {TIPOS_DE_LINK.map(({ id, rotulo }) => {
          const href = normalizarLink(valores[id]);
          const erro = tentouSalvar && invalidos.has(id);
          return (
            <div key={id} className="space-y-1">
              <Label htmlFor={`link-${id}`} className="text-xs">
                {t(rotulo)}
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
                    aria-label={`${t("Abrir")} ${t(rotulo)}`}
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
