/**
 * Operações sobre a árvore de passos da cadência. Todas são PURAS: recebem a
 * lista e devolvem uma nova, sem mutar a de entrada — o construtor guarda o
 * resultado no estado e o React compara por referência.
 */
import type { Passo, PassoRamo, TipoDePasso } from "./tipos";

/** Qual lista recebe o passo: a principal ou um dos lados de um ramo. */
export type IdDaLista = "raiz" | `${string}:sim` | `${string}:nao`;

export interface PontoDeInsercao {
  lista: IdDaLista;
  indice: number;
}

export function novoId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function passoVazio(tipo: TipoDePasso): Passo {
  const id = novoId();
  switch (tipo) {
    case "email":
      return { id, tipo, assunto: "", corpo: "", mesmaConversa: false };
    case "espera":
      return { id, tipo, diasUteis: 2 };
    case "ramo":
      return { id, tipo, condicao: { tipo: "abriu", vezes: 2, dentroDeDias: 3 }, sim: [], nao: [] };
    case "whatsapp":
      return { id, tipo, mensagem: "" };
    case "tarefa":
      return { id, tipo, titulo: "", prazoDias: 1 };
  }
}

function mapearListas(passos: Passo[], lista: IdDaLista, fn: (l: Passo[]) => Passo[]): Passo[] {
  if (lista === "raiz") return fn(passos);
  const [ramoId, lado] = lista.split(":") as [string, "sim" | "nao"];
  return passos.map((p) => {
    if (p.tipo !== "ramo") return p;
    if (p.id === ramoId) return { ...p, [lado]: fn(p[lado]) };
    return { ...p, sim: mapearListas(p.sim, lista, fn), nao: mapearListas(p.nao, lista, fn) };
  });
}

/**
 * Insere um passo. Um RAMO inserido no meio da sequência leva os passos que
 * vinham depois dele para o lado "não": depois de um ramo o caminho se divide
 * e não há mais "próximo passo" comum. "Não" é o lado que continua a sequência
 * original ("abriu 2x? sim → WhatsApp; não → segue o próximo e-mail").
 */
export function inserirPasso(passos: Passo[], ponto: PontoDeInsercao, novo: Passo): Passo[] {
  return mapearListas(passos, ponto.lista, (l) => {
    const i = Math.max(0, Math.min(ponto.indice, l.length));
    if (novo.tipo === "ramo") {
      return [...l.slice(0, i), { ...novo, nao: [...novo.nao, ...l.slice(i)] }];
    }
    return [...l.slice(0, i), novo, ...l.slice(i)];
  });
}

export function removerPasso(passos: Passo[], id: string): Passo[] {
  return passos
    .filter((p) => p.id !== id)
    .map((p) =>
      p.tipo === "ramo" ? { ...p, sim: removerPasso(p.sim, id), nao: removerPasso(p.nao, id) } : p,
    );
}

export function atualizarPasso(passos: Passo[], id: string, novo: Passo): Passo[] {
  return passos.map((p) => {
    if (p.id === id) return novo;
    if (p.tipo === "ramo") {
      return { ...p, sim: atualizarPasso(p.sim, id, novo), nao: atualizarPasso(p.nao, id, novo) };
    }
    return p;
  });
}

/** Cópia profunda com ids novos — duplicar um ramo duplica tudo o que há nele. */
export function clonarComIdsNovos(passo: Passo): Passo {
  if (passo.tipo === "ramo") {
    return {
      ...passo,
      id: novoId(),
      sim: passo.sim.map(clonarComIdsNovos),
      nao: passo.nao.map(clonarComIdsNovos),
    };
  }
  return { ...passo, id: novoId() };
}

export function duplicarPasso(passos: Passo[], id: string): Passo[] {
  const out: Passo[] = [];
  for (const p of passos) {
    if (p.tipo === "ramo" && p.id !== id) {
      out.push({ ...p, sim: duplicarPasso(p.sim, id), nao: duplicarPasso(p.nao, id) });
    } else {
      out.push(p);
    }
    if (p.id === id) out.push(clonarComIdsNovos(p));
  }
  return out;
}

export function encontrarPasso(passos: Passo[], id: string): Passo | null {
  for (const p of passos) {
    if (p.id === id) return p;
    if (p.tipo === "ramo") {
      const achado = encontrarPasso(p.sim, id) ?? encontrarPasso(p.nao, id);
      if (achado) return achado;
    }
  }
  return null;
}

/**
 * Numeração na ordem de leitura (de cima para baixo, "sim" antes de "não"),
 * igual à do card: "1. Enviar e-mail", "2. Aguardar"...
 */
export function numerarPassos(passos: Passo[]): Map<string, number> {
  const mapa = new Map<string, number>();
  let n = 0;
  const visitar = (lista: Passo[]) => {
    for (const p of lista) {
      mapa.set(p.id, ++n);
      if (p.tipo === "ramo") {
        visitar(p.sim);
        visitar(p.nao);
      }
    }
  };
  visitar(passos);
  return mapa;
}

export function todosOsPassos(passos: Passo[]): Passo[] {
  return passos.flatMap((p) => (p.tipo === "ramo" ? [p, ...todosOsPassos(p.sim), ...todosOsPassos(p.nao)] : [p]));
}

/** O e-mail que vem antes deste passo no mesmo caminho — para "mesma conversa". */
export function haEmailAntes(passos: Passo[], id: string): boolean {
  const procurar = (lista: Passo[], jaViuEmail: boolean): boolean | null => {
    let viu = jaViuEmail;
    for (const p of lista) {
      if (p.id === id) return viu;
      if (p.tipo === "ramo") {
        const r = procurar(p.sim, viu) ?? procurar(p.nao, viu);
        if (r !== null) return r;
      }
      if (p.tipo === "email") viu = true;
    }
    return null;
  };
  return procurar(passos, false) ?? false;
}

export type ProblemaDoPasso =
  | "Informe o assunto do e-mail."
  | "Escreva o corpo do e-mail."
  | "A espera precisa ser de pelo menos 1 dia útil."
  | "Escreva a mensagem do WhatsApp."
  | "Dê um título à tarefa."
  | "O ramo precisa de pelo menos um passo em um dos lados.";

/** Problemas que impedem ativar, por passo. Chaves são textos de `t()`. */
export function validarPassos(passos: Passo[]): Map<string, ProblemaDoPasso[]> {
  const erros = new Map<string, ProblemaDoPasso[]>();
  for (const p of todosOsPassos(passos)) {
    const lista: ProblemaDoPasso[] = [];
    if (p.tipo === "email") {
      if (!p.assunto.trim() && !p.mesmaConversa) lista.push("Informe o assunto do e-mail.");
      if (!p.corpo.trim()) lista.push("Escreva o corpo do e-mail.");
    }
    if (p.tipo === "espera" && !(p.diasUteis >= 1)) {
      lista.push("A espera precisa ser de pelo menos 1 dia útil.");
    }
    if (p.tipo === "whatsapp" && !p.mensagem.trim()) lista.push("Escreva a mensagem do WhatsApp.");
    if (p.tipo === "tarefa" && !p.titulo.trim()) lista.push("Dê um título à tarefa.");
    if (p.tipo === "ramo" && p.sim.length === 0 && p.nao.length === 0) {
      lista.push("O ramo precisa de pelo menos um passo em um dos lados.");
    }
    if (lista.length > 0) erros.set(p.id, lista);
  }
  return erros;
}

export function eRamo(p: Passo): p is PassoRamo {
  return p.tipo === "ramo";
}
