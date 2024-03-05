/*
Here we will look at how to accept Jettons deposits. Each user will have their own deposit address.

1. You once generated a key pair and get corresponding address of your HOT wallet as described in the `common.js`.
   All payments from the user will first go to the user's deposit wallet, and then go to the HOT wallet.

2. When your user has to pay, you generate new wallet for him (as described in `common.js`) and store keys in your database.

3. You tell the user - please send N jettons to this wallet address.

4. Your backend is constantly subscribed to blocks appearing on the network.
   It is convenient to use the Index HTTP API of toncenter.com: https://toncenter.com/api/v3/# or https://testnet.toncenter.com/api/v3/#

5. Your backend iterates the transactions of each block, and if the transaction occurred on one of the deposit jetton-wallets, it is processed as a deposit.
   For security, we double-check each deposit transaction (its parameters and that the transaction exists) with an additional direct request to the node.

*/

import TonWeb from "tonweb";
import {BlockSubscriptionIndex} from "./block/BlockSubscriptionIndex.js";
import TonWebMnemonic from "tonweb-mnemonic";

const BN = TonWeb.utils.BN;

const IS_TESTNET = false;
const TONCENTER_API_KEY = IS_TESTNET ? 'YOUR_TESTNET_API_KEY' : 'YOUR_MAINNET_API_KEY'; // obtain on https://toncenter.com
// You can use your own instance of TON-HTTP-API or public toncenter.com
const NODE_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
const INDEX_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/index/' : 'https://toncenter.com/api/index/';

const tonweb = new TonWeb(new TonWeb.HttpProvider(NODE_API_URL, {apiKey: TONCENTER_API_KEY}));

const MY_HOT_WALLET_ADDRESS = 'UQB7AhB4fP7SWtnfnIMcVUkwIgVLKqijlcpjNEPUVontys5I';

// Supported jettons config

const jettonsInfo = {
    'jUSDC': {
        address: 'EQB-MPwrd1G6WKNkLz_VnV6WqBDd142KMQv-g1O-8QUA3728',
        decimals: 6,
        hasStandardInternalTransfer: true,
        minDepositAmount: '1' // minimum amount to deposit in units
    },
    'KOTE': {
        address: 'EQBlU_tKISgpepeMFT9t3xTDeiVmo25dW_4vUOl6jId_BNIj',
        decimals: 9,
        hasStandardInternalTransfer: true,
        minDepositAmount: '1' // minimum amount to deposit in units
    }
};

const jettons = {};

for (const jettonInfoName in jettonsInfo) {
    const jettonInfo = jettonsInfo[jettonInfoName];
    jettons[jettonInfoName] = new TonWeb.token.jetton.JettonMinter(tonweb.provider, {address: jettonInfo.address});
}

// Create deposit jetton-wallets for each jetton for specified user

const userIdToTonWallet = {};
const userIdToJettonWallet = {};

const createWallet = (keyPair) => {
    const WalletClass = tonweb.wallet.all.v3R2;
    const wallet = new WalletClass(tonweb.provider, {
        publicKey: keyPair.publicKey
    });
    return wallet;
}

const createDepositWallet = async (userId, keyPair) => {
    const wallet = createWallet(keyPair);

    const address = await wallet.getAddress();
    console.log(`user ${userId} deposit wallet is ` + address.toString(true, true, false))
    userIdToTonWallet[userId] = {address, keyPair};
    // get deposit jetton-wallet addresses for this user
    for (const jettonName in jettons) {
        const jetton = jettons[jettonName];
        const jettonAddress = await jetton.getJettonWalletAddress(address);
        console.log(`user ${userId} underlying ${jettonName} jetton-wallet is ` + jettonAddress.toString(true, true, true));
        if (!userIdToJettonWallet[userId]) {
            userIdToJettonWallet[userId] = {};
        }
        userIdToJettonWallet[userId][jettonName] = jettonAddress;
    }
    return address;
}

// Sending from deposit wallet to hot wallet

const TOP_UP_AMOUNT = TonWeb.utils.toNano('0.05'); // 0.05 TON

