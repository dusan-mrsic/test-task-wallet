const { Pool } = require('pg');

const pool = new Pool({
    user: 'postgres',
    password: '1234',
    host: 'db',
    port: 5432, // default Postgres port
    database: 'users'
});

module.exports = {
    query: (text, params) => pool.query(text, params)
};