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
        jettons[name] = {
            jettonMinter: jettonMinter,
            jettonWalletAddress: jettonWalletAddress,
            jettonWallet: jettonWallet
        };
    }

    // Send jetton transfer from HOT wallet to destination address
    const jettonTransfer = async (jettonName, destinationAddress, jettonAmountInUnits) => {

        // NOTE: seqno protection and queue can be done in the same way as in `withdrawals.js` code in this repo
        const seqno = (await wallet.methods.seqno().call()) || 0;
        console.log({seqno})

        const jettonWallet = jettons[jettonName].jettonWallet;

        await wallet.methods.transfer({
            secretKey: keyPair.secretKey,
            toAddress: jettons[jettonName].jettonWalletAddress,
            amount: TonWeb.utils.toNano('0.05'), // TON
            seqno: seqno,
            payload: await jettonWallet.createTransferBody({
                jettonAmount: jettonAmountInUnits,
                toAddress: new TonWeb.utils.Address(destinationAddress),
                responseAddress: hotWalletAddress
            }),
            sendMode: 3,
        }).send()
    }

    await jettonTransfer('KOTE', 'EQA0i8-CdGnF_DhUHHf92R1ONH6sIA9vLZ_WLcCIhfBBXwtG', new TonWeb.utils.BN('1'))
}

init();