const processDeposit = async (request) => {
    const userTonWallet = userIdToTonWallet[request.userId];
    const keyPair = userTonWallet.keyPair;
    const wallet = createWallet(keyPair);

    const toncoinBalance = new BN(await tonweb.provider.getBalance(userTonWallet.address.toString(true, true, true)));

    if (new BN(TOP_UP_AMOUNT).gt(toncoinBalance)) {
        return false; // wait for Toncoins top-up for gas to transfer jettons
    }

    const jettonWalletAddress = userIdToJettonWallet[request.userId][request.jettonName];
    const jettonWallet = new TonWeb.token.jetton.JettonWallet(tonweb.provider, {address: jettonWalletAddress});

    const jettonBalance = (await jettonWallet.getData()).balance;

    const jettonInfo = jettonsInfo[request.jettonName];

    if (new BN(jettonInfo.minDepositAmount).gt(jettonBalance)) {
        console.log('not enough jettons');
        return false;
    }

    const seqno = await wallet.methods.seqno().call() || 0;

    const transfer = await wallet.methods.transfer({
        secretKey: keyPair.secretKey,
        toAddress: jettonWalletAddress,
        amount: 0,
        seqno: seqno,
        sendMode: 128 + 32, // mode 128 is used for messages that are to carry all the remaining balance; mode 32 means that the current account must be destroyed if its resulting balance is zero;
        payload: await jettonWallet.createTransferBody({
            queryId: seqno, // any number
            jettonAmount: jettonBalance, // jetton amount in units
            toAddress: new TonWeb.utils.Address(MY_HOT_WALLET_ADDRESS),
            responseAddress: new TonWeb.utils.Address(MY_HOT_WALLET_ADDRESS)
        })
    });

    // IMPORTANT:
    // We send all Toncoin balance from deposit wallet and destroy deposit wallet smart contract.
    // After destroy deposit wallet account will be `unitialized`.
    // Don't worry, you can always deploy it again with the next transfer (and then immediately destroy it).
    // TON has a micro fee for storage, which is occasionally debited from the balance of smart contracts simply for the fact that it's data is stored in the blockchain.
    // If there is nothing on the balance, then after a while the account will be frozen.
    // To avoid this and to be able to always use this address for this user, we destroy the account after each transfer.
    // Destroyed accounts do not store data and therefore do not pay for storage.

    await transfer.send();

    // Jetton-wallet contract has automatic Toncoin balance replenishment during transfer -
    // at the time the jettons arrive, the jetton-wallet contract always leaves a small Toncoin amount on the balance, enough to store for about a year.
    //
    // In case of freezing, if the balance of jetton on the jetton-wallet contract is zero, then the incoming jettons will unfreeze it.
    //
    // However, a case is possible when a user sent too few jettons, your service did not transfer jettons to a hot wallet, and then this jetton-wallet was frozen.
    // In this case, the user can be offered to unfreeze his deposit address on his own by https://unfreezer.ton.org/

    return true;
}

const depositsRequests = [];

let isProcessing = false;

const processDepositsTick = async () => {
    if (!depositsRequests.length) return; // nothing to withdraw

    if (isProcessing) return;
    isProcessing = true;

    console.log(depositsRequests.length + ' requests');

    // Get first  request from queue from database

    const request = depositsRequests[0];

    try {
        if (await processDeposit(request)) {
            depositsRequests.shift(); // delete first request from queue
        }
    } catch (e) {
        console.error(e);
    }

    isProcessing = false;
}

setInterval(processDepositsTick, 10 * 1000); // 10 seconds

// Listen blocks

const findDepositAddress = async (addressString) => {
    const address = new TonWeb.utils.Address(addressString).toString(false);

    for (const userId in userIdToJettonWallet) {
        for (const jettonInfoName in jettonsInfo) {
            const jettonWalletAddress = userIdToJettonWallet[userId][jettonInfoName].toString(false);
            if (address === jettonWalletAddress) {
                return {userId: userId, jettonName: jettonInfoName};
            }
        }
    }
    return null;
}

