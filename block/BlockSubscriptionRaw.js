// Subscribing to blocks using only simple TON-HTTP-API.
// Subscription logic implemented in tonweb https://github.com/toncenter/tonweb/tree/master/src/providers/blockSubscription.

import TonWeb from "tonweb";

export class BlockSubscriptionRaw {
    constructor(tonweb, startMasterchainBlockNumber, onTransaction) {
        this.tonweb = tonweb;
        this.startMasterchainBlockNumber = startMasterchainBlockNumber;
        this.onTransaction = onTransaction;
    }

    async start() {

        const onBlock = async (blockHeader) => {
            const workchain = blockHeader.id.workchain;
            const shardId = blockHeader.id.shard;
            const blockNumber = blockHeader.id.seqno;
            console.log('Got block ', workchain + ':' + shardId + ':' + blockNumber);

            // BlockId = workchain + shardId + blockNumber; these three parameters uniquely identify the block.

            const blockTransactions = await this.tonweb.provider.getBlockTransactions(workchain, shardId, blockNumber); // todo: (tolya-yanot) `incomplete` is not handled in response
            const shortTransactions = blockTransactions.transactions;
            for (const shortTx of shortTransactions) {
                await this.onTransaction(shortTx, blockHeader);
            }
        }

        // BlockStorage stores blocks that we have already processed
        // In this example we use in-memory storage
        // In real life you need to implement BlockStorage interface and use a real database (e.g. MySQL, PostgreSQL, MongoDB, etc).
        const storage = new TonWeb.InMemoryBlockStorage(log => console.log('DB: ' + log));

        const blockSubscribe = new TonWeb.BlockSubscription(this.tonweb.provider, storage, onBlock, {
            startMcBlockNumber: this.startMasterchainBlockNumber
        });
        await blockSubscribe.start();
    }
}