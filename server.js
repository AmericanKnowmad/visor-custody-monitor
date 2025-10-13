// server.js - Simple proxy server to fetch VISOR data
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for all origins (your frontend can call this)
app.use(cors());
app.use(express.json());

// Serve the frontend HTML
app.use(express.static('public'));

// Proxy endpoint to fetch VISOR data
app.get('/api/custody-history/:iicid', async (req, res) => {
    try {
        const iicId = req.params.iicid;
        
        // Validate IIC ID format
        if (!/^[a-f0-9-]{36}$/i.test(iicId)) {
            return res.status(400).json({ error: 'Invalid IIC ID format' });
        }
        
        console.log(`Fetching custody history for IIC ID: ${iicId}`);
        
        // Fetch the VISOR page
        const visorUrl = `https://visor.oregon.gov/iic-info?iicid=${iicId}`;
        const response = await fetch(visorUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        
        if (!response.ok) {
            throw new Error(`VISOR returned status ${response.status}`);
        }
        
        const html = await response.text();
        
        // Extract the custody data from the HTML
        const match = html.match(/"gridResponse":\{"displayMessage":null,"errorMessage":null,"showMessage":false,"data":(\[.*?\]),"exportFileName"/);
        
        if (!match) {
            return res.json({
                iicId,
                records: [],
                message: 'No custody history found for this IIC ID'
            });
        }
        
        const custodyData = JSON.parse(match[1]);
        
        // Sort by intake date
        custodyData.sort((a, b) => {
            const dateA = new Date(a.savin_intakedate || 0);
            const dateB = new Date(b.savin_intakedate || 0);
            return dateA - dateB;
        });
        
        // Calculate gaps between custody periods
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
        
        res.json({
            iicId,
            totalRecords: custodyData.length,
            records: processedRecords,
            retrievedAt: new Date().toISOString(),
            currentlyInCustody: custodyData.length > 0 && !custodyData[custodyData.length - 1].idoc_releasedate
        });
        
    } catch (error) {
        console.error('Error fetching custody history:', error);
        res.status(500).json({ 
            error: 'Failed to fetch custody history',
            details: error.message 
        });
    }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
    console.log(`VISOR Custody Monitor API running on port ${PORT}`);
});