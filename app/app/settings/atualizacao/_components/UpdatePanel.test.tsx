import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { irAoDesafioDeMfa } from "@/lib/auth/ir-ao-desafio-de-mfa";

import { UpdatePanel } from "./UpdatePanel";
import type { SystemVersion } from "@/hooks/system/useSystemVersion";

/**
 * O botão "Atualizar agora" morava DEPOIS do "O que muda" — com várias versões
 * acumuladas (o changelog "cumprida", medido pelo dono numa instalação
 * atrasada), quem só queria clicar precisava rolar a tela inteira antes de
 * achar o botão. Ele subiu para antes do changelog; os avisos que pesam na
 * decisão (`off_release`, `requires_attention` e o de histórico incompleto)
 * continuam antes DELE.
 */

const dadosVersao = vi.hoisted(() => ({ atual: null as SystemVersion | null }));

vi.mock("@/hooks/system/useSystemVersion", () => ({
  useSystemVersion: () => ({ data: dadosVersao.atual, isError: false }),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { post: vi.fn(), get: vi.fn() } }));
vi.mock("@/lib/auth/ir-ao-desafio-de-mfa", () => ({ irAoDesafioDeMfa: vi.fn() }));

function renderTela(dados: SystemVersion) {
  dadosVersao.atual = dados;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <UpdatePanel />
    </QueryClientProvider>,
  );
}

const CHANGELOG_LONGO: SystemVersion = {
  current_version: "1.0.0",
  is_owner: true,
  latest_version: "1.5.0",
  update_available: true,
  agent_online: true,
  notes: {
    requires_attention: [],
    complete: true,
    sections: Array.from({ length: 8 }, (_, i) => ({
      version: `1.${5 - i}.0`,
      body: `Corpo bem longo da versão 1.${5 - i}.0. `.repeat(20),
    })),
  },
  run: null,
};

