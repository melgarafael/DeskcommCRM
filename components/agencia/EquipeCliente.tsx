"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { enviarAvisoDeTeste } from "@/app/actions/agencia/avisos";
import {
  convidarMembro,
  desativarMembro,
  editarMembro,
  reativarMembro,
  reenviarConvite,
  revogarConvite,
  type ConviteEmitido,
} from "@/app/actions/agencia/membros";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export interface FuncaoDaLista {
  id: string;
  nome: string;
  cor: string;
  ativa: boolean;
}

export interface MembroDaLista {
  id: string;
  nome: string;
  email: string;
  whatsapp: string;
  situacao: "convidado" | "ativo" | "desativado";
  veTodosClientes: boolean;
  funcoes: string[];
  conviteExpiraEm: string | null;
  whatsappFalhou: boolean;
}

const ROTULO_DA_SITUACAO: Record<MembroDaLista["situacao"], string> = {
  convidado: "Convite pendente",
  ativo: "Ativo",
  desativado: "Desativado",
};

function EtiquetaDeFuncao({ f }: { f: FuncaoDaLista }) {
  return (
    <span
      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs"
      style={{ borderColor: f.cor, color: f.cor }}
    >
      {f.nome}
    </span>
  );
}

export function EquipeCliente({ membros, funcoes }: { membros: MembroDaLista[]; funcoes: FuncaoDaLista[] }) {
  const router = useRouter();
  const [editando, setEditando] = useState<MembroDaLista | "novo" | null>(null);
  const [convite, setConvite] = useState<(ConviteEmitido & { nome: string }) | null>(null);
  const [mensagem, setMensagem] = useState<{ tipo: "ok" | "erro"; texto: string } | null>(null);
  const [pendente, startTransition] = useTransition();
  const porId = new Map(funcoes.map((f) => [f.id, f]));

  function rodar(acao: () => Promise<{ ok: boolean; erro?: string }>, sucesso: string) {
    startTransition(async () => {
      const r = await acao();
      setMensagem(r.ok ? { tipo: "ok", texto: sucesso } : { tipo: "erro", texto: r.erro ?? "Algo deu errado." });
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button onClick={() => setEditando("novo")} data-testid="convidar-membro">
          Convidar membro
        </Button>
      </div>

      {mensagem && (
        <p
          role="status"
          className={cn("rounded-md border px-3 py-2 text-sm", mensagem.tipo === "erro" && "border-destructive text-destructive")}
        >
          {mensagem.texto}
        </p>
      )}

      {membros.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          Ninguém na equipe ainda. Convide o primeiro membro.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {membros.map((m) => (
            <li key={m.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between" data-testid="membro">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{m.nome}</span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs",
                      m.situacao === "ativo" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
                      m.situacao === "convidado" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
                      m.situacao === "desativado" && "bg-muted text-muted-foreground",
                    )}
                  >
                    {ROTULO_DA_SITUACAO[m.situacao]}
                  </span>
                  {m.whatsappFalhou && (
                    <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs text-destructive">
                      WhatsApp não entregue
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {m.email} · {m.whatsapp} · {m.veTodosClientes ? "vê todos os clientes" : "só os clientes que atende"}
                </p>
                <div className="flex flex-wrap gap-1">
                  {m.funcoes.map((id) => {
                    const f = porId.get(id);
                    return f ? <EtiquetaDeFuncao key={id} f={f} /> : null;
                  })}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={pendente} onClick={() => setEditando(m)}>
                  Editar
                </Button>
                {m.situacao === "convidado" && (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pendente}
                      onClick={() =>
                        startTransition(async () => {
                          const r = await reenviarConvite(m.id);
                          if (r.ok) setConvite({ ...r.dados, nome: m.nome });
                          else setMensagem({ tipo: "erro", texto: r.erro });
                          router.refresh();
                        })
                      }
                    >
                      Reenviar convite
                    </Button>
                    <Button variant="ghost" size="sm" disabled={pendente} onClick={() => rodar(() => revogarConvite(m.id), "Convite cancelado.")}>
                      Cancelar convite
                    </Button>
                  </>
                )}
                {m.situacao === "ativo" && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pendente}
                    onClick={() => rodar(() => enviarAvisoDeTeste(m.id), `Aviso de teste enviado para ${m.nome}.`)}
                  >
                    Aviso de teste
                  </Button>
                )}
                {m.situacao === "desativado" ? (
                  <Button variant="ghost" size="sm" disabled={pendente} onClick={() => rodar(() => reativarMembro(m.id), `${m.nome} foi reativado.`)}>
                    Reativar
                  </Button>
                ) : (
                  <Button variant="ghost" size="sm" disabled={pendente} onClick={() => rodar(() => desativarMembro(m.id), `${m.nome} foi desativado.`)}>
                    Desativar
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={editando !== null} onOpenChange={(v) => !v && setEditando(null)}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          {editando !== null && (
            <FormularioDeMembro
              membro={editando === "novo" ? null : editando}
              funcoes={funcoes.filter((f) => f.ativa || (editando !== "novo" && editando.funcoes.includes(f.id)))}
              onFeito={(emitido, nome) => {
                setEditando(null);
                if (emitido) setConvite({ ...emitido, nome });
                else setMensagem({ tipo: "ok", texto: "Membro atualizado." });
                router.refresh();
              }}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={convite !== null} onOpenChange={(v) => !v && setConvite(null)}>
        <DialogContent className="sm:max-w-lg">
          {convite && (
            <>
              <DialogHeader>
                <DialogTitle>Convite de {convite.nome}</DialogTitle>
                <DialogDescription>
                  {convite.enviadoPeloWhatsapp
                    ? "O link foi para o WhatsApp da pessoa. Se precisar, copie e mande por outro caminho."
                    : "O WhatsApp da agência não está configurado. Copie o link e mande para a pessoa."}
                </DialogDescription>
              </DialogHeader>
              <div className="flex gap-2">
                <Input readOnly value={convite.link} data-testid="link-do-convite" onFocus={(e) => e.currentTarget.select()} />
                <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(convite.link)}>
                  Copiar
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">O link vale 7 dias e funciona uma vez só.</p>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FormularioDeMembro({
  membro,
  funcoes,
  onFeito,
}: {
  membro: MembroDaLista | null;
  funcoes: FuncaoDaLista[];
  onFeito: (convite: ConviteEmitido | null, nome: string) => void;
}) {
  const [nome, setNome] = useState(membro?.nome ?? "");
  const [email, setEmail] = useState(membro?.email ?? "");
  const [whatsapp, setWhatsapp] = useState(membro?.whatsapp ?? "");
  const [escolhidas, setEscolhidas] = useState<string[]>(membro?.funcoes ?? []);
  const [veTodos, setVeTodos] = useState(membro?.veTodosClientes ?? false);
  const [erro, setErro] = useState<string | null>(null);
  const [pendente, startTransition] = useTransition();

  function alternar(id: string) {
    setEscolhidas((atual) => (atual.includes(id) ? atual.filter((x) => x !== id) : [...atual, id]));
  }

  function salvar(e: React.FormEvent) {
    e.preventDefault();
    setErro(null);
    startTransition(async () => {
      if (membro) {
        const r = await editarMembro({ id: membro.id, nome, whatsapp, funcoes: escolhidas, veTodosClientes: veTodos });
        if (r.ok) onFeito(null, nome);
        else setErro(r.erro);
      } else {
        const r = await convidarMembro({ nome, email, whatsapp, funcoes: escolhidas, veTodosClientes: veTodos });
        if (r.ok) onFeito(r.dados, nome);
        else setErro(r.erro);
      }
    });
  }

  return (
    <form onSubmit={salvar} className="space-y-4">
      <DialogHeader>
        <DialogTitle>{membro ? "Editar membro" : "Convidar membro"}</DialogTitle>
        <DialogDescription>
          {membro ? "Funções e alcance valem a partir da próxima tela que a pessoa abrir." : "A pessoa recebe um link para criar a senha."}
        </DialogDescription>
      </DialogHeader>
      <div className="space-y-1.5">
        <Label htmlFor="membro-nome">Nome</Label>
        <Input id="membro-nome" value={nome} onChange={(e) => setNome(e.target.value)} required autoComplete="off" />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="membro-email">E-mail</Label>
        <Input
          id="membro-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          disabled={!!membro}
          autoComplete="off"
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="membro-whatsapp">WhatsApp</Label>
        <Input
          id="membro-whatsapp"
          inputMode="tel"
          placeholder="(11) 91234-5678"
          value={whatsapp}
          onChange={(e) => setWhatsapp(e.target.value)}
          required
          autoComplete="off"
        />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Funções</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {funcoes.map((f) => (
            <label key={f.id} className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 text-sm">
              <input type="checkbox" checked={escolhidas.includes(f.id)} onChange={() => alternar(f.id)} />
              <span className="h-2.5 w-2.5 rounded-full" style={{ background: f.cor }} aria-hidden />
              {f.nome}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm">
        <span>
          Vê todos os clientes
          <span className="block text-xs text-muted-foreground">Desligado, vê só os clientes que atende.</span>
        </span>
        <Switch checked={veTodos} onCheckedChange={setVeTodos} />
      </label>
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={pendente}>
          {pendente ? "Salvando…" : membro ? "Salvar" : "Convidar"}
        </Button>
      </div>
    </form>
  );
}
