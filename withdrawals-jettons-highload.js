/*
Here we will look at how to process withdrawals (outgoing Toncoins) from your hot wallet to users wallets.

1. You have a key pair of your hot wallet (how to create key pair is described in `common.js`).
   You will send Toncoins from this wallet.

2. You need to save all withdrawal requests in your database.

3. When sending, for each withdrawal request will be assigned a `created_at` (unixtime) and `query_id`.

4. We can repeat sending this transfer until it successfully sends. The `created_at` and `query_id` transfer parameter protects us from double withdrawal.

A more detailed highload v3 overview: https://docs.ton.org/participate/wallets/contracts#highload-wallet-v3

*/

import TonWeb from "tonweb";
import TonWebMnemonic from "tonweb-mnemonic";

const BN = TonWeb.utils.BN;

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
        jettonName: 'jUSDC',
        amount: '1000',  // 1000 jetton units, or 0.001 jUSDC
        toAddress: 'UQAn_rlLlk_MwdfHcspLfpl3iEaQC1WZPFDD7KSbXNbXJ8wM',
        queryId: null,
        createdAt: null,
        processed: false,
        sent: null,
        wasRecreated: false,
        jettonSent: null,
        jettonQueryId: null,
    }
];

const sendWithdrawalRequest = async (withdrawalRequest) => {
    const jettonWallet = jettons[withdrawalRequest.jettonName].jettonWallet;

    const jettonWalletAddress = jettons[withdrawalRequest.jettonName].jettonWalletAddress.toString(true, true, true);

    const transfer = highloadWallet.methods.transfer({
        secretKey: keyPair.secretKey,
        queryId: HighloadQueryId.fromQueryId(withdrawalRequest.queryId),
        createdAt: withdrawalRequest.createdAt,
        toAddress: jettonWalletAddress,
        amount: TonWeb.utils.toNano('0.05'), // 0.05 TON
        payload: await jettonWallet.createTransferBody({
            queryId: new BN(withdrawalRequest.jettonQueryId.toString()), // any unique number
            jettonAmount: withdrawalRequest.amount, // jetton amount in units
            toAddress: new TonWeb.utils.Address(withdrawalRequest.toAddress),
            responseAddress: hotWalletAddress,
        }),
        needDeploy: withdrawalRequest.queryId === 0n,
    });

    return await transfer.send();
}

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
}

const init = async () => {
    await prepare();

    let isProcessing = false;
    let isTxProcessing = false;
    let isJettonTxProcessing = false;

    let lastKnownTxLt = undefined; // todo: load this from db
    let lastKnownTxUtime = undefined; // todo: load this from db
    // query id iterator
    let queryId = HighloadQueryId.fromQueryId(0n); // todo: load next query id from db
    let nextJettonQueryId = 0n; // todo: load next jetton query id from db

    const tick = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {

        // todo: load unprocessed withdrawal requests here (see unprocessed conditions below), up to some reasonable limit (we recommend 100 requests)

        if (!withdrawalRequests.length) return; // nothing to withdraw

        console.log(withdrawalRequests.length + ' requests');

        const now = (await tonweb.provider.getExtendedAddressInfo(hotWalletAddressString)).sync_utime;

        for (const withdrawalRequest of withdrawalRequests.filter(req => !req.processed && !req.wasRecreated).slice(0, 100)) { // todo: use requests from db
            if (withdrawalRequest.queryId === null) { // not sent yet

                withdrawalRequest.queryId = queryId.getQueryId();

                if (queryId.hasNext()) {
                    queryId = queryId.getNext();
                } else {
                    queryId = new HighloadQueryId(); // reset, start from 0 again
                }

                withdrawalRequest.createdAt = now;

                withdrawalRequest.jettonQueryId = nextJettonQueryId;
                nextJettonQueryId += 1n;

                // todo: persist queryId.getQueryId(), nextJettonQueryId in your database as the next query id and next jetton query id
                // todo: persist withdrawalRequest.queryId, withdrawalRequest.createdAt, and withdrawalRequest.jettonQueryId in your database

                await sendWithdrawalRequest(withdrawalRequest);


            } else {

                if (withdrawalRequest.createdAt < lastKnownTxUtime - HIGHLOAD_WALLET_TIMEOUT) {

                    // expired

                    // todo: remove the request from db or mark it as recreated (so that it is no longer retried)
                    withdrawalRequest.wasRecreated = true;
                    // todo: add a copy of the request to the db with no query id and created at, essentially re-creating it
                    withdrawalRequests.push({ ...withdrawalRequest, queryId: null, createdAt: null, jettonQueryId: null });

                } else {

                    // repeat send with same `queryId` and `createdAt`
                    try {
                        await sendWithdrawalRequest(withdrawalRequest); // may throw due to TOCTOU
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

        const fullTxList = await collectTxs(hotWalletAddressString, lastKnownTxLt, true);

        fullTxList.reverse();

        for (const tx of fullTxList) {
            try {
                if (tx.in_msg.source !== '') { // we're only looking for external messages
                    throw new Error('Not an external message');
                }

                const bodyStr = tx.in_msg.msg_data.body;

                const body = TonWeb.boc.Cell.oneFromBoc(TonWeb.utils.base64ToBytes(bodyStr)).beginParse();

                const msgInner = body.loadRef();

                msgInner.loadUint(32 + 8); // skip subwallet id and send mode

                const queryId = msgInner.loadUint(23);
                const createdAt = msgInner.loadUint(64);

                // todo: update request.processed and request.sent on the request with matching queryId and createdAt in the db according to the logic below
                const req = withdrawalRequests.find(r => r.queryId.toString() === queryId.toString() && r.createdAt.toString() === createdAt.toString());
                if (req !== undefined) {
                    req.processed = true;
                    if (tx.out_msgs.length > 0) {
                        req.sent = true;
                    } else {
                        req.sent = false;
                        console.error(`WARNING! REQUEST AT TX ${tx.transaction_id.lt}:${tx.transaction_id.hash} WAS NOT SENT`);
                        // todo: send some system alert to a sysadmin - there is not enough balance or something like that, and manual intervention is likely necessary
                        // if the request is necessary, it needs to be re-added to queue manually
                    }
                    // todo: persist req.processed and req.sent in db
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

            if (fullTxList.length > 0) {
                console.log('Found new txs on', name, 'from', fullTxList[0].transaction_id.lt, fullTxList[0].transaction_id.hash, 'to', fullTxList[fullTxList.length-1].transaction_id.lt, fullTxList[fullTxList.length-1].transaction_id.hash);
            }

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

    setInterval(jettonTxTick, 10 * 1000); // 10 seconds
    jettonTxTick();
}

init();