describe("tela de atualização — o botão não fica atrás do changelog", () => {
  it("'Atualizar agora' aparece ANTES de 'O que muda', mesmo com changelog extenso", () => {
    renderTela(CHANGELOG_LONGO);

    const botao = screen.getByRole("button", { name: "Atualizar agora" });
    const changelog = screen.getByText("O que muda");

    expect(
      Boolean(botao.compareDocumentPosition(changelog) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("o aviso 'Requer atenção' continua ANTES do botão — ele pesa na decisão de clicar", () => {
    renderTela({
      ...CHANGELOG_LONGO,
      notes: {
        ...CHANGELOG_LONGO.notes!,
        requires_attention: [{ version: "1.4.0", texto: "Rode o comando de migração antes." }],
      },
    });

    const aviso = screen.getByText("Requer atenção", { exact: false });
    const botao = screen.getByRole("button", { name: "Atualizar agora" });

    expect(Boolean(aviso.compareDocumentPosition(botao) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
  });

  it("o aviso de histórico incompleto continua ANTES do botão — com ele, o 'Requer atenção' pode estar faltando itens", () => {
    renderTela({
      ...CHANGELOG_LONGO,
      notes: { ...CHANGELOG_LONGO.notes!, complete: false },
    });

    const aviso = screen.getByText("Este histórico começa na versão", { exact: false });
    const botao = screen.getByRole("button", { name: "Atualizar agora" });

    expect(Boolean(aviso.compareDocumentPosition(botao) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
  });
});

/**
 * #2755 (item 3): O "SEM SMTP" APARECE NA TELA, E NÃO SÓ NO LOG.
 *
 * Até aqui o painel de atualização exibia o log do `update.sh` e mais nada.
 * Numa instalação sem SMTP, quem administrava descobria que o e-mail não saía
 * quando alguém reclamava de não ter recebido a recuperação de senha. O aviso
 * passou a ser lido pelo próprio painel, no caminho de leitura que já existe
 * (`GET /api/v1/system/version`) e com a régua da ação que sofre com isso
 * (`semSmtpNaInstalacao`) — sem campo novo de banco.
 *
 * Os DOIS lados importam: o aviso APARECE quando falta SMTP e NÃO aparece
 * quando o campo não veio (quem não é dono, ou instalação fora do servidor
 * único). Ausente é "não sei", e sobre o que não se sabe esta tela não afirma.
 */
describe("tela de atualização — o aviso de 'sem SMTP'", () => {
  const SEM_SMTP: SystemVersion = {
    current_version: "1.0.0",
    is_owner: true,
    latest_version: "1.0.0",
    update_available: false,
    agent_online: true,
    smtp_configured: false,
    notes: null,
    run: null,
  };

  it("⭐ sem SMTP: o aviso aparece, diz o que não sai e onde configurar", () => {
    renderTela(SEM_SMTP);

    expect(screen.getByTestId("aviso-sem-smtp")).toBeInTheDocument();
    expect(screen.getByText("Sem SMTP configurado", { exact: false })).toBeInTheDocument();
    expect(
      screen.getByText(/Configure o servidor de e-mail em \/admin\/email/),
    ).toBeInTheDocument();
    // O SMTP de /admin/email só chega ao serviço de login pelo update.sh
    // (`sincronizar_smtp_do_gotrue`); sem o passo, o aviso some e o e-mail segue sem sair.
    expect(screen.getByTestId("aviso-sem-smtp").textContent).toMatch(/update\.sh/);
    // Sem SMTP, convite e LGPD ainda saem pela Resend (lib/email/roteador.ts):
    // o aviso fala do serviço de login, nunca de "nenhum e-mail".
    expect(screen.getByTestId("aviso-sem-smtp").textContent).not.toMatch(/e-mail nenhum/);
  });

  it("o aviso vem ANTES do conteúdo — ele é da instalação, não do estado da atualização", () => {
    renderTela(SEM_SMTP);

    const aviso = screen.getByTestId("aviso-sem-smtp");
    const conteudo = screen.getByText("É a mais recente. Não há nada a fazer.");

    expect(
      Boolean(aviso.compareDocumentPosition(conteudo) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("atravessa o estado de espera: o dono vê o aviso mesmo com atualização em curso", () => {
    renderTela({
      ...SEM_SMTP,
      latest_version: "1.5.0",
      update_available: true,
      run: {
        id: "66666666-6666-4666-8666-666666666666",
        status: "dispatched",
        last_step: null,
        from_version: "1.0.0",
        to_version: "1.5.0",
        log_tail: "",
        dispatched_at: new Date().toISOString(),
      },
    });

    expect(screen.getByText("Pedido enviado — esperando o servidor pegar")).toBeInTheDocument();
    expect(screen.getByTestId("aviso-sem-smtp")).toBeInTheDocument();
  });

  it("⭐ CONTROLE — COM SMTP configurado: nenhum aviso", () => {
    renderTela({ ...SEM_SMTP, smtp_configured: true });

    expect(screen.queryByTestId("aviso-sem-smtp")).toBeNull();
  });

  it("campo ausente (quem não é dono, ou fora do servidor único): a tela não afirma nada", () => {
    const semCampo: SystemVersion = { ...SEM_SMTP };
    delete semCampo.smtp_configured;

    renderTela(semCampo);

    expect(screen.queryByTestId("aviso-sem-smtp")).toBeNull();
  });
});

/**
 * O #1040: a rodada de atualização sabe que houve disputa de banco, e a tela
 * CONTA isso — em português de gente — e diz onde está o detalhe. Até aqui o
 * aviso morria só no `.update.log`, no disco da VPS, e quem apertou o botão
 * via "sucesso" sem saber que a base estava ocupada.
 */
function rodada(overrides: Partial<NonNullable<SystemVersion["run"]>> = {}): SystemVersion {
  return {
    current_version: "1.0.0",
    is_owner: true,
    latest_version: "1.1.0",
    update_available: false,
    agent_online: true,
    just_updated: true,
    notes: null,
    run: {
      id: "55555555-5555-4555-8555-555555555555",
      status: "success",
      last_step: "app",
      from_version: "1.0.0",
      to_version: "1.1.0",
      log_tail: "",
      rodada_do_banco: { disputa: true, retentativas: 1, passada: 2 },
      ...overrides,
    },
  };
}

describe("tela de atualização — a rodada conta a disputa do banco", () => {
  it("terminou com disputa: a tela mostra o resumo em português de gente", () => {
    renderTela(rodada());

    // Não é log cru nem código: é frase. Os números vêm do estado persistido.
    expect(
      screen.getByText(
        /O banco estava em disputa com o sistema no ar: foram duas passadas e uma retentativa/,
      ),
    ).toBeInTheDocument();
  });

  it("e diz ONDE está o detalhe — o .update.log, que até aqui era o único lugar que sabia", () => {
    renderTela(rodada());

    const ponteiro = screen.getByText(/\.update\.log/);
    expect(ponteiro.textContent).toContain("na pasta do projeto no servidor");
  });

  it("o resumo e o ponteiro vêm JUNTOS — apontar o log sem contar o resumo seria jogar o problema pra trás da tela", () => {
    renderTela(rodada());

    const resumo = screen.getByText(/duas passadas/);
    const ponteiro = screen.getByText(/\.update\.log/);
    expect(
      Boolean(resumo.compareDocumentPosition(ponteiro) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);
  });

  it("rodada medida SEM disputa: conta que foi de uma vez e não aponta log nenhum", () => {
    // O controle do issue: aviso sem motivo vira ruído, e quem para de ler o
    // ruído para de ler o aviso. Endereço de log é linha só quando há o que ler.
    renderTela(rodada({ rodada_do_banco: { disputa: false, retentativas: 0, passada: 1 } }));

    expect(screen.getByText(/atualizou de uma vez, na primeira passada/)).toBeInTheDocument();
    expect(screen.queryByText(/\.update\.log/)).not.toBeInTheDocument();
  });

  it("ninguém mediu a rodada: a tela fica calada — nem resumo, nem ponteiro", () => {
    renderTela(rodada({ rodada_do_banco: null }));

    expect(screen.queryByText(/disputa com o sistema/)).not.toBeInTheDocument();
    expect(screen.queryByText(/\.update\.log/)).not.toBeInTheDocument();
  });

  it("no desfecho em que o servidor voltou atrás também: quem clicou tem o direito de saber", () => {
    renderTela({
      ...rodada({
        status: "failed_rolled_back",
        rodada_do_banco: { disputa: true, retentativas: 2, passada: 3 },
      }),
      just_updated: false,
      update_available: true,
    });

    expect(screen.getByText(/foram 3 passadas e 2 retentativas/)).toBeInTheDocument();
    expect(screen.getByText(/\.update\.log/)).toBeInTheDocument();
  });
});

/**
 * #2757 (ajuste 3): a volta que o agente fez SOZINHO aparece na tela.
 *
 * Antes disto o painel mostrava a versão mudar sem explicação — o registro da
 * volta automática ficava só no `.update-agent.log` da VPS. O aviso nomeia as
 * três coisas que o dono precisa saber: para onde voltou, a hora e o porquê, em
 * linguagem de gente (nada de `healthcheck`, código de saída ou nome de campo).
 *
 * CONTROLE: uma volta PEDIDA pela tela não é "sozinho" e não ganha o aviso — o
 * texto de sempre ("Voltei o sistema...") continua sendo o certo ali.
 */
describe("tela de atualização — o aviso da volta automática (#2757)", () => {
  const QUANDO = "2026-10-16T17:10:00.000Z";

  function volta(overrides: Partial<NonNullable<SystemVersion["run"]>> = {}): SystemVersion {
    return {
      current_version: "1.4.2",
      is_owner: true,
      latest_version: "1.5.0",
      update_available: true,
      agent_online: true,
      notes: null,
      run: {
        id: "77777777-7777-4777-8777-777777777777",
        status: "failed_rolled_back",
        last_step: "app",
        from_version: "1.4.2",
        to_version: "1.5.0",
        log_tail: "o site não respondeu em 2 healthchecks seguidos logo depois da atualização",
        finished_at: QUANDO,
        volta_automatica: true,
        ...overrides,
      },
    };
  }

  it("⭐ diz para onde voltou, a hora e o porquê — em linguagem de gente", () => {
    renderTela(volta());

    const aviso = screen.getByTestId("volta-automatica");
    const texto = aviso.textContent ?? "";
    // A hora é a do navegador de quem lê; o teste calcula a mesma, sem fixar fuso.
    const d = new Date(QUANDO);
    const hora = `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;

    expect(texto).toContain("voltou sozinho");
    expect(texto).toContain("1.4.2");
    expect(texto).toContain("1.5.0");
    expect(texto).toContain(hora);
    expect(texto).toMatch(/site não respondeu/);
    // O que a tela NÃO pode fazer: despejar o jargão do log em quem só quer saber o que houve.
    expect(texto).not.toMatch(/healthcheck|update\.sh|exit|rc=/);
  });

  it("sem a hora (run antigo, sem finished_at): o aviso sai sem inventar horário", () => {
    renderTela(volta({ finished_at: null }));

    const texto = screen.getByTestId("volta-automatica").textContent ?? "";
    expect(texto).toMatch(/voltou sozinho/);
    expect(texto).not.toMatch(/\d{2}h\d{2}/);
  });

  it("CONTROLE — volta pedida pela tela: nenhum aviso de 'sozinho'", () => {
    renderTela(volta({ volta_automatica: false }));

    expect(screen.queryByTestId("volta-automatica")).toBeNull();
    expect(
      screen.getByText("Voltei o sistema para a versão", { exact: false }),
    ).toBeInTheDocument();
  });

  it("⭐ a volta que TERMINOU não oferece o botão de voltar — o alvo dele já é a versão no ar", () => {
    // #3271: com o desfecho no próprio recado, a volta que terminou bem (chega
    // como `failed_rolled_back`) sabe que a versão anterior É a que está no ar.
    // O botão ali aponta para essa mesma versão: clicar só derrubaria o sistema
    // por ~2 min para reinstalar o que já roda. A frase de "está no ar agora"
    // CONTINUA, porque neste desfecho ela tem base — quem a perde é o caso
    // abaixo.
    renderTela(volta());

    expect(screen.queryByRole("button", { name: "Voltar para a versão anterior" })).toBeNull();
    expect(screen.getByText(/que é a que está no ar agora/)).toBeInTheDocument();
  });

  it("⭐ a volta que NÃO terminou mantém o botão e para de afirmar que a versão está no ar", () => {
    // O outro lado do mesmo campo: com `ok:false` a rota grava `failed`, e é
    // por este ramo que a tela passa — o desfecho em que ela NÃO sabe em que
    // versão o sistema ficou. A frase "é a que está no ar agora" some (não se
    // sustenta) e a saída de um clique fica: é exatamente o caso em que
    // esconder o botão tiraria a saída de quem precisa. `volta_automatica`
    // segue verdadeiro (a volta não foi pedida pela tela) — quem decide o ramo
    // é o status, nunca a marca de autoria.
    renderTela(volta({ status: "failed" }));

    expect(
      screen.getByRole("button", { name: "Voltar para a versão anterior" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/que é a que está no ar agora/)).toBeNull();
    expect(screen.getByText(/o sistema pode estar rodando a versão/)).toBeInTheDocument();
  });
});

/**
 * #3488 — O RETRATO VELHO NÃO FALA PELA INSTALAÇÃO.
 *
 * Medido em produção: o host parou de bater às 11h45 (DNS sem upstream), a
 * v1.90.0 saiu às 14h07 e às 16h a tela dizia "Você está na versão v1.89.0 —
 * É a mais recente. Não há nada a fazer." O retrato em `system_version` é o
 * último que o heartbeat conseguiu gravar: `latest_version` vazio,
 * `compare_failed` falso e `has_known_release` verdadeiro é, ao mesmo tempo, o
 * estado de "conferi agora" e o de "parei de conferir há horas". A única
 * válvula para dúvida era `agent_online`, e ela só abre às 24h.
 *
 * Os DOIS sentidos são o assunto — a tela não pode afirmar mais do que sabe,
 * nem menos:
 *
 *   (a) retrato VELHO não pode dizer "é a mais recente";
 *   (b) retrato FRESCO pode (o controle: sem ele, "nunca afirmar nada" também
 *       passaria, e a tela ficaria inútil);
 *   (c) retrato velho com versão nova ANUNCIADA não perde o botão — ali a
 *       informação antiga ainda basta para agir.
 */
describe("tela de atualização — retrato velho do host (#3488)", () => {
  const ULTIMA_BATIDA = "2026-10-26T14:45:02.000Z";

  /** O estado exato de produção durante a janela das 4h15 de silêncio. */
  const RETRATO_VELHO: SystemVersion = {
    current_version: "1.89.0",
    is_owner: true,
    latest_version: "",
    update_available: false,
    has_known_release: true,
    compare_failed: false,
    // A válvula antiga: menos de 24h, então o agente ainda conta como "online".
    agent_online: true,
    agent_stale: true,
    agent_last_seen_at: ULTIMA_BATIDA,
    notes: null,
    run: null,
  };

  it("⭐ (a) retrato velho NÃO diz 'é a mais recente' — diz que não sabe", () => {
    renderTela(RETRATO_VELHO);

    expect(screen.queryByText("É a mais recente. Não há nada a fazer.")).toBeNull();
    expect(screen.queryByText(/Você está na versão/)).toBeNull();

    expect(screen.getByText("Não sei se há versão nova")).toBeInTheDocument();
    expect(screen.getByText(/não posso afirmar que esta é a mais recente/)).toBeInTheDocument();
    // A idade da informação é dita, não escondida: a hora é a da última batida
    // que o retrato registrou (renderizada no fuso de quem lê).
    const d = new Date(ULTIMA_BATIDA);
    const hora = `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`;
    expect(screen.getByText(hora)).toBeInTheDocument();
    // O retrato antigo orienta conferir a conexão; ainda não é agente offline.
    expect(screen.queryByText(/hostgator-setup-kit\/update\.sh/)).toBeNull();
    expect(screen.getByText(/verifique a conexão do servidor com a internet/)).toBeInTheDocument();
  });

  it("agente offline preserva o caminho manual, mesmo com retrato velho", () => {
    renderTela({ ...RETRATO_VELHO, agent_online: false });

    expect(screen.getByText("Atualização automática indisponível")).toBeInTheDocument();
    expect(screen.getByText(/hostgator-setup-kit\/update\.sh/)).toBeInTheDocument();
    expect(screen.queryByText("Não sei se há versão nova")).toBeNull();
  });

  it("⭐ (b) CONTROLE — retrato fresco PODE dizer 'é a mais recente'", () => {
    renderTela({ ...RETRATO_VELHO, agent_stale: false });

    expect(screen.getByText("É a mais recente. Não há nada a fazer.")).toBeInTheDocument();
    expect(screen.queryByText("Não sei se há versão nova")).toBeNull();
  });

  it("(c) CONTROLE — retrato velho com versão nova anunciada mantém o botão", () => {
    // O que o retrato velho não sustenta é "não há nada a fazer". Que existe uma
    // versão mais nova, ele sustenta — e esconder o botão aqui tiraria a única
    // saída de quem está atrasado.
    renderTela({
      ...RETRATO_VELHO,
      latest_version: "1.90.0",
      update_available: true,
    });

    expect(screen.getByRole("button", { name: "Atualizar agora" })).toBeInTheDocument();
    expect(screen.queryByText("Não sei se há versão nova")).toBeNull();
  });

  it("retrato velho ainda diz qual é a versão instalada — só não afirma que ela é a última", () => {
    renderTela(RETRATO_VELHO);

    expect(screen.getByText(/Versão instalada:/)).toBeInTheDocument();
  });
});

/**
 * `POST /api/v1/system/update` exige o código provado nesta sessão
 * (`requirePlatformAdminEscrita`). O dono que entrou pelo dispositivo confiável
 * — ou cujo código venceu com a tela aberta — recebia 403 `mfa_required` e a
 * frase "tente de novo", que não resolve: a tela leva ao desafio (#3200).
 */
describe("tela de atualização — recusa por falta do código leva ao desafio", () => {
  const SEM_CODIGO = new ApiError(403, "mfa_required", undefined, "req-1", "Confirme o código.");

  const FALHOU: SystemVersion = {
    current_version: "1.4.2",
    is_owner: true,
    latest_version: "1.5.0",
    update_available: true,
    agent_online: true,
    notes: null,
    run: {
      id: "88888888-8888-4888-8888-888888888888",
      status: "failed_rolled_back",
      last_step: "app",
      from_version: "1.4.2",
      to_version: "1.5.0",
      log_tail: "",
      finished_at: null,
      volta_automatica: false,
    },
  };

  function recusar(erro: ApiError) {
    vi.mocked(irAoDesafioDeMfa).mockReset();
    vi.mocked(apiClient.post).mockReset();
    vi.mocked(apiClient.post).mockRejectedValue(erro);
  }

  it("⭐ 'Atualizar agora' recusado por mfa_required leva ao código", async () => {
    recusar(SEM_CODIGO);
    renderTela(CHANGELOG_LONGO);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar agora" }));

    await waitFor(() => expect(irAoDesafioDeMfa).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Não consegui iniciar a atualização", { exact: false })).toBeNull();
  });

  it("⭐ 'Voltar para a versão anterior' recusado por mfa_required leva ao código", async () => {
    recusar(SEM_CODIGO);
    renderTela(FALHOU);
    fireEvent.click(screen.getByRole("button", { name: "Voltar para a versão anterior" }));

    await waitFor(() => expect(irAoDesafioDeMfa).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Não consegui pedir a volta", { exact: false })).toBeNull();
  });

  it("CONTROLE: outra falha mostra a frase e fica na tela", async () => {
    recusar(new ApiError(500, "internal_error", undefined, "req-2", "boom"));
    renderTela(CHANGELOG_LONGO);
    fireEvent.click(screen.getByRole("button", { name: "Atualizar agora" }));

    await screen.findByText("Não consegui iniciar a atualização", { exact: false });
    expect(irAoDesafioDeMfa).not.toHaveBeenCalled();
  });
});

/**
 * #2756 — o `--force` vira CLIQUE.
 *
 * A `Saida` já mostrava o comando de saída de um estado de falha; o que faltava
 * era o botão que o executa. As quatro provas da issue, na ordem delas:
 *
 * 1. o botão aparece JUNTO do comando no estado de falha;
 * 2. o clique manda `{ force: true }` — UMA chave, sem caminho nenhum do
 *    cliente (o alvo é do SERVIDOR, e `route.test.ts` costura a outra ponta
 *    com a MESMA frase literal);
 * 3. os estados normais seguem com o "Atualizar agora" de sempre;
 * 4. os dois testes do endpoint, que já existiam, continuam verdes.
 */
describe("tela de atualização — o botão de força (#2756)", () => {
  function falha(overrides: Partial<NonNullable<SystemVersion["run"]>> = {}): SystemVersion {
    return {
      // Depois de uma falha o `git checkout` já tinha dado certo: o host
      // reporta a versão ALVO, e ela É a mais recente — é este o estado que o
      // 409 do caminho de atualizar barra e que só a força atravessa.
      current_version: "1.5.0",
      identity: {
        status: "confirmed",
        base_version: "1.5.0",
        revision: "a".repeat(40),
        customized: false,
        confirmed_at: new Date().toISOString(),
      },
      force_update_supported: true,
      is_owner: true,
      latest_version: "1.5.0",
      update_available: true,
      agent_online: true,
      notes: null,
      run: {
        id: "99999999-9999-4999-9999-999999999999",
        status: "failed",
        last_step: "app",
        from_version: "1.4.2",
        to_version: "1.5.0",
        log_tail: "",
        finished_at: null,
        volta_automatica: false,
        ...overrides,
      },
    };
  }

  function semMfa() {
    vi.mocked(irAoDesafioDeMfa).mockReset();
    vi.mocked(apiClient.post).mockReset();
  }

  it("⭐ estado de falha: 'Forçar atualização' fica JUNTO do comando de copia", () => {
    renderTela(falha());

    const botao = screen.getByRole("button", { name: "Forçar atualização" });
    const comando = screen.getByText("bash hostgator-setup-kit/update.sh --to v1.4.2 --force");

    // "Junto": o botão vem ANTES do `<code>` no mesmo bloco — é o clique daquela
    // linha, não um atalho solto em outro canto da tela.
    expect(Boolean(botao.compareDocumentPosition(comando) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(
      true,
    );
    // E o botão de ATUALIZAR continua DESLIGADO aqui: sem força ele é o falso
    // sucesso descrito no doc de `Saida`.
    expect(screen.queryByRole("button", { name: "Atualizar agora" })).toBeNull();
  });

  it("⭐ o clique manda SÓ { force: true } — nenhum caminho vem do cliente", async () => {
    semMfa();
    vi.mocked(apiClient.post).mockResolvedValue({});
    renderTela(falha());

    fireEvent.click(screen.getByRole("button", { name: "Forçar atualização" }));

    await waitFor(() =>
      expect(apiClient.post).toHaveBeenCalledWith("/api/v1/system/update", { force: true }),
    );
    // O `--to` não viaja: quem o deriva é o servidor, a partir do run.
    expect(vi.mocked(apiClient.post).mock.calls[0]?.[1]).toEqual({ force: true });
  });

  it("fora de release: o comando é o `--force` puro e o botão continua — é o caso em que a volta recusa", () => {
    // `from_version` de instalação seguindo o repositório não é versão
    // publicada: o `#2757` some (409 no servidor) e este aqui é o ÚNICO clique
    // de saída, executando o `--force` sem `--to` que a tela mostra.
    renderTela(falha({ from_version: "dev-abc1234" }));

    expect(screen.getByRole("button", { name: "Forçar atualização" })).toBeInTheDocument();
    expect(screen.getByText("bash hostgator-setup-kit/update.sh --force")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voltar para a versão anterior" })).toBeNull();
  });

  it("a volta que TERMINOU também ganha o força — ali o comando é a saída clicável", () => {
    // #3271 escondeu o "Voltar" neste ramo, mas o COMANDO continua na tela de
    // propósito ("inclusive o código, que já foi trocado"). O força é o clique
    // daquela linha; o "Voltar" segue fora.
    renderTela(falha({ status: "failed_rolled_back", volta_automatica: true }));

    expect(screen.getByRole("button", { name: "Forçar atualização" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voltar para a versão anterior" })).toBeNull();
  });

  it("CONTROLE — estado normal: nenhum 'Forçar', o 'Atualizar agora' de sempre", () => {
    renderTela(CHANGELOG_LONGO);

    expect(screen.queryByRole("button", { name: "Forçar atualização" })).toBeNull();
    expect(screen.getByRole("button", { name: "Atualizar agora" })).toBeInTheDocument();
    expect(screen.queryByText("bash hostgator-setup-kit/update.sh --force")).toBeNull();
  });

  it("⭐ 'Forçar atualização' recusado por mfa_required leva ao código", async () => {
    semMfa();
    vi.mocked(apiClient.post).mockRejectedValue(
      new ApiError(403, "mfa_required", undefined, "req-3", "Confirme o código."),
    );
    renderTela(falha());

    fireEvent.click(screen.getByRole("button", { name: "Forçar atualização" }));

    await waitFor(() => expect(irAoDesafioDeMfa).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("Não consegui iniciar a atualização", { exact: false })).toBeNull();
  });

  it("outra falha mostra a frase UMA vez — o força não repete o que o 'Voltar' já diz", async () => {
    semMfa();
    vi.mocked(apiClient.post).mockRejectedValue(
      new ApiError(500, "internal_error", undefined, "req-4", "boom"),
    );
    renderTela(falha());

    fireEvent.click(screen.getByRole("button", { name: "Forçar atualização" }));

    await screen.findByText("Não consegui iniciar a atualização", { exact: false });
    expect(
      screen.getAllByText("Não consegui iniciar a atualização", { exact: false }),
    ).toHaveLength(1);
    expect(irAoDesafioDeMfa).not.toHaveBeenCalled();
  });
  it("agente legado não recebe promessa de força pela tela", () => {
    renderTela({ ...falha(), identity: undefined, force_update_supported: undefined });
    expect(screen.queryByRole("button", { name: "Forçar atualização" })).toBeNull();
    expect(
      screen.getByText("bash hostgator-setup-kit/update.sh --to v1.4.2 --force"),
    ).toBeInTheDocument();
  });

  it("sem anúncio do host confirmado não oferece força", () => {
    renderTela({ ...falha(), force_update_supported: false });
    expect(screen.queryByRole("button", { name: "Forçar atualização" })).toBeNull();
  });

  it("personalização não ganha força mesmo com capacidade anunciada", () => {
    const dados = falha();
    renderTela({
      ...dados,
      identity: { ...dados.identity!, customized: true },
      manual_reconciliation_required: true,
    });
    expect(screen.queryByRole("button", { name: "Forçar atualização" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Voltar para a versão anterior" })).toBeNull();
  });
  it("origem com sufixo usa o comando sem tag e não oferece volta para uma imagem inexistente", () => {
    renderTela(falha({ from_version: "1.4.2-dev" }));
    expect(screen.getByText("bash hostgator-setup-kit/update.sh --force")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Voltar para a versão anterior" })).toBeNull();
  });

  it("identidade moderna preserva o destino, a hora e o motivo da volta automática", () => {
    const quando = "2026-10-20T12:13:00.000Z";
    renderTela(
      falha({ status: "failed_rolled_back", volta_automatica: true, finished_at: quando }),
    );
    const texto = screen.getByTestId("volta-automatica").textContent ?? "";
    const d = new Date(quando);
    expect(texto).toContain("voltou sozinho");
    expect(texto).toContain("1.4.2");
    expect(texto).toContain("1.5.0");
    expect(texto).toContain(
      `${String(d.getHours()).padStart(2, "0")}h${String(d.getMinutes()).padStart(2, "0")}`,
    );
    expect(texto).toContain("site não respondeu");
  });
});
