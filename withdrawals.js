/*
Here we will look at how to process withdrawals (outgoing Toncoins) from your hot wallet to users wallets.

1. You have a key pair of your hot wallet (how to create key pair is described in `common.js`).
   You will send Toncoins from this wallet.

2. You need to save all withdrawal requests from users in a persistent queue.

3. We will process withdrawals one by one, starting with the first one added.

4. We will repeat sending this transfer until it successfully sends. The `seqno` transfer parameter protects us from double withdrawal.

5. After transfer successfully sends, we move on to the next one in the queue.

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

const WalletClass = tonweb.wallet.all.v3R2;

const wallet = new WalletClass(tonweb.provider, {
    publicKey: keyPair.publicKey
});

const doWithdraw = async (withdrawalRequest) => {
    // check seqno

    const seqno = await wallet.methods.seqno().call(); // get the current wallet `seqno` from the network

    if (seqno > withdrawalRequest.seqno) {
        // this withdrawal request processed
        // mark it in your database and go to the next withdrawal request
        console.log(`request ${withdrawalRequest.seqno} completed`);
        return true;
    }

    // check toncoin balance

    const balance = new BN(await tonweb.provider.getBalance((await wallet.getAddress()).toString(true, true, true)));

    if (withdrawalRequest.amount.gte(balance)) {
        console.log('there is not enough balance to process the withdrawal');
        return false;
    }

    // If the recipient is a not yet initialized wallet
    // then you need to send a non-bounce transfer
    // As an option, you can always make non-bounce transfers for withdrawals

    let toAddress = withdrawalRequest.toAddress;

    const info = await tonweb.provider.getAddressInfo(toAddress);
    if (info.state !== 'active') {
        toAddress = new TonWeb.utils.Address(toAddress).toString(true, true, false); // convert to non-bounce
    }

    // sign transfer (offline operation)

    const transfer = await wallet.methods.transfer({
        secretKey: keyPair.secretKey,
        toAddress: toAddress,
        amount: withdrawalRequest.amount,
        seqno: withdrawalRequest.seqno,
        payload: '123' // if necessary, here you can set a unique payload to distinguish the operation
    });

    // send transfer

    const isOfflineSign = false; // Some services sign transactions on one server and send signed transactions from another server

    if (isOfflineSign) {
        const query = await transfer.getQuery(); // transfer query
        const boc = await query.toBoc(false); // serialized transfer query in binary BoC format
        const bocBase64 = TonWeb.utils.bytesToBase64(boc); // in base64 format

        await tonweb.provider.sendBoc(bocBase64); // send transfer request to network
    } else {
        await transfer.send(); // send transfer request to network
    }
    console.log(`request ${withdrawalRequest.seqno} sent`);

    return false;
}

// Withdrawal requests queue
const withdrawalRequests = [
    // Contains example withdrawal request
    // In real system `withdrawalRequests` is table in your persistent database
    {
        amount: TonWeb.utils.toNano('0.0123'),  // 0.0123 TON
        toAddress: 'UQAn_rlLlk_MwdfHcspLfpl3iEaQC1WZPFDD7KSbXNbXJ8wM',
    }
];

// ATTENTION:
// `seqno` is wallet smart contract parameter - current sequence number of request to outgoing transfer. Starts from 0.
// The wallet smart contract only processes the request where current `seqno` of smart contract == `seqno` of request message.
// If they are equal then the wallet smart contract processes the transfer and increases the `seqno` by 1.
// If not equal then the request is discarded.

// Thus, the `seqno is an important mechanism to prevent double withdrawal.

const init = async () => {
    const hotWalletAddress = await wallet.getAddress();
    const hotWalletAddressString = hotWalletAddress.toString(true, true, false);
    console.log('My HOT wallet is ', hotWalletAddressString);

    let isProcessing = false;

    const tick = async () => {
        if (!withdrawalRequests.length) return; // nothing to withdraw

        console.log(withdrawalRequests.length + ' requests');

        if (isProcessing) return;
        isProcessing = true;

        // Get first withdrawal request from queue from database

        const withdrawalRequest = withdrawalRequests[0];

        // If the withdrawal request has no `seqno`, then we take the current wallet `seqno` from the network

        if (!withdrawalRequest.seqno) {
            withdrawalRequest.seqno = await wallet.methods.seqno().call();
            // after we set `seqno`, it should never change again for this transfer to prevent double withdrawal
        }

        try {
            if (await doWithdraw(withdrawalRequest)) {
                withdrawalRequests.shift(); // delete first request from queue
            }
        } catch (e) {
            console.error(e);
        }

        isProcessing = false;
    }

    setInterval(tick, 10 * 1000); // 10 seconds
    tick();
}

init();