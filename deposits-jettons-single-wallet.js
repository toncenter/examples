/*
Here we will look at how to accept Jettons deposits to a single wallet.

So you are accepting payments (deposits) in Jettons:

1. You once generated a key pair and get corresponding address of your wallet as described in the `common.js`.
   You will accept payments to this wallet.

2. When your user has to pay, you generate UUID (unique number) for this payment and save it in your database.
   By this unique number you will be able to distinguish which payment the incoming coins belong to.

3. You tell the user - please send N jettons to my wallet address with UUID as text comment.

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

const MY_WALLET_ADDRESS = 'EQB7AhB4fP7SWtnfnIMcVUkwIgVLKqijlcpjNEPUVontypON'; // your HOT wallet

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

const jettons = {};

const prepare = async () => {
    for (const name in JETTONS_INFO) {
        const info = JETTONS_INFO[name];
        const jettonMinter = new TonWeb.token.jetton.JettonMinter(tonweb.provider, {
            address: info.address
        });
        const jettonWalletAddress = await jettonMinter.getJettonWalletAddress(new TonWeb.utils.Address(MY_WALLET_ADDRESS));
        console.log('My jetton wallet for ' + name + ' is ' + jettonWalletAddress.toString(true, true, true));
        const jettonWallet = new TonWeb.token.jetton.JettonWallet(tonweb.provider, {
            address: jettonWalletAddress
        });

        const jettonData = await jettonWallet.getData();
        if (jettonData.jettonMinterAddress.toString(false) !== new TonWeb.utils.Address(info.address).toString(false)) {
            throw new Error('jetton minter address from jetton wallet doesnt match config');
        }

        jettons[name] = {
            jettonMinter: jettonMinter,
            jettonWalletAddress: jettonWalletAddress,
            jettonWallet: jettonWallet
        };
    }
}

const jettonWalletAddressToJettonName = (jettonWalletAddress) => {
    const jettonWalletAddressString = new TonWeb.utils.Address(jettonWalletAddress).toString(false);
    for (const name in jettons) {
        const jetton = jettons[name];
        if (jetton.jettonWalletAddress.toString(false) === jettonWalletAddressString) {
            return name;
        }
    }
    return null;
}

// Listen

const init = async () => {
    await prepare();

    const onTransaction = async (tx) => {
        const sourceAddress = tx.in_msg.source;
        if (!sourceAddress) {
            // external message - not related to jettons
            return;
        }
        const jettonName = jettonWalletAddressToJettonName(sourceAddress);
        if (!jettonName) {
            // unknown or fake jetton transfer
            return;
        }

        if (!tx.in_msg.msg_data ||
            tx.in_msg.msg_data['@type'] !== 'msg.dataRaw' ||
            !tx.in_msg.msg_data.body
        ) {
            // no in_msg or in_msg body
            return;
        }

        const msgBody = TonWeb.utils.base64ToBytes(tx.in_msg.msg_data.body);

        const cell = TonWeb.boc.Cell.oneFromBoc(msgBody);
        const slice = cell.beginParse();
        const op = slice.loadUint(32);
        if (!op.eq(new TonWeb.utils.BN(0x7362d09c))) return; // op == transfer_notification
        const queryId = slice.loadUint(64);
        const amount = slice.loadCoins();
        const from = slice.loadAddress();
        const maybeRef = slice.loadBit();
        const payload = maybeRef ? slice.loadRef() : slice;
        const payloadOp = payload.loadUint(32);
        if (!payloadOp.eq(new TonWeb.utils.BN(0))) {
            console.log('no text comment in transfer_notification');
            return;
        }
        const payloadBytes = payload.loadBits(slice.getFreeBits());
        const comment = new TextDecoder().decode(payloadBytes);
        console.log('Got ' + jettonName + ' jetton deposit ' + amount.toString() + ' units with text comment "' + comment + '"');
    }

    const accountSubscription = new AccountSubscription(tonweb, MY_WALLET_ADDRESS, 0, onTransaction);
    await accountSubscription.start();
}

init();