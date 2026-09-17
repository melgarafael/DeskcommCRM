# Prova em tela do lote 1 da triagem — 14/set/2026

As imagens desta pasta são o lastro da afirmação feita no PR **#809**: as mudanças
de interface do lote 1 foram exercitadas **pela tela**, com Playwright dirigindo um
browser de verdade contra um Supabase **local** (a guarda do `playwright.config.ts`
recusa URL fora de localhost e não foi contornada).

`curl` e chamada de API não contam aqui — validam o backend, não o que a pessoa vê,
clica e entende. É a Doutrina de QA Visual com Recursos Reais (DoD 12 do `CLAUDE.md`).

## O que cada imagem prova

### #716 — o botão "Reativar" de tipo de agendamento
- `716-reativado-volta-a-ser-marcavel.png` — o tipo desativado volta a ativo, e a
  volta é lida numa **navegação nova** (`/app/agenda`), não em estado local: o que
  sobrevive à navegação foi gravado. Na `main` este botão **nunca** funcionou — o
  Zod descartava `is_active` em silêncio.

### #717 — a tela de atualização conta em que pé está
- `717-a-pedido-enviado.png` — "Pedido enviado" e o relógio, logo após o clique.
- `717-b-atualizando.png` — o estado intermediário, que antes era mudo.
- `717-c-acabou-de-instalar.png` — o desfecho lido numa **recarga sem heartbeat no
  meio**, que é exatamente a janela do defeito: antes, a tela ficava calada ali.
- `717-d-em-dia.png` — "você está na versão 1.1.0", o estado de repouso.

### #719 — revogar e devolver acesso pintam a linha na hora
- `719-revogado-antes-da-resposta.png` — a linha muda com a resposta do POST
  **presa** por `page.route`: a pintura é otimista de verdade, não o refetch chegando
  rápido.
- `719-rollback-apos-recusa.png` — o desfazer, medido com o refetch **também preso**.
  O que volta à tela só pode ter vindo do rollback.

### #727 — cada tela diz o próprio nome na aba
- `727-titulo-equipe.png` — uma das dezessete. As outras foram medidas por
  ferramenta (`page.title()` nas 17 rotas: 17 títulos, específicos e distintos,
  nenhum com a frase da landing), porque título de aba se lê por API, não a olho.

### #740 — a sugestão rejeitada sai da tela, e a falha diz o motivo
- `740-a-sugestao-na-tela.png` — a sugestão oferecida.
- `740-b-rejeitada-saiu-da-tela.png` — rejeitar esvazia o painel **e a confirmação
  fica**.
- `740-c-falha-com-motivo.png` — com o agente despublicado, a tela mostra "Nenhum
  agente publicado atende este canal…" (422 `reply_no_agent`), não a frase genérica.

## O que estas imagens NÃO provam

- **#732** (canal oficial da Meta) não tem imagem, e a razão é do código:
  `https://graph.facebook.com` está escrito à mão em
  `lib/channels/meta/validate-credentials.ts` e em
  `lib/channels/adapters/meta-cloud.ts`. Só a **versão** da API é knob; o host não é.
  Não há como pôr um receiver local no lugar da Graph, e conectar o número pela tela
  exigiria WABA e token reais. A cobertura desse canal é de unidade — backend, não
  tela. Fica registrado como dívida nomeada.
- A recusa exercitada no #719 foi **fabricada** (500 via `page.route`): não existe
  caminho de tela que faça o `reactivate` recusar de verdade.

## Como refazer

As specs que produzem estas imagens estão em `tests/e2e/qa-titulos-das-telas.spec.ts`,
`tests/e2e/qa-equipe-pinta-na-hora.spec.ts` e
`tests/e2e/qa-sugestao-rejeitada-e-motivo.spec.ts`, e as três estão registradas em
`SPECS_PARTE_3` do `.github/workflows/e2e.yml` — imagem sem spec que a regenere é
captura de tela, não evidência.
