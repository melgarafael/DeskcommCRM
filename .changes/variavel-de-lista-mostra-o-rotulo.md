---
impacto: nada_mudou
secao: corrigido
titulo: Variável de campo de lista mostra o rótulo da opção, e não o código interno
---

Um campo personalizado de lista (seleção, múltipla escolha, lista pesquisável) guarda no negócio o código da opção — "paris-franca" — e a variável usada nas mensagens de automação, de resposta rápida e de follow-up devolvia esse código ao cliente: "Sua viagem para paris-franca está chegando". Agora o texto sai com o rótulo que a empresa cadastrou na opção ("Paris (França)"); na múltipla escolha, os rótulos saem unidos por vírgula. Valor que não corresponde a nenhuma opção da lista (uma opção removida depois de gravada) continua saindo como está, e campo de texto, número ou data não muda. O texto de reserva da variável segue valendo para campo vazio. Nada muda na instalação.
