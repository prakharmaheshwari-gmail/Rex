const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

// Allows your Netlify frontend to talk to this server
app.use(cors({ origin: '*' })); 

// Must set this Environment Variable in Render dashboard!
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const MAX_SUPPLY = 100000;

const authenticate = (req, res, next) => {
    const deviceId = req.header('X-Device-Id');
    if (!deviceId) return res.status(401).json({ error: "Unauthorized" });
    req.deviceId = deviceId;
    next();
};

app.post('/api/sync', authenticate, async (req, res) => {
    const { deviceId } = req;
    try {
        await pool.query(`INSERT INTO users (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING`, [deviceId]);

        const userRes = await pool.query(`SELECT balance FROM users WHERE device_id = $1`, [deviceId]);
        const portRes = await pool.query(`SELECT property_id, qty, entry_price FROM portfolios WHERE device_id = $1`, [deviceId]);
        const logsRes = await pool.query(`
            SELECT t.*, p.name as prop_name 
            FROM trade_logs t JOIN properties p ON t.property_id = p.id 
            WHERE t.device_id = $1 ORDER BY t.created_at DESC LIMIT 50`, [deviceId]);
        
        const marketRes = await pool.query(`SELECT * FROM properties`);

        res.json({
            balance: parseInt(userRes.rows[0].balance),
            portfolio: portRes.rows,
            logs: logsRes.rows,
            market: marketRes.rows
        });
    } catch (err) {
        res.status(500).json({ error: "Server sync failed" });
    }
});

app.post('/api/trade', authenticate, async (req, res) => {
    const { deviceId } = req;
    const { propertyId, tradeType, tradeQty } = req.body; 
    
    const client = await pool.connect();
    
    try {
        await client.query('BEGIN');

        const propRes = await client.query(`SELECT base_price FROM properties WHERE id = $1`, [propertyId]);
        const userRes = await client.query(`SELECT balance FROM users WHERE device_id = $1`, [deviceId]);
        const portRes = await client.query(`SELECT qty, entry_price FROM portfolios WHERE device_id = $1 AND property_id = $2`, [deviceId, propertyId]);
        
        const basePrice = propRes.rows[0].base_price;
        const bid = Math.floor(basePrice * 0.99);
        const ask = Math.ceil(basePrice * 1.01);
        const executionPrice = tradeType === 'BUY' ? ask : bid;
        const totalCost = executionPrice * tradeQty;

        let balance = parseInt(userRes.rows[0].balance);
        let currentQty = portRes.rows.length > 0 ? portRes.rows[0].qty : 0;
        let entryPrice = portRes.rows.length > 0 ? portRes.rows[0].entry_price : 0;

        const isOpening = (tradeType === 'BUY' && currentQty >= 0) || (tradeType === 'SELL' && currentQty <= 0);
        let pnl = 0;

        if (isOpening) {
            if (balance < totalCost) throw new Error("Insufficient Available Credit.");
            if (Math.abs(currentQty) + tradeQty > MAX_SUPPLY) throw new Error("Supply Cap Reached.");

            const newQty = tradeType === 'BUY' ? currentQty + tradeQty : currentQty - tradeQty;
            const totalValueBefore = Math.abs(currentQty) * entryPrice;
            const newAvgEntry = (totalValueBefore + totalCost) / Math.abs(newQty);

            await client.query(`UPDATE users SET balance = balance - $1 WHERE device_id = $2`, [totalCost, deviceId]);
            await client.query(`
                INSERT INTO portfolios (device_id, property_id, qty, entry_price) 
                VALUES ($1, $2, $3, $4) 
                ON CONFLICT (device_id, property_id) DO UPDATE SET qty = $3, entry_price = $4`,
                [deviceId, propertyId, newQty, newAvgEntry]
            );
        } else {
            if (tradeQty > Math.abs(currentQty)) throw new Error("Cannot close more area than owned.");

            let receivedAmount = 0;
            if (tradeType === 'SELL') { pnl = (executionPrice - entryPrice) * tradeQty; receivedAmount = totalCost; } 
            else { pnl = (entryPrice - executionPrice) * tradeQty; receivedAmount = (entryPrice * tradeQty) + pnl; }

            const newQty = tradeType === 'BUY' ? currentQty + tradeQty : currentQty - tradeQty;

            await client.query(`UPDATE users SET balance = balance + $1 WHERE device_id = $2`, [receivedAmount, deviceId]);
            
            if (newQty === 0) await client.query(`DELETE FROM portfolios WHERE device_id = $1 AND property_id = $2`, [deviceId, propertyId]);
            else await client.query(`UPDATE portfolios SET qty = $1 WHERE device_id = $2 AND property_id = $3`, [newQty, deviceId, propertyId]);
        }

        const shift = Math.max(1, Math.floor(tradeQty / 200));
        const newBasePrice = tradeType === 'BUY' ? basePrice + shift : Math.max(100, basePrice - shift);
        await client.query(`UPDATE properties SET base_price = $1 WHERE id = $2`, [newBasePrice, propertyId]);

        await client.query(`
            INSERT INTO trade_logs (device_id, property_id, trade_type, qty, execution_price, total_cost, is_opening, pnl) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [deviceId, propertyId, tradeType, tradeQty, executionPrice, totalCost, isOpening, pnl]
        );

        await client.query('COMMIT');
        res.json({ success: true, message: "Trade Executed Globally" });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Global Exchange API running on port ${PORT}`));