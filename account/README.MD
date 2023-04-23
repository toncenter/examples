# Subscribing to account transactions

`getTransactions` HTTP API method has a limit on the number of transactions it can return at a time.

Thus, you may sometimes need to make several requests to get all transaction of the account, the code [AccountSubscription.js](AccountSubscription.js) implements this.