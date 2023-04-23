# Subscribing to blocks

Transactions are made on the blockchain. Transactions are packaged into blocks.

In order to process new payments on multiple accounts, you need to keep track of new blocks in the blockchain, get transactions from blocks, and find transactions that relate to your service.

In TON blockchain, blocks go in parallel in masterchain and shardchains.

There are two ways to handle all blocks:

1. Use TON HTTP Index API. Code example in [BlockSubscriptionIndex.js](BlockSubscriptionIndex.js). 

2. Use simple TON HTTP API and implement subscription logic by yourself. Code example in [BlockSubscriptionRaw.js](BlockSubscriptionRaw.js).

In [test.js](test.js) you can find example of using `BlockSubscriptionRaw` or `BlockSubscriptionIndex`.
