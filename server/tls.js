'use strict';
// Gera uma autoridade certificadora local (CA) e um certificado de servidor com os IPs da rede.
// Quem instalar a CA no aparelho passa a confiar no servidor => Service Worker e GPS funcionam em HTTPS local.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function openssl(args, cwd) {
  return execFileSync('openssl', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
}

function ensureCerts(dataDir, ips, hostnames) {
  const dir = path.join(dataDir, 'tls');
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  try {
    if (!fs.existsSync(f('ca.pem')) || !fs.existsSync(f('ca.key'))) {
      fs.writeFileSync(f('ca.cnf'), [
        '[req]', 'distinguished_name=dn', 'x509_extensions=v3', 'prompt=no',
        '[dn]', 'CN=ELO Chat Local CA', 'O=ELO Emergency Chat',
        '[v3]', 'basicConstraints=critical,CA:TRUE', 'keyUsage=critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier=hash',
      ].join('\n'));
      openssl(['req', '-x509', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '3650', '-config', 'ca.cnf'], dir);
      try { fs.rmSync(f('server.pem')); } catch (_) {}
    }
    const sans = [...hostnames.map((h) => `DNS:${h}`), ...ips.map((i) => `IP:${i}`)].sort();
    const wanted = sans.join(',');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(f('meta.json'), 'utf8')); } catch (_) {}
    const fresh = meta.created && Date.now() - meta.created < 700 * 864e5;
    if (!(fs.existsSync(f('server.pem')) && fs.existsSync(f('server.key')) && meta.sans === wanted && fresh)) {
      fs.writeFileSync(f('server.cnf'), [
        '[req]', 'distinguished_name=dn', 'prompt=no', '[dn]', 'CN=elo.local',
      ].join('\n'));
      fs.writeFileSync(f('ext.cnf'), [
        `subjectAltName=${wanted}`, 'basicConstraints=CA:FALSE', 'keyUsage=critical,digitalSignature',
        'extendedKeyUsage=serverAuth',
      ].join('\n'));
      openssl(['req', '-new', '-nodes', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1',
        '-keyout', 'server.key', '-out', 'server.csr', '-config', 'server.cnf'], dir);
      openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
        '-out', 'server.pem', '-days', '825', '-extfile', 'ext.cnf'], dir);
      fs.writeFileSync(f('meta.json'), JSON.stringify({ sans: wanted, created: Date.now() }));
    }
    return {
      key: fs.readFileSync(f('server.key')),
      cert: fs.readFileSync(f('server.pem')),
      caPath: f('ca.pem'),
    };
  } catch (e) {
    console.warn('[tls] não foi possível gerar certificados (openssl ausente?):', (e.stderr || e.message).toString().trim());
    return null;
  }
}

module.exports = { ensureCerts };
