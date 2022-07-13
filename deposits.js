/*
Here we will look at how to accept deposits. Each user will have their own deposit address.

1. You once generated a key pair and get corresponding address of your HOT wallet as described in the `common.js`.
   All payments from the user will first go to the user's deposit wallet, and then go to the HOT wallet.

2. When your user has to pay, you generate new wallet for him (as described in `common.js`).

3. You tell the user - please send N Toncoins to this wallet address.
   You can use a deeplink, by clicking on which the user will open the wallet app with all the fields filled in, if the wallet app is installed.
   ton://transfer/<wallet_address>?amount=<amount_in_nano>

4. Your backend is constantly subscribed to blocks appearing on the network.
   It is convenient to use the Index HTTP API of toncenter.com: https://toncenter.com/api/index/# or https://testnet.toncenter.com/api/index/#

5. Your backend iterates the transactions of each block, and if the transaction occurred on one of the deposit wallets, it is processed as a deposit.
   For security, we double-check each deposit transaction (its parameters and that the transaction exists) with an additional direct request to the node.

*/

const fetch = require('node-fetch');
const TonWeb = require("tonweb");
const BN = TonWeb.utils.BN;

const IS_TESTNET = true;
const TONCENTER_API_KEY = IS_TESTNET ? 'YOUR_TESTNET_TONCENTER_API_KEY' : 'YOUR_MAINNET_TONCENTER_API_KEY'; // obtain on https://toncenter.com
const INDEX_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/index/' : 'https://toncenter.com/api/index/';
const NODE_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';

const tonweb = new TonWeb(new TonWeb.HttpProvider(NODE_API_URL, {apiKey: TONCENTER_API_KEY}));

const MY_HOT_WALLET_ADDRESS = 'EQA0i8-CdGnF_DhUHHf92R1ONH6sIA9vLZ_WLcCIhfBBXwtG';

/**
 * HTTP request to node
 * @param method    {string}
 * @param params    {Object}
 * @return {Promise<Object>}
 */
const sendToNode = async (method, params) => {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-Key': TONCENTER_API_KEY
    };

    const request = {id: 1, jsonrpc: "2.0", method: method, params: params}

    return fetch(NODE_API_URL, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(request)
    })
        .then((response) => response.json())
        .then(({result, error}) => result || Promise.reject(error))
}

/**
 * HTTP request to Index API
 * @param masterchainBlockNumber    {number}
 * @return {Promise<Object>}
 */
const getTransactionsByMasterchainSeqno = (masterchainBlockNumber) => {
    const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-API-Key': TONCENTER_API_KEY
    };
    console.log(INDEX_API_URL + 'getTransactionsByMasterchainSeqno?seqno=' + masterchainBlockNumber)

    return fetch(
        INDEX_API_URL + 'getTransactionsByMasterchainSeqno?seqno=' + masterchainBlockNumber,
        {
            method: 'GET',
            headers: headers,
        })
        .then((response) => response.json())
        .then(response => response.error ? Promise.reject(response.error) : response)
}

/**
 * @param   address {string}
 * @return {boolean}
 */
const isDepositAddress = async (address) => {
    console.log(address);
    new TonWeb.Address(address).toString(true, true, true); // convert address to you form
    // more about address forms - https://ton.org/docs/#/howto/step-by-step?id=_1-smart-contract-addresses

    // check in DB that this address is one of deposit addresses of your service

    return true;
}

/**
 * @param tx    {Object}
 * @return {Promise<void>}
 */
const processDeposit = async (tx) => {
    const balance = new BN(await sendToNode('getAddressBalance', {address: tx.account}));

    if (balance.gt(new BN(0))) {

        const keyPair = TonWeb.utils.nacl.sign.keyPair(); // get key pair for this deposit wallet from your database

        const WalletClass = tonweb.wallet.all.v3R2;

        const depositWallet = new WalletClass(tonweb.provider, {
            publicKey: keyPair.publicKey
        });

        const seqno = await depositWallet.methods.seqno().call();

        const transfer = await depositWallet.methods.transfer({
            secretKey: keyPair.secretKey,
            toAddress: MY_HOT_WALLET_ADDRESS,
            amount: 0,
            seqno: seqno,
            payload: '123', // if necessary, here you can set a unique payload to distinguish the incoming payment to the hot wallet
            sendMode: 128 + 32, // mode 128 is used for messages that are to carry all the remaining balance; mode 32 means that the current account must be destroyed if its resulting balance is zero;
        });

        // IMPORTANT:
        // We send all balance from deposit wallet to hot wallet and destroy deposit wallet smart contract.
        // After destroy deposit wallet account will be `unitialized`.
        // Don't worry, you can always deploy it again with the next transfer (and then immediately destroy it).
        // TON has a micro fee for storage, which is occasionally debited from the balance of smart contracts simply for the fact that it's data is stored in the blockchain.
        // If there is nothing on the balance, then after a while the account will be frozen.
        // To avoid this and to be able to always use this address for this user, we destroy the account after each transfer.
        // Destroyed accounts do not store data and therefore do not pay for storage.

        await transfer.send();

        // In real life, you need to create a new transfer task, and repeat it until the balance of the deposit wallet is positive.
        // In case the API `send` call for some reason was not executed the first time.

        // You can process incoming coins on the hot wallet as described in `deposits-single-wallet.js`

    }
}

let lastProcessedMasterchainBlockNumber = 1453075; // saved in DB; last masterchain block number that your service processed

// current blocks you can see on https://tonscan.org/blocks or https://testnet.tonscan.org/blocks

const tick = async () => {
    try {
        const masterchainInfo = await sendToNode('getMasterchainInfo'); // get last masterchain info from node
        const lastMasterchainBlockNumber = masterchainInfo.last.seqno;

        if (lastMasterchainBlockNumber > lastProcessedMasterchainBlockNumber) {
            const masterchainBlockNumber = lastProcessedMasterchainBlockNumber + 1;

            const transactions = await getTransactionsByMasterchainSeqno(masterchainBlockNumber); // get all transactions (executed in masterchain and shardchains) related for this block number

            for (let tx of transactions) {
                if (await isDepositAddress(tx.account)) {
                    // For security, we double-check each deposit transaction with an additional direct request to the node
                    const result = await sendToNode('getTransactions', {
                        address: tx.account,
                        lt: tx.lt,
                        hash: tx.hash,
                        limit: 1
                    });
                    if (result.length < 1) {
                        throw new Error('no transaction in node');
                    }
                    const txFromNode = result[0];
                    // You can check `in_msg` and `out_msgs` parameters between `tx` and `txFromNode`

                    await processDeposit(tx);
                }
            }

            lastProcessedMasterchainBlockNumber = masterchainBlockNumber; // save in DB
        }
    } catch (e) {
        console.error(e);
    }
}

setInterval(tick, 1000); // new masterchain block created every ~5 seconds