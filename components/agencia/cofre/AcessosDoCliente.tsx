"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { cancelarFormulario, excluirItemDoCofre, gerarLinkDoFormulario, salvarItemDoCofre, verSenha } from "@/app/actions/agencia/cofre";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PLATAFORMAS_DO_COFRE, ROTULO_DA_PLATAFORMA_DO_COFRE, type ItemDoCofre, type PlataformaDoCofre } from "@/lib/agencia/cofre/vocabulario";
import { PLATAFORMAS_DO_FORMULARIO, ROTULO_DA_PLATAFORMA, type Respostas } from "@/lib/agencia/formulario/perguntas";
import { formatarDataHora } from "@/lib/agencia/tarefas/regras";

/**
 * A aba Acessos da ficha do cliente (docs/agencia/SPEC-cofre-e-formulario.md › Telas):
 * o formulário de acesso e o cofre. A senha só chega à tela por `verSenha`, que
 * exige `cofre.ver_senhas` no servidor e registra quem viu.
 */
export interface FormularioDaFicha {
  id: string;
  situacao: "valido" | "enviado" | "cancelado" | "expirado";
  criadoEm: string;
  expiraEm: string;
  enviadoEm: string | null;
  respostas: Respostas | null;
}

const SITUACAO: Record<FormularioDaFicha["situacao"], string> = {
  valido: "Aberto",
  enviado: "Enviado",
  cancelado: "Substituído",
  expirado: "Venceu sem envio",
};

interface Rascunho {
  id?: string;
  plataforma: PlataformaDoCofre;
  rotulo: string;
  login: string;
  extra: string;
  senha: string;
  trocarSenha: boolean;
}

