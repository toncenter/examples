/*
Here we will look at how to accept Toncoin deposits to a single wallet.

So you are accepting payments (deposits) in Toncoins:

1. You once generated a key pair and get corresponding address of your wallet as described in the `common.js`.
   You will accept payments to this wallet.

2. When your user has to pay, you generate UUID (unique number) for this payment and save it in your database.
   By this unique number you will be able to distinguish which payment the incoming coins belong to.

3. You tell the user - please send N Toncoins to my wallet address with UUID as text comment.
   You can use a deeplink, by clicking on which the user will open the wallet app with all the fields filled in, if the wallet app is installed.
   ton://transfer/<wallet_address>?amount=<amount_in_nano>&text=<uuid>

4. Your backend constantly periodically requests a list of your wallet transactions.

5. It iterates the list of transactions, finds incoming transactions, and it processes eligible transactions as a deposits, if they have not been processed yet.

*/

import TonWeb from "tonweb";
import {AccountSubscription} from "./account/AccountSubscription.js";

const isMainnet = true;

// Use toncenter.com as HTTP API endpoint to interact with TON blockchain.
// You can get HTTP API key at https://toncenter.com
// You can run your own HTTP API instance https://github.com/toncenter/ton-http-api
const tonweb = isMainnet ?
    new TonWeb(new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_MAINNET_API_KEY'})) :
    new TonWeb(new TonWeb.HttpProvider('https://testnet.toncenter.com/api/v2/jsonRPC', {apiKey: 'YOUR_TESTNET_API_KEY'}));

const MY_WALLET_ADDRESS = 'EQB7AhB4fP7SWtnfnIMcVUkwIgVLKqijlcpjNEPUVontypON';

// Listen

const onTransaction = async (tx) => {
    // If incoming message source address is defined and no outgoing messages - this is incoming Toncoins.
    // ATTENTION: ALWAYS CHECK THAT THERE WERE NO OUTGOING MESSAGES.
    // It is important to check that Toncoins did not bounce back in case of an error.

    if (tx.in_msg.source && tx.out_msgs.length === 0) {

        if (tx.in_msg.msg_data && tx.in_msg.msg_data['@type'] !== 'msg.dataText') { // no text comment
            return;
        }

        const value = tx.in_msg.value; // amount in nano-Toncoins (1 Toncoin = 1e9 nano-Toncoins)
        const senderAddress = tx.in_msg.source; // sender address
        const payload = tx.in_msg.message; // transfer text comment (in our case, the user should send the UUID as a text comment)

        // here you find the payment in your database by UUID,
        // check that the payment has not been processed yet and the amount matches,
        // save to the database that this payment has been processed.

        console.log(`Receive ${TonWeb.utils.fromNano(value)} TON from ${senderAddress} with comment "${payload}"`);
    }
}

const accountSubscription = new AccountSubscription(tonweb, MY_WALLET_ADDRESS, 0, onTransaction);
accountSubscription.start();