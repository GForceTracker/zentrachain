'use strict';

const { makeFaviconPng } = require('../brand-png');

module.exports = (req, res) => {
  try {
    const url = new URL(req.url, 'https://zentrachain.vercel.app');
    const requested = Number(url.searchParams.get('size') || 192);
    const size = [32, 180, 192].includes(requested) ? requested : 192;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(Buffer.from(makeFaviconPng(size)));
  } catch (error) {
    console.error('ZentraChain browser icon failed:', error);
    res.statusCode = 500;
    res.setHeader('Cache-Control', 'no-store');
    res.end('Favicon unavailable');
  }
};