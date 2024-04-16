/*
Here we will look at how to process withdrawals (outgoing Toncoins) from your hot wallet to users wallets.

1. You have a key pair of your hot wallet (how to create key pair is described in `common.js`).
   You will send Toncoins from this wallet.

2. You need to save all withdrawal requests in your database.

3. The withdrawal requests will be collected in batches.

4. When sending, each batch will be assigned a `created_at` (unixtime) and `query_id`.

5. We can repeat sending this batch until it successfully sends. The `created_at` and `query_id` transfer parameters protect us from double withdrawal.

*/

import TonWeb from "tonweb";
import TonWebMnemonic from "tonweb-mnemonic";

const BN = TonWeb.utils.BN;
const Cell = TonWeb.boc.Cell;
const Contract = TonWeb.Contract;

const isMainnet = true;

// Use toncenter.com as HTTP API endpoint to interact with TON blockchain.
// You can get HTTP API key at https://toncenter.com
// You can run your own HTTP API instance https://github.com/toncenter/ton-http-api
const tonweb = isMainnet ?
    new TonWeb(new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_MAINNET_API_KEY'})) :
    new TonWeb(new TonWeb.HttpProvider('https://testnet.toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_TESTNET_API_KEY'}));

// key pair for HOT wallet

const seed = await TonWebMnemonic.mnemonicToSeed('word1 word2 word3 ..'.split(' '));
// const seed = TonWeb.utils.base64ToBytes('YOU_PRIVATE_KEY_IN_BASE64');  // your hot wallet seed, see `common.js`
const keyPair = TonWeb.utils.keyPairFromSeed(seed);

// HOT wallet

const {HighloadWalletContractV3, HighloadQueryId} = TonWeb.HighloadWallets;

// Timeout - the time for which the highload-wallet will store the query_id of processed messages (for retry-protection).
// We recommend use timeout from 1 hour to 24 hours.
// This highload-wallet has a limit of 8380415 messages per timeout. If you fill the dictionary completely during the timeout, you will have to wait for the timeout before the dictionary is freed.
const HIGHLOAD_WALLET_TIMEOUT = 60 * 60 // 1 hour

const highloadWallet = new HighloadWalletContractV3(tonweb.provider, {
    publicKey: keyPair.publicKey,
    timeout: HIGHLOAD_WALLET_TIMEOUT,
});

// Withdrawal requests
const withdrawalRequests = [
    // Contains example withdrawal request
    // In real system `withdrawalRequests` is table in your persistent database
    {
        id: 1,
        jettonName: 'jUSDC',
        amount: '1000',  // 1000 jetton units, or 0.001 jUSDC
        toAddress: 'UQAn_rlLlk_MwdfHcspLfpl3iEaQC1WZPFDD7KSbXNbXJ8wM',
        batchId: null,
        jettonSent: null,
        jettonQueryId: null,
    }
];

// Batches
const batches = [
    // Contains example batch
    // In real system `batches` is table in your persistent database
    {
        id: 0,
        queryId: 0,
        createdAt: 0,
        processed: true,
        sent: null,
        wasRecreated: false,
        messagesSent: null,
    },
];

// Supported jettons config

const JETTONS_INFO = {
    'jUSDC': {
        address: 'EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728',
        decimals: 6
    },
    'KOTE': {
        address: 'EQBlU_tKISgpepeMFT9t3xTDeiVmo25dW_4vUOl6jId_BNIj',
        decimals: 9
    }
}

// Prepare

let hotWalletAddress;
let hotWalletAddressString;
const jettons = {};

