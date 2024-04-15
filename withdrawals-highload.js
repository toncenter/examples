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
        amount: TonWeb.utils.toNano('0.0123'),  // 0.0123 TON
        toAddress: 'UQAn_rlLlk_MwdfHcspLfpl3iEaQC1WZPFDD7KSbXNbXJ8wM',
        queryId: null,
        createdAt: null,
        processed: false,
        sent: null,
        wasRecreated: false,
    }
];

const sendWithdrawalRequest = (withdrawalRequest) => {
    const transfer = highloadWallet.methods.transfer({
        secretKey: keyPair.secretKey,
        queryId: HighloadQueryId.fromQueryId(withdrawalRequest.queryId),
        createdAt: withdrawalRequest.createdAt,
        toAddress: withdrawalRequest.toAddress,
        amount: withdrawalRequest.amount,
        needDeploy: withdrawalRequest.queryId === 0n
    });

    return transfer.send();
}

const init = async () => {
    const hotWalletAddress = await highloadWallet.getAddress();
    const hotWalletAddressString = hotWalletAddress.toString(true, true, false);
    console.log('My HOT wallet is', hotWalletAddressString);

    let isProcessing = false;
    let isTxProcessing = false;

    let lastKnownTxLt = undefined; // todo: load this from db
    let lastKnownTxUtime = undefined; // todo: load this from db
    // query id iterator
    let queryId = HighloadQueryId.fromQueryId(0n); // todo: load next query id from db

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

                // convert the address to bounceable or non-bounceable form as needed
                // note: you can also do that in the service that creates withdrawal requests instead of here
                // if you do this in the other service, it should improve the performance of this withdrawal service
                const addrInfo = await tonweb.provider.getAddressInfo(withdrawalRequest.toAddress);
                const addr = new TonWeb.Address(withdrawalRequest.toAddress).toString(true, true, addrInfo.state === 'active');
                if (addr !== withdrawalRequest.toAddress) {
                    withdrawalRequest.toAddress = addr;
                    // todo: persist withdrawalRequest.toAddress to db
                }

                // todo: persist queryId.getQueryId() in your database as the next query id
                // todo: persist withdrawalRequest.queryId and withdrawalRequest.createdAt in your database

                await sendWithdrawalRequest(withdrawalRequest);


            } else {

                if (withdrawalRequest.createdAt < lastKnownTxUtime - HIGHLOAD_WALLET_TIMEOUT) {

                    // expired

                    // todo: remove the request from db or mark it as recreated (so that it is no longer retried)
                    withdrawalRequest.wasRecreated = true;
                    // todo: add a copy of the request to the db with no query id and created at, essentially re-creating it
                    withdrawalRequests.push({ ...withdrawalRequest, queryId: null, createdAt: null });

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

        const TX_LIMIT = 20;

        let txs = await tonweb.provider.getTransactions(hotWalletAddressString, TX_LIMIT, undefined, undefined, undefined, true); // todo: remove archival (last `true` argument) if not needed
        const fullTxList = [];
        mainloop: while (true) {
            for (const tx of txs.length < TX_LIMIT ? txs : txs.slice(0, txs.length - 1)) {
                if (tx.transaction_id.lt === lastKnownTxLt) {
                    break mainloop;
                }

                fullTxList.push(tx);
            }

            if (txs.length < TX_LIMIT) {
                break;
            }

            txs = await tonweb.provider.getTransactions(hotWalletAddressString, TX_LIMIT, txs[txs.length-1].transaction_id.lt, txs[txs.length-1].transaction_id.hash, undefined, true); // todo: remove archival (last `true` argument) if not needed
        }

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

    await txTick(); // wait for its completion for the first time to clean possible undiscovered txs from a possibly crashed state
    setInterval(txTick, 5 * 1000); // 5 seconds

    setInterval(tick, 8 * 1000); // 8 seconds
    tick();
}

init();