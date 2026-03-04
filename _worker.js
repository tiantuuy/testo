const FIXED_UUID = '64c6e2fe-e7a8-4118-b3bc-a1ecd5b9553a'; 
const SECRET_PATH = '/your-secret-path'; 

// 你的反代/出口代理配置
let 反代IP = 'yx1.9898981.xyz:8443';

export default {
    async fetch(request) {
        try {
            const url = new URL(request.url);
            if (url.pathname !== SECRET_PATH) {
                return new Response('Not Found', { status: 404 });
            }

            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response(JSON.stringify({ status: "UP", fallback: 反代IP }), { status: 200 });
            }

            return await handleSPESSWebSocket(request);
        } catch (err) {
            return new Response(err.message, { status: 500 });
        }
    },
};

async function handleSPESSWebSocket(request) {
    const wsPair = new WebSocketPair();
    const [clientWS, serverWS] = Object.values(wsPair);
    serverWS.accept();

    const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';
    const wsReadable = createWebSocketReadableStream(serverWS, earlyDataHeader);
    let remoteSocket = null;
    let udpStreamWrite = null;
    let isDns = false;

    wsReadable.pipeTo(new WritableStream({
        async write(chunk) {
            if (isDns && udpStreamWrite) return udpStreamWrite(chunk);
            if (remoteSocket) {
                const writer = remoteSocket.writable.getWriter();
                await writer.write(chunk);
                writer.releaseLock();
                return;
            }
            
            const result = parseVLESSHeader(chunk);
            if (result.hasError) throw new Error(result.message);
            
            const vlessRespHeader = new Uint8Array([result.vlessVersion[0], 0]);
            const rawClientData = chunk.slice(result.rawDataIndex);
            
            if (result.isUDP && result.portRemote === 53) {
                isDns = true;
                const { write } = await handleUDPOutBound(serverWS, vlessRespHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }

            // --- 核心重试逻辑（参考原始代码方案） ---
            const [proxyHost, proxyPort] = 反代IP.split(':');

            // 定义重试函数：如果直连不通，则尝试通过代理
            async function tryConnect(useProxy = false) {
                try {
                    let socket;
                    if (useProxy) {
                        // 走 HTTP CONNECT 代理方案
                        socket = await httpConnect(result.addressRemote, result.portRemote, proxyHost, proxyPort || 8443);
                    } else {
                        // 尝试直连
                        socket = await connect({ hostname: result.addressRemote, port: result.portRemote });
                    }
                    
                    remoteSocket = socket;
                    const writer = socket.writable.getWriter();
                    await writer.write(rawClientData);
                    writer.releaseLock();

                    // 这里的 pipe 逻辑需要处理直连成功但没数据返回的情况（类似原始代码的 retry）
                    pipeRemoteToWebSocket(socket, serverWS, vlessRespHeader, async () => {
                        if (!useProxy) {
                            console.log("直连无数据，尝试切换代理...");
                            await tryConnect(true);
                        }
                    });
                } catch (err) {
                    if (!useProxy) {
                        return await tryConnect(true);
                    }
                    serverWS.close(1011, 'Connection All Failed');
                }
            }

            await tryConnect(false); // 初始尝试直连
        },
        close() { if (remoteSocket) remoteSocket.close(); }
    })).catch(() => {
        if (remoteSocket) remoteSocket.close();
        if (serverWS.readyState === 1) serverWS.close();
    });

    return new Response(null, { status: 101, webSocket: clientWS });
}

// 优化的代理连接函数
async function httpConnect(host, port, proxyHost, proxyPort) {
    const sock = await connect({ hostname: proxyHost, port: parseInt(proxyPort) });
    const req = `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Connection: Keep-Alive\r\n\r\n`;

    const writer = sock.writable.getWriter();
    await writer.write(new TextEncoder().encode(req));
    writer.releaseLock();

    const reader = sock.readable.getReader();
    const { value } = await reader.read();
    const resp = new TextDecoder().decode(value);
    reader.releaseLock();

    if (resp.includes(' 200')) return sock;
    sock.close();
    throw new Error('Proxy Handshake Failed');
}

// 转发逻辑：整合了“重试触发器”
async function pipeRemoteToWebSocket(remoteSocket, ws, vlessHeader, onNoDataFallback) {
    const reader = remoteSocket.readable.getReader();
    let headerSent = false;
    let dataReceived = false;

    try {
        // 设置一个简易的超时监测，如果 1.5 秒没收到数据且需要 fallback
        const timeout = setTimeout(() => {
            if (!dataReceived && onNoDataFallback) {
                reader.cancel(); // 终止当前读取，触发外层的 fallback
            }
        }, 1500);

        while (true) {
            const { done, value } = await reader.read();
            if (done || ws.readyState !== 1) break;

            dataReceived = true;
            clearTimeout(timeout);

            if (!headerSent) {
                const combined = new Uint8Array(vlessHeader.byteLength + value.byteLength);
                combined.set(vlessHeader, 0);
                combined.set(value, vlessHeader.byteLength);
                ws.send(combined);
                headerSent = true;
            } else {
                ws.send(value);
            }
        }
    } catch (e) {
        if (!dataReceived && onNoDataFallback) {
            await onNoDataFallback();
        }
    } finally {
        reader.releaseLock();
    }
}

// --- 其余 VLESS 解析和 DNS 逻辑保持不变 ---
import { connect } from 'cloudflare:sockets';

async function handleUDPOutBound(webSocket, vlessHeader) {
    let headerSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            for (let i = 0; i < chunk.byteLength;) {
                const len = new DataView(chunk.slice(i, i + 2).buffer).getUint16(0);
                controller.enqueue(chunk.slice(i + 2, i + 2 + len));
                i += 2 + len;
            }
        }
    });
    transformStream.readable.pipeTo(new WritableStream({
        async write(chunk) {
            const resp = await fetch('https://1.1.1.1/dns-query', {
                method: 'POST', headers: { 'content-type': 'application/dns-message' }, body: chunk,
            });
            const dnsResult = await resp.arrayBuffer();
            const udpLen = new Uint8Array([(dnsResult.byteLength >> 8) & 0xff, dnsResult.byteLength & 0xff]);
            if (webSocket.readyState === 1) {
                const out = headerSent ? [udpLen, dnsResult] : [vlessHeader, udpLen, dnsResult];
                webSocket.send(await new Blob(out).arrayBuffer());
                headerSent = true;
            }
        }
    }));
    return { write(chunk) { transformStream.writable.getWriter().write(chunk); } };
}

