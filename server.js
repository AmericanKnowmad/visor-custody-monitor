// server.js - VISOR Custody History Monitor
// Accesses publicly available custody data from Oregon VISOR system

const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Main endpoint to get custody history
app.get('/api/custody-history/:iicid', async (req, res) => {
    try {
        const iicId = req.params.iicid;
        
        // Validate IIC ID format
        if (!/^[a-f0-9-]{36}$/i.test(iicId)) {
            return res.status(400).json({ error: 'Invalid IIC ID format' });
        }
        
        console.log(`[${new Date().toISOString()}] Fetching custody history for IIC ID: ${iicId}`);
        
        // Strategy 1: Try calling the VISOR API directly
        try {
            const apiUrl = 'https://visor.oregon.gov/PortalConnectorMvc/Services/Data/GetFormFieldValues';
            
            const apiResponse = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': `https://visor.oregon.gov/iic-info?iicid=${iicId}`,
                    'Origin': 'https://visor.oregon.gov'
                },
                body: JSON.stringify({
                    controlDataId: '05961a64-abec-4cc9-8946-9e376699b0e9',
                    recordId: iicId,
                    logicalName: 'idoc_offender'
                })
            });
            
            if (apiResponse.ok) {
                const apiData = await apiResponse.json();
                console.log('API response received');
                
                // Find the custody history in the response
                if (apiData.fieldResponses) {
                    const subgridData = apiData.fieldResponses.find(fr => 
                        fr.controlDataId === 'b53c668f-4840-4868-8182-1c0ac0c19dc6' &&
                        fr.gridResponse
                    );
                    
                    if (subgridData && subgridData.gridResponse && subgridData.gridResponse.data) {
                        const custodyData = subgridData.gridResponse.data;
                        console.log(`Found ${custodyData.length} custody records via API`);
                        
                        return res.json(processCustodyData(iicId, custodyData));
                    }
                }
            } else {
                console.log(`API returned status ${apiResponse.status}, trying HTML scraping...`);
            }
        } catch (apiError) {
            console.log('API call failed:', apiError.message, '- trying HTML scraping...');
        }
        
        // Strategy 2: Scrape the HTML page
        const visorUrl = `https://visor.oregon.gov/iic-info?iicid=${iicId}`;
        const response = await fetch(visorUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.5'
            }
        });
        
        if (!response.ok) {
            throw new Error(`VISOR returned status ${response.status}`);
        }
        
        const html = await response.text();
        console.log(`Received ${html.length} bytes from VISOR HTML page`);
        
        const custodyData = extractCustodyDataFromHTML(html);
        
        if (!custodyData || custodyData.length === 0) {
            return res.json({
                iicId,
                records: [],
                totalRecords: 0,
                message: 'No custody history found for this IIC ID'
            });
        }
        
        return res.json(processCustodyData(iicId, custodyData));
        
    } catch (error) {
        console.error('Error fetching custody history:', error);
        res.status(500).json({ 
            error: 'Failed to fetch custody history',
            details: error.message 
        });
    }
});

// Helper: Extract custody data from HTML
function extractCustodyDataFromHTML(html) {
    console.log('Attempting to extract custody data from HTML...');
    
    // Pattern 1: Look for JSON in script tags or data attributes
    const patterns = [
        // Original pattern
        /"gridResponse":\s*\{\s*"displayMessage"\s*:\s*null\s*,\s*"errorMessage"\s*:\s*null\s*,\s*"showMessage"\s*:\s*false\s*,\s*"data"\s*:\s*(\[[\s\S]*?\])\s*,\s*"exportFileName"/,
        
        // Look for data array with idoc_name
        /"data"\s*:\s*(\[\s*\{[^}]*"idoc_name"[^}]*\}[\s\S]*?\])/,
        
        // Look for fieldResponses
        /"fieldResponses"\s*:\s*\[[\s\S]*?"data"\s*:\s*(\[[\s\S]*?\])\s*,\s*"exportFileName"/,
        
        // Escaped JSON in value attributes
        /value="\{&quot;fieldResponses&quot;[\s\S]*?&quot;data&quot;:(\[[\s\S]*?\])&quot;exportFileName/
    ];
    
    for (let i = 0; i < patterns.length; i++) {
        const match = html.match(patterns[i]);
        if (match) {
            console.log(`Pattern ${i + 1} matched`);
            try {
                // Handle escaped JSON if needed
                let jsonStr = match[1];
                if (jsonStr.includes('&quot;')) {
                    jsonStr = jsonStr
                        .replace(/&quot;/g, '"')
                        .replace(/&amp;/g, '&')
                        .replace(/&lt;/g, '<')
                        .replace(/&gt;/g, '>');
                }
                
                const data = JSON.parse(jsonStr);
                if (Array.isArray(data) && data.length > 0 && data[0].idoc_name) {
                    console.log(`Successfully extracted ${data.length} records`);
                    return data;
                }
            } catch (e) {
                console.log(`Pattern ${i + 1} matched but parse failed:`, e.message);
            }
        }
    }
    
    console.log('All HTML extraction patterns failed');
    return null;
}

// Helper: Process and format custody data
function processCustodyData(iicId, custodyData) {
    // Sort by intake date
    custodyData.sort((a, b) => {
        const dateA = new Date(a.savin_intakedate || 0);
        const dateB = new Date(b.savin_intakedate || 0);
        return dateA - dateB;
    });
    
    const processedRecords = [];
    
    for (let i = 0; i < custodyData.length; i++) {
        const record = custodyData[i];
        
        // Add custody record
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
    
    console.log(`Successfully processed ${custodyData.length} custody records`);
    
    return {
        iicId,
        totalRecords: custodyData.length,
        records: processedRecords,
        retrievedAt: new Date().toISOString(),
        currentlyInCustody: custodyData.length > 0 && !custodyData[custodyData.length - 1].idoc_releasedate
    };
}

// Debug endpoint to diagnose issues
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
        
        // Search for known offender numbers that should exist
        const testNumbers = ['372556', '373583', '374810', '374836', '24005844'];
        const foundNumbers = testNumbers.map(num => ({
            number: num,
            found: html.includes(num),
            position: html.indexOf(num)
        }));
        
        // Check for key patterns
        const patterns = {
            hasFieldResponses: html.includes('fieldResponses'),
            hasGridResponse: html.includes('gridResponse'),
            hasDataArray: html.includes('"data":['),
            hasIdocName: html.includes('idoc_name'),
            hasControlId: html.includes('b53c668f-4840-4868-8182-1c0ac0c19dc6'),
            hasIntakeDate: html.includes('savin_intakedate'),
            hasReleaseDate: html.includes('idoc_releasedate')
        };
        
        // Try to find where the data actually is
        let dataLocation = null;
        const controlIdx = html.indexOf('b53c668f-4840-4868-8182-1c0ac0c19dc6');
        if (controlIdx !== -1) {
            dataLocation = {
                controlIdPosition: controlIdx,
                contextBefore: html.substring(Math.max(0, controlIdx - 200), controlIdx),
                contextAfter: html.substring(controlIdx, Math.min(html.length, controlIdx + 500))
            };
        }
        
        res.json({
            iicId,
            htmlLength: html.length,
            offenderNumbersFound: foundNumbers,
            patterns,
            dataLocation
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        service: 'VISOR Custody Monitor',
        version: '1.0.0'
    });
});

// Start server
app.listen(PORT, () => {
    console.log(`VISOR Custody Monitor API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
