/** Catálogo versionado: unidade não depende das fotos privadas em saida/. */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Nicho } from "./jornada";
import dados from "./receitas-jornadas.json";

const Receita = z.object({
  jornada: z.string().regex(/^[a-z0-9-]+$/), pessoa: z.string().min(1),
  cenas: z.array(z.object({ id: z.string(), mensagem: z.string().min(1), resposta: z.string(), resposta_observada: z.boolean().optional(),
    acao_humana: z.enum(["need_lead_info", "escalate", "resolved"]).optional(),
    responde_ao_caso: z.boolean().optional(),
    tarefa_status: z.enum(["pending", "in_progress", "done", "cancelled"]).optional(),
    superficie: z.enum(["conversa", "nota", "passagem", "agenda", "negocio", "caso", "tarefa", "configuracao-externa", "fonte-externa"]) }).strict()),
}).strict();
export const receitas = z.array(Receita).parse(dados);
export type Receita = z.infer<typeof Receita>;
export type Historia = Nicho["jornadas"][number];
export const chaveDaCena = (jornada: string, cena: string) => `demo-${jornada}--historia--${cena}`;
export function lerHistorias() {
  const pasta = path.join(path.dirname(new URL(import.meta.url).pathname), "demonstracoes");
  return readdirSync(pasta).filter((f) => f.endsWith(".json")).sort()
    .flatMap((f) => Nicho.parse(JSON.parse(readFileSync(path.join(pasta, f), "utf8"))).jornadas);
}
/** Prefixo exclusivo, estável entre recapturas e independente da ordem de execução. */
export function idDaHistoria(jornada: string, entidade: number) {
  const n = receitas.findIndex((r) => r.jornada === jornada);
  if (n < 0) throw new Error("jornada sem receita");
  return `deca0000-0000-4000-8000-${String((n + 1) * 100 + entidade).padStart(12, "0")}`;
}

export const ROTULO_ACAO_HUMANA = { need_lead_info: "Preciso de info do cliente", escalate: "Não consigo — passar pra humano", resolved: "Concluí" } as const;

/** A cena de ação fotografa a escolha antes do envio. Na cena seguinte o efeito já existe. */
export function evolucaoDoCaso(receita: Receita, indice: number) {
  let status: "awaiting_human" | "awaiting_lead" | "resolved" | "escalated" = "awaiting_human";
  const eventos: Array<{ cena: number; kind: string; actor_kind: "human" | "lead"; human_action?: "need_lead_info" | "escalate" | "resolved"; body: string }> = [];
  for (const [i, cena] of receita.cenas.slice(0, indice + 1).entries()) {
    if (cena.responde_ao_caso) {
      if (status !== "awaiting_lead") throw new Error("resposta ao caso sem pergunta pendente");
      eventos.push({ cena: i, kind: "lead_provided", actor_kind: "lead", body: cena.mensagem });
      status = "awaiting_human";
    }
    if (!cena.acao_humana || (i === indice && cena.superficie === "caso")) continue;
    const acao = cena.acao_humana;
    eventos.push({ cena: i, kind: "human_replied", actor_kind: "human", human_action: acao, body: cena.resposta });
    status = acao === "need_lead_info" ? "awaiting_lead" : acao === "escalate" ? "escalated" : "resolved";
    eventos.push({ cena: i, kind: acao === "need_lead_info" ? "lead_asked" : status, actor_kind: "human", body: cena.resposta });
  }
  return { status, fechado: status === "resolved" || status === "escalated", eventos };
}

/** A versão pertence ao app fotografado; nunca é deduzida do checkout do curso. */
export function exigirVersaoDaFoto(valor: string | undefined): string {
  const versao = valor?.trim().replace(/^v/, "");
  if (!versao) throw new Error("defina CURSO_VERSAO_FOTOS com a versão real do app fotografado");
  return versao;
}
