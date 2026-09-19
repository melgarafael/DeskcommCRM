import { readFileSync } from "node:fs";

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * QUANTO TEMPO RESTA PARA ESCREVER — do lado de quem atende.
 *
 * ─── O que faltava ─────────────────────────────────────────────────────────
 *
 * A regra da janela de 24h existe desde sempre em `windowRemainingMs`, e é
 * aplicada — mas o ÚNICO consumidor era o guardrail do agente de IA. Medido com
 * `grep`: nenhum componente, nenhuma rota do inbox, nenhum hook.
 *
 * O humano abria a conversa sem saber que restavam vinte minutos, escrevia
 * depois e recebia um `failed` com `131047`. Um número de cinco dígitos no
 * lugar de "a janela fechou; mande um modelo".
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que o relógio só apareça em canal que REALMENTE restringe (mostrá-lo onde não
 * muda nada ensina a ignorá-lo em todos); que a borda das 24h feche de verdade;
 * e que a tela não decida isso sozinha — quem sabe da regra é o seam.
 */
import { JanelaSelo } from "@/components/inbox/JanelaSelo";
import { estadoDaJanela, formatarDecorrido, formatarRestante } from "@/lib/channels/janela";

const AGORA = new Date("2026-08-10T18:00:00Z");
const hMenos = (h: number) => new Date(AGORA.getTime() - h * 3_600_000).toISOString();

describe("o estado da janela", () => {
  it("canal SEM restrição não tem relógio — inventá-lo ensina a ignorá-lo", () => {
    // O número por QR aceita texto livre a qualquer hora.
    expect(estadoDaJanela("waha", hMenos(48), AGORA)).toEqual({ tipo: "sem_restricao" });
  });

  it("canal com restrição e cliente recente: aberta, com o que resta", () => {
    const e = estadoDaJanela("zernio", hMenos(1), AGORA);
    expect(e.tipo).toBe("aberta");
    if (e.tipo === "aberta") expect(Math.round(e.restanteMs / 3_600_000)).toBe(23);
  });

  it("passadas as 24h: fechada, e diz HÁ QUANTO fechou", () => {
    // Não é "desde a última mensagem": os dois diferem em exatamente 24h, e a
    // pergunta do operador é "passei muito?".
    const e = estadoDaJanela("zernio", hMenos(25), AGORA);
    expect(e.tipo).toBe("fechada");
    if (e.tipo === "fechada") expect(Math.round((e.fechadaHaMs ?? 0) / 3_600_000)).toBe(1);
  });

  it("em 24h EXATAS já fechou — a borda é exclusiva, como a da plataforma", () => {
    const e = estadoDaJanela("zernio", hMenos(24), AGORA);
    expect(e.tipo).toBe("fechada");
    if (e.tipo === "fechada") expect(e.fechadaHaMs).toBe(0);
  });

  it("cliente que NUNCA escreveu: fechada SEM prazo — nunca houve fechamento", () => {
    // Fail-closed, e `null` em vez de um número: inventar "fechada há 3 dias"
    // descreveria um prazo que nunca correu.
    expect(estadoDaJanela("zernio", null, AGORA)).toEqual({ tipo: "fechada", fechadaHaMs: null });
  });

  it("sem canal resolvido não trava nada", () => {
    // Inventar "fechada" barraria um envio que talvez saísse sem problema.
    expect(estadoDaJanela(null, hMenos(1), AGORA)).toEqual({ tipo: "sem_restricao" });
  });
});

describe("como o tempo é escrito", () => {
  it("horas e minutos quando falta muito", () => {
    expect(formatarRestante(23 * 3_600_000 + 40 * 60_000)).toBe("23h 40m");
  });

  it("só minutos abaixo de uma hora", () => {
    expect(formatarRestante(40 * 60_000)).toBe("40m");
  });

  it('abaixo de um minuto NÃO vira "0m" — que se lê como fechada', () => {
    expect(formatarRestante(30_000)).toBe("menos de 1m");
  });
});

