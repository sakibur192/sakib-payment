const express = require('express');
const db = require('./db'); // Loads your db.js pool definition cleanly
const axios = require('axios');
const app = express();
app.use(express.json());

// 📲 SMS EDGE INGESTION GATEWAY ROUTE



app.use((req, res, next) => {
  console.log(`📡 [INCOMING REQUEST]: ${req.method} ${req.url} - ${new Date().toISOString()}`);
  next();
});



app.post('/sms', async (req, res) => {

  console.log(req.body);
  

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


// Helper utility function to stall thread execution for a given time
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.post('/verify-lock', async (req, res) => {
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

    let smsMatch = null;
    const maxRetries = 5;
    const delayMs = 2000; // 2 seconds

    console.log(`🔍 [VERIFY REQUEST]: Starting search polling sequence for TRX: ${normalizedTrx}`);

    // 🔄 3. Polling Loop: Retry up to 5 times every 2 seconds if not found
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      smsMatch = await db.query(
        'SELECT * FROM sms_data WHERE trx_id = $1',
        [normalizedTrx]
      );

      // If a record is found, break out of the retry loop immediately
      if (smsMatch.rows.length > 0) {
        console.log(`🎯 [FOUND]: TRX ${normalizedTrx} discovered in database on attempt #${attempt}`);
        break;
      }

      // If this was the last attempt and still not found, don't sleep, just let the code drop through
      if (attempt < maxRetries) {
        console.log(`⏳ [POLLING]: TRX ${normalizedTrx} not found on attempt #${attempt}. Retrying in 2s...`);
        await delay(delayMs);
      }
    }

    // Case A: The Transaction ID does not exist at all after 5 attempts (10 seconds total)
    if (smsMatch.rows.length === 0) {
      console.log(`❌ [NOT FOUND]: Polling exhausted. TRX ${normalizedTrx} completely absent from ledger.`);
      return res.status(404).json({
        status: 'not_found',
        message: 'Transaction ID not verified by gateway network SMS records after polling timeout.'
      });
    }

    const gatewayRecord = smsMatch.rows[0];

    // 🛑 PROTECTION RULE: Check if this transaction has already been used/verified
    if (gatewayRecord.status === 'verified' || gatewayRecord.is_verified === true) {
      console.warn(`⚠️ [DUPLICATE ATTEMPT]: TRX ${normalizedTrx} has already been verified and claimed previously.`);
      return res.status(409).json({
        status: 'already_used',
        message: 'This Transaction ID has already been claimed and cannot be processed again.'
      });
    }

    // Case B: Transaction ID found, but the money amount sent is incorrect (Fraud/Error check)
    if (Number(gatewayRecord.amount) !== targetAmount) {
      console.warn(`⚠️ [FRAUD FLAGGED]: TRX ${normalizedTrx} found, but amounts mismatch! Expected: ৳${gatewayRecord.amount}, Got: ৳${targetAmount}`);
      return res.status(422).json({
        status: 'mismatch',
        message: 'Transaction ID found, but the transaction volume value does not match.'
      });
    }

    // 🔒 LOCK THE TRANSACTION: Mark it as verified in the database right now
    await db.query(
      'UPDATE sms_data SET status = $1 WHERE trx_id = $2',
      ['verified', normalizedTrx]
    );

    // Case C: Success match verified for the first time!
    console.log(`✅ [MATCH VERIFIED & LOCKED]: TRX ${normalizedTrx} cleared for ৳${targetAmount}`);
    
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
// 🛠️ DATABASE MIGRATION SYSTEM SETTINGS ROUTE
// ==========================================
app.get('/dbset', async (req, res) => {
    try {
        // Query to check if the status column already exists to prevent duplicate column errors
        const checkColumnQuery = `
            SELECT column_name 
            FROM information_schema.columns 
            WHERE table_name='sms_data' AND column_name='status';
        `;
        
        const checkResult = await db.query(checkColumnQuery);
        
        if (checkResult.rows.length > 0) {
            return res.status(200).json({
                success: true,
                message: "Database schema is already up to date. Column 'status' exists."
            });
        }

        // Execute raw ALTER TABLE execution query layer
        const migrationQuery = "ALTER TABLE sms_data ADD COLUMN status VARCHAR(20) DEFAULT 'pending';";
        await db.query(migrationQuery);
        
        console.log("⚙️ Database structural migration updated. Column 'status' appended safely.");
        
        return res.status(200).json({
            success: true,
            message: "Database schema migrated successfully! Added 'status' column defaulting to 'pending'."
        });
        
    } catch (error) {
        console.error('❌ Database migration routing failed:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error executing migration layout script.',
            error: error.message
        });
    }
});








// ==========================================
// 📱 ANDROID APP BACKEND FEED EDGE
// ==========================================
app.get('/db/sms-data', async (req, res) => {
    try {
        // Explicitly include status in the column selection field list
        const query = 'SELECT trx_id, amount, sender, created_at, status FROM sms_data ORDER BY created_at DESC;';
        const result = await db.query(query);
        
        return res.status(200).json(result.rows);
    } catch (error) {
        console.error('❌ Failed to pull data ledger logs:', error);
        return res.status(500).json({ error: error.message });
    }
});
// ==========================================
// 🗑️ CLEAN HISTORY ROUTE
// ==========================================
app.delete('/api/history/clear', async (req, res) => {
    try {
        // TRUNCATE is faster and resets auto-increment IDs. 
        // If your database uses foreign key restrictions, use "DELETE FROM sms_data" instead.
        const query = 'TRUNCATE TABLE sms_data;'; 
        
        await db.query(query);
        
        console.log('🗑️ Database history cleared successfully by administrative client.');
        
        return res.status(200).json({
            success: true,
            message: 'Transaction ledger cleared successfully.'
        });
    } catch (error) {
        console.error('❌ Failed to execute database clear query:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error while clearing transaction log.',
            error: error.message
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



























































































// =========================================================================
// 🚀 ALL-IN-ONE SCHEMA MIGRATION & INITIALIZATION ROUTE
// =========================================================================
app.get('/api/migrate-v2', async (req, res) => {
  try {
    console.log("⚙️ Initializing database structure deployment pipeline...");

    // ১. Main User Profiles Table তৈরি করা (Remittance ও Private User উভয়ের জন্য)
    await db.query(`
      CREATE TABLE IF NOT EXISTS users_v2 (
          id SERIAL PRIMARY KEY,
          username VARCHAR(100) UNIQUE NOT NULL,
          deposit_user_code VARCHAR(100) UNIQUE NOT NULL, 
          is_private_user BOOLEAN DEFAULT FALSE,          
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ২. Multiple Secret Codes Ledger Table তৈরি করা
    await db.query(`
      CREATE TABLE IF NOT EXISTS user_codes (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users_v2(id) ON DELETE CASCADE,
          secret_transaction_code VARCHAR(100) UNIQUE NOT NULL,
          is_code_active BOOLEAN DEFAULT TRUE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ৩. Dedicated Remittance Message Storage Table তৈরি করা
    await db.query(`
      CREATE TABLE IF NOT EXISTS remittance_sms_data (
          id SERIAL PRIMARY KEY,
          sms_body TEXT NOT NULL,                         
          amount NUMERIC(10, 2) NOT NULL,                 
          status VARCHAR(20) DEFAULT 'pending',           
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Tables deployed successfully. Injecting seed data...");

    // ৪. প্রথমবার রান করার সময় টেস্ট করার জন্য একটি ডিফল্ট রেমিটেন্স ইউজার প্রোফাইল ইনসার্ট করা
    const seedUser = await db.query(`
      INSERT INTO users_v2 (username, deposit_user_code, is_private_user)
      VALUES ('Remittance Test Client', 'REM_USER_77', false)
      ON CONFLICT (deposit_user_code) DO UPDATE SET username = EXCLUDED.username
      RETURNING id;
    `);

    const targetUserId = seedUser.rows[0].id;

    // ৫. উক্ত টেস্ট ইউজারের জন্য একটি ডিফল্ট একটিভ কোড ইনসার্ট করা
    await db.query(`
      INSERT INTO user_codes (user_id, secret_transaction_code, is_code_active)
      VALUES ($1, 'SECRET99', true)
      ON CONFLICT (secret_transaction_code) DO NOTHING;
    `, [targetUserId]);

    console.log("⚙️ Database migration and seeding execution completed successfully.");

    return res.status(200).json({
      success: true,
      message: "Database architecture successfully migrated! Built tables: users_v2, user_codes, and remittance_sms_data. Seed profile active.",
      test_credentials: {
        deposit_user_code: "REM_USER_77",
        active_secret_code: "SECRET99",
        note: "Use these values to test your /api/verify/remittance endpoint layout."
      }
    });

  } catch (err) {
    console.error('❌ Migration routing pipeline critical failure:', err);
    return res.status(500).json({
      success: false,
      message: 'Internal server error executing architecture setup script.',
      error: err.message
    });
  }
});

// =========================================================================
// 🔄 DATABASE SCHEMATIC PATCH: CREATE PRIVATE USER TRANSACTIONS TABLE
// =========================================================================
app.get('/api/migrate/create-private-ledger', async (req, res) => {
  try {
    console.log("⚙️ Deploying Private User Transactions Ledger Table...");

    // private_user_transactions টেবিল তৈরি করার কুয়েরি
    await db.query(`
      CREATE TABLE IF NOT EXISTS private_user_transactions (
          id SERIAL PRIMARY KEY,
          user_id INT REFERENCES users_v2(id) ON DELETE CASCADE, 
          verified_by_code_id INT REFERENCES user_codes(id),      
          submitted_user_code VARCHAR(100),                       
          amount NUMERIC(10, 2) NOT NULL,                         
          status VARCHAR(20) DEFAULT 'success',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Table 'private_user_transactions' deployed or verified successfully.");

    return res.status(200).json({
      success: true,
      message: "Database schema updated successfully! 'private_user_transactions' table is now active.",
      action_required: "You can now safely run the Private User verification and history APIs."
    });

  } catch (err) {
    console.error('❌ Private ledger table deployment failed:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to create private user transactions table.',
      error: err.message
    });
  }
});
// =========================================================================
// 🔄 DATABASE SCHEMATIC PATCH: ADD HISTORY TRACKING COLUMN
// =========================================================================
app.get('/api/migrate/add-history-column', async (req, res) => {
  try {
    console.log("⚙️ Executing database structure update...");

    // remittance_sms_data টেবিলে verified_by_code_id ফরেন কি কলামটি যুক্ত করার কুয়েরি
    // await db.query(`
    //   ALTER TABLE remittance_sms_data 
    //   ADD COLUMN IF NOT EXISTS verified_by_code_id INT REFERENCES user_codes(id);
    // `);

// এই কুয়েরিটি আপনার মাইগ্রেশন রাউটের ভেতরে রান করে নিন
await db.query(`
  ALTER TABLE remittance_sms_data 
  ADD COLUMN IF NOT EXISTS submitted_user_code VARCHAR(100);
`);

    console.log("✅ Column 'verified_by_code_id' verified or added successfully.");

    return res.status(200).json({
      success: true,
      message: "Database schema patched successfully! 'verified_by_code_id' column is now active in 'remittance_sms_data' table.",
      action_required: "You can now safely run the verification and history APIs."
    });

  } catch (err) {
    console.error('❌ Schema patch deployment failed:', err);
    return res.status(500).json({
      success: false,
      message: 'Failed to update database schema structure.',
      error: err.message
    });
  }
});

app.get('/api/migrate/add-username-tracking', async (req, res) => {
  try {
    console.log("⚙️ Patching tables for explicit username tracking...");

    // 1. Add column to Remittance table
    await db.query(`
      ALTER TABLE remittance_sms_data 
      ADD COLUMN IF NOT EXISTS action_by_username VARCHAR(100);
    `);

    // 2. Add column to Private/VIP Ledger table
    await db.query(`
      ALTER TABLE private_user_transactions 
      ADD COLUMN IF NOT EXISTS action_by_username VARCHAR(100);
    `);

    return res.status(200).json({
      success: true,
      message: "Database patched! 'action_by_username' column added to tracking tables."
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});



// =========================================================================
// 👑 ADMIN PANEL: USER & CODE MANAGER (For Remittance)
// =========================================================================

// ১. এডমিন নতুন রেমিটেন্স ইউজার তৈরি করবে
app.post('/api/admin/users', async (req, res) => {
  try {
    const { username, deposit_user_code } = req.body;

    if (!username || !deposit_user_code) {
      return res.status(400).json({ error: "Username and deposit_user_code are required." });
    }

    const result = await db.query(
      `INSERT INTO users_v2 (username, deposit_user_code, is_private_user)
       VALUES ($1, $2, false)
       RETURNING *`,
      [username.trim(), deposit_user_code.trim()]
    );

    return res.status(201).json({ success: true, user: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ২. এডমিন ইউজারের জন্য নতুন সিক্রেট কোড সেট করবে (আগের কোড অটো-নিষ্ক্রিয় হবে)
app.post('/api/admin/users/add-code', async (req, res) => {
  try {
    const { deposit_user_code, secret_transaction_code } = req.body;

    if (!deposit_user_code || !secret_transaction_code) {
      return res.status(400).json({ error: "Missing required fields." });
    }

    // ইউজার আইডি খুঁজে বের করা
    const userResult = await db.query('SELECT id FROM users_v2 WHERE deposit_user_code = $1', [deposit_user_code.trim()]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: "User profile not found." });
    }
    const userId = userResult.rows[0].id;

    // 🛑 নিয়ম: ওই ইউজারের আগের সব কোড আগে Inactive (false) করা হবে
    await db.query('UPDATE user_codes SET is_code_active = false WHERE user_id = $1', [userId]);

    // নতুন কোডটি Active (true) হিসেবে ইনসার্ট করা
    const result = await db.query(
      `INSERT INTO user_codes (user_id, secret_transaction_code, is_code_active)
       VALUES ($1, $2, true)
       RETURNING *`,
      [userId, secret_transaction_code.trim()]
    );

    return res.status(201).json({ 
      success: true, 
      message: "New code activated. Previous codes deactivated.", 
      code_data: result.rows[0] 
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ১. সমস্ত ইউজার এবং তাদের অ্যাসাইন করা সব কোডের হিস্ট্রি একসাথে দেখা
app.get('/api/admin/users/list', async (req, res) => {
  try {
    const query = `
      SELECT 
        u.id,
        u.username,
        u.deposit_user_code,
        u.is_private_user,
        COALESCE(
          json_agg(
            json_build_object(
              'code_id', c.id,
              'secret_code', c.secret_transaction_code,
              'is_active', c.is_code_active,
              'created_at', c.created_at
            )
          ) FILTER (WHERE c.id IS NOT NULL), '[]'
        ) as all_codes
      FROM users_v2 u
      LEFT JOIN user_codes c ON u.id = c.user_id
      GROUP BY u.id, u.username, u.deposit_user_code, u.is_private_user
      ORDER BY u.id DESC;
    `;
    const result = await db.query(query);
    return res.status(200).json({ success: true, users: result.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ২. সুনির্দিষ্ট কোনো একটি কোড আইডি ধরে তার লাইফসাইকেল অন/অফ করা
app.post('/api/admin/codes/toggle-status', async (req, res) => {
  try {
    const { code_id, target_status } = req.body; // target_status: true/false

    if (code_id === undefined || target_status === undefined) {
      return res.status(400).json({ error: "code_id and target_status are required." });
    }

    // নির্দিষ্ট কোডটি আপডেট করুন
    await db.query(
      `UPDATE user_codes SET is_code_active = $1 WHERE id = $2`,
      [target_status, code_id]
    );

    return res.json({ success: true, message: `Specific token status mutated to ${target_status}` });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});
// =========================================================================
// 📱 APP EDGE: INCOMING REMITTANCE SMS INGESTION
// =========================================================================

// ৩. অ্যান্ড্রয়েড অ্যাপ থেকে আসা রেমিটেন্স এসএমএস স্টোর করার রাউট
app.post('/sms-rem', async (req, res) => {
  try {
    // Extract what Kotlin is actually sending (sender and amount)
    const { sender, amount } = req.body;

    // Use sender as the sms_body text content
    const sms_body = sender;

    if (!sms_body || !amount) {
      return res.status(400).json({ 
        error: "sender (as sms_body) and amount are strictly required." 
      });
    }

    // রেমিটেন্স ডাটাবেসে সম্পূর্ণ মেসেজ ও অ্যামাউন্ট pending হিসেবে জমা হবে
    const result = await db.query(
      `INSERT INTO remittance_sms_data (sms_body, amount, status) 
       VALUES ($1, $2, 'pending') 
       RETURNING *`,
      [sms_body, Number(amount)]
    );

    return res.json({ 
      status: 'inserted', 
      message: 'Remittance SMS logged successfully.',
      data: result.rows[0] 
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// =========================================================================
// 🌍 USER END: WEBSITE VERIFICATION GATEWAY
// =========================================================================

// ৪. কাস্টমার যখন ওয়েবসাইট থেকে সাবমিট করবে, তখন ভেরিফাই করার রাউট
// =========================================================================
// 🌍 USER END: WEBSITE VERIFICATION GATEWAY (SECURE ID BYPASS)
// =========================================================================
// app.post('/api/verify/remittance', async (req, res) => {
//   try {
//     const { deposit_user_code, secret_transaction_code, amount } = req.body;

//     if (!secret_transaction_code || !amount) {
//       return res.status(400).json({ error: "secret_transaction_code and amount are required." });
//     }

//     // 🎯 Capturing the username linked to the code right here
//     const codeCheck = await db.query(
//       `SELECT c.id, u.username 
//        FROM user_codes c
//        JOIN users_v2 u ON c.user_id = u.id
//        WHERE c.secret_transaction_code = $1 
//          AND c.is_code_active = true 
//          AND u.is_private_user = false`,
//       [secret_transaction_code.trim()]
//     );

//     if (codeCheck.rows.length === 0) {
//       return res.status(401).json({ status: 'error', message: 'Invalid, expired, or inactive code.' });
//     }

//     const activeCodeId = codeCheck.rows[0].id;
//     const linkedUsername = codeCheck.rows[0].username; // 👈 Storing username in memory
//     const targetAmount = Number(amount);
    
//     const smsMatch = await db.query(
//       `SELECT id FROM remittance_sms_data 
//        WHERE amount = $1 AND status = 'pending' 
//        ORDER BY created_at DESC LIMIT 1`,
//       [targetAmount]
//     );

//     if (smsMatch.rows.length === 0) {
//       return res.status(404).json({ status: 'not_found', message: 'No live matching pending SMS found.' });
//     }

//     const matchedSms = smsMatch.rows[0];
//     const clientUserCode = deposit_user_code ? deposit_user_code.trim() : null;

//     // 🔒 [UPDATED]: Saving 'linkedUsername' directly into the row permanently
//     await db.query(
//       `UPDATE remittance_sms_data 
//        SET status = 'verified', 
//            verified_by_code_id = $1,
//            submitted_user_code = $2,
//            action_by_username = $3 
//        WHERE id = $4`, 
//       [activeCodeId, clientUserCode, linkedUsername, matchedSms.id]
//     );

//     return res.json({
//       status: 'success',
//       deposit_user_code: clientUserCode,
//       amount: targetAmount
//     });

//   } catch (err) {
//     return res.status(500).json({ error: err.message });
//   }
// });


// =========================================================================
// 📊 ADMIN ANALYTICS: TOTAL & USER-WISE REMITTANCE HISTORY
// =========================================================================

// ১. টোটাল রেমিটেন্স হিস্টোরি (সব সাকসেস এবং পেন্ডিং ট্রানজেকশন একসঙ্গে)


// ১. টোটাল রেমিটেন্স হিস্টোরি (সব সাকসেস এবং পেন্ডিং ট্রানজেকশন একসঙ্গে)
app.get('/api/admin/remittance/history-all', async (req, res) => {
  try {
    const query = `
      SELECT 
        r.id AS transaction_id,
        r.sms_body,
        r.amount,
        r.status,
        r.submitted_user_code AS claimed_by_player_id, 
        r.action_by_username AS executed_by_username, -- 🎯 [NEW]: Explicitly pulled from your saved table row
        r.created_at AS sms_received_at,
        u.username AS admin_configured_user,
        c.secret_transaction_code AS used_secret_code
      FROM remittance_sms_data r
      LEFT JOIN user_codes c ON r.verified_by_code_id = c.id
      LEFT JOIN users_v2 u ON c.user_id = u.id
      ORDER BY r.created_at DESC;
    `;

    const result = await db.query(query);
    return res.status(200).json({
      success: true,
      total_records: result.rowCount,
      history: result.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ২. ইউজারভিত্তিক রেমিটেন্স হিস্টোরি (নির্দিষ্ট কোনো ইউজারের সমস্ত সফল ট্রানজেকশন)
// এখানে URL এ ইউজারের unique id বা username পাস করতে হবে (উদা: /api/admin/remittance/history-user/1)

// ২. ইউজারভিত্তিক রেমিটেন্স হিস্টোরি (নির্দিষ্ট কোনো ইউজারের সমস্ত সফল ট্রানজেকশন)
app.get('/api/admin/remittance/history-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const query = `
      SELECT 
        r.id AS transaction_id,
        r.sms_body,
        r.amount,
        r.status,
        r.submitted_user_code AS claimed_by_player_id, 
        r.action_by_username AS executed_by_username, -- 🎯 [NEW]: Explicitly pulled from row data
        r.created_at AS processed_at,
        c.secret_transaction_code AS used_secret_code
      FROM remittance_sms_data r
      JOIN user_codes c ON r.verified_by_code_id = c.id
      WHERE c.user_id = $1 AND r.status = 'verified'
      ORDER BY r.created_at DESC;
    `;

    const result = await db.query(query, [userId]);
    const userCheck = await db.query('SELECT username, deposit_user_code FROM users_v2 WHERE id = $1', [userId]);
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: "User profile not found." });
    }

    return res.status(200).json({
      success: true,
      user: userCheck.rows[0],
      total_verified_transactions: result.rowCount,
      history: result.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


























// app.post('/api/verify/private-user', async (req, res) => {
//   try {
//     // 🛠️ [ADDED]: Check global Gateway lifecycle availability first
//     const gatewayCheck = await db.query(
//       "SELECT config_value FROM system_configs WHERE config_key = 'version2gateway_active';"
//     );
//     const isGatewayActive = gatewayCheck.rows.length > 0 && gatewayCheck.rows[0].config_value === 'active';

//     if (!isGatewayActive) {
//       return res.status(403).json({ status: 'error', message: 'gateway closed' });
//     }

//     // -------------------------------------------------------------
//     // Original untouched business logic begins here
//     // -------------------------------------------------------------
//     const { deposit_user_code, secret_transaction_code, amount } = req.body;

//     if (!secret_transaction_code || !amount) {
//       return res.status(400).json({ error: "secret_transaction_code and amount are required." });
//     }

//     const privateCodeCheck = await db.query(
//       `SELECT c.id AS code_id, u.id AS user_id, u.username
//        FROM user_codes c
//        JOIN users_v2 u ON c.user_id = u.id
//        WHERE c.secret_transaction_code = $1 
//          AND c.is_code_active = true 
//          AND u.is_private_user = true`,
//       [secret_transaction_code.trim()]
//     );

//     if (privateCodeCheck.rows.length === 0) {
//       return res.status(401).json({ status: 'unauthorized', message: 'Access denied.' });
//     }

//     const { code_id, user_id, username } = privateCodeCheck.rows[0];
//     const targetAmount = Number(amount);
//     const clientUserCode = deposit_user_code ? deposit_user_code.trim() : null;

//     await db.query(
//       `INSERT INTO private_user_transactions (user_id, verified_by_code_id, submitted_user_code, amount, status, action_by_username)
//        VALUES ($1, $2, $3, $4, 'success', $5)`,
//       [user_id, code_id, clientUserCode, targetAmount, username]
//     );

//     return res.json({
//       status: 'success',
//       is_vip_bypass: true,
//       deposit_user_code: clientUserCode,
//       amount: targetAmount
//     });

//   } catch (err) {
//     return res.status(500).json({ error: err.message });
//   }
// });


// app.post('/api/verify/remittance', async (req, res) => {
//   try {
//     // 🛠️ [ADDED]: Check global Gateway lifecycle availability first
//     const gatewayCheck = await db.query(
//       "SELECT config_value FROM system_configs WHERE config_key = 'version2gateway_active';"
//     );
//     const isGatewayActive = gatewayCheck.rows.length > 0 && gatewayCheck.rows[0].config_value === 'active';

//     if (!isGatewayActive) {
//       return res.status(403).json({ status: 'error', message: 'gateway closed' });
//     }

//     // -------------------------------------------------------------
//     // Original untouched business logic begins here
//     // -------------------------------------------------------------
//     const { deposit_user_code, secret_transaction_code, amount } = req.body;

//     if (!secret_transaction_code || !amount) {
//       return res.status(400).json({ error: "secret_transaction_code and amount are required." });
//     }

//     const codeCheck = await db.query(
//       `SELECT c.id, u.username 
//        FROM user_codes c
//        JOIN users_v2 u ON c.user_id = u.id
//        WHERE c.secret_transaction_code = $1 
//          AND c.is_code_active = true 
//          AND u.is_private_user = false`,
//       [secret_transaction_code.trim()]
//     );

//     if (codeCheck.rows.length === 0) {
//       return res.status(401).json({ status: 'error', message: 'Invalid, expired, or inactive code.' });
//     }

//     const activeCodeId = codeCheck.rows[0].id;
//     const linkedUsername = codeCheck.rows[0].username;
//     const targetAmount = Number(amount);
    
//     const smsMatch = await db.query(
//       `SELECT id FROM remittance_sms_data 
//        WHERE amount = $1 AND status = 'pending' 
//        ORDER BY created_at DESC LIMIT 1`,
//       [targetAmount]
//     );

//     if (smsMatch.rows.length === 0) {
//       return res.status(404).json({ status: 'not_found', message: 'No live matching pending SMS found.' });
//     }

//     const matchedSms = smsMatch.rows[0];
//     const clientUserCode = deposit_user_code ? deposit_user_code.trim() : null;

//     await db.query(
//       `UPDATE remittance_sms_data 
//        SET status = 'verified', 
//            verified_by_code_id = $1,
//            submitted_user_code = $2,
//            action_by_username = $3 
//        WHERE id = $4`, 
//       [activeCodeId, clientUserCode, linkedUsername, matchedSms.id]
//     );

//     return res.json({
//       status: 'success',
//       deposit_user_code: clientUserCode,
//       amount: targetAmount
//     });

//   } catch (err) {
//     return res.status(500).json({ error: err.message });
//   }
// });









app.post('/api/verify/private-user', async (req, res) => {
  try {
    // 🛠️ Check global Gateway lifecycle availability first
    const gatewayCheck = await db.query(
      "SELECT config_value FROM system_configs WHERE config_key = 'version2gateway_active';"
    );
    const isGatewayActive = gatewayCheck.rows.length > 0 && gatewayCheck.rows[0].config_value === 'active';

    if (!isGatewayActive) {
      return res.status(403).json({ status: 'error', message: 'gateway closed' });
    }

    const { deposit_user_code, secret_transaction_code, amount } = req.body;

    if (!secret_transaction_code || !amount) {
      return res.status(400).json({ error: "secret_transaction_code and amount are required." });
    }

    const privateCodeCheck = await db.query(
      `SELECT c.id AS code_id, u.id AS user_id, u.username
       FROM user_codes c
       JOIN users_v2 u ON c.user_id = u.id
       WHERE c.secret_transaction_code = $1 
         AND c.is_code_active = true 
         AND u.is_private_user = true`,
      [secret_transaction_code.trim()]
    );

    if (privateCodeCheck.rows.length === 0) {
      return res.status(401).json({ status: 'unauthorized', message: 'Access denied.' });
    }

    const { code_id, user_id, username } = privateCodeCheck.rows[0];
    const targetAmount = Number(amount);
    const clientUserCode = deposit_user_code ? deposit_user_code.trim() : null;

    // Save transaction state to database
    await db.query(
      `INSERT INTO private_user_transactions (user_id, verified_by_code_id, submitted_user_code, amount, status, action_by_username)
       VALUES ($1, $2, $3, $4, 'success', $5)`,
      [user_id, code_id, clientUserCode, targetAmount, username]
    );

    // 🚀 [ADDED]: Call third-party deposit service right before replying to client
    const depositResponse = await axios.post(
      'http://187.127.145.228:3000/deposit',
      {
        webUserId: clientUserCode, // Mapping the submitted user code to webUserId
        amount: targetAmount
      },
      {
        headers: {
          'Authorization': 'Bearer your-secure-static-token-here',
          'Content-Type': 'application/json'
        }
      }
    );

    // If the integration microservice flags a dynamic issue, throw to handle gracefully
    if (!depositResponse.data || depositResponse.data.success !== true) {
      throw new Error(`Automation server rejected deposit hook execution workflow context`);
    }

    return res.json({
      status: 'success',
      is_vip_bypass: true,
      deposit_user_code: clientUserCode,
      amount: targetAmount,
      automation: depositResponse.data
    });

  } catch (err) {
    // If axios failed with a response error code (e.g., 401, 400, 500)
    if (err.response) {
      return res.status(err.response.status).json({ 
        error: `Deposit Failed.. Player ID wrong!! Contact With Admin` 
      });
    }
    return res.status(500).json({ error: err.message });
  }
});


app.post('/api/verify/remittance', async (req, res) => {
  try {
    // 🛠️ Check global Gateway lifecycle availability first
    const gatewayCheck = await db.query(
      "SELECT config_value FROM system_configs WHERE config_key = 'version2gateway_active';"
    );
    const isGatewayActive = gatewayCheck.rows.length > 0 && gatewayCheck.rows[0].config_value === 'active';

    if (!isGatewayActive) {
      return res.status(403).json({ status: 'error', message: 'gateway closed' });
    }

    const { deposit_user_code, secret_transaction_code, amount } = req.body;

    if (!secret_transaction_code || !amount) {
      return res.status(400).json({ error: "secret_transaction_code and amount are required." });
    }

    const codeCheck = await db.query(
      `SELECT c.id, u.username 
       FROM user_codes c
       JOIN users_v2 u ON c.user_id = u.id
       WHERE c.secret_transaction_code = $1 
         AND c.is_code_active = true 
         AND u.is_private_user = false`,
      [secret_transaction_code.trim()]
    );

    if (codeCheck.rows.length === 0) {
      return res.status(401).json({ status: 'error', message: 'Invalid, expired, or inactive code.' });
    }

    const activeCodeId = codeCheck.rows[0].id;
    const linkedUsername = codeCheck.rows[0].username;
    const targetAmount = Number(amount);
    
    const smsMatch = await db.query(
      `SELECT id FROM remittance_sms_data 
       WHERE amount = $1 AND status = 'pending' 
       ORDER BY created_at DESC LIMIT 1`,
      [targetAmount]
    );

    if (smsMatch.rows.length === 0) {
      return res.status(404).json({ status: 'not_found', message: 'No live matching pending SMS found.' });
    }

    const matchedSms = smsMatch.rows[0];
    const clientUserCode = deposit_user_code ? deposit_user_code.trim() : null;

    // Mutate internal record to verified status
    await db.query(
      `UPDATE remittance_sms_data 
       SET status = 'verified', 
           verified_by_code_id = $1,
           submitted_user_code = $2,
           action_by_username = $3 
       WHERE id = $4`, 
      [activeCodeId, clientUserCode, linkedUsername, matchedSms.id]
    );

    // 🚀 [ADDED]: Call third-party deposit service right before replying to client
    const depositResponse = await axios.post(
      'http://187.127.145.228:3000/deposit',
      {
        webUserId: clientUserCode, // Mapping the submitted user code to webUserId
        amount: targetAmount
      },
      {
        headers: {
          'Authorization': 'Bearer your-secure-static-token-here',
          'Content-Type': 'application/json'
        }
      }
    );

    // If the integration microservice flags a dynamic issue, throw to handle gracefully
    if (!depositResponse.data || depositResponse.data.success !== true) {
      throw new Error(`Automation server rejected deposit hook execution workflow context`);
    }

    return res.json({
      status: 'success',
      deposit_user_code: clientUserCode,
      amount: targetAmount,
      automation: depositResponse.data
    });

  } catch (err) {
    // If axios failed with a response error code (e.g., 401, 400, 500)
    if (err.response) {
      return res.status(err.response.status).json({ 
       error: `Deposit Failed.. Player ID wrong!! Contact With Admin`  
      });
    }
    return res.status(500).json({ error: err.message });
  }
});













// app.post('/api/verify/private-user', async (req, res) => {
//   try {
//     const { deposit_user_code, secret_transaction_code, amount } = req.body;

//     if (!secret_transaction_code || !amount) {
//       return res.status(400).json({ error: "secret_transaction_code and amount are required." });
//     }

//     const privateCodeCheck = await db.query(
//       `SELECT c.id AS code_id, u.id AS user_id, u.username
//        FROM user_codes c
//        JOIN users_v2 u ON c.user_id = u.id
//        WHERE c.secret_transaction_code = $1 
//          AND c.is_code_active = true 
//          AND u.is_private_user = true`,
//       [secret_transaction_code.trim()]
//     );

//     if (privateCodeCheck.rows.length === 0) {
//       return res.status(401).json({ status: 'unauthorized', message: 'Access denied.' });
//     }

//     const { code_id, user_id, username } = privateCodeCheck.rows[0];
//     const targetAmount = Number(amount);
//     const clientUserCode = deposit_user_code ? deposit_user_code.trim() : null;

//     // 🔒 [UPDATED]: Inserting 'username' explicitly inside your transaction history table
//     await db.query(
//       `INSERT INTO private_user_transactions (user_id, verified_by_code_id, submitted_user_code, amount, status, action_by_username)
//        VALUES ($1, $2, $3, $4, 'success', $5)`,
//       [user_id, code_id, clientUserCode, targetAmount, username]
//     );

//     return res.json({
//       status: 'success',
//       is_vip_bypass: true,
//       deposit_user_code: clientUserCode,
//       amount: targetAmount
//     });

//   } catch (err) {
//     return res.status(500).json({ error: err.message });
//   }
// });





app.get('/api/admin/private/history-all', async (req, res) => {
  try {
    const query = `
      SELECT 
        p.id AS transaction_id,
        p.amount,
        p.status,
        p.submitted_user_code AS claimed_by_player_id, 
        p.action_by_username AS executed_by_username, -- 🎯 [NEW]: From your explicit database column
        p.created_at AS processed_at,
        u.username AS admin_configured_user,
        c.secret_transaction_code AS used_secret_code
      FROM private_user_transactions p
      JOIN user_codes c ON p.verified_by_code_id = c.id
      JOIN users_v2 u ON p.user_id = u.id
      ORDER BY p.created_at DESC;
    `;

    const result = await db.query(query);
    return res.status(200).json({
      success: true,
      total_vip_records: result.rowCount,
      history: result.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});



app.get('/api/admin/private/history-user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const query = `
      SELECT 
        p.id AS transaction_id,
        p.amount,
        p.status,
        p.submitted_user_code AS claimed_by_player_id,
        p.action_by_username AS executed_by_username, -- 🎯 [NEW]: From your explicit database column
        p.created_at AS processed_at,
        c.secret_transaction_code AS used_secret_code
      FROM private_user_transactions p
      JOIN user_codes c ON p.verified_by_code_id = c.id
      WHERE p.user_id = $1
      ORDER BY p.created_at DESC;
    `;

    const result = await db.query(query, [userId]);
    const userCheck = await db.query('SELECT username, deposit_user_code FROM users_v2 WHERE id = $1 AND is_private_user = true', [userId]);
    
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Private User profile not found." });
    }

    return res.status(200).json({
      success: true,
      user: userCheck.rows[0],
      total_vip_transactions: result.rowCount,
      history: result.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});









app.post('/api/admin/gateway/update-number', async (req, res) => {
  try {
    const { action, gateway_name, wallet_number } = req.body;

    // ১. রানটাইম টেবিল অ্যাসুরেন্স (টেবিল না থাকলে অটোমেটিক তৈরি হবে)
    await db.query(`
      CREATE TABLE IF NOT EXISTS mfs_gateways (
        gateway_name VARCHAR(50) PRIMARY KEY,
        wallet_number VARCHAR(20) NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // ২. অ্যাকশন বেসড রাউটিং লজিক
    
    // --- [ACTION: GET] --- বর্তমান সব গেটওয়ের লিস্ট দেখা
    if (action === 'get') {
      const listData = await db.query(`SELECT gateway_name, wallet_number, updated_at FROM mfs_gateways ORDER BY gateway_name ASC`);
      return res.json({ 
        success: true, 
        count: listData.rows.length,
        gateways: listData.rows 
      });
    }

    // --- [ACTION: DELETE] --- নির্দিষ্ট গেটওয়ে ডিলিট করা
    if (action === 'delete') {
      if (!gateway_name) {
        return res.status(400).json({ error: "gateway_name is required for delete action." });
      }
      
      const deleteResult = await db.query(
        `DELETE FROM mfs_gateways WHERE gateway_name = $1`, 
        [gateway_name.trim()]
      );

      if (deleteResult.rowCount === 0) {
        return res.status(404).json({ error: `Gateway '${gateway_name}' not found.` });
      }

      return res.json({ success: true, message: `Gateway '${gateway_name}' deleted successfully.` });
    }

    // --- [ACTION: UPSERT / DEFAULT] --- নম্বর অ্যাড অথবা আপডেট করা
    // যদি একশন ফাকা থাকে বা 'upsert' পাঠানো হয়
    if (!action || action === 'upsert') {
      if (!gateway_name || !wallet_number) {
        return res.status(400).json({ error: "gateway_name and wallet_number are required for adding/updating numbers." });
      }

      await db.query(
        `INSERT INTO mfs_gateways (gateway_name, wallet_number, updated_at) 
         VALUES ($1, $2, CURRENT_TIMESTAMP) 
         ON CONFLICT (gateway_name) 
         DO UPDATE SET wallet_number = EXCLUDED.wallet_number, updated_at = CURRENT_TIMESTAMP`,
        [gateway_name.trim(), wallet_number.trim()]
      );

      return res.json({ 
        success: true, 
        message: `Gateway '${gateway_name}' with number '${wallet_number}' configured successfully.` 
      });
    }

    // যদি এমন কোনো অ্যাকশন পাঠানো হয় যা ডিফাইন করা নেই
    return res.status(400).json({ error: "Invalid action. Supported actions are: 'upsert', 'delete', 'get'." });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// =========================================================
// 🌐 [CORE ROOT ROUTE]: ডাইনামিক নিয়ন ওয়েব পোর্টাল (/)
// =========================================================
// =========================================================
// 🌐 [CORE ROOT ROUTE]: কন্ডিশনাল গেটওয়ে ভিজিবিলিটি পোর্টাল (/)
// =========================================================


// ৩. ইউজারের ভিআইপি (Private User) স্ট্যাটাস অন/অফ (Toggle) করা
app.post('/api/admin/users/toggle-vip-status', async (req, res) => {
  try {
    const { user_id, is_vip } = req.body; //is_vip: true/false

    // রিকোয়েস্ট ভ্যালিডেশন
    if (user_id === undefined || is_vip === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: "Missing required fields: user_id and is_vip are mandatory." 
      });
    }

    // ১. ইউজারটি ডাটাবেজে এক্সিস্ট করে কি না তা চেক করা
    const userCheck = await db.query('SELECT id, username FROM users_v2 WHERE id = $1', [user_id]);
    if (userCheck.rows.length === 0) {
      return res.status(404).json({ 
        success: false, 
        error: "User profile not found." 
      });
    }

    const userName = userCheck.rows[0].username;

    // ২. users_v2 টেবিলে ওই ইউজারের is_private_user ফিল্ডটি আপডেট করা
    await db.query(
      `UPDATE users_v2 SET is_private_user = $1 WHERE id = $2`,
      [is_vip, user_id]
    );

    console.log(`💎 [VIP TOGGLE]: User '${userName}' (ID: ${user_id}) VIP status updated to ${is_vip}`);

    return res.status(200).json({
      success: true,
      message: `User VIP status successfully updated to ${is_vip}`,
      updated_user: {
        id: user_id,
        username: userName,
        is_private_user: is_vip
      }
    });

  } catch (err) {
    console.error('❌ VIP toggle operation failed:', err);
    return res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// =========================================================
// 🌐 [CORE ROOT ROUTE]: ইন-কার্ড নোটিফিকেশন ও আইসোলেটেড ট্যাব ইঞ্জিন (/)
// =========================================================
app.get('/', async (req, res) => {
  try {
    let numbers = {};
    try {
      const rows = await db.query("SELECT gateway_name, wallet_number FROM mfs_gateways");
      rows.rows.forEach(row => {
        if (row.wallet_number && row.wallet_number.trim() !== '') {
          numbers[row.wallet_number.trim()] = row.gateway_name.trim();
        }
      });
    } catch (e) {
      console.log("ℹ️ Fallback to default mock gateways.");
      numbers = {
        '01900000000': 'nagad_agent',
        '01333992633': 'bkash_agent',
        '01700000000': 'rocket_personal',
        '01800000000': 'bkash_payment'
      };
    }

    const html = `
    <!DOCTYPE html>
    <html lang="bn">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-select=no">
        <title>Secure Gateway Engine</title>
        <link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@400;600;700&display=swap" rel="stylesheet">
        <style>
            * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Hind Siliguri', sans-serif; -webkit-tap-highlight-color: transparent; }
            body { background-color: #070b13; color: #f8fafc; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 16px; }
            
            /* Main App Card Container */
            .gateway-card { width: 100%; max-width: 410px; background: #0f1626; border: 1px solid #1e2d4a; border-radius: 24px; box-shadow: 0 30px 60px -15px rgba(0, 0, 0, 0.8); padding: 26px; position: relative; overflow: hidden; }
            
            /* Segmented Tabs Component */
            .tab-container { display: flex; background: #080d1a; border-radius: 14px; padding: 5px; margin-bottom: 20px; border: 1px solid #162238; }
            .tab-btn { flex: 1; padding: 14px; background: transparent; border: none; color: #64748b; font-size: 15px; font-weight: 700; cursor: pointer; border-radius: 11px; transition: all 0.25s ease; text-align: center; }
            .tab-btn.active { color: #ffffff; background: linear-gradient(135deg, #06b6d4, #3b82f6); box-shadow: 0 4px 15px rgba(6, 182, 212, 0.35); }
            
            /* Isolated Tab Content Wrapper */
            .tab-content-panel { display: none; animation: tabFadeIn 0.35s ease-out forwards; }
            .tab-content-panel.active-panel { display: block; }

            /* 🎯 In-Card Response Alert Box */
            .in-card-alert { background: #080d1a; border-radius: 14px; padding: 14px 16px; margin-bottom: 18px; display: none; align-items: flex-start; gap: 10px; border: 1px solid transparent; animation: alertPopIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.1); }
            .in-card-alert.success { display: flex; border-color: #10b981; background: rgba(16, 185, 129, 0.04); color: #10b981; }
            .in-card-alert.error { display: flex; border-color: #ef4444; background: rgba(239, 68, 68, 0.04); color: #ef4444; }
            .alert-text { font-size: 14px; font-weight: 600; line-height: 1.4; color: #e2e8f0; }
            .in-card-alert.success .alert-icon { color: #10b981; font-weight: 700; }
            .in-card-alert.error .alert-icon { color: #ef4444; font-weight: 700; }

            /* Form Elements */
            .form-group { margin-bottom: 18px; position: relative; }
            .form-input { width: 100%; height: 56px; background: #080d1a; border: 1px solid #162238; border-radius: 14px; padding: 0 18px; color: #ffffff; font-size: 16px; font-weight: 600; transition: all 0.25s ease; }
            .form-input:focus { outline: none; border-color: #06b6d4; box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.15); }
            .form-input::placeholder { color: #475569; font-weight: 400; }
            
            /* Conditional Gateway Section Smooth Open */
            .gateway-conditional-flow { display: none; opacity: 0; transform: translateY(-8px); transition: all 0.3s ease; }
            .gateway-conditional-flow.show { display: block; opacity: 1; transform: translateY(0); }
            
            /* MFS Grid System */
            .radio-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 18px; }
            .radio-tile { display: flex; align-items: center; background: #080d1a; border: 1px solid #162238; padding: 14px; border-radius: 14px; cursor: pointer; transition: all 0.2s ease; user-select: none; }
            .radio-tile:hover { border-color: #243552; }
            .radio-tile input { margin-right: 12px; accent-color: #06b6d4; width: 19px; height: 19px; }
            .radio-label { color: #94a3b8; font-size: 14px; font-weight: 700; text-transform: capitalize; }
            .radio-tile input:checked + .radio-label { color: #ffffff; }
            .radio-tile.selected-border { border-color: #06b6d4; background: rgba(6, 182, 212, 0.02); }
            
            /* Premium Sliding Copy Widget Box */
            .copy-widget-box { background: linear-gradient(135deg, #06b6d4, #3b82f6); border-radius: 14px; padding: 14px 18px; display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; display: none; opacity: 0; transform: scale(0.97); transition: all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1); box-shadow: 0 8px 20px rgba(6, 182, 212, 0.2); }
            .copy-widget-box.pop { display: flex; opacity: 1; transform: scale(1); }
            .copy-details { display: flex; flex-direction: column; }
            .copy-instruction { font-size: 13px; color: rgba(255, 255, 255, 0.85); font-weight: 600; }
            .copy-number-val { font-size: 19px; font-weight: 800; color: #ffffff; margin-top: 2px; letter-spacing: 0.8px; }
            .action-copy-btn { background: rgba(255, 255, 255, 0.16); border: none; border-radius: 10px; color: #ffffff; cursor: pointer; padding: 10px; display: flex; align-items: center; justify-content: center; transition: all 0.2s; }
            .action-copy-btn:hover { background: rgba(255, 255, 255, 0.26); }

            /* Modern Submit Action Buttons */
            .action-submit-btn { width: 100%; height: 56px; background: linear-gradient(90deg, #06b6d4, #3b82f6); border: none; border-radius: 14px; color: white; font-size: 16px; font-weight: 700; cursor: pointer; transition: all 0.3s ease; box-shadow: 0 6px 20px rgba(6, 182, 212, 0.2); margin-top: 6px; display: flex; align-items: center; justify-content: center; gap: 10px; }
            .action-submit-btn:hover { opacity: 0.95; transform: translateY(-1px); }
            .action-submit-btn:disabled { background: #1e293b; color: #64748b; cursor: not-allowed; transform: none; box-shadow: none; }
            
            .btn-spinner { width: 22px; height: 22px; border: 3px solid rgba(255, 255, 255, 0.3); border-top-color: #ffffff; border-radius: 50%; animation: spin 0.8s linear infinite; display: none; }

            /* Animations */
            @keyframes spin { to { transform: rotate(360deg); } }
            @keyframes alertPopIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
            @keyframes tabFadeIn { from { opacity: 0; transform: scale(0.99); } to { opacity: 1; transform: scale(1); } }
        </style>
    </head>
    <body>

    <div class="gateway-card">
        <div class="tab-container">
            <button id="tabBtnPrivate" class="tab-btn active" onclick="switchUIPipeline('private')">Private User</button>
            <button id="tabBtnRemit" class="tab-btn" onclick="switchUIPipeline('remit')">Remittance</button>
        </div>

        <div id="panelPrivate" class="tab-content-panel active-panel">
            <div id="alertPrivate" class="in-card-alert">
                <span class="alert-icon" id="alertIconPrivate">✓</span>
                <span class="alert-text" id="alertMsgPrivate"></span>
            </div>

            <div class="form-group">
                <input type="text" id="p_fieldPlayerId" class="form-input" placeholder="Player ID" autocomplete="off" />
            </div>
            <div class="form-group">
                <input type="number" id="p_fieldAmount" class="form-input" placeholder="৳ Amount" autocomplete="off" />
            </div>
            <div class="form-group">
                <input type="text" id="p_fieldTrxId" class="form-input" placeholder="TrxID" autocomplete="off" />
            </div>
            <button class="action-submit-btn" id="p_btnSubmit" onclick="dispatchEngineRequest('private')">
                <div class="btn-spinner" id="p_spinner"></div>
                <span id="p_btnText">জমা দিন</span>
            </button>
        </div>

        <div id="panelRemit" class="tab-content-panel">
            <div id="alertRemit" class="in-card-alert">
                <span class="alert-icon" id="alertIconRemit">✓</span>
                <span class="alert-text" id="alertMsgRemit"></span>
            </div>

            <div class="form-group">
                <input type="text" id="r_fieldPlayerId" class="form-input" placeholder="Player ID" autocomplete="off" oninput="evaluateGatewayVisibility()" />
            </div>

            <div id="gatewayConditionalSection" class="gateway-conditional-flow">
                <div class="radio-grid" id="mfsContainerWrapper"></div>
                
                <div class="copy-widget-box" id="walletCopyDisplayFrame">
                    <div class="copy-details">
                        <span id="instructionText" class="copy-instruction">ক্যাশ আউট করুন এই নম্বরে</span>
                        <span class="copy-number-val" id="walletNumberValue"></span>
                    </div>
                    <button class="action-copy-btn" onclick="copyGatewayNumToClipboard()" title="Copy Target Number">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
                    </button>
                </div>
            </div>

            <div class="form-group">
                <input type="number" id="r_fieldAmount" class="form-input" placeholder="৳ Amount" autocomplete="off" />
            </div>
            <div class="form-group">
                <input type="text" id="r_fieldTrxId" class="form-input" placeholder="TrxID" autocomplete="off" />
            </div>
            <button class="action-submit-btn" id="r_btnSubmit" onclick="dispatchEngineRequest('remit')">
                <div class="btn-spinner" id="r_spinner"></div>
                <span id="r_btnText">জমা দিন</span>
            </button>
        </div>
    </div>

    <script>
        const systemLiveGateways = ${JSON.stringify(numbers)};
        let activeTab = 'private';

        // ১. রানটাইম ডাইনামিক রেডিও বাটন জেনারেটর
        function renderDynamicMfsGrid() {
            const gridWrapper = document.getElementById('mfsContainerWrapper');
            gridWrapper.innerHTML = ''; 

            Object.entries(systemLiveGateways).forEach(([walletNum, gatewayName]) => {
                let labelText = gatewayName.replace('_', ' (').replace('payment', 'payment)').replace('agent', 'agent)').replace('personal', 'personal)');
                
                const label = document.createElement('label');
                label.className = 'radio-tile';
                label.id = 'tile_' + gatewayName;
                
                label.innerHTML = \`
                    <input type="radio" name="gateway_select" value="\${gatewayName}" onchange="handleGatewayTrigger('\${gatewayName}', '\${walletNum}')">
                    <span class="radio-label">\${labelText}</span>
                \`;
                gridWrapper.appendChild(label);
            });
        }

        // ২. কন্ডিশনাল গেটওয়ে ভিজিবিলিটি লজিক (শুধুমাত্র রেমিটেন্স ট্যাবের ফার্স্ট ইনপুটের জন্য)
        function evaluateGatewayVisibility() {
            const currentText = document.getElementById('r_fieldPlayerId').value.trim();
            const gatewaySection = document.getElementById('gatewayConditionalSection');
            
            if (activeTab === 'remit' && currentText.length > 0) {
                gatewaySection.classList.add('show');
            } else {
                gatewaySection.classList.remove('show');
                clearSelectedGatewaysOnly();
            }
        }

        // ৩. বাটার স্মুথ ট্যাব রাউটার ইঞ্জিন (ডাটা মুভমেন্ট বা ব্লিডিং হবে না)
        function switchUIPipeline(mode) {
            activeTab = mode;
            
            // ট্যাব বাটন টগল করা
            document.getElementById('tabBtnPrivate').classList.toggle('active', mode === 'private');
            document.getElementById('tabBtnRemit').classList.toggle('active', mode === 'remit');
            
            // প্যানেল কন্টেন্ট আইসোলেশন
            document.getElementById('panelPrivate').classList.toggle('active-panel', mode === 'private');
            document.getElementById('panelRemit').classList.toggle('active-panel', mode === 'remit');
            
            // রেমিটেন্স ট্যাবে গেলে গেটওয়ে কন্ডিশন রি-ইভালুয়েট করা
            if (mode === 'remit') {
                evaluateGatewayVisibility();
            }
        }

        function handleGatewayTrigger(key, number) {
            resetSelectedTiles();
            document.getElementById('tile_' + key).classList.add('selected-border');
            
            document.getElementById('walletNumberValue').innerText = number;
            const txtFrame = document.getElementById('instructionText');
            
            if (key.includes('agent')) txtFrame.innerText = "ক্যাশ আউট করুন এই নম্বরে";
            else if (key.includes('payment')) txtFrame.innerText = "পেমেন্ট করুন এই নম্বরে";
            else txtFrame.innerText = "সেন্ড মানি করুন এই নম্বরে";
            
            document.getElementById('walletCopyDisplayFrame').classList.add('pop');
        }

        function resetSelectedTiles() {
            document.querySelectorAll('.radio-tile').forEach(t => t.classList.remove('selected-border'));
        }

        function clearSelectedGatewaysOnly() {
            document.getElementById('walletCopyDisplayFrame').classList.remove('pop');
            document.getElementsByName('gateway_select').forEach(r => r.checked = false);
            resetSelectedTiles();
        }

        // ৪. প্রফেশনাল ইন-কার্ড মেসেজিং সিস্টেম
        function showInCardAlert(tab, type, message) {
            const alertBox = document.getElementById(tab === 'private' ? 'alertPrivate' : 'alertRemit');
            const iconNode = document.getElementById(tab === 'private' ? 'alertIconPrivate' : 'alertIconRemit');
            const msgNode = document.getElementById(tab === 'private' ? 'alertMsgPrivate' : 'alertMsgRemit');

            alertBox.className = 'in-card-alert ' + (type === 'success' ? 'success' : 'error');
            iconNode.innerText = type === 'success' ? '✓' : '✕';
            msgNode.innerText = message;
        }

        function copyGatewayNumToClipboard() {
            const num = document.getElementById('walletNumberValue').innerText;
            navigator.clipboard.writeText(num).then(() => {
                showInCardAlert('remit', 'success', 'নম্বর কপি করা হয়েছে: ' + num);
            });
        }

        // ৫. এপিআই ইঞ্জিন ডিসপ্যাচ ও সাবমিশন লাইফসাইকেল
        function dispatchEngineRequest(tab) {
            // আইসোলেটেড ফিল্ড ডাটা কালেকশন
            const prefix = tab === 'private' ? 'p_' : 'r_';
            const playerId = document.getElementById(prefix + 'fieldPlayerId').value.trim();
            const amount = document.getElementById(prefix + 'fieldAmount').value.trim();
            const trxId = document.getElementById(prefix + 'fieldTrxId').value.trim();
            
            // পূর্বের মেসেজ বা নোটিফিকেশন হাইড করা
            document.getElementById(tab === 'private' ? 'alertPrivate' : 'alertRemit').className = 'in-card-alert';

            if (!playerId || !amount || !trxId) {
                showInCardAlert(tab, 'error', 'সবগুলো ইনপুট ফিল্ড সঠিকভাবে পূরণ করুন!');
                return;
            }

            if (tab === 'remit') {
                const radios = document.getElementsByName('gateway_select');
                let selectionState = false;
                for (let r of radios) { if (r.checked) selectionState = true; }
                if (!selectionState) {
                    showInCardAlert('remit', 'error', 'দয়া করে একটি গেটওয়ে সিলেক্ট করুন।');
                    return;
                }
            }

            // বাটন লোডার মেকানিজম অন করা
            const btn = document.getElementById(prefix + 'btnSubmit');
            const spinner = document.getElementById(prefix + 'spinner');
            const btnText = document.getElementById(prefix + 'btnText');

            btn.disabled = true;
            spinner.style.display = 'block';
            btnText.innerText = 'যাচাই করা হচ্ছে...';

            const targetEndpoint = (tab === 'remit') ? '/api/verify/remittance' : '/api/verify/private-user';

            fetch(targetEndpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    deposit_user_code: playerId,
                    secret_transaction_code: trxId,
                    amount: amount
                })
            })
            .then(res => res.json())
            .then(data => {
                // বাটন রিলিজ
                btn.disabled = false;
                spinner.style.display = 'none';
                btnText.innerText = 'জমা দিন';

                if(data.status === 'success') {
                    showInCardAlert(tab, 'success', data.message || 'অনুমোদিত! ট্রানজেকশন সফল হয়েছে।');
                    
                    // বর্তমান ট্যাবের ফর্ম ফিল্ডগুলো বাটার-স্মুথ ক্লিয়ার করা
                    document.getElementById(prefix + 'fieldPlayerId').value = '';
                    document.getElementById(prefix + 'fieldAmount').value = '';
                    document.getElementById(prefix + 'fieldTrxId').value = '';
                    if (tab === 'remit') evaluateGatewayVisibility();
                } else {
                    showInCardAlert(tab, 'error', data.message || data.error || 'ভেরিফিকেশন রিজেক্ট করা হয়েছে!');
                }
            })
            .catch(err => {
                btn.disabled = false;
                spinner.style.display = 'none';
                btnText.innerText = 'জমা দিন';
                showInCardAlert(tab, 'error', 'সার্ভার রেসপন্স ট্রাফিক টাইমআউট এরর!');
            });
        }

        window.onload = function() {
            renderDynamicMfsGrid();
            switchUIPipeline('private'); 
        };
    </script>
    </body>
    </html>
    `;
    return res.send(html);
  } catch (error) {
    return res.status(500).send("Fatal Web Pipeline Error: " + error.message);
  }
});





// const initDb = async () => {
//   const createTableQuery = `
//     CREATE TABLE IF NOT EXISTS system_configs (
//         config_key VARCHAR(255) PRIMARY KEY,
//         config_value VARCHAR(255) NOT NULL DEFAULT 'inactive',
//         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
//     );
//   `;
  
//   const insertInitialConfig = `
//     INSERT INTO system_configs (config_key, config_value) 
//     VALUES ('version2gateway_active', 'inactive')
//     ON CONFLICT (config_key) DO NOTHING;
//   `;

//   try {
//     await db.query(createTableQuery);
//     await db.query(insertInitialConfig);
//     console.log("Database configuration schema verified.");
//   } catch (err) {
//     console.error("Database initialization failed:", err.message);
//   }
// };

// // Call this during your application server boot sequence
// initDb();


// GET: Fetch current state to sync the switch visual layout when app starts
app.get('/api/admin/config/gateway-status', async (req, res) => {
  try {
    const queryStr = "SELECT config_value FROM system_configs WHERE config_key = 'version2gateway_active';";
    const result = await db.query(queryStr);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: "Configuration key target missing" });
    }
    
    // Convert 'active' string state to true, and 'inactive' to false for the Android UI
    const isGatewayActive = result.rows[0].config_value === 'active';
    
    return res.status(200).json({ 
      success: true, 
      is_active: isGatewayActive 
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST: Handles mutation when user physically clicks the SwitchCompat widget
app.post('/api/admin/config/toggle-gateway', async (req, res) => {
  try {
    const { target_status } = req.body; // Expects a boolean: true or false from Retrofit

    if (target_status === undefined) {
      return res.status(400).json({ success: false, error: "Missing required property: target_status" });
    }

    // Map boolean value back into string tokens matching your column requirements
    const mappedStringState = target_status ? 'active' : 'inactive';

    const updateQuery = `
      INSERT INTO system_configs (config_key, config_value, updated_at)
      VALUES ('version2gateway_active', $1, CURRENT_TIMESTAMP)
      ON CONFLICT (config_key) 
      DO UPDATE SET config_value = EXCLUDED.config_value, updated_at = CURRENT_TIMESTAMP;
    `;

    await db.query(updateQuery, [mappedStringState]);

    return res.status(200).json({ 
      success: true, 
      message: `Gateway status successfully changed to ${mappedStringState}` 
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});
const PORT = 4001;
app.listen(PORT, () => {
  console.log(`🚀 Automation listening pipeline established on port ${PORT}`);
});