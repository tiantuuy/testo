const FIXED_UUID = '64c6e2fe-e7a8-4118-b3bc-a1ecd5b9553a'; 
const SECRET_PATH = '/your-secret-path'; 

// 错误响应模板
const API_ERROR_RESPONSE = (url, status = 404) => {
    return new Response(JSON.stringify({
        timestamp: new Date().toISOString(),
        status: status,
        error: status === 404 ? "Not Found" : "Unauthorized",
        message: `No static resource or API endpoint found for: ${url.pathname}`,
        path: url.pathname,
        service: "api-gateway-v2"
    }), {
        status: status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Server': 'nginx' }
    });
};

let 反代IP = 'yx1.9898981.xyz:8443', 启用http反代 = false, 我的http账号 = '', parsedHttpAddress = {};

export default {
    async fetch(request) {
        try {
            const url = new URL(request.url);
            if (url.pathname !== SECRET_PATH) return API_ERROR_RESPONSE(url, 404);

            const upgradeHeader = request.headers.get('Upgrade');
            if (upgradeHeader !== 'websocket') {
                return new Response(JSON.stringify({ status: "UP", version: "2.5.0-RELEASE" }), {
                    status: 200, headers: { 'Content-Type': 'application/json', 'Server': 'nginx' }
                });
            }

            // 获取参数
            await 反代参数获取(request);
            const [反代IP地址, 反代IP端口] = await 解析地址端口(反代IP);

            return await handleSPESSWebSocket(request, {
                parsedHttpAddress,
                enableHttp: 启用http反代,
                ProxyIP: 反代IP地址,
                ProxyPort: 反代IP端口
            });
        } catch (err) {
            return new Response(err.message, { status: 500 });
        }
    },
};

async function handleSPESSWebSocket(request, config) {
    const { parsedHttpAddress, enableHttp, ProxyIP, ProxyPort } = config;
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
            if (isDns && udpStreamWrite) {
                return udpStreamWrite(chunk);
            }
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
            
            // UDP 53 DNS 处理
            if (result.isUDP && result.portRemote === 53) {
                isDns = true;
                const { write } = await handleUDPOutBound(serverWS, vlessRespHeader);
                udpStreamWrite = write;
                udpStreamWrite(rawClientData);
                return;
            }

            // TCP 连接建立
            try {
                let tcpSocket;
                if (enableHttp) {
                    tcpSocket = await httpConnect(result.addressType, result.addressRemote, result.portRemote, parsedHttpAddress);
                } else {
                    // 如果不是 443 端口，尝试通过反代 IP 转发，否则直连
                    const target = (result.portRemote === 443) ? { hostname: result.addressRemote, port: 443 } : { hostname: ProxyIP, port: ProxyPort };
                    tcpSocket = await connect(target);
                }
                
                remoteSocket = tcpSocket;
                const writer = tcpSocket.writable.getWriter();
                await writer.write(rawClientData);
                writer.releaseLock();

                pipeRemoteToWebSocket(remoteSocket, serverWS, vlessRespHeader);
            } catch (err) {
                serverWS.close(1011, 'Connect Failed');
            }
        },
        close() {
            if (remoteSocket) remoteSocket.close();
        }
    })).catch(() => {
        if (remoteSocket) remoteSocket.close();
        if (serverWS.readyState === 1) serverWS.close();
    });

    return new Response(null, { status: 101, webSocket: clientWS });
}

// 高效转发：解决 CPU 限制
async function pipeRemoteToWebSocket(remoteSocket, ws, vlessHeader) {
    const reader = remoteSocket.readable.getReader();
    let headerSent = false;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (ws.readyState !== 1) break;

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
    } finally {
        reader.releaseLock();
        if (ws.readyState === 1) ws.close();
    }
}

async function handleUDPOutBound(webSocket, vlessHeader) {
    let headerSent = false;
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            // 简单的 UDP 长度切分
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
                method: 'POST',
                headers: { 'content-type': 'application/dns-message' },
                body: chunk,
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

    const writer = transformStream.writable.getWriter();
    return { write(chunk) { writer.write(chunk); } };
}