function createWebSocketReadableStream(ws, earlyDataHeader) {
    return new ReadableStream({
        start(controller) {
            ws.addEventListener('message', e => controller.enqueue(e.data));
            ws.addEventListener('close', () => controller.close());
            ws.addEventListener('error', e => controller.error(e));
            if (earlyDataHeader) {
                try {
                    const b64 = earlyDataHeader.replace(/-/g, '+').replace(/_/g, '/');
                    controller.enqueue(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
                } catch (e) {}
            }
        }
    });
}

function parseVLESSHeader(buffer) {
    const view = new DataView(buffer);
    if (buffer.byteLength < 24) return { hasError: true };
    const uuid = Array.from(new Uint8Array(buffer.slice(1, 17)), b => b.toString(16).padStart(2, '0')).join('');
    const formattedUuid = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
    if (formattedUuid !== FIXED_UUID) return { hasError: true };
    const optLen = view.getUint8(17);
    const cmd = view.getUint8(18 + optLen);
    let offset = 19 + optLen;
    const port = view.getUint16(offset); offset += 2;
    const type = view.getUint8(offset++);
    let address = '';
    if (type === 1) { address = Array.from(new Uint8Array(buffer.slice(offset, offset + 4))).join('.'); offset += 4; }
    else if (type === 2) { const len = view.getUint8(offset++); address = new TextDecoder().decode(buffer.slice(offset, offset + len)); offset += len; }
    return { hasError: false, addressRemote: address, portRemote: port, rawDataIndex: offset, vlessVersion: new Uint8Array([view.getUint8(0)]), isUDP: cmd === 2 };
}
