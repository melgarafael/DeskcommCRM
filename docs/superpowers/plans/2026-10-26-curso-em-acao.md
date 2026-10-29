# Deskcomm em ação Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use $superpowers-subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** acrescentar jornadas visuais por nicho ao curso, úteis para apresentação comercial e aprendizado.

**Architecture:** conteúdo declarativo validado por Zod e manifesto de fotos do curso; renderizador estático dedicado, integrado ao montador e às utilidades atuais. Capturas e provas na bancada isolada, publicação no site existente.

**Tech Stack:** TypeScript, Zod, HTML/CSS/JavaScript sem dependências, Playwright e Vitest existentes.

**Spec:** `docs/superpowers/specs/2026-10-26-curso-em-acao-design.md`.

## Global Constraints

- Preservar todas as lições existentes, seus hashes, busca, simulador, zoom e progresso.
- Não adicionar dependências de runtime nem rotas/tabelas ao produto.
- Conteúdo privado, contas, sessões, tokens e dados de clientes nunca entram nos assets públicos.
- Nunca executar a semente destrutiva contra hg-vps. Ela só aceita banco local na bancada vps-teste.
- Foto real não prova uma ação de IA. Roteiros e integrações externas devem ser nomeados com precisão.
- Usar PT-BR claro e identidade visual do curso, com contraste, foco visível, celular e redução de movimento.

### Task 1: Contrato e interface das jornadas

**Files:** Create `curso/jornada.ts`, `curso/jornada.test.ts`, `curso/site/demonstracoes.js`, `curso/site/demonstracoes.css`; modify `curso/montar.ts`, `curso/site/app.js`, `curso/site/pagina.html`.

**Interfaces:** consumir schema exato da spec; exportar `Nicho` (Zod + type), `validarJornadas(nichos, modulos, capturas)` para verificar ids, lições e fotos; renderer com uma função fábrica explícita recebendo dados/utilidades do app e expondo reconhecimento de rota, render, pós-render, entradas de busca e título. Fixar as assinaturas concretas no relatório para a tarefa de conteúdo. `captura` identifica uma chave existente do manifesto.

- [ ] Escrever testes comportamentais para schema e integridade, cobrindo ids repetidos, referência de lição ausente, foto ausente e conteúdo válido. Rodar `pnpm exec vitest run curso/jornada.test.ts` e confirmar falha antes de implementar.
- [ ] Implementar contrato, leitor do montador e renderer dedicado. Menu e início têm entrada; catálogo permite escolher nicho/história. Cenas com cliente/operação/benefício e foto anotada reutilizam `figura`/`legenda`; modo montagem liga as lições. Não incluir placeholders públicos nem alterar NAV_CATALOG.
- [ ] Implementar anterior/próximo, linha do tempo, setas (sem capturar teclas em inputs), tela cheia com fallback e saída, copiar link com mensagem de sucesso/falha. Hash inválido recupera catálogo sem erro. A busca inclui histórias e nichos.
- [ ] Validar com conteúdo de fixture no teste e no navegador; não deixar fixture falsa no conteúdo público. `pnpm exec vitest run curso/jornada.test.ts curso/licoes.test.ts`; `pnpm typecheck`; `pnpm lint`. Registrar limitações de visual que dependem de conteúdo final.
- [ ] Fazer commit apenas dos arquivos da tarefa e relatório com testes, interfaces e decisões visuais.

### Task 2: Conteúdo dos dez nichos

**Files:** Create `curso/demonstracoes/{clinicas,e-commerce,imobiliarias,seguros,consorcio,infoprodutos,advocacia,contabilidade,educacao,servicos}.json`; modify `curso/jornada.test.ts` para integridade do catálogo real.

**Interfaces:** consumir `Nicho` da tarefa 1. Cada nicho tem três jornadas e cada jornada pelo menos quatro cenas. IDs de jornada são únicos no catálogo inteiro, para as chaves de captura não colidirem; usar prefixo do nicho. Começar como `roteiro-demonstrativo` e explicar que as fotos mostram telas reais com dados fictícios e que o atendimento é um roteiro. Não afirmar prova do motor sem evidência da tarefa 3.

