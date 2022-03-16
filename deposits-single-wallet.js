/*
Here we will look at how to accept deposits to a single wallet.

So you are accepting payments (deposits) in Toncoins:

1. You once generated a key pair and get corresponding address of your wallet as described in the `common.js`.
   You will accept payments to this wallet.

2. When your user has to pay, you generate UUID (unique number) for this payment and save it in your database.
   By this unique number you will be able to distinguish which payment the incoming coins belong to.

3. You tell the user - please send N Toncoins to my wallet address with UUID as text comment.
   You can use a deeplink, by clicking on which the user will open the wallet app with all the fields filled in, if the wallet app is installed.
   ton://transfer/<wallet_address>?amount=<amount_in_nano>&text=<uuid>

4. Your backend constantly periodically requests a list of your wallet transactions.

5. It iterates the list of transactions, finds incoming transactions, and it processes them as a deposit, if they have not been processed yet.

*/

const TonWeb = require("tonweb");

const isMainnet = false;

// Use toncenter.com as HTTP API endpoint to interact with TON blockchain.
// You can get HTTP API key at https://toncenter.com
// You can run your own HTTP API instance https://github.com/toncenter/ton-http-api
const tonweb = isMainnet ?
    new TonWeb(new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_MAINNET_API_KEY'})) :
    new TonWeb(new TonWeb.HttpProvider('https://testnet.toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_TESTNET_API_KEY'}));

let isProcessing = false;
let startTime = 1645023521; // start unixtime (stored in your database), transactions made earlier will be discarded. Initially save the time + 1 of your first transaction in the wallet.
const MY_WALLET_ADDRESS = 'EQA0i8-CdGnF_DhUHHf92R1ONH6sIA9vLZ_WLcCIhfBBXwtG';

const getTransactions = async (time, offsetTransactionLT, offsetTransactionHash) => {
    const COUNT = 20;

    if (offsetTransactionLT) {
        console.log(`Get ${COUNT} transactions before transaction ${offsetTransactionLT}:${offsetTransactionHash}`);
    } else {
        console.log(`Get last ${COUNT} transactions`);
    }

    // TON transaction has composite ID: account address (on which the transaction took place) + transaction LT (logical time) + transaction hash.
    // So TxID = address+LT+hash, these three parameters uniquely identify the transaction.
    // In our case, we are monitoring one wallet and the address is MY_WALLET_ADDRESS.

    const transactions = await tonweb.provider.getTransactions(MY_WALLET_ADDRESS, COUNT, offsetTransactionLT, offsetTransactionHash);

    console.log(`Got ${transactions.length} transactions`);

    if (!transactions.length) {
        // unfortunately there is an imperfection in the HTTP API at the moment https://github.com/toncenter/ton-http-api/issues/27
        // in rare non-persistent cases, it may return fewer transactions than requested, although transactions actually exist.
        // so here we can't rely on the fact that the transactions actually ended.
        return 0;
    }

    if (!time) time = transactions[0].utime;

    for (const tx of transactions) {

        if (tx.utime < startTime) {
            return time;
        }

        // If incoming message source address is defined and no outgoing messages - this is incoming coins.
        // ATTENTION: always check that there were no outgoing messages.

        if (tx.in_msg.source && tx.out_msgs.length === 0) {
            const value = tx.in_msg.value; // amount in nano-Toncoins (1 Toncoin = 1e9 nano-Toncoins)
            const senderAddress = tx.in_msg.source; // sender address
            const payload = tx.in_msg.message; // transfer text comment (in our case, the user should send the UUID as a text comment)

            // here you find the payment in your database by UUID,
            // check that the payment has not been processed yet and the amount matches,
            // save to the database that this payment has been processed.

            console.log(`Receive ${TonWeb.utils.fromNano(value)} TON from ${senderAddress} with comment "${payload}"`);
        }
    }

    if (transactions.length === 1) {
        return 0;
    }

    const lastTx = transactions[transactions.length - 1];
    return await getTransactions(time, lastTx.transaction_id.lt, lastTx.transaction_id.hash);
}

const tick = async () => {
    if (isProcessing) return;
    isProcessing = true;

    try {
        const result = await getTransactions(undefined, undefined, undefined);
        if (result > 0) {
            startTime = result; // store in your database
        }
    } catch (e) {
        console.error(e);
    }

    isProcessing = false;
}

setInterval(tick, 10 * 1000); // poll every 10 seconds
tick();