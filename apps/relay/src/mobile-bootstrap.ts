export function mobileBootstrapResponse(): Response {
  return new Response(MOBILE_BOOTSTRAP_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store, max-age=0",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
        "img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'",
    },
  });
}

const MOBILE_BOOTSTRAP_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Open Bezi Buddy</title>
  <style>
    :root{color-scheme:dark;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#090d0b;color:#e0eee5}
    main{width:min(34rem,calc(100% - 3rem));border:1px solid #40534a;background:#0f1713;padding:2rem}
    .prompt{color:#66e8a5;font-weight:700}.muted{color:#92aa9b;line-height:1.6}
    a{display:block;margin-top:1.5rem;padding:1rem;text-align:center;background:#66e8a5;color:#0f1813;font-weight:800;text-decoration:none}
    #error{color:#ff7777}
  </style>
</head>
<body><main>
  <div class="prompt">&gt; android bootstrap_</div>
  <h1>Open Bezi Buddy</h1>
  <p class="muted">This private link connects the installed Android app to your current Windows session.</p>
  <p id="error" hidden>The setup payload is missing. Relaunch Bezi Buddy on the PC.</p>
  <a id="open" href="#">OPEN APP &gt;</a>
</main>
<script>
  const payload = new URLSearchParams(location.hash.slice(1)).get('payload');
  const button = document.getElementById('open');
  if (payload) {
    button.href = 'beziremote://bootstrap?payload=' + encodeURIComponent(payload);
  } else {
    button.hidden = true;
    document.getElementById('error').hidden = false;
  }
</script></body></html>`;
