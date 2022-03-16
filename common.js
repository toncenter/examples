// Here we will look at how to create a key pair, a wallet and get a wallet address.
// All operations are offline.

const TonWeb = require("tonweb");
const tonMnemonic = require("tonweb-mnemonic");

// An account (wallet) in the blockchain (which stores the balance of coins) is determined by its private key (which only you know).
// Thus, to create a new account, you need to generate a new public/private key pair.
// Use the TweetNaCl library
const createKeyPair = async () => {

    // 1. Use tonweb-mnemonic to generate random 24 words which determine the secret key.
    // These words will be compatible with TON wallet applications, i.e. using them you will be able to import your account into third-party applications.

    /** @type {string[]} */
    const words = await tonMnemonic.generateMnemonic();

    /** @type {Uint8Array} */
    const seed = await tonMnemonic.mnemonicToSeed(words);

    /** @type {nacl.SignKeyPair} */
    const keyPair = TonWeb.utils.nacl.sign.keyPair.fromSeed(seed);

    console.log(TonWeb.utils.bytesToHex(keyPair.publicKey));
    console.log(TonWeb.utils.bytesToHex(keyPair.secretKey));

    // or
    // 2. Generate new random key pair directly.
    // Note that you can get key pair from mnemonic words but CANNOT get mnemonic words from a key pair.

    /** @type {nacl.SignKeyPair} */
    const keyPair2 = TonWeb.utils.nacl.sign.keyPair();

    console.log(TonWeb.utils.bytesToHex(keyPair2.publicKey));
    console.log(TonWeb.utils.bytesToHex(keyPair2.secretKey));

}

createKeyPair();


// In the TON blockchain all entities are smart contracts.
// The account (wallet) of the user is also a custom smart contract.
/**
 * @param keyPair {nacl.SignKeyPair}
 */
const createWallet = async (keyPair) => {
    const tonweb = new TonWeb();

    // There are standard wallet smart contracts that everyone uses.
    // There are several versions, at the moment wallet v3R2 is default.

    const WalletClass = tonweb.wallet.all.v3R2;

    const wallet = new WalletClass(tonweb.provider, {
        publicKey: keyPair.publicKey
    });


    // Wallet address depends on key pair and smart contract code.
    // So for different versions of the smart contract you will get a different address, although the key pair is the same.
    // Let's get the wallet address (offline operation):

    /** @type {Address} */
    const address = await wallet.getAddress();

    // The address can be displayed in different formats
    // More on https://ton.org/docs/#/howto/step-by-step?id=_1-smart-contract-addresses

    console.log(address.toString(true, true, true)); // print address in default format. In 99% of cases this format is used in UI applications.

    // We did everything offline and there is no our wallet smart contract on the network yet.
    // To deploy it, we first need to send Toncoins to the address.
    // Then when you want to send Toncoins from wallet to someone else - along with this first outgoing transfer, the deployment of the wallet smart contract will happen automatically.

}

createWallet(TonWeb.utils.nacl.sign.keyPair());