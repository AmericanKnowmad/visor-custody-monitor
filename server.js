// server.js - Improved version with better debugging
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Proxy endpoint to fetch VISOR data
app.get('/api/custody-history/:iicid', async (req, res) => {
    try {
        const iicId = req.params.iicid;
        
        // Validate IIC ID format
        if (!/^[a-f0-9-]{36}$/i.test(iicId)) {
            return res.status(400).json({ error: 'Invalid IIC ID format' });
        }
        
        console.log(`[${new Date().toISOString()}] Fetching custody history for IIC ID: ${iicId}`);
        
        // Fetch the VISOR page
        const visorUrl = `https://visor.oregon.gov/iic-info?iicid=${iicId}`;
        const response = await fetch(visorUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            }
        });
        
        if (!response.ok) {
            console.error(`VISOR returned status ${response.status}`);
            throw new Error(`VISOR returned status ${response.status}`);
        }
        
        const html = await response.text();
        console.log(`Received ${html.length} bytes from VISOR`);
        
        // Try multiple extraction patterns
        let custodyData = null;
        
        // Pattern 1: Original pattern
        let match = html.match(/"gridResponse":\s*\{\s*"displayMessage"\s*:\s*null\s*,\s*"errorMessage"\s*:\s*null\s*,\s*"showMessage"\s*:\s*false\s*,\s*"data"\s*:\s*(\[.*?\])\s*,\s*"exportFileName"/s);
        
        if (!match) {
            // Pattern 2: More flexible pattern
            match = html.match(/"data"\s*:\s*(\[\{[^}]*"idoc_name"[^}]*\}[^\]]*\])/);
        }
        
        if (!match) {
            // Pattern 3: Look for the control ID we know exists
            match = html.match(/"controlDataId"\s*:\s*"b53c668f-4840-4868-8182-1c0ac0c19dc6"[^}]*"gridResponse"[^}]*"data"\s*:\s*(\[[^\]]*\])/);
        }
        
        if (!match) {
            console.error('Failed to extract custody data with any pattern');
            console.log('HTML snippet:', html.substring(0, 500));
            
            // Check if the page loaded at all
            if (html.includes('idoc_name')) {
                console.log('Found idoc_name in HTML, but regex failed');
            }
            
            return res.json({
                iicId,
                records: [],
                message: 'No custody history found. The VISOR page may have changed format.',
                debug: {
                    htmlLength: html.length,
                    hasIdocName: html.includes('idoc_name'),
                    hasGridResponse: html.includes('gridResponse')
                }
            });
        }
        
        try {
            custodyData = JSON.parse(match[1]);
            console.log(`Successfully extracted ${custodyData.length} custody records`);
        } catch (parseError) {
            console.error('Failed to parse custody data:', parseError);
            return res.status(500).json({ 
                error: 'Failed to parse custody data',
                details: parseError.message 
            });
        }
        
        // Sort by intake date
        custodyData.sort((a, b) => {
            const dateA = new Date(a.savin_intakedate || 0);
            const dateB = new Date(b.savin_intakedate || 0);
            return dateA - dateB;
        });
        
        // Process records and calculate gaps
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
            
            // Calculate gap to next record
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
        
        const result = {
            iicId,
            totalRecords: custodyData.length,
            records: processedRecords,
            retrievedAt: new Date().toISOString(),
            currentlyInCustody: custodyData.length > 0 && !custodyData[custodyData.length - 1].idoc_releasedate
        };
        
        console.log(`Returning ${processedRecords.length} total items (including gaps)`);
        res.json(result);
        
    } catch (error) {
        console.error('Error fetching custody history:', error);
        res.status(500).json({ 
            error: 'Failed to fetch custody history',
            details: error.message 
        });
    }
});

// Debug endpoint to see raw HTML
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
        
        // Find the relevant section
        const startIdx = html.indexOf('"gridResponse"');
        const endIdx = html.indexOf('"formData"', startIdx);
        
        const snippet = startIdx !== -1 && endIdx !== -1 
            ? html.substring(startIdx, endIdx + 200)
            : 'Grid response section not found';
        
        res.json({
            iicId,
            htmlLength: html.length,
            snippet,
            hasGridResponse: html.includes('gridResponse'),
            hasData: html.includes('"data":['),
            hasIdocName: html.includes('idoc_name')
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'VISOR Custody Monitor'
    });
});

app.listen(PORT, () => {
    console.log(`VISOR Custody Monitor API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
```

