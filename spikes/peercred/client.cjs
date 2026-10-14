'use strict';
// usage: client.cjs [--fire-and-forget]   (fire-and-forget: send and exit before the reply)
const net = require('node:net');
const c = net.connect(process.env.SOCK || '/tmp/pc.sock');
c.on('connect', () => {
  c.write('hi\n');
  if (process.argv.includes('--fire-and-forget')) process.exit(0);
});
c.on('data', (d) => process.stdout.write(d));
c.on('error', (e) => console.error('client error', e.code));