// 核心工具函数
function createWebSocketReadableStream(ws, earlyDataHeader) {
    return new ReadableStream({
        start(controller) {
            ws.addEventListener('message', e => controller.enqueue(e.data));
            ws.addEventListener('close', () => controller.close());
            ws.addEventListener('error', e => controller.error(e));
            if (earlyDataHeader) {
                try {
                    const decoded = atob(earlyDataHeader.replace(/-/g, '+').replace(/_/g, '/'));
                    controller.enqueue(Uint8Array.from(decoded, c => c.charCodeAt(0)));
                } catch (e) {}
            }
        }
    });
}

function parseVLESSHeader(buffer) {
    const view = new DataView(buffer);
    if (buffer.byteLength < 24) return { hasError: true, message: 'Short Header' };
    const uuid = formatUUID(new Uint8Array(buffer.slice(1, 17)));
    if (uuid !== FIXED_UUID) return { hasError: true, message: 'Invalid User' };
    
    const optionsLength = view.getUint8(17);
    const command = view.getUint8(18 + optionsLength);
    let offset = 19 + optionsLength;
    const port = view.getUint16(offset);
    offset += 2;
    const addressType = view.getUint8(offset++);
    let address = '';
    if (addressType === 1) {
        address = Array.from(new Uint8Array(buffer.slice(offset, offset + 4))).join('.');
        offset += 4;
    } else if (addressType === 2) {
        const len = view.getUint8(offset++);
        address = new TextDecoder().decode(buffer.slice(offset, offset + len));
        offset += len;
    }
    return { hasError: false, addressRemote: address, portRemote: port, rawDataIndex: offset, vlessVersion: new Uint8Array([view.getUint8(0)]), isUDP: command === 2, addressType };
}

function formatUUID(bytes) {
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

import { connect } from 'cloudflare:sockets';

async function 解析地址端口(proxyIP) {
    const parts = proxyIP.split(':');
    return [parts[0], parseInt(parts[1]) || 443];
}

async function 反代参数获取(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const searchParams = url.searchParams;

    // 检查是否启用 HTTP 代理路径或参数
    let httpMatch = path.match(/\/http=?(.*)/i);
    if (httpMatch || searchParams.has('http')) {
        启用http反代 = true;
        我的http账号 = httpMatch ? httpMatch[1] : searchParams.get('http');
        if (我的http账号) {
            parsedHttpAddress = await 获取账号信息(我的http账号);
        }
    }
}

async function 获取账号信息(address) {
    const lastAtIndex = address.lastIndexOf("@");
    let [latter, former] = lastAtIndex === -1 ? [address, undefined] : [address.substring(lastAtIndex + 1), address.substring(0, lastAtIndex)];
    let username, password, hostname, port;
    if (former) [username, password] = former.split(":");
    const latters = latter.split(":");
    hostname = latters[0];
    port = parseInt(latters[1]) || 80;
    return { username, password, hostname, port };
}

async function httpConnect(addressType, addressRemote, portRemote, proxy) {
    const sock = await connect({ hostname: proxy.hostname, port: proxy.port });
    let req = `CONNECT ${addressRemote}:${portRemote} HTTP/1.1\r\nHost: ${addressRemote}:${portRemote}\r\n`;
    if (proxy.username && proxy.password) {
        req += `Proxy-Authorization: Basic ${btoa(proxy.username + ":" + proxy.password)}\r\n`;
    }
    req += `\r\n`;
    const writer = sock.writable.getWriter();
    await writer.write(new TextEncoder().encode(req));
    writer.releaseLock();

    const reader = sock.readable.getReader();
    const { value } = await reader.read();
    const resp = new TextDecoder().decode(value);
    reader.releaseLock();

    if (resp.includes('200')) return sock;
    throw new Error('HTTP Connect Failed');
}