export function AcessosDoCliente(p: {
  clienteId: string;
  formulario: FormularioDaFicha | null;
  cofre: ItemDoCofre[];
  podeGerenciar: boolean;
  podeVerSenhas: boolean;
}) {
  const router = useRouter();
  const [pendente, startTransition] = useTransition();
  const [msg, setMsg] = useState<{ ok: boolean; texto: string } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [enviarZap, setEnviarZap] = useState(true);
  const [senhas, setSenhas] = useState<Record<string, string>>({});
  const [editando, setEditando] = useState<Rascunho | null>(null);

  const r = p.formulario?.respostas ?? null;

  function gerar() {
    setMsg(null);
    startTransition(async () => {
      const res = await gerarLinkDoFormulario(p.clienteId, enviarZap);
      if (!res.ok) return setMsg({ ok: false, texto: res.erro });
      setLink(res.dados.link);
      const zap = {
        enviado: "Link enviado no WhatsApp do cliente.",
        sem_numero: "O cadastro não tem WhatsApp do cliente: copie o link e mande você.",
        sem_whatsapp: "O WhatsApp da agência não está configurado: copie o link e mande você.",
        nao_pedido: "Link gerado.",
      }[res.dados.whatsapp];
      setMsg({ ok: res.dados.whatsapp === "enviado" || res.dados.whatsapp === "nao_pedido", texto: `${zap} Vale 72 horas.` });
      router.refresh();
    });
  }

  function mostrar(itemId: string) {
    startTransition(async () => {
      const res = await verSenha(itemId);
      if (!res.ok) return setMsg({ ok: false, texto: res.erro });
      setSenhas((s) => ({ ...s, [itemId]: res.dados.senha }));
      router.refresh();
    });
  }

  function salvar() {
    if (!editando) return;
    startTransition(async () => {
      const res = await salvarItemDoCofre({
        ...(editando.id ? { id: editando.id } : {}),
        clienteId: p.clienteId,
        plataforma: editando.plataforma,
        rotulo: editando.rotulo,
        login: editando.login,
        extra: editando.extra,
        senha: editando.trocarSenha ? editando.senha : null,
      });
      if (!res.ok) return setMsg({ ok: false, texto: res.erro });
      setEditando(null);
      setMsg({ ok: true, texto: "Acesso salvo." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-md border p-4" data-testid="formulario-da-ficha">
        <div className="space-y-1">
          <h2 className="font-semibold">Formulário de acesso</h2>
          <p className="text-sm text-muted-foreground">O cliente preenche por um link que vale 72 horas; as respostas caem aqui e as senhas vão para o cofre.</p>
        </div>
        {p.formulario ? (
          <p className="text-sm">
            <strong>{SITUACAO[p.formulario.situacao]}</strong> · gerado em {formatarDataHora(p.formulario.criadoEm)}
            {p.formulario.situacao === "valido" && ` · vale até ${formatarDataHora(p.formulario.expiraEm)}`}
            {p.formulario.enviadoEm && ` · enviado em ${formatarDataHora(p.formulario.enviadoEm)}`}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">Nenhum link gerado ainda.</p>
        )}
        {p.podeGerenciar && (
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={gerar} disabled={pendente}>
              {p.formulario?.situacao === "valido" ? "Gerar outro link" : "Gerar link do formulário"}
            </Button>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={enviarZap} onChange={(e) => setEnviarZap(e.target.checked)} />
              Mandar no WhatsApp do cliente
            </label>
            {p.formulario?.situacao === "valido" && (
              <Button
                type="button"
                variant="ghost"
                disabled={pendente}
                onClick={() =>
                  startTransition(async () => {
                    await cancelarFormulario(p.formulario!.id);
                    router.refresh();
                  })
                }
              >
                Cancelar o link
              </Button>
            )}
          </div>
        )}
        {link && (
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly value={link} aria-label="Link do formulário" className="min-w-0 flex-1" data-testid="link-do-formulario" />
            <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(link)}>
              Copiar
            </Button>
          </div>
        )}
        {r && (
          <details className="rounded-md bg-muted/40 p-3 text-sm" data-testid="respostas-do-formulario">
            <summary className="cursor-pointer font-medium">Ver as respostas</summary>
            <div className="mt-2 space-y-2">
              {r.empresas.map((e, i) => (
                <p key={i}>
                  <strong>{e.nome}</strong> · CNPJ {e.cnpj} · {e.whatsapp} · {e.email}
                  {e.site && ` · ${e.site}`}
                  {e.enderecos.filter(Boolean).map((x) => (
                    <span key={x} className="block text-muted-foreground">
                      {x}
                    </span>
                  ))}
                </p>
              ))}
              <p className="whitespace-pre-line">
                <strong>Horários:</strong> {r.horarios}
              </p>
              <p>
                <strong>Responsáveis:</strong>{" "}
                {r.responsaveis
                  .filter((x) => x.nome)
                  .map((x) => `${x.nome}${x.cargo ? ` (${x.cargo})` : ""}`)
                  .join(", ")}
              </p>
              <p className="whitespace-pre-line">
                <strong>Produtos e serviços:</strong> {r.produtos}
              </p>
              <p>
                <strong>Acessos:</strong>{" "}
                {PLATAFORMAS_DO_FORMULARIO.map((pl) => `${ROTULO_DA_PLATAFORMA[pl]}: ${r.acessos[pl].naoTem ? "não tem" : r.acessos[pl].login || "—"}`).join(" · ")}
              </p>
              {r.observacoes && <p className="whitespace-pre-line"><strong>Observações:</strong> {r.observacoes}</p>}
            </div>
          </details>
        )}
      </section>

      <section className="space-y-3 rounded-md border p-4" data-testid="cofre-do-cliente">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h2 className="font-semibold">Cofre de acessos</h2>
            <p className="text-sm text-muted-foreground">
              Senhas cifradas. {p.podeVerSenhas ? "Cada vez que alguém vê uma senha fica registrado." : "Você vê os logins; as senhas, só quem tem a permissão do cofre."}
            </p>
          </div>
          {p.podeVerSenhas && (
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setEditando({ plataforma: "outro", rotulo: "", login: "", extra: "", senha: "", trocarSenha: true })}
              >
                Adicionar acesso
              </Button>
              {p.cofre.length > 0 && (
                <a href={`/api/v1/agencia/cofre/${p.clienteId}/relatorio`} className="inline-flex h-9 items-center rounded-md border px-3 text-sm" data-testid="relatorio-de-acessos">
                  Relatório de acessos (PDF)
                </a>
              )}
            </div>
          )}
        </div>

        {p.cofre.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhum acesso guardado. Eles chegam pelo formulário ou são cadastrados aqui.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {p.cofre.map((i) => (
              <li key={i.id} className="space-y-1 p-3 text-sm" data-testid="item-do-cofre">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">{i.rotulo}</span>
                  <span className="text-xs text-muted-foreground">{i.origem === "formulario" ? "do formulário" : "cadastrado à mão"}</span>
                </div>
                {i.extra && <p className="text-muted-foreground">Página: {i.extra}</p>}
                <p>Login: {i.login ?? "—"}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <span>
                    Senha:{" "}
                    <span className="font-mono" data-testid="senha-do-item">
                      {senhas[i.id] ?? (i.temSenha ? "••••••••" : "—")}
                    </span>
                  </span>
                  {p.podeVerSenhas && i.temSenha && !senhas[i.id] && (
                    <Button type="button" size="sm" variant="outline" disabled={pendente} onClick={() => mostrar(i.id)}>
                      Ver senha
                    </Button>
                  )}
                  {senhas[i.id] && (
                    <Button type="button" size="sm" variant="ghost" onClick={() => void navigator.clipboard?.writeText(senhas[i.id]!)}>
                      Copiar
                    </Button>
                  )}
                  {p.podeVerSenhas && (
                    <>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setEditando({ id: i.id, plataforma: i.plataforma, rotulo: i.rotulo, login: i.login ?? "", extra: i.extra ?? "", senha: "", trocarSenha: false })
                        }
                      >
                        Editar
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={pendente}
                        onClick={() => {
                          if (window.confirm(`Apagar o acesso "${i.rotulo}" do cofre?`)) {
                            startTransition(async () => {
                              const res = await excluirItemDoCofre(i.id);
                              if (!res.ok) setMsg({ ok: false, texto: res.erro });
                              router.refresh();
                            });
                          }
                        }}
                      >
                        Apagar
                      </Button>
                    </>
                  )}
                </div>
                {i.ultimaVisualizacao && (
                  <p className="text-xs text-muted-foreground">
                    Visto por último por {i.ultimaVisualizacao.quem ?? "alguém"} em {formatarDataHora(i.ultimaVisualizacao.quando)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {editando && (
          <div className="grid gap-3 rounded-md bg-muted/40 p-3 sm:grid-cols-2" data-testid="editor-do-cofre">
            <div className="space-y-1">
              <Label htmlFor="cofre-plataforma">Plataforma</Label>
              <select
                id="cofre-plataforma"
                value={editando.plataforma}
                onChange={(e) => {
                  const plataforma = e.target.value as PlataformaDoCofre;
                  setEditando({ ...editando, plataforma, rotulo: editando.rotulo || ROTULO_DA_PLATAFORMA_DO_COFRE[plataforma] });
                }}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                {PLATAFORMAS_DO_COFRE.map((x) => (
                  <option key={x} value={x}>
                    {ROTULO_DA_PLATAFORMA_DO_COFRE[x]}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cofre-rotulo">Nome</Label>
              <Input id="cofre-rotulo" value={editando.rotulo} onChange={(e) => setEditando({ ...editando, rotulo: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cofre-login">Login</Label>
              <Input id="cofre-login" value={editando.login} onChange={(e) => setEditando({ ...editando, login: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="cofre-extra">Página / observação</Label>
              <Input id="cofre-extra" value={editando.extra} onChange={(e) => setEditando({ ...editando, extra: e.target.value })} />
            </div>
            <div className="space-y-1 sm:col-span-2">
              {editando.id && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={editando.trocarSenha} onChange={(e) => setEditando({ ...editando, trocarSenha: e.target.checked })} />
                  Trocar a senha
                </label>
              )}
              {editando.trocarSenha && (
                <Input
                  id="cofre-senha"
                  aria-label="Senha"
                  type="password"
                  autoComplete="new-password"
                  value={editando.senha}
                  onChange={(e) => setEditando({ ...editando, senha: e.target.value })}
                  placeholder="Senha (vazio = sem senha)"
                />
              )}
            </div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="button" onClick={salvar} disabled={pendente}>
                Salvar acesso
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditando(null)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </section>

      {msg && (
        <p role="status" className={msg.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>
          {msg.texto}
        </p>
      )}
    </div>
  );
}
