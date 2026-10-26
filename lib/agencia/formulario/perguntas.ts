/**
 * As perguntas do formulário de acesso (docs/agencia/SPEC-cofre-e-formulario.md,
 * F1 — as mesmas do formulário antigo, mapa › apêndice B) e as regras puras em
 * volta delas: rascunho sem senha (F3), validação do envio e a cópia legível que
 * vai para o Drive (F4) — também sem senha.
 */
import { z } from "zod";

export const PLATAFORMAS_DO_FORMULARIO = ["instagram", "facebook", "google", "tiktok"] as const;
export type PlataformaDoFormulario = (typeof PLATAFORMAS_DO_FORMULARIO)[number];

export const ROTULO_DA_PLATAFORMA: Record<PlataformaDoFormulario, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  google: "Google Meu Negócio",
  tiktok: "TikTok",
};

const texto = (max: number) => z.string().trim().max(max).default("");

export const empresaSchema = z.object({
  nome: texto(200),
  cnpj: texto(20),
  site: texto(300),
  telefone: texto(30),
  whatsapp: texto(30),
  email: texto(200),
  enderecos: z.array(z.string().trim().max(400)).max(30).default([]),
});

export const responsavelSchema = z.object({
  nome: texto(120),
  cargo: texto(120),
  whatsapp: texto(30),
  email: texto(200),
});

const acessoSchema = z.object({
  login: texto(200),
  senha: z.string().max(500).default(""),
  /** Facebook: nome da página. */
  pagina: texto(200),
  naoTem: z.boolean().default(false),
});

export const respostasSchema = z.object({
  empresas: z.array(empresaSchema).max(20).default([]),
  horarios: texto(2000),
  responsaveis: z.array(responsavelSchema).max(30).default([]),
  produtos: texto(10_000),
  acessos: z
    .object({
      instagram: acessoSchema.prefault({}),
      facebook: acessoSchema.prefault({}),
      google: acessoSchema.prefault({}),
      tiktok: acessoSchema.prefault({}),
    })
    .prefault({}),
  observacoes: texto(5000),
});

export type Respostas = z.output<typeof respostasSchema>;
export type EntradaDasRespostas = z.input<typeof respostasSchema>;

export function respostasVazias(): Respostas {
  return respostasSchema.parse({ empresas: [{ enderecos: [""] }], responsaveis: [{}] });
}

/** O rascunho e as respostas guardadas NUNCA levam senha (F3/F4). */
export function semSenhas(r: Respostas): Respostas {
  const acessos = Object.fromEntries(
    PLATAFORMAS_DO_FORMULARIO.map((p) => [p, { ...r.acessos[p], senha: "" }]),
  ) as Respostas["acessos"];
  return { ...r, acessos };
}

/** CNPJ com os dígitos verificadores certos. Aceita com ou sem máscara. */
export function cnpjValido(valor: string): boolean {
  const d = valor.replace(/\D/g, "");
  if (d.length !== 14 || /^(\d)\1{13}$/.test(d)) return false;
  const dv = (base: string, pesos: number[]) => {
    const soma = pesos.reduce((s, p, i) => s + Number(base[i]) * p, 0);
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };
  const p1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const p2 = [6, ...p1];
  return dv(d, p1) === Number(d[12]) && dv(d, p2) === Number(d[13]);
}

/** O que falta para poder enviar, na ordem das perguntas; lista vazia = pode enviar. */
export function pendenciasDoEnvio(r: Respostas): string[] {
  const falta: string[] = [];
  const principal = r.empresas[0];
  if (!principal?.nome) falta.push("o nome da empresa");
  r.empresas.forEach((e, i) => {
    const qual = r.empresas.length > 1 ? ` da empresa ${i + 1}` : "";
    if (e.cnpj && !cnpjValido(e.cnpj)) falta.push(`um CNPJ válido${qual}`);
    if (!e.whatsapp) falta.push(`o WhatsApp comercial${qual}`);
    if (!e.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.email)) falta.push(`um e-mail de contato válido${qual}`);
    if (!e.enderecos.some((x) => x.trim())) falta.push(`pelo menos um endereço${qual}`);
  });
  if (principal && !principal.cnpj) falta.push("o CNPJ");
  if (!r.horarios) falta.push("os horários de atendimento");
  if (!r.responsaveis.some((x) => x.nome)) falta.push("pelo menos um responsável");
  if (!r.produtos) falta.push("os produtos ou serviços");
  return falta;
}

/** A cópia legível para a subpasta "01 Formulário" do Drive — sem nenhuma senha. */
export function textoLegivel(r: Respostas, cliente: string, enviadoEm: Date): string {
  const quando = enviadoEm.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
  const linhas: string[] = [`Formulário de acesso — ${cliente}`, `Enviado em ${quando}`, ""];
  r.empresas.forEach((e, i) => {
    linhas.push(r.empresas.length > 1 ? `EMPRESA ${i + 1}` : "EMPRESA");
    linhas.push(`Nome: ${e.nome}`, `CNPJ: ${e.cnpj}`, `Site: ${e.site || "—"}`);
    linhas.push(`Telefone: ${e.telefone || "—"}`, `WhatsApp: ${e.whatsapp}`, `E-mail: ${e.email}`);
    e.enderecos.filter(Boolean).forEach((x, j) => linhas.push(`Endereço ${j + 1}: ${x}`));
    linhas.push("");
  });
  linhas.push("HORÁRIOS DE ATENDIMENTO", r.horarios, "");
  linhas.push("RESPONSÁVEIS");
  r.responsaveis.filter((x) => x.nome).forEach((x) => linhas.push(`- ${x.nome}${x.cargo ? ` (${x.cargo})` : ""} ${x.whatsapp} ${x.email}`.trim()));
  linhas.push("", "PRODUTOS E SERVIÇOS", r.produtos, "");
  linhas.push("ACESSOS (as senhas ficam só no cofre da central)");
  for (const p of PLATAFORMAS_DO_FORMULARIO) {
    const a = r.acessos[p];
    if (a.naoTem) linhas.push(`- ${ROTULO_DA_PLATAFORMA[p]}: não tem`);
    else if (a.login || a.pagina) linhas.push(`- ${ROTULO_DA_PLATAFORMA[p]}: ${[a.pagina, a.login].filter(Boolean).join(" · ")}`);
  }
  if (r.observacoes) linhas.push("", "OBSERVAÇÕES", r.observacoes);
  return linhas.join("\n");
}
