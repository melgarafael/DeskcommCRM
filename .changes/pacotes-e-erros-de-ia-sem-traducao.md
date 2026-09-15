---
impacto: nada_mudou
secao: corrigido
titulo: A tela de criar agente e alguns avisos de IA voltaram a português mesmo com o idioma em espanhol
---

O guarda de i18n (`tests/unit/i18n-espanhol-cobre-a-tela.test.ts`) varre o AST das telas
atrás de prosa em português fora de `t()`, mas não alcança texto que mora fora da tela — em
constantes importadas de `lib/`. Quatro pontos escapavam por essa lacuna:

- Os pacotes de capacidade (Atender e responder, Vender e mover o funil, Não perder o
  cliente, Passar para um humano, Organizar a operação, Aprender e evoluir) na tela de criar
  ou editar agente, e o texto de cada um.
- O prompt padrão de um agente novo — que também é o `system_prompt` de verdade se ninguém
  editar, por isso em espanhol ele já instrui a IA a responder em espanhol, não em pt-BR.
- Os seis avisos de erro do cadastro da chave de inteligência artificial (onboarding).
- No construtor de fluxo de resposta correspondida, duas opções ("Se a informação já
  existir" e as três alternativas dela) que a mesma tela de classificação já traduzia
  corretamente — só esta ficou para trás.

Corrigido envolvendo cada ponto em `t()`/`useT()` no local de exibição (mesma convenção do
resto do produto) e completando o dicionário. Nenhum comportamento muda para quem usa
português.
