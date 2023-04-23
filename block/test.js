// Example of using `BlockSubscriptionRaw` or `BlockSubscriptionIndex`

import TonWeb from "tonweb";
import {BlockSubscriptionRaw} from "./BlockSubscriptionRaw.js";
import {BlockSubscriptionIndex} from "./BlockSubscriptionIndex.js";

const IS_TESTNET = true;
const TONCENTER_API_KEY = IS_TESTNET ? 'YOUR_TESTNET_API_KEY' : 'YOUR_MAINNET_API_KEY'; // obtain on https://toncenter.com
// You can use your own instance of TON-HTTP-API or public toncenter.com
const NODE_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/v2/jsonRPC' : 'https://toncenter.com/api/v2/jsonRPC';
const INDEX_API_URL = IS_TESTNET ? 'https://testnet.toncenter.com/api/index/' : 'https://toncenter.com/api/index/';

const tonweb = new TonWeb(new TonWeb.HttpProvider(NODE_API_URL, {apiKey: TONCENTER_API_KEY}));

const init = async () => {

    const onTransaction = async (shortTx) => {
        console.log('Got transaction ' + shortTx.lt + ':' + shortTx.hash + ' at account ' + shortTx.account);
    }

    const masterchainInfo = await tonweb.provider.getMasterchainInfo(); // get last masterchain info from node
    const lastMasterchainBlockNumber = masterchainInfo.last.seqno;
    console.log(`Starts from ${lastMasterchainBlockNumber} masterchain block`);

    const blockSubscription = new BlockSubscriptionRaw(tonweb, lastMasterchainBlockNumber, onTransaction);
    // or
    // const blockSubscription = new BlockSubscriptionIndex(tonweb, lastMasterchainBlockNumber, onTransaction, INDEX_API_URL, TONCENTER_API_KEY);
    await blockSubscription.start();
}

init();