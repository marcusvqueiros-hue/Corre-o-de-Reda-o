(async function () {
  var a = document.getElementById('secure');
  var port = 8443;
  try { var r = await fetch('/api/info'); var i = await r.json(); if (i.httpsPort) port = i.httpsPort; } catch (e) {}
  var url = location.protocol === 'https:' ? location.origin + '/' : 'https://' + location.hostname + ':' + port + '/';
  a.href = url;
  document.getElementById('addr').textContent = url;
})();
