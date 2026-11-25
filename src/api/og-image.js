'use strict';

const { makeOgImagePng } = require('../brand-png');

module.exports = (req, res) => {
  try {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(Buffer.from(makeOgImagePng()));
  } catch (error) {
    console.error('ZentraChain social preview image failed:', error);
    res.statusCode = 500;
    res.setHeader('Cache-Control', 'no-store');
    res.end('Preview image unavailable');
  }
};