// server.js
const express = require("express");
const axios = require("axios");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "2mb" }));

const SF_API_VERSION = process.env.SF_API_VERSION || "v61.0";
const sq = s => String(s ?? "").replace(/'/g, "\\'");
const getLoginUrl = () => (process.env.SF_LOGIN_URL || "https://login.salesforce.com").replace(/\/+$/,"");
const getPrivateKey = () => {
  const k = process.env.SF_PRIVATE_KEY || "";
  return k.includes("\\n") ? k.replace(/\\n/g, "\n") : k;
};

// Extract user ID from JWT id URL (e.g. https://login.salesforce.com/id/00DHp000004Abj7MAC/005VO00000AF8ifYAD -> 005VO00000AF8ifYAD)
const extractUserId = (jwtId) => {
  if (!jwtId) return null;
  const parts = jwtId.split('/');
  return parts[parts.length - 1];
};

function buildAssertion() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: process.env.SF_CONSUMER_KEY, 
    sub: process.env.SF_USERNAME,
    aud: getLoginUrl(),
    exp: now + 180
  };
  return jwt.sign(payload, getPrivateKey(), { algorithm: "RS256" });
}

async function getSfToken() {
  const url = `${getLoginUrl()}/services/oauth2/token`;
  const body = new URLSearchParams();
  body.append("grant_type","urn:ietf:params:oauth:grant-type:jwt-bearer");
  body.append("assertion", buildAssertion());
  const { data } = await axios.post(url, body.toString(), {
    headers:{ "Content-Type":"application/x-www-form-urlencoded" },
    timeout: 15000
  });
  return data;
}


app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/auth/sf/jwt/test", async (_, res) => {
  try {
    const tok = await getSfToken();
    res.json({
      ok: true,
      token_type: tok.token_type,
      instance_url: tok.instance_url,
      scope: tok.scope,
      access_token_preview: tok.access_token?.slice(0, 36) + "...(truncated)"
    });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.response?.data || e.message });
  }
});

