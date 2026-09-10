/**
 * Leitura do SSE do backend do Codex (compartilhada).
 *
 * DESCOBERTA MEDIDA (spike ao vivo, 2026-09-10): com `store:false` o evento
 * terminal (`response.completed`) chega com `output:[]` VAZIO — mesmo tendo
 * gerado tokens (`output_tokens:5`) e mesmo tendo entregado o texto nos
 * deltas (`response.output_text.delta`). Quem lesse só o terminal devolveria
 * resposta vazia com cara de sucesso: o pior tipo de bug deste produto (usage
 * conta, tela mostra nada, ninguém entende).
 *
 * Por isso esta função devolve as DUAS coisas: o `response` do terminal
 * (usage, id, modelo — metadados confiáveis) E o conteúdo remontado dos
 * deltas (texto + chamadas de tool). O chamador prefere o `output[]` do
 * terminal quando ele vem preenchido e cai nos deltas quando vem vazio.
 */
export interface ChamadaAcumulada {
  callId: string;
  name: string;
  arguments: string;
}

export interface LeituraSSE {
  resposta: Record<string, unknown> | null;
  texto: string;
  chamadas: ChamadaAcumulada[];
}

export async function lerRespostaSSE(sse: Response): Promise<LeituraSSE> {
  const leitor = sse.body!.getReader();
  const decodificador = new TextDecoder();
  let buffer = "";
  let resposta: Record<string, unknown> | null = null;
  let texto = "";
  const chamadas = new Map<string, ChamadaAcumulada>();
  let ultimaAberta: string | null = null;
  // O backend pode anunciar a mesma chamada duas vezes: um `added` só com
  // `id` (sem `call_id`, sem nome) e depois o `done` com `call_id`. Sem o
  // alias, virariam DUAS chamadas — uma fantasma sem nome, que quebra o turno
  // seguinte com 400 `empty_string` (medido ao vivo) e faz o AI SDK tentar
  // executar ferramenta `''`. O alias funde as duas na mesma entrada.
  const apelidoParaChave = new Map<string, string>();

  const garantirChamada = (id: string): ChamadaAcumulada => {
    const chave = apelidoParaChave.get(id) ?? id;
    let c = chamadas.get(chave);
    if (!c) {
      c = { callId: chave, name: "", arguments: "" };
      chamadas.set(chave, c);
    }
    return c;
  };

  const fundirApelido = (itemId: string | undefined, callId: string | undefined): string | null => {
    if (callId) {
      if (itemId && itemId !== callId) {
        const orfa = chamadas.get(itemId);
        const dona = garantirChamada(callId);
        if (orfa && orfa !== dona) {
          if (dona.name === "" && orfa.name !== "") dona.name = orfa.name;
          if (dona.arguments === "" && orfa.arguments !== "") dona.arguments = orfa.arguments;
          chamadas.delete(itemId);
        }
        apelidoParaChave.set(itemId, callId);
      }
      return callId;
    }
    // Sem call_id (delta com item_id cru): resolve o alias, senão o delta
    // funda uma segunda entrada em vez de somar na chamada certa.
    if (itemId) return apelidoParaChave.get(itemId) ?? itemId;
    return null;
  };

  const processarLinha = (linha: string): void => {
    if (!linha.startsWith("data: ")) return;
    const dado = linha.slice(6);
    if (dado === "[DONE]") return;
    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(dado) as Record<string, unknown>;
    } catch {
      return; // Chunk malformado: ignora.
    }
        const tipo = evt["type"];
        if (tipo === "response.output_text.delta" && typeof evt["delta"] === "string") {
          texto += evt["delta"] as string;
        } else if (tipo === "response.output_item.added") {
          const item = evt["item"] as Record<string, unknown> | undefined;
          if (item?.["type"] === "function_call") {
            const chave = fundirApelido(
              typeof item["id"] === "string" ? (item["id"] as string) : undefined,
              typeof item["call_id"] === "string" ? (item["call_id"] as string) : undefined,
            );
            if (chave) {
              const c = garantirChamada(chave);
              if (typeof item["name"] === "string" && item["name"] !== "") c.name = item["name"] as string;
              if (typeof item["arguments"] === "string" && item["arguments"] !== "") {
                c.arguments = item["arguments"] as string;
              }
              ultimaAberta = chave;
            }
          }
        } else if (tipo === "response.function_call_arguments.delta") {
          const chave =
            (typeof evt["item_id"] === "string" ? fundirApelido(evt["item_id"] as string, undefined) : null) ??
            ultimaAberta;
          if (chave && typeof evt["delta"] === "string") garantirChamada(chave).arguments += evt["delta"] as string;
        } else if (tipo === "response.output_item.done") {
          const item = evt["item"] as Record<string, unknown> | undefined;
          if (item?.["type"] === "function_call") {
            const chave = fundirApelido(
              typeof item["id"] === "string" ? (item["id"] as string) : undefined,
              typeof item["call_id"] === "string" ? (item["call_id"] as string) : undefined,
            );
            if (chave) {
              const c = garantirChamada(chave);
              if (typeof item["name"] === "string" && item["name"] !== "") c.name = item["name"] as string;
              if (typeof item["arguments"] === "string" && item["arguments"] !== "") {
                c.arguments = item["arguments"] as string;
              }
              ultimaAberta = null;
            }
          }
        } else if (tipo === "response.completed" || tipo === "response.incomplete" || tipo === "response.failed") {
          if (typeof evt["response"] === "object" && evt["response"] !== null) {
            resposta = evt["response"] as Record<string, unknown>;
          }
        }
  };

  try {
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      buffer += decodificador.decode(value, { stream: true });
      const linhas = buffer.split("\n");
      buffer = linhas.pop() ?? "";
      for (const linha of linhas) processarLinha(linha);
    }
    // O último fragmento pode não terminar em "\n" (chunk final cortado na
    // moldura): o que sobrou no buffer ainda é uma linha válida. Sem isto, um
    // terminal no fim do stream seria descartado e a chamada "vazia".
    if (buffer.trim() !== "") processarLinha(buffer);
  } finally {
    leitor.releaseLock();
  }
  return { resposta, texto, chamadas: [...chamadas.values()] };
}
