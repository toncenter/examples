/*
Here we will look at how to accept deposits. Each user will have their own deposit address.

1. You once generated a key pair and get corresponding address of your HOT wallet as described in the `common.js`.
   All payments from the user will first go to the user's deposit wallet, and then go to the HOT wallet.

2. When your user has to pay, you generate new wallet for him (as described in `common.js`).

3. You tell the user - please send N Toncoins to this wallet address.
   You can use a deeplink, by clicking on which the user will open the wallet app with all the fields filled in, if the wallet app is installed.
   ton://transfer/<wallet_address>?amount=<amount_in_nano>

4. Your backend is constantly subscribed to blocks appearing on the network.

5. Your backend iterates the transactions of each block, and if the transaction occurred on one of the deposit wallets, it is processed as a deposit.

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

const MY_HOT_WALLET_ADDRESS = 'EQA0i8-CdGnF_DhUHHf92R1ONH6sIA9vLZ_WLcCIhfBBXwtG';

async function init() {

    // BlockStorage stores blocks that we have already processed
    // In this example we use in-memory storage
    // In real life you need to implement BlockStorage interface and use a real database (e.g. MySQL, PostgreSQL or MongoDB).
    const storage = new TonWeb.InMemoryBlockStorage(console.log);

    const onBlock = async (blockHeader) => {
        const workchain = blockHeader.id.workchain;
        const shardId = blockHeader.id.shard;
        const blockNumber = blockHeader.id.seqno;
        console.log('Got block ', workchain + ':' + shardId + ':' + blockNumber);

        // BlockId = workchain + shardId + blockNumber; these three parameters uniquely identify the block.

        const blockTransactions = await tonweb.provider.getBlockTransactions(workchain, shardId, blockNumber); // todo: (tolya-yanot) `incomplete` is not handled in response
        const shortTransactions = blockTransactions.transactions;
        for (const shortTx of shortTransactions) {
            console.log('Got transaction at ' + shortTx.account);

            // If the `shortTx.account` address is in your database of deposit addresses
            // then we check and process the deposit

            // if you need to get the full transaction you can do the following:

            const transactions = await tonweb.provider.getTransactions(shortTx.account, 1, shortTx.lt, shortTx.hash);
            const tx = transactions[0];

            // But it is enough for us to find out that there is a balance on the deposit wallet and send the coins to the hot wallet

            const balance = new BN(await tonweb.provider.getBalance(shortTx.account));

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
    }

    const blockSubscribe = new TonWeb.BlockSubscription(tonweb.provider, storage, onBlock);
    await blockSubscribe.start();
}

init();