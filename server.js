const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helper function to extract custody data from HTML
function extractCustodyData(html) {
    console.log('Starting data extraction...');
    
    // Strategy 1: Look for the control ID followed by data array
    const controlIdPattern = /b53c668f-4840-4868-8182-1c0ac0c19dc6[\s\S]{0,1000}"data"\s*:\s*(\[[^\]]*\{[^\}]*"idoc_name"[^\}]*\}[^\]]*\])/;
    let match = html.match(controlIdPattern);
    
    if (match) {
        console.log('Strategy 1: Found data near control ID');
        try {
            return JSON.parse(match[1]);
        } catch (e) {
            console.log('Strategy 1 parse failed:', e.message);
        }
    }
    
    // Strategy 2: Look for any array containing multiple idoc_localnumber records
    const dataArrayPattern = /\[\s*\{\s*"idoc_name"\s*:\s*"[^"]+"\s*,\s*"idoc_facilityid"[\s\S]{0,500}?\}\s*(?:,\s*\{[\s\S]{0,500}?\})*\s*\]/g;
    const matches = html.match(dataArrayPattern);
    
    if (matches) {
        console.log(`Strategy 2: Found ${matches.length} potential data arrays`);
        // Find the longest one (most likely to be the full custody history)
        let longestArray = null;
        let maxLength = 0;
        
        for (const m of matches) {
            try {
                const parsed = JSON.parse(m);
                if (Array.isArray(parsed) && parsed.length > maxLength && parsed[0].idoc_name) {
                    longestArray = parsed;
                    maxLength = parsed.length;
                }
            } catch (e) {
                // Skip invalid JSON
            }
        }
        
        if (longestArray) {
            console.log(`Strategy 2: Selected array with ${longestArray.length} records`);
            return longestArray;
        }
    }
    
    // Strategy 3: Look for the escaped JSON in script tags or hidden inputs
    const escapedPattern = /\{&quot;idoc_name&quot;:&quot;[^&]+&quot;[\s\S]{0,500}?\}/g;
    const escapedMatches = html.match(escapedPattern);
    
    if (escapedMatches) {
        console.log(`Strategy 3: Found ${escapedMatches.length} escaped JSON objects`);
        try {
            // Unescape and parse
            const unescaped = escapedMatches.map(m => 
                m.replace(/&quot;/g, '"')
                 .replace(/&amp;/g, '&')
            );
            
            const records = unescaped.map(u => JSON.parse(u)).filter(r => r.idoc_name);
            
            if (records.length > 0) {
                console.log(`Strategy 3: Extracted ${records.length} records from escaped JSON`);
                return records;
            }
        } catch (e) {
            console.log('Strategy 3 parse failed:', e.message);
        }
    }
    
    // Strategy 4: Find the GetFormFieldValues response (the API response embedded in HTML)
    const formFieldPattern = /"formData"\s*:\s*"\{([^"]*(?:\\.[^"]*)*)"/;
    match = html.match(formFieldPattern);
    
    if (match) {
        console.log('Strategy 4: Found formData field');
        try {
            // Unescape the nested JSON
            const unescaped = match[1]
                .replace(/\\"/g, '"')
                .replace(/\\\\/g, '\\');
            
            const formData = JSON.parse('{' + unescaped + '}');
            
            // Look for any field that might contain the subgrid data
            console.log('FormData keys:', Object.keys(formData));
        } catch (e) {
            console.log('Strategy 4 parse failed:', e.message);
        }
    }
    
    console.log('All extraction strategies failed');
    return null;
}

app.get('/api/custody-history/:iicid', async (req, res) => {
    try {
        const iicId = req.params.iicid;
        
        if (!/^[a-f0-9-]{36}$/i.test(iicId)) {
            return res.status(400).json({ error: 'Invalid IIC ID format' });
        }
        
        console.log(`[${new Date().toISOString()}] Fetching custody history for IIC ID: ${iicId}`);
        
        const visorUrl = `https://visor.oregon.gov/iic-info?iicid=${iicId}`;
        const response = await fetch(visorUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            }
        });
        
        if (!response.ok) {
            throw new Error(`VISOR returned status ${response.status}`);
        }
        
        const html = await response.text();
        console.log(`Received ${html.length} bytes from VISOR`);
        
        const custodyData = extractCustodyData(html);
        
        if (!custodyData || custodyData.length === 0) {
            return res.json({
                iicId,
                records: [],
                message: 'No custody history found for this IIC ID'
            });
        }
        
        // Sort by intake date
        custodyData.sort((a, b) => {
            const dateA = new Date(a.savin_intakedate || 0);
            const dateB = new Date(b.savin_intakedate || 0);
            return dateA - dateB;
        });
        
        // Process records
        const processedRecords = [];
        for (let i = 0; i < custodyData.length; i++) {
            const record = custodyData[i];
            
            processedRecords.push({
                type: 'CUSTODY',
                offenderNumber: record.idoc_name,
                facility: record.idoc_facilityid,
                intakeDate: record.savin_intakedate,
                releaseDate: record.idoc_releasedate,
                currentlyInCustody: !record.idoc_releasedate
            });
            
            // Calculate gap
            if (i < custodyData.length - 1 && record.idoc_releasedate) {
                const nextRecord = custodyData[i + 1];
                if (nextRecord.savin_intakedate) {
                    const releaseTime = new Date(record.idoc_releasedate);
                    const nextIntakeTime = new Date(nextRecord.savin_intakedate);
                    const gapMs = nextIntakeTime - releaseTime;
                    
                    if (gapMs > 0) {
                        const days = Math.floor(gapMs / (1000 * 60 * 60 * 24));
                        const hours = Math.floor((gapMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
                        const minutes = Math.floor((gapMs % (1000 * 60 * 60)) / (1000 * 60));
                        
                        processedRecords.push({
                            type: 'OUT_OF_CUSTODY',
                            durationMs: gapMs,
                            days,
                            hours,
                            minutes,
                            startDate: record.idoc_releasedate,
                            endDate: nextRecord.savin_intakedate
                        });
                    }
                }
            }
        }
        
        console.log(`Successfully processed ${custodyData.length} custody records`);
        
        res.json({
            iicId,
            totalRecords: custodyData.length,
            records: processedRecords,
            retrievedAt: new Date().toISOString(),
            currentlyInCustody: custodyData.length > 0 && !custodyData[custodyData.length - 1].idoc_releasedate
        });
        
    } catch (error) {
        console.error('Error:', error);
        res.status(500).json({ 
            error: 'Failed to fetch custody history',
            details: error.message 
        });
    }
});

// Super detailed debug endpoint
app.get('/api/debug/:iicid', async (req, res) => {
    try {
        const iicId = req.params.iicid;
        const visorUrl = `https://visor.oregon.gov/iic-info?iicid=${iicId}`;
        
        const response = await fetch(visorUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        const html = await response.text();
        
        // Find where idoc_name appears
        const idocNameIndices = [];
        let idx = html.indexOf('idoc_name');
        while (idx !== -1 && idocNameIndices.length < 5) {
            idocNameIndices.push(idx);
            idx = html.indexOf('idoc_name', idx + 1);
        }
        
        // Get snippets around each occurrence
        const snippets = idocNameIndices.map((index, i) => ({
            occurrence: i + 1,
            position: index,
            before: html.substring(Math.max(0, index - 100), index),
            match: html.substring(index, index + 50),
            after: html.substring(index + 50, Math.min(html.length, index + 150))
        }));
        
        res.json({
            iicId,
            htmlLength: html.length,
            idocNameOccurrences: idocNameIndices.length,
            snippets,
            hasControlId: html.includes('b53c668f-4840-4868-8182-1c0ac0c19dc6')
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'VISOR Custody Monitor'
    });
});

app.listen(PORT, () => {
    console.log(`VISOR Custody Monitor API running on port ${PORT}`);
});

