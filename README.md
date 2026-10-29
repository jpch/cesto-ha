# continente-mcp-ha

Add-on do Home Assistant que serve de servidor central para a app [assistente-compras](https://github.com/jpch/assistente-compras). Corre o MCP não oficial do Continente e guarda a lista de compras partilhada da casa.

## Principais funcionalidades

- Corre o `continentept-mcp` (pesquisa no catálogo, favoritos, histórico e carrinho do Continente) e expõe-no por HTTP na rede de casa.
- Lista de compras partilhada em SQLite, com API HTTP documentada e um token por app ou telemóvel.
- Interpretação de listas em texto (quantidades e unidades) e identificação de produtos por foto, com fornecedor de IA de visão configurável.
- Fila de pedidos, para que duas pessoas não alterem o carrinho ao mesmo tempo.
- Modo de teste que nunca altera o carrinho real.
- Sensores no HA (servidor, sessão do Continente, itens na lista, última sincronização) e notificação quando a sessão expira.
- Credenciais do Continente guardadas só no servidor; nunca finaliza checkout nem pagamento.

## Instalação

No Home Assistant, abre a loja de add-ons, adiciona este repositório (`https://github.com/jpch/continente-mcp-ha`) e instala o add-on.

Aviso: usa um MCP não oficial, sem ligação ao Continente.

Ver o [CHANGELOG](CHANGELOG.md) para o histórico de alterações.
