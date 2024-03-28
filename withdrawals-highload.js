/*
Here we will look at how to process withdrawals (outgoing Toncoins) from your hot wallet to users wallets.

1. You have a key pair of your hot wallet (how to create key pair is described in `common.js`).
   You will send Toncoins from this wallet.

2. You need to save all withdrawal requests in your database.

3. When sending, for each withdrawal request will be assigned a `created_at` (unixtime) and `query_id`.

4. We can repeat sending this transfer until it successfully sends. The `created_at` and `query_id` transfer parameter protects us from double withdrawal.

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

let queryId = new HighloadQueryId(); // query id iterator

// Withdrawal requests
const withdrawalRequests = [
    // Contains example withdrawal request
    // In real system `withdrawalRequests` is table in your persistent database
    {
        amount: TonWeb.utils.toNano('0.0123'),  // 0.0123 TON
        toAddress: 'UQAn_rlLlk_MwdfHcspLfpl3iEaQC1WZPFDD7KSbXNbXJ8wM',
        queryId: null,
        createdAt: null
    }
];

const sendWithdrawalRequest = (withdrawalRequest) => {
    const transfer = highloadWallet.methods.transfer({
        secretKey: keyPair.secretKey,
        queryId: withdrawalRequest.queryId,
        createdAt: withdrawalRequest.createdAt,
        toAddress: withdrawalRequest.toAddress,
        amount: withdrawalRequest.amount,
        needDeploy: withdrawalRequest.queryId === 0n
    });

    return transfer.send();
}

const init = async () => {
    const hotWalletAddress = await wallet.getAddress();
    const hotWalletAddressString = hotWalletAddress.toString(true, true, true);
    console.log('My HOT wallet is ', hotWalletAddressString);

    let isProcessing = false;

    const tick = async () => {
        if (!withdrawalRequests.length) return; // nothing to withdraw

        console.log(withdrawalRequests.length + ' requests');

        if (isProcessing) return;
        isProcessing = true;

        const now = Math.floor(Date.now() / 1000) - 60; // todo: in practice, you need to use the `utime` of the last shardchain block where the highload-walet is located

        for (const withdrawalRequest of withdrawalRequests) {
            if (!withdrawalRequest.queryId) { // not sent yet

                withdrawalRequest.queryId = queryId.getQueryId();

                if (queryId.isEnd()) {
                    queryId = new HighloadQueryId(); // reset, start from 0 again
                } else {
                    queryId.increase();
                }

                withdrawalRequest.createdAt = now;

                // save to your database

                await sendWithdrawalRequest(withdrawalRequest);


            } else {

                if (now - withdrawalRequest.createdAt >= HIGHLOAD_WALLET_TIMEOUT) {

                    // todo: expired - if not found in account transactions - can be recreated with new `query_id` and `created_at`

                } else {
                    const isProcessed = await highloadWallet.isProcessed(withdrawalRequest.queryId, false);

                    if (isProcessed) {

                        // mark withdrawal request as processed

                    } else {

                        // repeat send with same `queryId` and `createdAt`
                        await sendWithdrawalRequest(withdrawalRequest);

                    }

                }

            }

        }

        isProcessing = false;
    }

    setInterval(tick, 10 * 1000); // 10 seconds
    tick();
}

init();