const prepare = async () => {
    hotWalletAddress = await highloadWallet.getAddress();
    hotWalletAddressString = hotWalletAddress.toString(true, true, false);
    console.log('My HOT wallet is', hotWalletAddressString);

    // ATTENTION:
    // Jetton-wallet contract has automatic Toncoin balance replenishment during transfer -
    // at the time the jettons arrive, the jetton-wallet contract always leaves a small Toncoin amount on the balance, enough to store for about a year.
    //
    // However, if there were no transfers for a very long time, it may freeze - to prevent this you need to maintain a Toncoin balance
    // on your jetton-wallets contracts yourself.
    // If the freezing has already happened, you can unfreeze them manually by https://unfreezer.ton.org/

    for (const name in JETTONS_INFO) {
        const info = JETTONS_INFO[name];
        const jettonMinter = new TonWeb.token.jetton.JettonMinter(tonweb.provider, {
            address: info.address
        });
        const jettonWalletAddress = await jettonMinter.getJettonWalletAddress(hotWalletAddress);
        console.log('My jetton wallet for ' + name + ' is ' + jettonWalletAddress.toString(true, true, true));
        const jettonWallet = new TonWeb.token.jetton.JettonWallet(tonweb.provider, {
            address: jettonWalletAddress
        });
        jettons[name] = {
            jettonMinter: jettonMinter,
            jettonWalletAddress: jettonWalletAddress,
            jettonWallet: jettonWallet
        };
    }
}

// returns txs from the most recent to the oldest or knownLt
const collectTxs = async (address, knownLt, archival = false) => {
    const TX_LIMIT = 20;

    let txs = await tonweb.provider.getTransactions(address, TX_LIMIT, undefined, undefined, undefined, archival);
    const fullTxList = [];
    mainloop: while (true) {
        for (const tx of txs.length < TX_LIMIT ? txs : txs.slice(0, txs.length - 1)) {
            if (tx.transaction_id.lt === knownLt) {
                break mainloop;
            }

            fullTxList.push(tx);
        }

        if (txs.length < TX_LIMIT) {
            break;
        }

        txs = await tonweb.provider.getTransactions(address, TX_LIMIT, txs[txs.length-1].transaction_id.lt, txs[txs.length-1].transaction_id.hash, undefined, archival);
    }

    return fullTxList;
};

const createBatchBody = async (actions, queryId) => {
    let prev = new Cell();

    for (let i = actions.length - 1; i >= 0; i--) {
        const action = actions[i];

        const jettonWallet = jettons[action.jettonName].jettonWallet;
        const jettonWalletAddress = jettons[action.jettonName].jettonWalletAddress.toString(true, true, true);

        const nc = new Cell();
        nc.refs.push(prev);
        nc.bits.writeUint(0x0ec3c86d, 32);
        nc.bits.writeUint8(1); // send mode - always 1
        nc.refs.push(Contract.createCommonMsgInfo(Contract.createInternalMessageHeader(jettonWalletAddress, TonWeb.utils.toNano('0.05')), undefined, await jettonWallet.createTransferBody({
            queryId: new BN(action.jettonQueryId.toString()), // any unique number
            jettonAmount: action.amount, // jetton amount in units
            toAddress: new TonWeb.utils.Address(action.toAddress),
            responseAddress: hotWalletAddress,
        })));
        prev = nc;
    }

    const body = new Cell();

    body.bits.writeUint(0xae42e5a4, 32);
    body.bits.writeUint(queryId, 64);
    body.refs.push(prev);

    return body;
}

const sendWithdrawalRequest = async (withdrawalRequest) => {
    const transfer = highloadWallet.methods.transfer({
        secretKey: keyPair.secretKey,
        queryId: HighloadQueryId.fromQueryId(withdrawalRequest.queryId),
        createdAt: withdrawalRequest.createdAt,
        toAddress: hotWalletAddressString,
        amount: TonWeb.utils.toNano('1'),
        needDeploy: withdrawalRequest.queryId === 0n,
        payload: await createBatchBody(withdrawalRequest.requests, withdrawalRequest.id),
    });

    return await transfer.send();
}

