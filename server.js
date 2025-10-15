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
        
        // VISOR embeds the data in a JSON structure - let's find it more carefully
        let custodyData = null;
        
        // Try to find the fieldResponses with controlDataId b53c668f-4840-4868-8182-1c0ac0c19dc6
        const fieldResponsesMatch = html.match(/"fieldResponses":\s*(\[[\s\S]*?\])\s*,\s*"formData":/);
        
        if (fieldResponsesMatch) {
            console.log('Found fieldResponses section');
            try {
                const fieldResponses = JSON.parse(fieldResponsesMatch[1]);
                console.log(`Parsed ${fieldResponses.length} field responses`);
                
                // Find the one with our control ID
                const subgridResponse = fieldResponses.find(fr => 
                    fr.controlDataId === 'b53c668f-4840-4868-8182-1c0ac0c19dc6' &&
                    fr.gridResponse
                );
                
                if (subgridResponse && subgridResponse.gridResponse.data) {
                    custodyData = subgridResponse.gridResponse.data;
                    console.log(`Found custody data: ${custodyData.length} records`);
                }
            } catch (parseError) {
                console.error('Error parsing fieldResponses:', parseError);
            }
        }
        
        // Fallback: Try original pattern
        if (!custodyData) {
            console.log('Trying fallback extraction patterns...');
            
            // Pattern: Look for any array with idoc_name entries
            const dataArrayMatch = html.match(/\[(\{"idoc_name"[^}]+\}(?:,\{"idoc_name"[^}]+\})*)\]/);
            if (dataArrayMatch) {
                try {
                    custodyData = JSON.parse('[' + dataArrayMatch[1] + ']');
                    console.log(`Fallback pattern found ${custodyData.length} records`);
                } catch (e) {
                    console.error('Fallback parse failed:', e);
                }
            }
        }
        
        if (!custodyData || custodyData.length === 0) {
            console.error('No custody data extracted');
            return res.json({
                iicId,
                records: [],
                message: 'No custody history found for this IIC ID',
                debug: {
                    htmlLength: html.length,
                    hasFieldResponses: html.includes('fieldResponses'),
                    hasIdocName: html.includes('idoc_name'),
                    hasControlId: html.includes('b53c668f-4840-4868-8182-1c0ac0c19dc6')
                }
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

// Enhanced debug endpoint
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
        
        // Find fieldResponses section
        const fieldResponsesIdx = html.indexOf('"fieldResponses"');
        const formDataIdx = html.indexOf('"formData"', fieldResponsesIdx);
        
        const snippet = fieldResponsesIdx !== -1 && formDataIdx !== -1
            ? html.substring(fieldResponsesIdx, Math.min(formDataIdx, fieldResponsesIdx + 2000))
            : 'fieldResponses section not found';
        
        res.json({
            iicId,
            htmlLength: html.length,
            snippet,
            hasFieldResponses: html.includes('fieldResponses'),
            hasGridResponse: html.includes('gridResponse'),
            hasData: html.includes('"data":['),
            hasIdocName: html.includes('idoc_name'),
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
