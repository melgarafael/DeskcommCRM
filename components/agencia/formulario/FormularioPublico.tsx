"use client";

import { useRef, useState, useTransition } from "react";

import { confirmarEnvioPublico, enviarFormulario, iniciarEnvioPublico, salvarRascunho } from "@/app/actions/agencia/formularioPublico";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PLATAFORMAS_DO_FORMULARIO,
  ROTULO_DA_PLATAFORMA,
  pendenciasDoEnvio,
  type PlataformaDoFormulario,
  type Respostas,
} from "@/lib/agencia/formulario/perguntas";
import { cn } from "@/lib/utils";

/**
 * O formulário de acesso que o cliente preenche (docs/agencia/SPEC-cofre-e-formulario.md).
 * Em etapas, pensado para o celular. Cada "Continuar" salva o rascunho no
 * servidor — sem as senhas, que só saem daqui no envio final (F3).
 */
const PASSOS = ["Empresa", "Horários", "Responsáveis", "Produtos", "Acessos", "Arquivos", "Enviar"] as const;

const PISTA: Record<PlataformaDoFormulario, { login: string; exemplo: string }> = {
  instagram: { login: "Usuário (@instagram da empresa)", exemplo: "@suaempresa" },
  facebook: { login: "E-mail / Gmail vinculado ao Facebook", exemplo: "empresa@gmail.com" },
  google: { login: "Gmail do Google Meu Negócio", exemplo: "meunegocio.empresa@gmail.com" },
  tiktok: { login: "Usuário / Gmail do TikTok", exemplo: "@suaempresa" },
};

function mascaraCnpj(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 14);
  return d
    .replace(/^(\d{2})(\d)/, "$1.$2")
    .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
    .replace(/\.(\d{3})(\d)/, ".$1/$2")
    .replace(/(\d{4})(\d)/, "$1-$2");
}

function Envio({ token, categoria, titulo, descricao }: { token: string; categoria: "identidade" | "fotos"; titulo: string; descricao: string }) {
  const entrada = useRef<HTMLInputElement>(null);
  const [estado, setEstado] = useState<string | null>(null);
  const [enviados, setEnviados] = useState<string[]>([]);

  async function enviar(arquivos: FileList | null) {
    for (const a of Array.from(arquivos ?? [])) {
      setEstado(`Enviando ${a.name}…`);
      const s = await iniciarEnvioPublico(token, { nome: a.name, mime: a.type, tamanho: a.size, categoria });
      if (!s.ok) {
        setEstado(s.erro);
        return;
      }
      const subido = await new Promise<{ id: string } | null>((ok) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", s.dados.urlDeEnvio);
        xhr.setRequestHeader("Content-Type", a.type || "application/octet-stream");
        xhr.upload.onprogress = (e) => e.lengthComputable && setEstado(`Enviando ${a.name}… ${Math.round((e.loaded / e.total) * 100)}%`);
        xhr.onload = () => {
          try {
            ok(xhr.status < 300 ? (JSON.parse(xhr.responseText) as { id: string }) : null);
          } catch {
            ok(null);
          }
        };
        xhr.onerror = () => ok(null);
        xhr.send(a);
      });
      const conf = subido ? await confirmarEnvioPublico(token, subido.id, categoria) : { ok: false as const, erro: `O envio de ${a.name} falhou.` };
      if (!conf.ok) {
        setEstado(conf.erro);
        return;
      }
      setEnviados((x) => [...x, a.name]);
    }
    setEstado(null);
    if (entrada.current) entrada.current.value = "";
  }

  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-sm font-medium">{titulo}</p>
      <p className="text-xs text-muted-foreground">{descricao}</p>
      <input ref={entrada} type="file" multiple className="hidden" onChange={(e) => void enviar(e.target.files)} />
      <Button type="button" variant="outline" size="sm" onClick={() => entrada.current?.click()}>
        Escolher arquivos
      </Button>
      {estado && <p className="text-xs text-muted-foreground" role="status">{estado}</p>}
      {enviados.length > 0 && <p className="text-xs">Enviados: {enviados.join(", ")}</p>}
    </div>
  );
}

