# Módulo Amigo pela tela (15/11/2026)

**Tipo:** REPRODUZÍVEL. As capturas saem de [prova.pw.ts](prova.pw.ts), que as regrava a cada execução de [rodar.sh](rodar.sh).

**Contra qual código:** branch `adapta/4227-modulo-amigo` em `9a4c274778`. O ambiente imita uma instalação fresca: um Supabase local próprio, o `baseline.sql` aplicado com `ON_ERROR_STOP=1`, `scripts/bootstrap-owner.ts`, build de produção e nenhum env opcional. O Amigo é um receptor falso ([receptor.mjs](receptor.mjs)), e o que ele recebeu fica gravado em `recebido.jsonl`.

| Captura | O que prova |
|---|---|
| [01-sem-modulo-tela-404.png](01-sem-modulo-tela-404.png) | Com o módulo fora, a tela do Amigo responde 404. |
| [02-sem-modulo-hub-sem-porta.png](02-sem-modulo-hub-sem-porta.png) | O hub de integrações não mostra a porta do Amigo. |
| [03-modulos-antes-de-instalar.png](03-modulos-antes-de-instalar.png) | O cartão do módulo aparece na tela de módulos, ainda sem instalar. |
| [04-modulo-instalado.png](04-modulo-instalado.png) | Depois de instalar, o cartão mostra "Instalado" e `modulos_instalados` fica `ativo`. |
| [05-hub-com-a-porta.png](05-hub-com-a-porta.png) | A porta aparece no hub. |
| [06-tela-amigo-sem-conexao.png](06-tela-amigo-sem-conexao.png) | A tela abre no estado vazio, sem conexão. |
| [07-token-testado.png](07-token-testado.png) | O token é validado contra o receptor antes de ser salvo. |
| [08-conectado-token-salvo.png](08-conectado-token-salvo.png) | O token salvo aparece só pelos 4 últimos dígitos. |
| [09-conectado-apos-recarregar.png](09-conectado-apos-recarregar.png) | Depois de recarregar a página, nenhuma resposta e nenhuma coluna do banco traz o token em claro. |
| [10-desligado-tela-404.png](10-desligado-tela-404.png) | Depois de desligar o módulo, a tela volta ao 404 e a API também responde 404. |
| [11-desligado-hub-sem-porta.png](11-desligado-hub-sem-porta.png) | E a porta some do hub. |
