---
impacto: capacidade_nova
secao: adicionado
titulo: A tela Marca ganhou o Tema da plataforma, que leva a paleta de uma extensão de tema ao login, ao admin e às organizações sem tema
---

Até aqui, o tema de uma extensão só pintava o `/app` da organização que o escolheu. A tela de login, todo o `/admin` e as organizações sem tema ficavam na paleta de fábrica, mesmo com a marca aplicada (medido numa 1.96.0: bordas, campos e textos em tons quentes dentro do `/admin`).

Agora `/admin/marca` tem o cartão «Tema da plataforma», onde quem administra a plataforma escolhe «Nenhum» ou um dos temas que as extensões instaladas oferecem. O tema pinta superfícies, bordas e textos; a cor de ação continua vindo da Marca, e dentro de uma organização que escolheu tema próprio a paleta dela continua mandando. Remover a extensão desliga o tema sozinho, e `?sem_css=1` mostra a tela sem ele. A troca fica registrada na auditoria como alteração da marca.

Sem escolha, nada muda na tela: nenhum `<style>` novo é emitido e as telas não consultam a tabela de extensões (só o cartão de `/admin/marca`, para montar a lista). O servidor faz uma leitura da configuração da instalação a cada 30 segundos por processo para saber se há escolha.

Um caso de borda: «Nenhum» apaga a escolha gravada pela tela, mas se `APP_TEMA_DA_PLATAFORMA` estiver no `.env`, o valor do `.env` volta a valer. Para desligar de vez nesse caso, tire a variável do `.env`.

Contribuição de @webtecnica (#3815), a partir da medição de @franklinferre (#3790).
