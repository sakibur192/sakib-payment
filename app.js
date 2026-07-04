const express = require('express');
const db = require('./db'); // Loads your db.js pool definition cleanly

const app = express();
app.use(express.json());

// 📲 SMS EDGE INGESTION GATEWAY ROUTE







app.post('/sms', async (req, res) => {
  try {
    const { trx_id, amount, sender } = req.body;

    // ✅ Normalize sender (optional but recommended)
    const normalizedSender = sender.trim().toLowerCase();

    // ✅ Allowed senders
    const allowedSenders = ['bkash', 'nagad', '16216'];

    // ❌ If sender not allowed → skip insert
    if (!allowedSenders.includes(normalizedSender)) {
      return res.status(400).json({
        status: 'ignored',
        message: 'Sender not allowed'
      });
    }

    // 1. Check if it exists
    const checkExist = await db.query(
      'SELECT trx_id FROM sms_data WHERE trx_id = $1',
      [trx_id]
    );

    if (checkExist.rows.length > 0) {
      return res.status(409).json({
        status: 'exists',
        message: 'Transaction ID already exists in database'
      });
    }

    // 2. Insert
    const result = await db.query(
      `INSERT INTO sms_data (trx_id, amount, sender)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [trx_id, amount, sender]
    );

    res.json({
      status: 'inserted',
      data: result.rows[0]
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ==========================================
// 🔍 AUTOMATED CHECKOUT MATCHING & VERIFICATION EDGE
// ==========================================
app.post('/verify', async (req, res) => {
  try {
    // 1. Check for Hardcoded Auth Key in Headers
    const authKey = req.headers['x-auth-key'];
    
    if (!authKey || authKey !== 'sakibauthkey0011') {
      return res.status(401).json({
        status: 'unauthorized',
        message: 'Invalid or missing security token assignment.'
      });
    }

    const { trx_id, amount } = req.body;

    // 2. Validate structural presence of parameters
    if (!trx_id || !amount) {
      return res.status(400).json({
        status: 'error',
        message: 'Both trx_id and amount are strictly required for validation matchmaking.'
      });
    }

    const normalizedTrx = trx_id.trim();
    const targetAmount = Number(amount);

    // 3. Query the sms_data table populated by your /sms gateway route
    const smsMatch = await db.query(
      'SELECT * FROM sms_data WHERE trx_id = $1',
      [normalizedTrx]
    );

    // Case A: The Transaction ID does not exist at all in our ledger records
    if (smsMatch.rows.length === 0) {
      return res.status(404).json({
        status: 'not_found',
        message: 'Transaction ID not verified by gateway network SMS records yet.'
      });
    }

    const gatewayRecord = smsMatch.rows[0];

    // Case B: Transaction ID found, but the money amount sent is incorrect (Fraud/Error check)
    if (Number(gatewayRecord.amount) !== targetAmount) {
      console.warn(`⚠️ [FRAUD FLAGGED]: TRX ${normalizedTrx} found, but amounts mismatch! Expected: ৳${gatewayRecord.amount}, Got: ৳${targetAmount}`);
      return res.status(422).json({
        status: 'mismatch',
        message: 'Transaction ID found, but the transaction volume value does not match.'
      });
    }

    // Case C: Success match verified!
    console.log(`✅ [MATCH VERIFIED]: TRX ${normalizedTrx} cleared for ৳${targetAmount}`);
    
    return res.json({
      status: 'success',
      message: 'Payment verified and cleared automatically.',
      data: {
        trx_id: gatewayRecord.trx_id,
        amount: gatewayRecord.amount,
        sender: gatewayRecord.sender,
        verified_at: new Date()
      }
    });

  } catch (err) {
    console.error('❌ Error inside verification runtime pipeline:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});




// ==========================================
// 📱 ANDROID APP BACKEND FEED EDGE
// ==========================================
app.get('/db/sms-data', async (req, res) => {
  try {
    // Queries all logs sorted from newest to oldest
    const historyLogs = await db.query(
      `SELECT trx_id, amount, sender, created_at 
       FROM sms_data 
       ORDER BY id DESC`
    );

    // Logs access connection context for server monitoring
    console.log(`📱 Android App requested history feed. Dispatching ${historyLogs.rows.length} rows.`);

    // Returns a raw clean JSON Array to match Retrofit's expect matrix
    return res.status(200).json(historyLogs.rows);

  } catch (err) {
    console.error('❌ Error executing database history query:', err);
    return res.status(500).json({ 
      status: 'error', 
      message: 'Failed to fetch transaction records from ledger storage.' 
    });
  }
});


// ==========================================
// 📊 ANALYTICS DASHBOARD DATA AGGREGATOR
// ==========================================
app.get('/api/dashboard', async (req, res) => {
  try {
    const range = req.query.range || 'today';
    let timeCondition = '';

    // Calculate time frame boundaries programmatically
    switch (range) {
      case 'today':
        timeCondition = "created_at >= CURRENT_DATE";
        break;
      case '3days':
        timeCondition = "created_at >= CURRENT_DATE - INTERVAL '3 days'";
        break;
      case '7days':
        timeCondition = "created_at >= CURRENT_DATE - INTERVAL '7 days'";
        break;
      case '15days':
        timeCondition = "created_at >= CURRENT_DATE - INTERVAL '15 days'";
        break;
      case '30days':
        timeCondition = "created_at >= CURRENT_DATE - INTERVAL '30 days'";
        break;
      case 'alltime':
        timeCondition = "1=1"; // Bypasses time constraints entirely
        break;
      default:
        timeCondition = "created_at >= CURRENT_DATE";
    }

    // Single-pass query calculates totals and aggregates vendor distributions simultaneously
    const dashboardQuery = `
      SELECT 
        COALESCE(SUM(amount), 0) AS total_volume,
        COUNT(id) AS total_count,
        COUNT(CASE WHEN LOWER(sender) = 'bkash' THEN 1 END) AS bkash_count,
        COUNT(CASE WHEN LOWER(sender) = 'nagad' THEN 1 END) AS nagad_count,
        COUNT(CASE WHEN LOWER(sender) = 'upay' THEN 1 END) AS upay_count,
        COUNT(CASE WHEN LOWER(sender) = 'rocket' THEN 1 END) AS rocket_count,
        COUNT(CASE WHEN LOWER(sender) NOT IN ('bkash', 'nagad', 'upay', 'rocket') THEN 1 END) AS other_count
      FROM sms_data
      WHERE ${timeCondition}
    `;

    const result = await db.query(dashboardQuery);
    const metrics = result.rows[0];

    return res.status(200).json({
      range_selected: range,
      total_cash_volume: parseFloat(metrics.total_volume),
      total_transactions: parseInt(metrics.total_count, 10),
      network_split: {
        bkash: parseInt(metrics.bkash_count, 10),
        nagad: parseInt(metrics.nagad_count, 10),
        upay: parseInt(metrics.upay_count, 10),
        rocket: parseInt(metrics.rocket_count, 10),
        other: parseInt(metrics.other_count, 10)
      }
    });

  } catch (err) {
    console.error('❌ Dashboard extraction failure:', err);
    return res.status(500).json({ status: 'error', message: err.message });
  }
});




const PORT = 4001;
app.listen(PORT, () => {
  console.log(`🚀 Automation listening pipeline established on port ${PORT}`);
});