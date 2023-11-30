const express = require('express');
const app = express();
const db = require('./db');
const { Web3 } = require('web3');
const { ethers } = require('ethers');
const fs = require('fs');
const abi = require('ethereumjs-abi');

const port = 3000;
const contractAddress = '0x9999f7Fea5938fD3b1E26A12c3f2fb024e194f97';

app.use(express.json());
app.use(express.urlencoded());


const url = "https://rpc-mumbai.maticvigil.com";
const web3 = new Web3(url);
var jsonFile = "./abi.json";
var parsed = JSON.parse(fs.readFileSync(jsonFile));
const usdcContract = new web3.eth.Contract(parsed, contractAddress);

async function createUsersTable() {
    try {
        await db.query(`
        CREATE TABLE IF NOT EXISTS users (
          user_id SERIAL PRIMARY KEY,
          balance DECIMAL NOT NULL,
          email VARCHAR(255) NOT NULL,
          deposit_address VARCHAR(255) NOT NULL,
          private_key VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS transactions (
            transaction_id SERIAL PRIMARY KEY,
            amount DECIMAL NOT NULL,
            address_from VARCHAR(255) NOT NULL,
            address_to VARCHAR(255) NOT NULL,
            type VARCHAR(255) NOT NULL,
            created_at TIMESTAMP DEFAULT NOW()
          );
      `);
        console.log('DB tables created or already exists.');
    } catch (error) {
        console.error('Error creating DB tables:', error);
    }
}

app.post('/createUser', async (req, res) => {
    try {
        const email = req.body.email;

        if (!email) {
            res.status(400).json('Email is required for creating a user');
        }

        const wallet = ethers.Wallet.createRandom(new ethers.JsonRpcProvider(url));
        const initialBalance = 0;
        const depositAddress = wallet.address.toLowerCase();
        const privateKey = wallet.privateKey;


        const result = await db.query(
            'INSERT INTO users (balance, email, deposit_address, private_key) VALUES ($1, $2, $3, $4) RETURNING *',
            [initialBalance, email, depositAddress, privateKey]
        );
        res.json(result);
    } catch (err) {
        console.log(err);
        res.status(500).json('Internal Server Error');
    }
});

app.post('/scanblock', async (req, res) => {
    try {
        const blockNumber = req.body.block_number;

        if (!blockNumber) {
            res.status(400).json('blockNumber is required for scanning a block');
        }

        const block = await web3.eth.getBlock(blockNumber);

        for (const txHash of block.transactions) {
            const tx = await web3.eth.getTransaction(txHash);

            if (tx.to) {

                const transferFunctionSignature = '0xa9059cbb';
                const transferFromFunctionSignature = '0x23b872dd';

                const isTransfer = tx.input.startsWith(transferFunctionSignature);
                const isTransferFrom = tx.input.startsWith(transferFromFunctionSignature);

                if (isTransfer || isTransferFrom) {
                    const toAndValue = abi.rawDecode(['address', 'uint256'], Buffer.from(tx.input.slice(10), 'hex'));
                    const toAddress = web3.utils.toHex(toAndValue[0]);
                    const value = toAndValue[1].toNumber() / 10 ** 6;

                    await db.query(
                        'UPDATE USERS SET balance = balance + $1 WHERE deposit_address = $2',
                        [value, toAddress]
                    )

                    await db.query(
                        'INSERT INTO transactions (amount, address_from, address_to, type) VALUES ($1, $2, $3, $4) RETURNING *',
                        [value, tx.from, toAddress, 'deposit']
                    );

                    console.log('Token Transfer:', {
                        from: tx.from,
                        toAddress,
                        value: value,
                        token: tx.to,
                        txHash: tx.hash,
                    });
                }
            }
        }

        res.json({ success: true });

    } catch (err) {
        console.log(err);
        res.status(500).json('Internal Server Error');
    }
});

app.post('/withdraw', async (req, res) => {
    const { withdraw_address, withdraw_amount, user_email } = req.body;

    try {
        const result = await db.query('SELECT deposit_address, private_key FROM users WHERE email = $1', [user_email]);
        const depositAddress = result.rows[0].deposit_address;
        const privateKey = result.rows[0].private_key;
        const balance = await usdcContract.methods.balanceOf(depositAddress).call();

        const balanceInUsdc = Number(balance) / 10 ** 6;

        if (parseFloat(balanceInUsdc) >= parseFloat(withdraw_amount)) {
            let value = ethers.parseUnits(withdraw_amount, 6);

            const query = usdcContract.methods.transfer(withdraw_address, value);
            const encodedABI = query.encodeABI();

            let signedTxn = await web3.eth.accounts.signTransaction({
                nonce: await web3.eth.getTransactionCount(depositAddress),
                to: contractAddress,
                data: encodedABI,
                gasPrice: await web3.eth.getGasPrice(),
                gas: 2000000,
            }, privateKey);

            await web3.eth.sendSignedTransaction(signedTxn.rawTransaction).then((receipt) => {
                if (receipt.status === true || web3.utils.toHex(receipt.status) === '0x1') {
                    db.query(
                        'UPDATE USERS SET balance = balance - $1 WHERE deposit_address = $2',
                        [withdraw_amount, depositAddress]
                    )
                    db.query(
                        'INSERT INTO transactions (amount, address_from, address_to, type) VALUES ($1, $2, $3, $4) RETURNING *',
                        [withdraw_amount, depositAddress, withdraw_address, 'withdrawal']
                    );

                    res.status(200).json({ message: 'Transaction successful' });
                } else {
                    res.status(400).json({ message: 'Transaction failed' });
                }
            })

        } else {
            res.status(400).json({ message: 'Insufficient balance for withdrawal' });
        }
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.get('/walletBalance', async (req, res) => {
    try {
        const user_email = req.query.user_email;

        if (!user_email) {
            return res.status(400).json('user_email is required for fetching wallet balance');
        }

        const user = await db.query('SELECT * FROM users WHERE email = $1', [user_email]);

        if (!user.rows.length) {
            return res.status(404).json('User not found');
        }

        const depositAddress = user.rows[0].deposit_address;
        const userBalance = user.rows[0].balance;

        const latestDeposit = await db.query(
            'SELECT amount FROM transactions WHERE address_to = $1 AND type = $2 ORDER BY created_at DESC LIMIT 1',
            [depositAddress, 'deposit']
        );

        const transactions = await db.query(
            'SELECT amount, address_from, address_to FROM transactions WHERE address_from = $1 OR address_to = $1',
            [depositAddress]
        );

        res.json({
            userBalance,
            latestDeposit: latestDeposit.rows.length ? latestDeposit.rows[0].amount : 0,
            transactions: transactions.rows,
        });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Internal server error' });
    }
});

app.listen(port, async () => {
    console.log(`Server listening at http://localhost:${port}`);
    await createUsersTable();
});