const init = async () => {
    await prepare();

    let isProcessing = false;
    let isTxProcessing = false;
    let isBatchingProcessing = false;
    let isJettonTxProcessing = false;

    let lastKnownTxLt = undefined; // todo: load this from db
    let lastKnownTxUtime = undefined; // todo: load this from db
    // query id iterator
    let queryId = HighloadQueryId.fromQueryId(0n); // todo: load next query id from db
    let nextJettonQueryId = 0n; // todo: load next jetton query id from db
    let nextBatchId = 1; // todo: load next batch id from your db or just use your db's auto increment feature

    let unbatchedTicks = 0;
    const batchingTick = async () => {
        if (isBatchingProcessing) return;
        isBatchingProcessing = true;

        try {
            // todo: load unbatched requests from your db, up to some reasonable limit
            let requests = withdrawalRequests.filter(r => r.batchId === null).slice(0, 1000);

            if (requests.length === 0) {
                return;
            }

            // try to create batches of at least 15 and at most 50 requests
            if (requests.length > 15) {
                unbatchedTicks = 0;

                while (requests.length > 15) {
                    const toBatch = requests.slice(0, 50);

                    const batchId = nextBatchId++;
                    // todo: persist the next batch id in your db (if you are not using the db's auto increment mechanism)

                    for (const request of toBatch) {
                        request.batchId = batchId;
                    }
                    // note: a batch must only become visible to `tick` after all of the batch's requests have been assigned the batch id, so it needs to be either in a db transaction or `tick` must first query batches, then related requests (as is done in this example)
                    batches.push({
                        id: batchId,
                        queryId: null,
                        createdAt: null,
                        processed: false,
                        sent: null,
                        wasRecreated: false,
                        messagesSent: null,
                    });
                    // todo: persist batchId on the requests in question (toBatch), and persist the new batch in the db

                    requests = requests.slice(50);
                }

                if (requests.length > 0) {
                    unbatchedTicks = 1;
                }

                return;
            }

            unbatchedTicks++;
            // if there are few requests at the moment, create a batch anyway
            if (unbatchedTicks >= 3) {
                unbatchedTicks = 0;

                const batchId = nextBatchId++;
                // todo: persist the next batch id in your db (if you are not using the db's auto increment mechanism)

                for (const request of requests) {
                    request.batchId = batchId;
                }
                // note: a batch must only become visible to `tick` after all of the batch's requests have been assigned the batch id, so it needs to be either in a db transaction or `tick` must first query batches, then related requests (as is done in this example)
                batches.push({
                    id: batchId,
                    queryId: null,
                    createdAt: null,
                    processed: false,
                    sent: null,
                    wasRecreated: false,
                    messagesSent: null,
                });
                // todo: persist batchId on the requests in question (toBatch), and persist the new batch in the db

                return;
            }
        } catch (e) { console.error(e); } finally {
            isBatchingProcessing = false;
        }
    };

    const tick = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {

        // todo: load unprocessed batches from your db (see unprocessed conditions below), up to some reasonable limit (we recommend 20 batches)
        const unprocessedBatches = batches.filter(b => !b.processed && !b.wasRecreated).slice(0, 20);

        const batchesToExecute = {};

        for (const batch of unprocessedBatches) {
            batchesToExecute[batch.id] = {
                requests: [],
                queryId: batch.queryId,
                createdAt: batch.createdAt,
                id: batch.id,
            };
        }

        // todo: populate the `requests` arrays of the batches using requests from your db with matching batch ids
        for (const request of withdrawalRequests) {
            if (request.batchId in batchesToExecute) {
                batchesToExecute[request.batchId].requests.push(request);
            }
        }

        const nBatches = Object.keys(batchesToExecute).length;

        console.log(nBatches + ' batches');

        if (nBatches === 0) return; // nothing to withdraw

        const now = (await tonweb.provider.getExtendedAddressInfo(hotWalletAddressString)).sync_utime;

        for (const batchId in batchesToExecute) {
            const batch = batchesToExecute[batchId];
            if (batch.queryId === null) { // not sent yet

                for (const request of batch.requests) {
                    const jettonQueryId = nextJettonQueryId;
                    nextJettonQueryId += 1n;
                    // todo: persist next jetton query id in db

                    request.jettonQueryId = jettonQueryId;
                    // todo: persist request.jettonQueryId in db
                }

                batch.queryId = queryId.getQueryId();

                if (queryId.hasNext()) {
                    queryId = queryId.getNext();
                } else {
                    queryId = new HighloadQueryId(); // reset, start from 0 again
                }

                batch.createdAt = now;

                // todo: persist queryId.getQueryId() in your database as the next query id
                // todo: persist batch.queryId and batch.createdAt in your database
                batches.find(b => b.id === batch.id).queryId = batch.queryId;
                batches.find(b => b.id === batch.id).createdAt = batch.createdAt;

                await sendWithdrawalRequest(batch);


            } else {
                if (batch.createdAt < lastKnownTxUtime - HIGHLOAD_WALLET_TIMEOUT) {

                    // expired

                    // todo: remove the batch from db or mark it as recreated (so that it is no longer retried)
                    batches.find(b => b.id === batch.id).wasRecreated = true;
                    // todo: unset batchId on all requests of this batch so that they may be batched into a new batch
                    for (const request of batch.requests) {
                        request.batchId = null;
                    }
                    // note: the above two operations should ideally be done in a db transaction, otherwise the system is susceptible to data inconsistencies if a crash happens (however funds will still be safe)

                } else {

                    // repeat send with same `queryId` and `createdAt`
                    try {
                        await sendWithdrawalRequest(batch); // may throw due to TOCTOU
                    } catch (e) {}

                }
            }

        }

        } catch (e) { console.error(e); } finally {
            isProcessing = false;
        }
    }

    const txTick = async () => {
        if (isTxProcessing) return;
        isTxProcessing = true;

        try {

        const TX_LIMIT = 20;

        let txs = await tonweb.provider.getTransactions(hotWalletAddressString, TX_LIMIT, undefined, undefined, undefined, true); // todo: remove archival if not needed
        const fullTxList = [];
        mainloop: while (true) {
            for (const tx of txs.length < TX_LIMIT ? txs : txs.slice(0, txs.length - 1)) {
                if (tx.transaction_id.lt === lastKnownTxLt) {
                    break mainloop;
                }

                fullTxList.push(tx);
            }

            if (txs.length < 20) {
                break;
            }

            txs = await tonweb.provider.getTransactions(hotWalletAddressString, TX_LIMIT, txs[txs.length-1].transaction_id.lt, txs[txs.length-1].transaction_id.hash, undefined, true); // todo: remove archival if not needed
        }

        fullTxList.reverse();

        for (const tx of fullTxList) {
            try {
                if (tx.in_msg.source === '') { // external message
                    const bodyStr = tx.in_msg.msg_data.body;

                    const body = TonWeb.boc.Cell.oneFromBoc(TonWeb.utils.base64ToBytes(bodyStr)).beginParse();

                    const msgInner = body.loadRef();

                    msgInner.loadUint(32 + 8); // skip subwallet id and send mode

                    const queryId = msgInner.loadUint(23);
                    const createdAt = msgInner.loadUint(64);

                    // todo: update batch.processed and batch.sent on the batch with matching queryId and createdAt in the db according to the logic below
                    const batch = batches.find(b => b.queryId.toString() === queryId.toString() && b.createdAt.toString() === createdAt.toString());
                    if (batch !== undefined) {
                        batch.processed = true;
                        batch.sent = tx.out_msgs.length > 0;
                        if (!batch.sent) {
                            console.error(`WARNING! BATCH queryId ${queryId.toNumber()} createdAt ${createdAt.toString()} AT TX ${tx.transaction_id.lt}:${tx.transaction_id.hash} WAS NOT SENT`);
                            // todo: send some system alert to a sysadmin - there is not enough balance or something like that, and manual intervention is likely necessary
                            // if the request is necessary, it needs to be re-added to queue manually
                        }
                        // todo: persist batch.processed and batch.sent in db
                    }
                } else if (new TonWeb.Address(tx.in_msg.source).toString(false) === hotWalletAddress.toString(false)) { // internal message from self
                    const bodyStr = tx.in_msg.msg_data.body;

                    const body = TonWeb.boc.Cell.oneFromBoc(TonWeb.utils.base64ToBytes(bodyStr)).beginParse();

                    if (body.loadUint(32).toNumber() !== 0xae42e5a4) {
                        throw new Error('Unknown op');
                    }

                    const queryId = body.loadUint(64);

                    // todo: update batch.messagesSent on the batch with matching id in the db according to the logic below
                    const batch = batches.find(b => b.id.toString() === queryId.toString());
                    if (batch !== undefined) {
                        batch.messagesSent = tx.out_msgs.length > 0;
                        if (!batch.messagesSent) {
                            console.error(`WARNING! BATCH ${queryId.toString()} DID NOT SEND MESSAGES`);
                            // todo: send some system alert to a sysadmin - there is not enough balance or something like that, and manual intervention is likely necessary
                            // if the request is necessary, it needs to be re-added to queue manually
                        }
                        // todo: persist batch.messagesSent in db
                    }
                }
            } catch (e) {}

            lastKnownTxLt = tx.transaction_id.lt;
            lastKnownTxUtime = tx.utime;

            // todo: persist last known tx lt and utime to db
        }

        } catch (e) { console.error(e); } finally {
            isTxProcessing = false;
        }
    };

    const jettonTxTick = async () => {
        if (isJettonTxProcessing) return;
        isJettonTxProcessing = true;

        try {

        for (const name in jettons) {
            const info = jettons[name];
            const addr = info.jettonWalletAddress;
            let knownLt = '0'; // todo: load last known lt **for this jetton name** from db

            const fullTxList = await collectTxs(addr.toString(false), knownLt, true); // todo: remove archival if not needed

            fullTxList.reverse();

            for (const tx of fullTxList) {
                try {

                const sourceAddressString = tx.in_msg.source;
                if (sourceAddressString === '') {
                    throw new Error('External message');
                }

                if (new TonWeb.Address(sourceAddressString).toString(false) !== hotWalletAddress.toString(false)) {
                    throw new Error('Wrong sender address');
                }

                if (!tx.in_msg.msg_data ||
                    tx.in_msg.msg_data['@type'] !== 'msg.dataRaw' ||
                    !tx.in_msg.msg_data.body
                ) {
                    throw new Error('No body');
                }

                const msgBody = TonWeb.utils.base64ToBytes(tx.in_msg.msg_data.body);

                const cell = TonWeb.boc.Cell.oneFromBoc(msgBody);
                const slice = cell.beginParse();
                const op = slice.loadUint(32);
                if (!op.eq(new BN(0x0f8a7ea5))) {
                    throw new Error('Wrong op');
                }

                // todo: update request.jettonSent on the request with matching jettonQueryId in the db according to the logic below
                const jettonQueryId = slice.loadUint(64);
                const req = withdrawalRequests.find(r => r.jettonQueryId.toString() === jettonQueryId.toString());
                if (req !== undefined) {
                    if (tx.out_msgs.length === 0 || (tx.out_msgs.length === 1 && new TonWeb.Address(tx.out_msgs[0].destination).toString(false) === hotWalletAddress.toString(false))) {
                        req.jettonSent = false;
                        console.error(`WARNING! REQUEST jetton queryId ${queryId.toString()} AT TX ${tx.transaction_id.lt}:${tx.transaction_id.hash} WAS NOT SENT`);
                        // todo: send some system alert to a sysadmin - there is not enough balance or something like that, and manual intervention is likely necessary
                        // if the request is necessary, it needs to be re-added to queue manually
                    } else {
                        req.jettonSent = true;
                    }
                    // todo: persist req.jettonSent in db
                }

                } catch (e) {}

                knownLt = tx.transaction_id.lt;
                // todo: persist knownLt in db as last known lt **for this jetton name**

            }
        }

        } catch (e) { console.error(e); } finally {
            isJettonTxProcessing = false;
        }
    };

    await txTick(); // wait for its completion for the first time to clean possible undiscovered txs from a possibly crashed state
    setInterval(txTick, 5 * 1000); // 5 seconds

    setInterval(tick, 8 * 1000); // 8 seconds
    tick();

    setInterval(batchingTick, 10 * 1000); // 10 seconds
    batchingTick();

    setInterval(jettonTxTick, 10 * 1000); // 10 seconds
    jettonTxTick();
}

init();