- [ ] Ler lições reais e fontes canônicas da feature que cada jornada apresenta. Usar capturas existentes para ilustrar recursos enquanto as novas fotos são preparadas; nunca descrever a pessoa/empresa da foto como se já fosse a do roteiro.
- [ ] Redigir três histórias distintas por nicho, com começo, qualificação, ação e continuidade. Variar entre agenda, funil, tarefa, atendimento humano, caso e integração externa; evitar trinta paráfrases do mesmo texto.
- [ ] Nomear requisitos e limites de cada história; nenhuma promessa de diagnóstico, aprovação de crédito, consulta universal de pedidos, atualização automática de sistema externo, prazo fiscal ou resultado comercial. Valores e prazos de exemplo devem ser declarados exemplos.
- [ ] Vincular lições exatas no modo montagem e validar com `pnpm exec vitest run curso/jornada.test.ts curso/licoes.test.ts`; montar curso com `CURSO_BASE=/curso/ pnpm exec tsx curso/montar.ts`.
- [ ] Fazer commit e relatório de todas as histórias e referências.

### Task 3: Reprodução e capturas próprias

**Files:** Create `curso/capturar-jornadas.ts`, `curso/semear-jornadas.ts` e ajudantes focados se necessário; modify compartilhamento mínimo de `curso/capturar.ts` somente se evitar duplicação, `curso/demonstracoes/*.json` para apontar novas fotos; documentar em `docs/testing/curso-em-acao.md`.

**Interfaces:** nomes de captura `demo-<jornada>--historia--<cena>`. Os scripts novos só aceitam Supabase e app localhost, reutilizam segurança/medição e credenciais privadas da bancada. Não inserir credencial real em semente ou arquivos públicos.

- [ ] Preparar a bancada vps-teste preservando volumes. Reproduzir os pilotos clínica/agenda, pedido via dados externos e infoproduto/caso. Usar a configuração autorizada da Deskcomm Admin para IA sem imprimir ou persistir chaves. Guardar evidência de execução e limites separada dos assets.
- [ ] Criar receitas de dados fictícios e fotografar as cenas nos estados reais do produto. Distinguir estado semeado, ação executada pelo usuário/ferramenta e execução observada de IA. Usar nomes/contextos coerentes por nicho.
- [ ] Para ação por IA, medir agente e ferramenta direta no mesmo texto cru; se divergirem, manter rótulo de roteiro e registrar defeito. Não alegar comportamento que a execução não demonstrou.
- [ ] Validar todas as referências, fotos e geometria, montar e percorrer catálogo/cenas/modo montagem no navegador desktop e celular. Registrar captura visual e ausência de erros.
- [ ] Fazer commit dos scripts, roteiros e relatório público sanitizado. As fotos/manifesto continuam em saída ignorada até a publicação no site.

### Task 4: Publicação e verificação final

**Files:** site `/Users/rafaelmelgaco/deskcomm-site-curso/public/curso/index.html` e `public/curso/capturas/*.jpg`; documentação de evidência no produto e fragmento de release somente se efeito real no operador exigir.

**Interfaces:** publicar só HTML e JPEGs referenciados, sem arquivos privados. Preservar 61 módulos existentes sem depender de contagem congelada; medir a contagem no gerado.

- [ ] Rodar testes relevantes, typecheck/lint/build do produto; testes/typecheck/build do site. Validar navegação e decodificar todas as imagens com Playwright, incluindo fluxos existentes.
- [ ] Fazer revisão independente do diff completo; corrigir achados relevantes e revisar correções.
- [ ] Abrir PRs com conteúdo exato e evidência; acompanhar checks. Publicar conforme autorização de continuidade já dada e práticas do repositório, sem alterar shared branch diretamente.
- [ ] Confirmar URL pública `/curso/#acao`, links diretos, imagens, modos e celular após deploy. Relatar entrega e qualquer limitação medida.
