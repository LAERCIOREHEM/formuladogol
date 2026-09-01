function encodeBase64Url(bytes) {
  let binary = '';
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const value of view) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export class PushState {
  constructor(state) {
    this.state = state;
  }

  async getOrCreateVapid() {
    const existing = await this.state.storage.get('vapid');
    if (existing && existing.publicKey && existing.privateKey) return existing;

    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    );
    const publicRaw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    const privateJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const vapid = {
      subject: 'https://formuladogol.com.br',
      publicKey: encodeBase64Url(publicRaw),
      privateKey: privateJwk.d,
      createdAt: new Date().toISOString()
    };
    if (!vapid.privateKey) throw new Error('Falha ao gerar chave VAPID privada.');
    await this.state.storage.put('vapid', vapid);
    return vapid;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/vapid') {
      const vapid = await this.getOrCreateVapid();
      return Response.json(vapid);
    }
    if (url.pathname === '/health') {
      const vapid = await this.getOrCreateVapid();
      return Response.json({ ok: true, vapidReady: Boolean(vapid.publicKey) });
    }
    return new Response('Not found', { status: 404 });
  }
}
