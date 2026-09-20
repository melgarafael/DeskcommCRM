# Site de apresentação escreve.ai

Home editorial centrada nos resultados: atenção ao primeiro contato, continuidade da conversa e tempo para o negócio. Duas imagens conceituais originais, geradas com IA, estão otimizadas em WebP. O filme de 10 segundos criado no Google Flow é reproduzido somente por ação do visitante, em um diálogo com controles nativos.

A página usa HTML, CSS e JavaScript sem framework. A demonstração de três etapas contém dados fictícios, não envia mensagens e não coleta formulários. Login/cadastro seguem em `crm.escreve.ai`; o Conversa permanece acessível no rodapé. Navegação antiga por `#recursos`, `#como-funciona` e `#duvidas` é preservada.

## Desenvolvimento e publicação

Na pasta `website`, execute `pnpm dlx wrangler dev`. Se o runtime local não reconhecer a data do projeto, use `--compatibility-date 2026-09-18` apenas no preview. A publicação usa `pnpm dlx wrangler deploy` com sessão Cloudflare autorizada. Nunca commite credenciais.

## Rotas e preservação

O Worker atende GET/HEAD `/` e uma lista explícita de recursos sob `/_escreve/`, declarada em `worker.mjs`. Demais caminhos e métodos são encaminhados à origem existente, preservando corpo e cabeçalhos. DNS, MX, APIs e subdomínios não são substituídos.

O antigo redirecionamento da raiz para Conversa permanece desativado. Rollback da apresentação: restaurar a versão anterior do mesmo Worker. Não alterar os aplicativos ou o DNS.

## Verificação

`node website/check-routing.mjs` exercita o conjunto de rotas, HEAD, queries e preservação de requisições legadas. `node --check website/assets/home.js` verifica a sintaxe do JavaScript.

No navegador, conferir desktop e mobile, as três etapas interativas, abertura/fechamento do filme por botão e Escape, FAQ, links de cadastro/login e ausência de overflow. `prefers-reduced-motion` remove animações; conteúdo permanece visível sem JavaScript. As imagens não são casos de clientes nem depoimentos.

## Fontes dos ativos

- `assets/conversation-sculpture.webp` e `assets/time-for-people.webp`: imagens originais geradas para esta home; fontes PNG preservadas no diretório de imagens geradas do Codex.
- `brand-film.mp4`: filme aprovado nesta sessão, Google Flow, projeto `95cb996b-2ed3-4457-87e2-4a3a3fbcab9f`; `assets/film-poster.webp` é um frame do próprio filme.
- `assets/logo.png`: identidade existente em `docs/brand/escreve-ai-logo.png`.
- DM Sans: Google Fonts.

A página utiliza referências de ritmo editorial, espaços e hierarquia da apresentação de iPhone da Apple, com imagens, marca e textos próprios.

## Inovações orientadas a resultado

A seção `#inovacoes` apresenta descoberta de empresas, contexto do contato, canais conectados, acompanhamento, qualificação e criação conversacional do agente a partir do resultado para quem usa. Cada cartão expande uma explicação concreta das condições. Não afirma taxas de conversão, faturamento ou garantias; não anuncia chamadas automáticas de voz como disponíveis.

## Movimento

GSAP + ScrollTrigger 3.15.0 são servidos localmente, com os avisos originais de licença preservados. `assets/GSAP-NOTICE.txt` registra a origem. `motion.js` adiciona abertura em sequência, revelação por rolagem, profundidade na imagem, zoom da fotografia, mensagens em cascata, transição do filme e progresso de leitura. Em desktop, as cenas dos cartões respondem suavemente ao ponteiro. Não há rolagem artificial nem animações infinitas.

O carregamento é progressivo: sem as bibliotecas, o conteúdo e os controles continuam funcionando. `gsap.matchMedia` respeita mudanças em `prefers-reduced-motion` e desfaz estilos e ouvintes; efeitos de ponteiro são exclusivos de dispositivos adequados. A expansão dos detalhes atualiza as posições de rolagem. Confira também `node --check website/assets/motion.js`.