const validateJettonTransfer = async (txFromIndex, jettonName) => {
    try {
        const jettonInfo = jettonsInfo[jettonName];

        const sourceAddress = txFromIndex.in_msg.source;
        if (!sourceAddress) {
            // external message - not related to jettons
            return false;
        }

        // For security, we double-check each deposit transaction with an additional direct request to the node
        const result = await tonweb.provider.getTransactions(txFromIndex.account, 1, txFromIndex.lt, txFromIndex.hash);
        if (result.length < 1) {
            throw new Error('no transaction in node');
        }
        const tx = result[0];
        // You can check `in_msg` and `out_msgs` parameters between `txFromIndex` and `tx` from node

        if (tx.out_msgs.length === 1 && new TonWeb.utils.Address(tx.out_msgs[0].destination).toString(false) === new TonWeb.utils.Address(tx.in_msg.source).toString(false)) {
            return false; // bounced message - error in transaction
        }

        // KEEP IN MIND that jettons are not required to implement a common internal_transfer, although the vast majority of jettons do.
        // If you want to support an unusual jetton, you don't need to parse the internal_transfer, just look at the balance of the jetton-wallet and transfer it to the hot wallet.

        if (jettonInfo.hasStandardInternalTransfer) {

            if (!tx.in_msg.msg_data ||
                tx.in_msg.msg_data['@type'] !== 'msg.dataRaw' ||
                !tx.in_msg.msg_data.body
            ) {
                // no in_msg or in_msg body
                return false;
            }

            const msgBody = TonWeb.utils.base64ToBytes(tx.in_msg.msg_data.body);

            const cell = TonWeb.boc.Cell.oneFromBoc(msgBody);
            const slice = cell.beginParse();
            const op = slice.loadUint(32);
            if (!op.eq(new TonWeb.utils.BN(0x178d4519))) return; // op == internal_transfer_notification
            const queryId = slice.loadUint(64);
            const amount = slice.loadCoins(); // amount of incoming jettons in units
            const from = slice.loadAddress();

            if ((await jettons[jettonName].getJettonWalletAddress(new TonWeb.utils.Address(from))).toString(false) !== new TonWeb.utils.Address(sourceAddress).toString(false)) {
                // fake transfer - IT IS VERY IMPORTANT TO DO THIS CHECK
                return false;
            }
        }

        return true;
    } catch (e) {
        console.error(e);
        return false;
    }
}

const onTransaction = async (tx) => {
    // If the `tx.account` address is in your database of users jetton-wallet addresses
    // then we validate and process the deposit
    const found = await findDepositAddress(tx.account);

    if (found) {
        if (!(await validateJettonTransfer(tx, found.jettonName))) {
            return;
        }

        const jettonInfo = jettonsInfo[found.jettonName]
        const jettonWalletAddress = userIdToJettonWallet[found.userId][found.jettonName];
        const jettonWallet = new TonWeb.token.jetton.JettonWallet(tonweb.provider, {address: jettonWalletAddress});
        const jettonBalance = (await jettonWallet.getData()).balance;

        if (new BN(jettonInfo.minDepositAmount).gt(jettonBalance)) {
            console.log('not enough jettons');
            return false;
        }

        console.log(found.jettonName + ' jetton deposit of user ' + found.userId + ' detected');

        // Your need create Toncoin top-up queue (see `withdrawals.js`) from you reserve wallet to user deposit wallet
        // You will send `TOP_UP_AMOUNT` small amount of Toncoins to deposit wallet. It's amount for gas to transfer jetton.

        // Add withdrawal request to top-up queue here:

        // topUpRequests.push({
        //     amount: TOP_UP_AMOUNT,
        //     toAddress: userIdToTonWallet[found.userId].address
        // });

        depositsRequests.push({ // request to transfer jettons from deposit wallet to hot wallet
            jettonName: found.jettonName,
            userId: found.userId
        });
    }
}

const init = async () => {
    await createDepositWallet(0, TonWeb.utils.newKeyPair()); // generate new keypair for user deposit wallet
    console.log('To deposit send jettons to address ' + (userIdToTonWallet[0]).address.toString(true, true, false));
    await createDepositWallet(1, TonWeb.utils.newKeyPair()); // generate new keypair for user deposit wallet
    console.log('To deposit send jettons to address ' + (userIdToTonWallet[1]).address.toString(true, true, false));
    await createDepositWallet(2, TonWeb.utils.keyPairFromSeed(await TonWebMnemonic.mnemonicToSeed('word1 word2 word3 ...'.split(' '))));
    console.log('To deposit send jettons to address ' + (userIdToTonWallet[2]).address.toString(true, true, false));

    const masterchainInfo = await tonweb.provider.getMasterchainInfo(); // get last masterchain info from node
    const lastMasterchainBlockNumber = masterchainInfo.last.seqno;
    console.log(`Starts from ${lastMasterchainBlockNumber} masterchain block`);

    // const blockSubscription = new BlockSubscriptionRaw(tonweb, lastMasterchainBlockNumber, onTransaction);
    // or
    const blockSubscription = new BlockSubscriptionIndex(tonweb, lastMasterchainBlockNumber, onTransaction, INDEX_API_URL, TONCENTER_API_KEY);
    await blockSubscription.start();
}

init();