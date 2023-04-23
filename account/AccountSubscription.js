const wait = (millis) => {
    return new Promise(resolve => {
        setTimeout(resolve, millis);
    });
}

export class AccountSubscription {
    constructor(tonweb, accountAddress, startTime, onTransaction) {
        this.tonweb = tonweb;
        this.accountAddress = accountAddress;
        this.startTime = startTime; // start unixtime (stored in your database), transactions made earlier will be discarded.
        this.onTransaction = onTransaction;
    }

    async start() {
        const getTransactions = async (time, offsetTransactionLT, offsetTransactionHash, retryCount) => {
            const COUNT = 10;

            if (offsetTransactionLT) {
                console.log(`Get ${COUNT} transactions before transaction ${offsetTransactionLT}:${offsetTransactionHash}`);
            } else {
                console.log(`Get last ${COUNT} transactions`);
            }

            // TON transaction has composite ID: account address (on which the transaction took place) + transaction LT (logical time) + transaction hash.
            // So TxID = address+LT+hash, these three parameters uniquely identify the transaction.
            // In our case, we are monitoring one wallet and the address is `accountAddress`.

            let transactions;

            try {
                transactions = await this.tonweb.provider.getTransactions(this.accountAddress, COUNT, offsetTransactionLT, offsetTransactionHash);
            } catch (e) {
                console.error(e);
                // if an API error occurs, try again
                retryCount++;
                if (retryCount < 10) {
                    await wait(retryCount * 1000);
                    return getTransactions(time, offsetTransactionLT, offsetTransactionHash, retryCount);
                } else {
                    return 0;
                }
            }

            console.log(`Got ${transactions.length} transactions`);

            if (!transactions.length) {
                // If you use your own API instance make sure the code contains this fix https://github.com/toncenter/ton-http-api/commit/a40a31c62388f122b7b7f3da7c5a6f706f3d2405
                // If you use public toncenter.com then everything is OK.
                return time;
            }

            if (!time) time = transactions[0].utime;

            for (const tx of transactions) {

                if (tx.utime < this.startTime) {
                    return time;
                }

                await this.onTransaction(tx);
            }

            if (transactions.length === 1) {
                return time;
            }

            const lastTx = transactions[transactions.length - 1];
            return await getTransactions(time, lastTx.transaction_id.lt, lastTx.transaction_id.hash, 0);
        }


        let isProcessing = false;

        const tick = async () => {
            if (isProcessing) return;
            isProcessing = true;

            try {
                const result = await getTransactions(undefined, undefined, undefined, 0);
                if (result > 0) {
                    this.startTime = result; // store in your database
                }
            } catch (e) {
                console.error(e);
            }

            isProcessing = false;
        }

        setInterval(tick, 10 * 1000); // poll every 10 seconds
        tick();
    }
}