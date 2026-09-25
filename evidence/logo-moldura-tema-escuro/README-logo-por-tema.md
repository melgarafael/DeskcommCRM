# Logo por tema — prova visual

Playwright/Chromium, Supabase local recém-instalado a partir do baseline, dados sintéticos. Execução em 24/09/2026 na base 1.40.0 + alteração de logos: os 7 casos de `tests/e2e/logo-moldura-no-tema-escuro.spec.ts` passaram (2,2 minutos). A arte de teste clara é azul; a escura é branca com bordas transparentes.

O caso 7 faz upload pela tela, verifica arquivos distintos na prévia, alterna o tema pelo controle real do menu, abre o login sem sessão e remove apenas a arte escura. Confere o fundo calculado pelo navegador e que o logo padrão permanece depois de recarregar. Os casos 1–6 preservam o comportamento anterior de uma imagem única e da marca padrão.

- `7-duas-artes-previa.png`: os dois campos e suas prévias.
- `7-barra-dark.png`: arte escura no menu, sem moldura.
- `7-login-dark.png` e `7-login-light.png`: fachada nos dois temas.

O porte para a main upstream foi conferido com 20 testes unitários específicos e 29 invariantes de banco (instalação/reaplicação do baseline inclusas). A execução visual desta evidência usa a base 1.40.0; a suíte completa na main upstream fica a cargo do CI do PR. Nenhum ambiente, credencial ou identidade real aparece nas imagens.
