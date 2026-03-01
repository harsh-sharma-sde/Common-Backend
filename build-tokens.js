/**
 * DESIGN SYSTEM TOKEN SERVICE (V1)
 * * Purpose: Centralized distribution of design tokens to ensure 
 * brand consistency across micro-frontends and platforms.
 */

const express = require('express');
const cors = require('cors'); // Middleware to handle Cross-Origin Resource Sharing
const app = express();

// SECURITY & SCALABILITY: 
// In production, restrict origin to known internal domains (e.g., *.company.com)
// to prevent unauthorized third-party apps from scraping your brand identity.
app.use(cors()); 

/**
 * GET /api/v1/tokens/:brandId
 * * Returns semantic and primitive tokens for a specific brand context.
 * This enables "Runtime Theming" where the UI can adapt without a rebuild.
 */
app.get('/api/v1/tokens/:brandId', (req, res) => {
  const { brandId } = req.params;

  // DATA MODEL: 
  // In a scaled system, this would be fetched from a Distributed Cache (Redis) 
  // or a Document DB (MongoDB/DynamoDB) rather than hardcoded.
  const tokens = {
    'brand-a': {
      colors: { 
        primary: '#007bff', // Primitive/Global token
        text: '#ffffff'     // Semantic token
      },
      spacing: { unit: '12px' }
    },
    'brand-b': {
      colors: { primary: '#28a745', text: '#ffffff' },
      spacing: { unit: '4px' }
    }
  };

  // FALLBACK STRATEGY: 
  // Always provide a 'default' or 'base' theme to prevent UI breakage 
  // if an invalid brandId is provided.
  const brandTokens = tokens[brandId] || tokens['brand-a'];

  // CACHING STRATEGY:
  // Set Cache-Control headers. Tokens don't change often, so we should 
  // leverage CDN and Browser caching to reduce server load.
  res.setHeader('Cache-Control', 'public, max-age=3600');
  
  res.json(brandTokens);
});

// MONITORING: 
// For SDE3, ensure the port is configurable via environment variables 
// for containerization (Docker/Kubernetes).
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Token Server running on port ${PORT}`));