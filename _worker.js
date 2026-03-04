import { connect } from 'cloudflare:sockets';

const _cQndIdPFBwdwdfPS = '/t-vip-9026/auth-888999';
const _rcHzgeggsXmfUWrW = '56892533-7dad-324a-b0e8-51040d0d04ad';
const _JeHxQnQHudDPWbyN = 'ProxyIP.FR.CMLiussss.net';
const _JsGTkSTJgBtAOVZl = 443;

export default {
    async fetch(request) {
        const url = new URL(request.url);
        
        
        if (url.pathname !== _cQndIdPFBwdwdfPS) {
            return new Response('Not Found', { status: 404 });
        }
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response(JSON.stringify({ status: "UP", version: "2.4.2" }), { status: 200 });
        }

        const [client, server] = Object.values(new WebSocketPair());
        server.accept();

        
        handleVLESS(server).catch(err => console.error("VLESS Fatal:", err.message));

        return new Response(null, {
            status: 101,
            webSocket: client,
        });
    }
};

async function handleVLESS(ws) {
    let remoteSocket = null;
    let vlessResponseHeader = null;

    
    const wsStream = new ReadableStream({
        start(controller) {
            ws.addEventListener('message', (event) => {
                controller.enqueue(event.data);
            });
            ws.addEventListener('close', () => controller.close());
            ws.addEventListener('error', () => controller.error(new Error('WS Error')));
        }
    });

    const reader = wsStream.getReader();

    try {
        
        const { value: firstChunk, done } = await reader.read();
        if (done) return;

        const parsed = parseVLESSHeader(firstChunk);
        if (parsed.hasError) throw new Error(parsed.message);

        vlessResponseHeader = new Uint8Array([parsed.vlessVersion[0], 0]);
        const initialData = firstChunk.slice(parsed.rawDataIndex);

        
        
        try {
            remoteSocket = await connect({ hostname: parsed.addressRemote, port: parsed.portRemote });
        } catch (e) {
            console.log(`Direct connect failed, trying proxy: ${_JeHxQnQHudDPWbyN}`);
            remoteSocket = await connect({ hostname: _JeHxQnQHudDPWbyN, port: _JsGTkSTJgBtAOVZl });
        }

        const writer = remoteSocket.writable.getWriter();
        await writer.write(initialData);
        writer.releaseLock();

        
        
        
        const remoteToWs = async () => {
            const remoteReader = remoteSocket.readable.getReader();
            let isFirst = true;
            try {
                while (true) {
                    const { value, done } = await remoteReader.read();
                    if (done) break;
                    if (isFirst) {
                        
                        const combined = new Uint8Array(vlessResponseHeader.length + value.byteLength);
                        combined.set(vlessResponseHeader, 0);
                        combined.set(new Uint8Array(value), vlessResponseHeader.length);
                        ws.send(combined);
                        isFirst = false;
                    } else {
                        ws.send(value);
                    }
                }
            } finally {
                remoteReader.releaseLock();
                ws.close();
            }
        };

        
        const wsToRemote = async () => {
            try {
                
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    const writer = remoteSocket.writable.getWriter();
                    await writer.write(value);
                    writer.releaseLock();
                }
            } finally {
                if (remoteSocket) remoteSocket.close();
            }
        };

        
        await Promise.all([remoteToWs(), wsToRemote()]);

    } catch (err) {
        console.error("Handler Error:", err.message);
        ws.close();
    } finally {
        if (remoteSocket) remoteSocket.close();
    }
}


function parseVLESSHeader(buffer) {
    const view = new DataView(buffer instanceof ArrayBuffer ? buffer : buffer.buffer);
    if (buffer.byteLength < 24) return { hasError: true, message: 'Header too short' };

    const version = new Uint8Array(buffer.slice(0, 1));
    
    
    const uuidBytes = new Uint8Array(buffer.slice(1, 17));
    const uuidHex = Array.from(uuidBytes).map(b => b.toString(16).padStart(2, '0')).join('');
    if (uuidHex !== _rcHzgeggsXmfUWrW.replace(/-/g, '')) {
        return { hasError: true, message: 'Unauthorized UUID' };
    }

    const addonsLen = view.getUint8(17);
    let offset = 18 + addonsLen;
    
    const command = view.getUint8(offset); 
    offset++;
    
    const port = view.getUint16(offset);
    offset += 2;

    const addressType = view.getUint8(offset);
    offset++;

    let address = '';
    if (addressType === 1) { 
        address = Array.from(new Uint8Array(buffer.slice(offset, offset + 4))).join('.');
        offset += 4;
    } else if (addressType === 2) { 
        const len = view.getUint8(offset);
        offset++;
        address = new TextDecoder().decode(buffer.slice(offset, offset + len));
        offset += len;
    } else if (addressType === 3) { 
        const ipv6 = [];
        for (let i = 0; i < 8; i++) {
            ipv6.push(view.getUint16(offset).toString(16));
            offset += 2;
        }
        address = ipv6.join(':');
    }

    return {
        hasError: false,
        addressRemote: address,
        portRemote: port,
        vlessVersion: version,
        rawDataIndex: offset
    };
}
