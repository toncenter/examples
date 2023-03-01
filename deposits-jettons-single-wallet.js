import TonWeb from "tonweb";

const tonweb = new TonWeb(
    new TonWeb.HttpProvider('https://toncenter.com/api/v2/jsonRPC',
        {apiKey: 'YOUR_TONCENTER_API_KEY'}
    ));

// key pair for HOT wallet

const seed = TonWeb.utils.base64ToBytes('YOU_PRIVATE_KEY_IN_BASE64');
const keyPair = TonWeb.utils.keyPairFromSeed(seed);

// HOT wallet

const WalletClass = tonweb.wallet.all['v3R2'];
const wallet = new WalletClass(tonweb.provider, {
    publicKey: keyPair.publicKey,
    wc: 0
});

// Supported jettons config

const JETTONS_INFO = {
    'ANDRR': {
        address: 'EQCxhWBOOBNegH5Wz23KNwNZfr9yrQoiDpqW4u2pVReUgWgX',
        decimals: 9
    },
    'KOTE': {
        address: 'EQBlU_tKISgpepeMFT9t3xTDeiVmo25dW_4vUOl6jId_BNIj',
        decimals: 9
    }
}

//

const jettons = {};

const init = async () => {
    const hotWalletAddress = await wallet.getAddress();
    const hotWalletAddressString = hotWalletAddress.toString(true, true, true);
    console.log('My HOT wallet is ', hotWalletAddressString);

    for (const name in JETTONS_INFO) {
        const info = JETTONS_INFO[name];
        const jettonMinter = new TonWeb.token.jetton.JettonMinter(tonweb.provider, {
            address: info.address
        });
        const jettonWalletAddress = await jettonMinter.getJettonWalletAddress(hotWalletAddress);
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

    const tick = async () => {
        // NOTE: `getTransactions` paging can be done in the same way as in `deposits-single-wallet.js` code in this repo
        const transactions = await tonweb.provider.getTransactions(hotWalletAddressString);
        console.log(transactions);
        console.log('Check last ' + transactions.length + ' transactions');

        for (const tx of transactions) {
            const sourceAddress = tx.in_msg.source;
            const jettonName = jettonWalletAddressToJettonName(sourceAddress);
            if (!jettonName) {
                // unknown or fake jetton transfer
                continue;
            }

            if (!tx.in_msg.msg_data ||
                tx.in_msg.msg_data['@type'] !== 'msg.dataRaw' ||
                !tx.in_msg.msg_data.body
            ) {
                // no in_msg or in_msg body
                continue;
            }

            const msgBody = TonWeb.utils.base64ToBytes(tx.in_msg.msg_data.body);

            const cell = TonWeb.boc.Cell.oneFromBoc(msgBody);
            const slice = cell.beginParse();
            const op = slice.loadUint(32);
            if (!op.eq(new TonWeb.utils.BN(0x7362d09c))) continue; // op == transfer_notification
            const queryId = slice.loadUint(64);
            const amount = slice.loadCoins();
            const from = slice.loadAddress();
            const maybeRef = slice.loadBit();
            const payload = maybeRef ? slice.loadRef().beginParse() : slice;
            const payloadOp = payload.loadUint(32);
            if (!payloadOp.eq(new TonWeb.utils.BN(0))) {
                console.log('no text comment in transfer_notification');
                continue;
            }
            const payloadBytes = payload.loadBits(slice.getFreeBits());
            const comment = new TextDecoder().decode(payloadBytes);
            console.log('Got ' + jettonName + ' jetton deposit ' + amount.toString() + ' units with text comment "' + comment + '"');
        }
    }

    setInterval(tick, 60 * 1000); // every 1 min
    tick();
}

init();