async function getRcToken() {
  const url = `${process.env.RC_SERVER}/restapi/oauth/token`;
  const auth = Buffer.from(`${process.env.RC_CLIENT_ID}:${process.env.RC_CLIENT_SECRET}`).toString('base64');
  
  const body = new URLSearchParams();
  body.append('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  body.append('assertion', process.env.RC_JWT_TOKEN);
  
  const { data } = await axios.post(url, body.toString(), {
    headers: {
      'Authorization': `Basic ${auth}`,  // ← Need this!
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    timeout: 15000
  });
  
  return data;
}

// Extract actual person name from a call
// For inbound calls, look through legs to find the person who answered
// For outbound calls, return the caller name
function getSalesRepNameFromCall(call) {
  if (call.direction === 'Outbound') {
    return call.from.name;
  }

  // For inbound calls, look through legs to find a person (not department)
  if (call.legs && Array.isArray(call.legs)) {
    for (const leg of call.legs) {
      // Find a leg with a person's name in the "to" field (not just a number)
      if (leg.to?.name && leg.to.name.trim()) {
        const name = leg.to.name.trim();
        // Skip generic department names
        if (!name.match(/^(corporate|gear|stores|health|pk|customer\s+service)/i)) {
          return name;
        }
      }
    }
  }

  // Fallback to top-level to.name if we can't find anything in legs
  if (call.to?.name && call.to.name.trim()) {
    return call.to.name;
  }

  return null;
}

// Extract extension from a call
// For outbound calls, use the caller's extension
// For inbound calls, look through legs to find the person who answered and get their extension
function getExtensionFromCall(call) {
  if (call.direction === 'Outbound') {
    // For outbound, try to find extensionNumber in the call or legs
    if (call.from?.extensionNumber) return call.from.extensionNumber;

    // Check legs for extensionNumber
    if (call.legs && Array.isArray(call.legs)) {
      for (const leg of call.legs) {
        if (leg.from?.extensionNumber) return leg.from.extensionNumber;
      }
    }

    // Fallback to extensionId if no number is found
    return call.from?.extensionId;
  }

  // For inbound calls, look through legs to find a person (not department) and get their extension number
  if (call.legs && Array.isArray(call.legs)) {
    for (const leg of call.legs) {
      if (leg.to?.name && leg.to.name.trim()) {
        const name = leg.to.name.trim();
        // Skip generic department names
        if (!name.match(/^(corporate|gear|stores|health|pk|customer\s+service|accounts?\s+receivable)/i)) {
          // Found the person - return their extension number if available
          if (leg.to?.extensionNumber) return leg.to.extensionNumber;
          // Fallback to extensionId
          return leg.to?.extensionId;
        }
      }
    }
  }

  return null;
}

// Look up Salesforce User by name
async function lookupUserByName(name, sfTok) {
  if (!name) return null;

  try {
    const cleanName = name.trim();
    const q = encodeURIComponent(
      `SELECT Id, Name FROM User WHERE Name = '${sq(cleanName)}' LIMIT 1`
    );
    const response = await axios.get(
      `${sfTok.instance_url}/services/data/${SF_API_VERSION}/query?q=${q}`,
      { headers: { 'Authorization': `Bearer ${sfTok.access_token}` } }
    );

    if (response.data?.records?.[0]) {
      return response.data.records[0].Id;
    }
  } catch (err) {
    console.log(`   ⚠️  User lookup failed for "${name}": ${err.message}`);
  }

  return null;
}

// ---------- RingCentral Call Sync ----------
const syncedCalls = new Set(); // Track synced calls (upgrade to DB later)
let lastSyncTime = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(); // Start from 24h ago

app.get("/sync/ringcentral", async (req, res) => {
  const startTime = Date.now();
  let synced = 0;
  let skipped = 0;
  const errors = [];
  
  try {
    console.log(`🔄 SYNCING RINGCENTRAL CALLS since ${lastSyncTime}`);
    
    // 1. Get RingCentral access token
    const rcAuth = await getRcToken();
    const rcToken = rcAuth.access_token;
    
    // 2. Fetch recent calls from RingCentral
    const rcResponse = await axios.get(
      `${process.env.RC_SERVER}/restapi/v1.0/account/~/call-log`,
      {
        params: {
          dateFrom: lastSyncTime,
          perPage: 50,
          view: 'Detailed'
        },
        headers: { 'Authorization': `Bearer ${rcToken}` },
        timeout: 15000
      }
    );
    
    const calls = rcResponse.data.records || [];
    console.log(`📞 Found ${calls.length} calls since ${lastSyncTime}`);
    
    // 3. Get Salesforce token
    const sfTok = await getSfToken();
    const H = { Authorization: `Bearer ${sfTok.access_token}` };
    
    // 4. Group calls by sessionId and take only the first occurrence
    const uniqueCalls = new Map();
    for (const call of calls) {
      if (!uniqueCalls.has(call.sessionId)) {
        uniqueCalls.set(call.sessionId, call);
      }
    }
    
    console.log(`📊 Unique sessions: ${uniqueCalls.size} (${calls.length - uniqueCalls.size} duplicates filtered)`);
    
    // 5. Check which sessionIds already exist in Salesforce (using CONTAINS logic)
    const sessionIds = Array.from(uniqueCalls.keys());
    const existingSessionIds = new Set();
    
    if (sessionIds.length > 0) {
      try {
        // Build OR query to check if CALL_UNIQUE_ID contains any of our sessionIds
        // This handles both exact matches and RingCentral's format with extra metadata
        const likeConditions = sessionIds.map(id => `rcsfl__CALL_UNIQUE_ID__c LIKE '%${id}%'`).join(' OR ');
        const qExisting = encodeURIComponent(
          `SELECT rcsfl__CALL_UNIQUE_ID__c FROM Task WHERE ${likeConditions}`
        );
        
        const existingResponse = await axios.get(
          `${sfTok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qExisting}`,
          { headers: H }
        );
        
        // Extract the sessionId from each existing task's CALL_UNIQUE_ID
        existingResponse.data?.records?.forEach(record => {
          if (record.rcsfl__CALL_UNIQUE_ID__c) {
            // Check which sessionId this task contains
            for (const sessionId of sessionIds) {
              if (record.rcsfl__CALL_UNIQUE_ID__c.includes(sessionId)) {
                existingSessionIds.add(sessionId);
                console.log(`   💾 Found existing: ${sessionId} in ${record.rcsfl__CALL_UNIQUE_ID__c}`);
              }
            }
          }
        });
        
        console.log(`💾 Found ${existingSessionIds.size} existing tasks in Salesforce`);
      } catch (err) {
        console.log(`⚠️  Could not check existing tasks: ${err.message}`);
      }
    }
    
    // 6. Process each unique call
    for (const [sessionId, call] of uniqueCalls) {
      try {
        // Skip if already in Salesforce
        if (existingSessionIds.has(sessionId)) {
          console.log(`⏭️  Skipping ${sessionId} - already exists in Salesforce`);
          skipped++;
          continue;
        }
        
        // Skip if already synced in this run
        if (syncedCalls.has(sessionId)) {
          console.log(`⏭️  Skipping ${sessionId} - already synced in memory`);
          skipped++;
          continue;
        }
        
        // Skip non-voice calls
        if (call.type !== 'Voice') {
          skipped++;
          continue;
        }
        
        console.log(`\n📞 Processing call ${sessionId}:`);
        console.log(`   Direction: ${call.direction}`);
        console.log(`   From: ${call.from.phoneNumber} (${call.from.name || 'Unknown'})`);
        console.log(`   To: ${call.to.phoneNumber} (${call.to.name || 'Unknown'})`);
        console.log(`   Duration: ${call.duration}s`);
        console.log(`   Result: ${call.result}`);
        
        // Determine which phone number to match (external number)
        const phoneToMatch = call.direction === 'Inbound' 
          ? call.from.phoneNumber 
          : call.to.phoneNumber;
        
        // Clean phone number for matching
        const cleanPhone = phoneToMatch.replace(/[\s\-\(\)\+]/g, '');
        const last10Digits = cleanPhone.slice(-10);
        
        console.log(`   Matching phone: ${phoneToMatch} (last 10: ${last10Digits})`);
        
        // Look up Contact or Lead by phone
        let whoId = null;
        let whatId = null;
        let recordType = null;
        
        // Try Contact first
        try {
          const qC = encodeURIComponent(
            `SELECT Id, AccountId, Name FROM Contact WHERE Phone LIKE '%${last10Digits}%' LIMIT 1`
          );
          const rc = await axios.get(
            `${sfTok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qC}`,
            { headers: H }
          );
          if (rc.data?.records?.[0]) {
            whoId = rc.data.records[0].Id;
            whatId = rc.data.records[0].AccountId;
            recordType = 'Contact';
            console.log(`   ✅ Found Contact: ${rc.data.records[0].Name} (${whoId})`);
          }
        } catch (err) {
          console.log(`   ⚠️  Contact lookup failed: ${err.message}`);
        }
        
        // Try Lead if no Contact found
        if (!whoId) {
          try {
            const qL = encodeURIComponent(
              `SELECT Id, Name FROM Lead WHERE Phone LIKE '%${last10Digits}%' LIMIT 1`
            );
            const rl = await axios.get(
              `${sfTok.instance_url}/services/data/${SF_API_VERSION}/query?q=${qL}`,
              { headers: H }
            );
            if (rl.data?.records?.[0]) {
              whoId = rl.data.records[0].Id;
              recordType = 'Lead';
              console.log(`   ✅ Found Lead: ${rl.data.records[0].Name} (${whoId})`);
            }
          } catch (err) {
            console.log(`   ⚠️  Lead lookup failed: ${err.message}`);
          }
        }
        
        if (!whoId) {
          console.log(`   ⚠️  No Contact or Lead found for ${phoneToMatch}`);
        }

        // Determine sales rep name based on call direction
        // Inbound: look through legs to find the person who answered
        // Outbound: caller is the sales rep (internal person who made the call)
        const salesRepName = getSalesRepNameFromCall(call);

        // Look up the sales rep as a Salesforce User and get their ID
        let ownerId = null;
        if (salesRepName) {
          ownerId = await lookupUserByName(salesRepName, sfTok);
          if (ownerId) {
            console.log(`   ✅ Found User: ${salesRepName} (${ownerId})`);
          } else {
            console.log(`   ⚠️  No User found for sales rep: ${salesRepName}`);
          }
        }

        // Default to OAuth user if no sales rep found
        if (!ownerId) {
          ownerId = extractUserId(sfTok.id);
          console.log(`   ℹ️  Defaulting to OAuth user: ${ownerId}`);
        }

        // Format dates
        const callStartTime = new Date(call.startTime);
        const callEndTime = new Date(callStartTime.getTime() + (call.duration * 1000));

        // Get extension from the call
        const extension = getExtensionFromCall(call);

        // Create Task using RingCentral's existing custom fields
        const taskPayload = {
          // Standard Salesforce fields
          Subject: `${call.direction} to ${call.direction === 'Inbound' ? call.to.phoneNumber : call.from.phoneNumber}`,
          Status: 'Completed',
          ActivityDate: call.startTime.split('T')[0],
          Priority: 'Normal',
          TaskSubtype: 'Call',
          CallType: call.direction,
          CallDurationInSeconds: call.duration,
          CallDisposition: call.result,
          CallObject: call.sessionId,
          OwnerId: ownerId,

          // RingCentral's existing custom fields (rcsfl__ prefix)
          rcsfl__call_start_time__c: callStartTime.toISOString(),
          rcsfl__call_end_time__c: callEndTime.toISOString(),
          rcsfl__CALL_UNIQUE_ID__c: call.sessionId, // Just the sessionId, not the extended format
          rcsfl__caller_name__c: call.from.name || null,
          rcsfl__callee_name__c: call.to.name || null,
          rcsfl__caller_location__c: call.from.location || null,
          rcsfl__callee_location__c: call.to.location || null,
          rcsfl__from_number__c: call.from.phoneNumber,
          rcsfl__to_number__c: call.to.phoneNumber,
          rcsfl__RC_Logging_Type__c: 'call',
          rc_extension__c: extension || null,

          // Link to Contact/Lead/Account if found
          ...(whoId && { WhoId: whoId }),
          ...(whatId && { WhatId: whatId })
        };
        
        console.log(`   Creating Task in Salesforce...`);
        const taskResponse = await axios.post(
          `${sfTok.instance_url}/services/data/${SF_API_VERSION}/sobjects/Task`,
          taskPayload,
          { headers: H }
        );
        
        const taskId = taskResponse.data.id;
        console.log(`   ✅ Task created: ${taskId}`);
        console.log(`      Subject: ${taskPayload.Subject}`);
        console.log(`      Linked to: ${recordType || 'None'} ${whoId || 'N/A'}`);
        if (whatId) console.log(`      Related to Account: ${whatId}`);
        
        // Mark as synced
        syncedCalls.add(sessionId);
        existingSessionIds.add(sessionId); // Add to existing set to prevent re-processing
        synced++;
        
      } catch (callError) {
        console.error(`   ❌ Failed to sync call ${sessionId}:`, callError.message);
        if (callError.response?.data) {
          console.error(`   SF Error:`, JSON.stringify(callError.response.data, null, 2));
        }
        errors.push({
          sessionId: sessionId,
          error: callError.message,
          details: callError.response?.data
        });
      }
    }
    
    // Update last sync time
    lastSyncTime = new Date().toISOString();
    
    const duration = Date.now() - startTime;
    console.log(`\n✅ SYNC COMPLETE in ${duration}ms`);
    console.log(`   ✅ Synced: ${synced}`);
    console.log(`   ⏭️  Skipped: ${skipped}`);
    console.log(`   ❌ Errors: ${errors.length}`);
    console.log(`   📅 Next sync from: ${lastSyncTime}`);
    
    res.json({
      ok: true,
      synced,
      skipped,
      errors: errors.length,
      errorDetails: errors,
      total: calls.length,
      uniqueSessions: uniqueCalls.size,
      lastSyncTime,
      duration: `${duration}ms`
    });
    
  } catch (e) {
    const duration = Date.now() - startTime;
    console.error(`❌ RINGCENTRAL SYNC FAILED after ${duration}ms`);
    console.error(`   Error:`, e?.response?.data || e.message);
    
    res.status(500).json({
      ok: false,
      error: e.response?.data || e.message,
      synced,
      skipped,
      errors: errors.length
    });
  }
});

app.get("/test/ringcentral/mapping", async (req, res) => {
  try {
    console.log(`🔍 Testing RingCentral → Salesforce mapping...`);

    // Get Salesforce and RingCentral auth
    const sfTok = await getSfToken();
    const rcAuth = await getRcToken();
    const callLogResponse = await axios.get(
      `${process.env.RC_SERVER}/restapi/v1.0/account/~/call-log`,
      {
        params: {
          dateFrom: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
          perPage: 5,
          view: 'Detailed'
        },
        headers: { 'Authorization': `Bearer ${rcAuth.access_token}` },
        timeout: 15000
      }
    );

    const calls = callLogResponse.data.records || [];

    console.log(`📊 Found ${calls.length} calls`);

    // Map each call to show owner assignment
    const mappedCalls = await Promise.all(calls.map(async (call) => {
      const salesRepName = getSalesRepNameFromCall(call);
      const extension = getExtensionFromCall(call);
      let ownerId = null;
      let ownerName = null;

      if (salesRepName) {
        ownerId = await lookupUserByName(salesRepName, sfTok);
        ownerName = salesRepName;
      }

      if (!ownerId) {
        ownerId = extractUserId(sfTok.id);
        ownerName = '(OAuth User - Default)';
      }

      return {
        sessionId: call.sessionId,
        direction: call.direction,
        from: call.from.name || call.from.phoneNumber,
        to: call.to.name || call.to.phoneNumber,
        fromExtensionNumber: call.from?.extensionNumber || null,
        fromExtensionId: call.from?.extensionId || null,
        toExtensionNumber: call.to?.extensionNumber || null,
        toExtensionId: call.to?.extensionId || null,
        legsCount: call.legs?.length || 0,
        firstLegToName: call.legs?.[0]?.to?.name || null,
        firstLegToExtensionNumber: call.legs?.[0]?.to?.extensionNumber || null,
        firstLegToExtensionId: call.legs?.[0]?.to?.extensionId || null,
        salesRepName,
        extension,
        ownerAssignment: {
          ownerId,
          ownerName
        },
        rawCall: call
      };
    }));

    res.json({
      ok: true,
      summary: {
        totalCalls: calls.length
      },
      mappedCalls
    });

  } catch (e) {
    console.error(`❌ Mapping test failed:`, e.message);
    res.status(500).json({
      ok: false,
      error: e.message,
      details: e.response?.data
    });
  }
});

// Schedule sync to run every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  console.log('\n⏰ SCHEDULED SYNC TRIGGERED');
  try {
    // Make internal request to the sync endpoint
    const syncUrl = `http://localhost:${process.env.PORT || 3000}/sync/ringcentral`;
    await axios.get(syncUrl);
  } catch (err) {
    console.error('❌ Scheduled sync failed:', err.message);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server listening on :${port}`);
  console.log('📅 Scheduled RingCentral sync: Every 15 minutes');
});