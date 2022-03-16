/*
Here we will look at how to process withdrawals (outgoing coins) from your hot wallet to user wallet.

1. You have a key pair of your hot wallet (how to create key pair is described in `common.js`).
   You will send coins from this wallet.

2. You need to save all withdrawal requests from users in a persistent queue.

3. We will process withdrawals one by one, starting with the first one added.

4. We will repeat sending this transfer until it successfully sends. The `seqno` transfer parameter protects us from double withdrawal.

5. After transfer successfully sends, we move on to the next one in the queue.

*/

const TonWeb = require("tonweb");
const BN = TonWeb.utils.BN;

const isMainnet = false;

// Use toncenter.com as HTTP API endpoint to interact with TON blockchain.
// You can get HTTP API key at https://toncenter.com
// You can run your own HTTP API instance https://github.com/toncenter/ton-http-api
const tonweb = isMainnet ?
    new TonWeb(new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_MAINNET_API_KEY'})) :
    new TonWeb(new TonWeb.HttpProvider('https://testnet.toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_TESTNET_API_KEY'}));

const keyPair = TonWeb.utils.nacl.sign.keyPair(); // your hot wallet key pair

const WalletClass = tonweb.wallet.all.v3R2;

const wallet = new WalletClass(tonweb.provider, {
    publicKey: keyPair.publicKey
});

const doWithdraw = async (withdrwalRequest) => {
    const seqno = await wallet.methods.seqno().call();

    if (seqno > withdrwalRequest.seqno) {
        // this withdrawal request processed
        // mark it in your database and go to the next withdrawal request
        return true;
    }

    const balance = new BN(await tonweb.provider.getBalance(await wallet.getAddress()));

    if (withdrwalRequest.amount.gte(balance)) {
        console.log('there is not enough balance to process the withdrawal');
        return false;
    }

    // sign transfer (offline operation)

    const transfer = await wallet.methods.transfer({
        secretKey: keyPair.secretKey,
        toAddress: withdrwalRequest.toAddress,
        amount: withdrwalRequest.amount,
        seqno: withdrwalRequest.seqno,
        payload: '123', // if necessary, here you can set a unique payload to distinguish the operation
        sendMode: 3,
    });
    const query = await transfer.getQuery(); // transfer query
    const boc = await query.toBoc(false); // serialized transfer query in binary BoC format
    const bocBase64 = TonWeb.utils.bytesToBase64(boc); // in base64 format

    // send transfer request to network

    await transfer.send();

    // OR
    // await transfer.provider.sendBoc(bocBase64);

}

// ATTENTION:
// `seqno` is wallet smart contract parameter - current sequence number of request to outgoing transfer. Starts from 0.
// The wallet smart contract only processes the request where current `seqno` of smart contract == `seqno` of request message.
// If they are equal then the wallet smart contract processes the transfer and increases the `seqno` by 1.
// If not equal then the request is discarded.

// Thus, the `seqno is an important mechanism to prevent double withdrawal.

const init = async () => {

    // Get first withdrawal request from queue from database

    const withdrwalRequest = {
        amount: TonWeb.utils.toNano(1),  // 1 TON
        toAddress: 'EQDjVXa_oltdBP64Nc__p397xLCvGm2IcZ1ba7anSW0NAkeP',
    };

    // If the withdrawal request has no `seqno`, then we take the current wallet `seqno` from the network

    if (!withdrwalRequest.seqno) {
        withdrwalRequest.seqno = await wallet.methods.seqno().call();
        // after we set `seqno`, it should never change again for this transfer to prevent double withdrawal
    }

    let isProcessing = false;

    const tick = async () => {
        if (isProcessing) return;
        isProcessing = true;

        try {
            await doWithdraw(withdrwalRequest);
        } catch (e) {
            console.error(e);
        }

        isProcessing = false;
    }

    setInterval(tick, 10 * 1000); // 10 seconds

}

init();