describe("quanto tempo passou", () => {
  it("uma unidade só — já fechou, e o minuto não muda a saída", () => {
    expect(formatarDecorrido(3 * 86_400_000)).toBe("3d");
    expect(formatarDecorrido(5 * 3_600_000)).toBe("5h");
    expect(formatarDecorrido(20 * 60_000)).toBe("20m");
  });

  it("recém-fechada não vira \"0m\"", () => {
    expect(formatarDecorrido(30_000)).toBe("agora mesmo");
  });
});

describe("o selo na tela", () => {
  it("não renderiza nada em canal sem restrição", () => {
    const { container } = render(<JanelaSelo provider="waha" lastInboundAt={hMenos(1)} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("mostra o tempo restante quando aberta", () => {
    render(<JanelaSelo provider="zernio" lastInboundAt={new Date(Date.now() - 3_600_000).toISOString()} />);
    expect(screen.getByText(/Janela \d+h/)).toBeInTheDocument();
  });

  it("diz o que fazer quando fechada, não só que fechou", () => {
    // "Janela fechada" sozinho deixa o operador sem saída. O texto nomeia a
    // saída que existe: modelo aprovado.
    render(<JanelaSelo provider="zernio" lastInboundAt={new Date(Date.now() - 30 * 3_600_000).toISOString()} />);
    expect(screen.getByText(/só modelo/i)).toBeInTheDocument();
  });

  it("e diz HÁ QUANTO fechou — 20 minutos e um mês pedem decisões diferentes", () => {
    render(<JanelaSelo provider="zernio" lastInboundAt={new Date(Date.now() - 30 * 3_600_000).toISOString()} />);
    expect(screen.getByText(/fechada há 6h/i)).toBeInTheDocument();
  });

  it("cliente que nunca escreveu não ganha um prazo inventado", () => {
    render(<JanelaSelo provider="zernio" lastInboundAt={null} />);
    expect(screen.getByText(/nunca escreveu/i)).toBeInTheDocument();
  });
});

describe("os elos que somem sem barulho", () => {
  it("a regra mora no SEAM, não na tela", () => {
    // Um `if (provider === "zernio")` no componente é o que o invariante 1 da
    // doutrina proíbe, e o `lint:channels` reprova.
    const fonte = readFileSync("components/inbox/JanelaSelo.tsx", "utf8");
    expect(fonte).toMatch(/estadoDaJanela/);
    expect(fonte, "a tela está decidindo por provider").not.toMatch(/"zernio"|"meta_cloud"|"waha"/);
  });

  it("a cabeçalho MONTA o selo — a regra sozinha não mostra nada", () => {
    const fonte = readFileSync("components/inbox/ConversationHeader.tsx", "utf8");
    // A tag no INÍCIO da linha, não em qualquer lugar dela: a primeira versão
    // deste caso aceitava `{null && <JanelaSelo` — o sabote de desmontar o selo
    // passou verde, porque a string continuava lá.
    expect(fonte, "o selo não é montado, só mencionado").toMatch(/\n\s*<JanelaSelo\b/);
    expect(fonte).toMatch(/lastInboundAt=\{conversation\.last_inbound_at\}/);
  });

  it("o `provider` chega pela consulta — sem ele o selo nunca aparece", () => {
    // A coluna fora do `select` não chega, e o cast do embed faz isso NÃO ser
    // erro de tipo: ficaria `undefined` e todo canal viraria "sem restrição".
    const fonte = readFileSync("app/api/v1/conversations/_handler.ts", "utf8");
    expect(fonte).toMatch(/channel_sessions:channel_session_id \(phone_number, display_name, provider[,)]/);
  });

  it("o composer é BLOQUEADO quando a janela fechou", () => {
    // Pedido explícito do dono: se não dá para enviar, que não deixe tentar.
    // Reusa o `blockedReason` que já existe — um segundo mecanismo de bloqueio
    // divergiria, e o segundo esqueceria de cobrir o áudio ou o anexo.
    const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    expect(fonte).toMatch(/motivoDaJanela/);
    // Por prop PRÓPRIA, não por `blockedReason`: a primeira versão passava por
    // ali e levava a nota interna junto, que nunca chega ao cliente.
    expect(fonte, "o motivo da janela não chega ao composer").toMatch(
      /janelaFechada=\{motivoDaJanela\}/,
    );
  });

  it("e o bloqueio VENCE sozinho com a aba aberta", () => {
    // Sem relógio, quem deixa o inbox aberto a tarde inteira seguiria com o
    // composer liberado numa conversa que já venceu.
    const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    expect(fonte).toMatch(/setAgoraJanela/);
    expect(fonte).toMatch(/setInterval/);
  });

  it("a nota interna NÃO é barrada pela janela", () => {
    // Regressão que eu mesmo criei: o primeiro bloqueio usou `blockedReason`, e
    // ele desabilita o composer inteiro. A nota interna nunca chega ao cliente —
    // a regra da plataforma não a alcança —, e é justamente onde o atendente
    // registra por que a conversa esfriou.
    const fonte = readFileSync("components/inbox/Composer.tsx", "utf8");
    expect(fonte).toMatch(/janelaFechada/);
    expect(fonte, "a janela está barrando a nota").toMatch(
      /mode === "reply" && !!janelaFechada/,
    );
  });

  it("barrar OFERECE a saída — o seletor de modelo aprovado", () => {
    // Barrar sem oferecer deixa o operador sem caminho: ele lê "só modelo
    // aprovado sai daqui" e não tem como mandar um.
    const fonte = readFileSync("components/inbox/InboxLayout.tsx", "utf8");
    // A GUARDA junto com a tag: `{false && (` deixava a tag na linha seguinte e
    // o caso passava verde com a saída removida da tela.
    expect(fonte).toMatch(/\{motivoDaJanela && \(\s*\n\s*<JanelaFechadaAviso/);
    const aviso = readFileSync("components/inbox/JanelaFechadaAviso.tsx", "utf8");
    expect(aviso).toMatch(/type: "template"/);
    expect(aviso).toMatch(/template_name/);
  });

  it("o modelo sai pelo CANAL da conversa, não sempre pela Meta", () => {
    // Medido: `sendTemplateForSession` lê `META_PHONE_NUMBER_ID` do ambiente, e
    // template de qualquer canal saía pelo número da Meta. Para o canal
    // intermediado isso é a mensagem saindo pelo número ERRADO — pior que falhar.
    const fonte = readFileSync("app/api/v1/messages/_handler.ts", "utf8");
    expect(fonte).toMatch(/adapter\.sendTemplate/);
    expect(fonte.indexOf("adapter.sendTemplate")).toBeLessThan(
      fonte.indexOf("sendTemplateForSession(supabase"),
    );
  });

  it("a conta é a MESMA do guardrail do agente", () => {
    // Duas contas para a mesma pergunta divergem: a tela diria "aberta" e o
    // envio seria recusado, ou o contrário — e ninguém saberia em qual acreditar.
    const fonte = readFileSync("lib/channels/janela.ts", "utf8");
    expect(fonte).toMatch(/from "@\/lib\/agent-engine\/guardrails\/messaging-window"/);
    expect(fonte).toMatch(/windowRemainingMs\(/);
  });
});

it("rede social com janela fechada orienta aguardar o cliente sem oferecer modelo", () => {
  render(<JanelaSelo provider="zernio_social" lastInboundAt={null} />);
  expect(screen.getByText(/aguardando o cliente/)).toBeInTheDocument();
  expect(screen.queryByText(/só modelo/)).not.toBeInTheDocument();
});
