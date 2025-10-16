// server.js - VISOR Custody History Monitor
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
        
        if (!/^[a-f0-9-]{36}$/i.test(iicId)) {
            return res.status(400).json({ error: 'Invalid IIC ID format' });
        }
        
        console.log(`[${new Date().toISOString()}] Fetching custody history for IIC ID: ${iicId}`);
        
        // Step 1: Load the main page to establish session
        const pageUrl = `https://visor.oregon.gov/iic-info?iicid=${iicId}`;
        const pageResponse = await fetch(pageUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        
        // Extract cookies from the initial page load
        const cookies = pageResponse.headers.raw()['set-cookie'];
        const cookieHeader = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
        
        console.log('Page loaded, cookies obtained');
        
        // Step 2: Call the GetFormFieldValues API that the page calls
        const apiUrl = 'https://visor.oregon.gov/PortalConnectorMvc/Services/Data/GetFormFieldValues';
        
        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': pageUrl,
                'Origin': 'https://visor.oregon.gov',
                'Cookie': cookieHeader
            },
            body: JSON.stringify({
                controlDataId: '05961a64-abec-4cc9-8946-9e376699b0e9',
                recordId: iicId,
                logicalName: 'idoc_offender',
                formId: '0a0f8f3e-3238-4e5b-a3a2-0083580416df'
            })
        });
        
        console.log(`API response status: ${apiResponse.status}`);
        
        if (!apiResponse.ok) {
            const errorText = await apiResponse.text();
            console.error(`API error: ${errorText}`);
            throw new Error(`API returned status ${apiResponse.status}`);
        }
        
        const apiData = await apiResponse.json();
        console.log('API response received');
        
        // Extract custody data from fieldResponses
        if (!apiData.fieldResponses || !Array.isArray(apiData.fieldResponses)) {
            console.error('No fieldResponses in API data');
            return res.json({
                iicId,
                records: [],
                totalRecords: 0,
                message: 'No custody history data returned from VISOR'
            });
        }
        
        // Find the subgrid with our control ID
        const subgridResponse = apiData.fieldResponses.find(fr => 
            fr.controlDataId === 'b53c668f-4840-4868-8182-1c0ac0c19dc6' &&
            fr.gridResponse &&
            fr.gridResponse.data
        );
        
        if (!subgridResponse) {
            console.error('Subgrid response not found in fieldResponses');
            console.log('Available controlDataIds:', apiData.fieldResponses.map(fr => fr.controlDataId));
            return res.json({
                iicId,
                records: [],
                totalRecords: 0,
                message: 'Custody history subgrid not found in response'
            });
        }
        
        const custodyData = subgridResponse.gridResponse.data;
        console.log(`Found ${custodyData.length} custody records`);
        
        // Process and return the data
        return res.json(processCustodyData(iicId, custodyData));
        
    } catch (error) {
        console.error('Error fetching custody history:', error);
        res.status(500).json({ 
            error: 'Failed to fetch custody history',
            details: error.message 
        });
    }
});

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

// Debug endpoint
app.get('/api/debug/:iicid', async (req, res) => {
    try {
        const iicId = req.params.iicid;
        
        // Try the API call with full details
        const pageUrl = `https://visor.oregon.gov/iic-info?iicid=${iicId}`;
        const pageResponse = await fetch(pageUrl);
        const cookies = pageResponse.headers.raw()['set-cookie'];
        const cookieHeader = cookies ? cookies.map(c => c.split(';')[0]).join('; ') : '';
        
        const apiUrl = 'https://visor.oregon.gov/PortalConnectorMvc/Services/Data/GetFormFieldValues';
        
        const apiResponse = await fetch(apiUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0',
                'Referer': pageUrl,
                'Cookie': cookieHeader
            },
            body: JSON.stringify({
                controlDataId: '05961a64-abec-4cc9-8946-9e376699b0e9',
                recordId: iicId,
                logicalName: 'idoc_offender',
                formId: '0a0f8f3e-3238-4e5b-a3a2-0083580416df'
            })
        });
        
        const status = apiResponse.status;
        const responseText = await apiResponse.text();
        
        let apiData = null;
        try {
            apiData = JSON.parse(responseText);
        } catch (e) {
            // Not JSON
        }
        
        res.json({
            iicId,
            apiStatus: status,
            apiResponseLength: responseText.length,
            hasFieldResponses: apiData && apiData.fieldResponses,
            fieldResponseCount: apiData && apiData.fieldResponses ? apiData.fieldResponses.length : 0,
            controlIds: apiData && apiData.fieldResponses ? apiData.fieldResponses.map(fr => fr.controlDataId) : [],
            responsePreview: responseText.substring(0, 500)
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
        service: 'VISOR Custody Monitor',
        version: '1.1.0'
    });
});

app.listen(PORT, () => {
    console.log(`VISOR Custody Monitor API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});