export function FormularioPublico({
  token,
  empresa,
  agencia,
  inicial,
  aceitaArquivos,
  expiraEm,
}: {
  token: string;
  empresa: string;
  agencia: string;
  inicial: Respostas;
  aceitaArquivos: boolean;
  expiraEm: string;
}) {
  const [r, setR] = useState<Respostas>(inicial);
  const [passo, setPasso] = useState(-1);
  const [erro, setErro] = useState<string | null>(null);
  const [enviado, setEnviado] = useState(false);
  const [pendente, startTransition] = useTransition();
  const topo = useRef<HTMLDivElement>(null);

  const mudar = (p: Partial<Respostas>) => setR((x) => ({ ...x, ...p }));
  const mudarEmpresa = (i: number, p: Partial<Respostas["empresas"][number]>) =>
    mudar({ empresas: r.empresas.map((e, j) => (j === i ? { ...e, ...p } : e)) });
  const mudarAcesso = (pl: PlataformaDoFormulario, p: Partial<Respostas["acessos"][PlataformaDoFormulario]>) =>
    mudar({ acessos: { ...r.acessos, [pl]: { ...r.acessos[pl], ...p } } });

  function ir(n: number) {
    setErro(null);
    startTransition(async () => {
      if (passo >= 0) {
        const s = await salvarRascunho(token, r);
        if (!s.ok) {
          setErro(s.erro);
          return;
        }
      }
      setPasso(n);
      topo.current?.scrollIntoView({ behavior: "smooth" });
    });
  }

  function enviar() {
    setErro(null);
    const falta = pendenciasDoEnvio(r);
    if (falta.length) return setErro(`Falta preencher: ${falta.join(", ")}.`);
    startTransition(async () => {
      const s = await enviarFormulario(token, r);
      if (!s.ok) return setErro(s.erro);
      setEnviado(true);
    });
  }

  if (enviado) {
    return (
      <div className="space-y-3 text-center" data-testid="formulario-recebido">
        <h1 className="text-2xl font-semibold">Recebido! Obrigado.</h1>
        <p className="text-sm text-muted-foreground">
          As informações da {empresa} chegaram para a {agencia}. As senhas ficaram guardadas cifradas, e só a equipe autorizada consegue ver.
        </p>
      </div>
    );
  }

  if (passo === -1) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold tracking-tight">Onboarding e acessos — {empresa}</h1>
        <p className="text-sm text-muted-foreground">
          Preencha as informações essenciais da empresa para começarmos o projeto. Dá para parar e continuar depois pelo mesmo link, até{" "}
          {new Date(expiraEm).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.
        </p>
        <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
          Informe apenas acessos corporativos e oficiais da empresa. Não use contas e senhas pessoais.
        </p>
        <Button type="button" onClick={() => ir(0)} className="w-full" disabled={pendente}>
          Começar
        </Button>
      </div>
    );
  }

  const campo = (id: string, rotulo: string, valor: string, aoMudar: (v: string) => void, extra: Record<string, unknown> = {}) => (
    <div className="space-y-1">
      <Label htmlFor={id}>{rotulo}</Label>
      <Input id={id} value={valor} onChange={(e) => aoMudar(e.target.value)} {...extra} />
    </div>
  );

  return (
    <div className="space-y-5" ref={topo}>
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Etapa {passo + 1} de {PASSOS.length} · {PASSOS[passo]}
        </p>
        <div className="h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-all" style={{ width: `${((passo + 1) / PASSOS.length) * 100}%` }} />
        </div>
      </div>

      {passo === 0 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">A empresa</h2>
          {r.empresas.map((e, i) => (
            <div key={i} className="space-y-3 rounded-md border p-3">
              {r.empresas.length > 1 && <p className="text-sm font-medium">Empresa {i + 1}</p>}
              {campo(`empresa-nome-${i}`, "Nome da empresa", e.nome, (v) => mudarEmpresa(i, { nome: v }))}
              {campo(`empresa-cnpj-${i}`, "CNPJ", e.cnpj, (v) => mudarEmpresa(i, { cnpj: mascaraCnpj(v) }), { inputMode: "numeric", placeholder: "00.000.000/0001-00" })}
              {campo(`empresa-site-${i}`, "Site oficial (se tiver)", e.site, (v) => mudarEmpresa(i, { site: v }), { placeholder: "Endereço do site, se tiver", inputMode: "url" })}
              {campo(`empresa-telefone-${i}`, "Telefone fixo / central (se tiver)", e.telefone, (v) => mudarEmpresa(i, { telefone: v }), { inputMode: "tel" })}
              {campo(`empresa-whatsapp-${i}`, "WhatsApp comercial", e.whatsapp, (v) => mudarEmpresa(i, { whatsapp: v }), { inputMode: "tel" })}
              {campo(`empresa-email-${i}`, "E-mail geral de contato", e.email, (v) => mudarEmpresa(i, { email: v }), { type: "email" })}
              <div className="space-y-2">
                <Label>Endereços da loja ou unidades</Label>
                {e.enderecos.map((x, j) => (
                  <Input
                    key={j}
                    aria-label={`Endereço ${j + 1}`}
                    value={x}
                    placeholder="Rua, número, bairro, cidade"
                    onChange={(ev) => mudarEmpresa(i, { enderecos: e.enderecos.map((y, k) => (k === j ? ev.target.value : y)) })}
                  />
                ))}
                <Button type="button" size="sm" variant="ghost" onClick={() => mudarEmpresa(i, { enderecos: [...e.enderecos, ""] })}>
                  + Adicionar outro endereço
                </Button>
              </div>
            </div>
          ))}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => mudar({ empresas: [...r.empresas, { nome: "", cnpj: "", site: "", telefone: "", whatsapp: "", email: "", enderecos: [""] }] })}
          >
            + Outra empresa do mesmo grupo
          </Button>
        </section>
      )}

      {passo === 1 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Horários de atendimento</h2>
          <textarea
            aria-label="Horários de atendimento"
            rows={5}
            value={r.horarios}
            onChange={(e) => mudar({ horarios: e.target.value })}
            placeholder={"Segunda a Sexta: 08:00 às 18:00\nSábado: 08:00 às 13:00\nDomingos e feriados: fechado"}
            className="w-full rounded-md border bg-background p-2 text-sm"
          />
        </section>
      )}

      {passo === 2 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Responsáveis por setor</h2>
          <p className="text-sm text-muted-foreground">Marketing, comercial, financeiro, diretoria… com os contatos corporativos.</p>
          {r.responsaveis.map((x, i) => (
            <div key={i} className="grid gap-2 rounded-md border p-3 sm:grid-cols-2">
              {(["nome", "cargo", "whatsapp", "email"] as const).map((k) => (
                <Input
                  key={k}
                  aria-label={`${k === "nome" ? "Nome" : k === "cargo" ? "Cargo / setor" : k === "whatsapp" ? "WhatsApp" : "E-mail"} do responsável ${i + 1}`}
                  placeholder={k === "nome" ? "Nome" : k === "cargo" ? "Cargo / setor" : k === "whatsapp" ? "WhatsApp" : "E-mail"}
                  value={x[k]}
                  onChange={(e) => mudar({ responsaveis: r.responsaveis.map((y, j) => (j === i ? { ...y, [k]: e.target.value } : y)) })}
                />
              ))}
            </div>
          ))}
          <Button type="button" size="sm" variant="outline" onClick={() => mudar({ responsaveis: [...r.responsaveis, { nome: "", cargo: "", whatsapp: "", email: "" }] })}>
            + Outro responsável
          </Button>
        </section>
      )}

      {passo === 3 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Produtos ou serviços</h2>
          <textarea
            aria-label="Produtos ou serviços"
            rows={8}
            value={r.produtos}
            onChange={(e) => mudar({ produtos: e.target.value })}
            placeholder="Descreva os principais produtos, serviços, especialidades e diferenciais…"
            className="w-full rounded-md border bg-background p-2 text-sm"
          />
        </section>
      )}

      {passo === 4 && (
        <section className="space-y-4">
          <h2 className="text-lg font-semibold">Acessos às contas da empresa</h2>
          <p className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm">
            Nunca informe contas pessoais. As senhas são guardadas cifradas e só são gravadas quando você enviar o formulário — se sair antes,
            precisa digitá-las de novo.
          </p>
          {PLATAFORMAS_DO_FORMULARIO.map((pl) => {
            const a = r.acessos[pl];
            return (
              <div key={pl} className="space-y-2 rounded-md border p-3" data-testid={`acesso-${pl}`}>
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">{ROTULO_DA_PLATAFORMA[pl]}</p>
                  <label className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={a.naoTem} onChange={(e) => mudarAcesso(pl, { naoTem: e.target.checked })} />
                    Não tem
                  </label>
                </div>
                {!a.naoTem && (
                  <div className="grid gap-2">
                    {pl === "facebook" && (
                      <Input aria-label="Nome da página no Facebook" placeholder="Nome da página no Facebook" value={a.pagina} onChange={(e) => mudarAcesso(pl, { pagina: e.target.value })} />
                    )}
                    <Input aria-label={`Login do ${ROTULO_DA_PLATAFORMA[pl]}`} placeholder={PISTA[pl].login} value={a.login} onChange={(e) => mudarAcesso(pl, { login: e.target.value })} />
                    <Input
                      aria-label={`Senha do ${ROTULO_DA_PLATAFORMA[pl]}`}
                      placeholder="Senha"
                      type="password"
                      autoComplete="off"
                      value={a.senha}
                      onChange={(e) => mudarAcesso(pl, { senha: e.target.value })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {passo === 5 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">Arquivos</h2>
          {aceitaArquivos ? (
            <>
              <Envio
                token={token}
                categoria="identidade"
                titulo="Identidade visual"
                descricao="Logos (PDF, vetor ou alta qualidade), manual da marca, paleta, tipografia e materiais institucionais."
              />
              <Envio token={token} categoria="fotos" titulo="Fotos e gravações da empresa" descricao="Fotos do espaço, produtos, equipe e vídeos que já tiverem." />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">O envio de arquivos por aqui não está disponível agora. A agência vai pedir a identidade visual e as fotos depois.</p>
          )}
        </section>
      )}

      {passo === 6 && (
        <section className="space-y-2">
          <h2 className="text-lg font-semibold">Observações</h2>
          <textarea
            aria-label="Observações gerais"
            rows={5}
            value={r.observacoes}
            onChange={(e) => mudar({ observacoes: e.target.value })}
            placeholder="Algo mais que a agência precisa saber?"
            className="w-full rounded-md border bg-background p-2 text-sm"
          />
        </section>
      )}

      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}

      <div className={cn("flex gap-2", passo === 0 ? "justify-end" : "justify-between")}>
        {passo > 0 && (
          <Button type="button" variant="outline" disabled={pendente} onClick={() => ir(passo - 1)}>
            Voltar
          </Button>
        )}
        {passo < PASSOS.length - 1 ? (
          <Button type="button" disabled={pendente} onClick={() => ir(passo + 1)}>
            {pendente ? "Salvando…" : "Continuar"}
          </Button>
        ) : (
          <Button type="button" disabled={pendente} onClick={enviar}>
            {pendente ? "Enviando…" : "Enviar formulário"}
          </Button>
        )}
      </div>
    </div>
  );
}
