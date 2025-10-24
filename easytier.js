
// EasyTier Web 增强版（支持“邀请链接/二维码”与可选信令服务器发现）
class EasyTierWeb {
    constructor() {
        this.peer = null;
        this.ws = null;
        this.wsUrl = '';
        this.wsReconnectTimer = null;

        this.isConnected = false;
        this.connecting = false;
        this.startTime = null;

        this.localId = '';
        this.virtualIp = '';
        this.networkName = '';

        this.connections = new Map();
        this.knownPeers = new Set();

        // URL 参数：?network=xxx&peer=yyy
        const url = new URL(window.location.href);
        this.joinPeerId = url.searchParams.get('peer') || '';
        this.prefillNetwork = url.searchParams.get('network') || '';

        // 定时器引用
        this.uptimeInterval = null;
        this.heartbeatInterval = null;
        this.shareInterval = null;
    }

    // 连接动作
    connect(networkName, networkSecret, signalServer) {
        if (this.isConnected || this.connecting) return;
        this.connecting = true;

        this.networkName = (networkName || '').trim();
        this.wsUrl = (signalServer || '').trim();

        this.log('🔄 正在连接到网络: ' + this.networkName);
        this.updateUI();

        // 初始化 PeerJS（使用公共 PeerServer）
        this.peer = new Peer(null, {
            host: 'peerjs.92k.de',
            secure: true,
            port: 443,
            path: '/',
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:global.stun.twilio.com:3478' },
                    { urls: 'stun:stun.services.mozilla.com' }
                    // 如需 TURN，可自行添加：
                    // { urls: 'turn:your-turn-server.com:3478', username: 'user', credential: 'pass' }
                ]
            }
        });

        this.peer.on('open', (id) => {
            this.localId = id;
            this.virtualIp = this.generateVirtualIp(id);
            this.isConnected = true;
            this.connecting = false;
            this.startTime = Date.now();

            this.updateUI();
            this.log('✅ 已连接到网络');
            this.log('📍 本地 ID: ' + id);
            this.log('🌐 虚拟 IP: ' + this.virtualIp);

            // 本地发现占位（同机标签页有效）
            this.announceLocal();

            // 生成邀请链接/二维码（纯前端直连）
            this.generateShareArtifacts();

            // 可选：连接信令服务器做“网络内自动发现”
            if (this.wsUrl) this.initDiscovery();

            // 如果通过邀请链接打开，自动连向对端
            if (this.joinPeerId) {
                this.log('🔗 检测到邀请，将尝试连接: ' + this.short(this.joinPeerId));
                setTimeout(() => this.connectToPeer(this.joinPeerId), 300);
            } else {
                this.connectToKnownPeersLocal();
            }

            this.startTimers();
        });

        this.peer.on('connection', (conn) => this.handleConnection(conn));

        this.peer.on('disconnected', () => {
            this.log('⚠️ PeerJS 断开，尝试重连...');
            try { this.peer.reconnect(); } catch (e) {}
        });

        this.peer.on('close', () => this.log('🔌 PeerJS 已关闭'));

        this.peer.on('error', (err) => {
            this.log('❌ PeerJS 错误: ' + (err.message || err.type || err));
            this.connecting = false;
            this.updateUI();
        });
    }

    // 初始化 WebSocket 信令发现（可选）
    initDiscovery() {
        try {
            this.ws = new WebSocket(this.wsUrl);
        } catch (e) {
            this.log('❌ 无法连接信令服务器: ' + e.message);
            return;
        }

        this.ws.onopen = () => {
            this.log('🛰️ 信令服务器已连接');
            this.wsSend({
                type: 'join',
                network: this.networkName,
                peerId: this.localId,
                ip: this.virtualIp
            });
        };

        this.ws.onmessage = (ev) => {
            let msg = null;
            try { msg = JSON.parse(ev.data); } catch {}
            if (!msg) return;

            switch (msg.type) {
                case 'peers-list':
                    if (Array.isArray(msg.peers)) {
                        this.log(`🔍 从信令获取 ${msg.peers.length} 个节点`);
                        msg.peers.forEach(p => {
                            const pid = typeof p === 'string' ? p : p.peerId;
                            if (pid) this.connectToPeer(pid);
                        });
                    }
                    break;
                case 'peer-joined':
                    if (msg.peerId) {
                        this.log('🆕 节点加入: ' + this.short(msg.peerId));
                        this.connectToPeer(msg.peerId);
                    }
                    break;
                case 'peer-left':
                    if (msg.peerId) {
                        this.log('👋 节点离开: ' + this.short(msg.peerId));
                    }
                    break;
                case 'heartbeat-ack':
                    break;
            }
        };

        this.ws.onclose = () => {
            this.log('⚠️ 信令服务器断开');
            this.scheduleWsReconnect();
        };

        this.ws.onerror = () => {
            this.log('⚠️ 信令服务器错误');
        };
    }

    wsSend(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        }
    }

    scheduleWsReconnect() {
        if (!this.wsUrl || !this.isConnected) return;
        if (this.wsReconnectTimer) return;
        this.wsReconnectTimer = setTimeout(() => {
            this.wsReconnectTimer = null;
            this.initDiscovery();
        }, 3000);
    }

    // 处理 PeerJS 连接（含重复连接去重）
    handleConnection(conn) {
        const peerId = conn && conn.peer;
        if (!peerId) return;

        // 如果已存在一个打开的连接，关闭重复连接
        const existing = this.connections.get(peerId);
        if (existing && existing.connection && existing.connection.open) {
            this.log('ℹ️ 已存在连接，关闭重复: ' + this.short(peerId));
            try { conn.close(); } catch {}
            return;
        }

        this.log('📡 新连接: ' + this.short(peerId));

        conn.on('open', () => {
            this.connections.set(peerId, {
                connection: conn,
                lastPing: Date.now(),
                latency: 0
            });
            this.updatePeerList();

            // 发送欢迎消息与已知节点
            conn.send({
                type: 'hello',
                id: this.localId,
                ip: this.virtualIp,
                network: this.networkName,
                timestamp: Date.now(),
                knownPeers: Array.from(this.knownPeers)
            });
        });

        conn.on('data', (data) => this.handleMessage(peerId, data));

        conn.on('close', () => {
            const cur = this.connections.get(peerId);
            // 只在映射仍指向该连接时才删除，避免误删新连接
            if (cur && cur.connection === conn) {
                this.connections.delete(peerId);
                this.updatePeerList();
                this.log('📴 断开: ' + this.short(peerId));
            }
        });

        conn.on('error', (err) => {
            this.log('⚠️ 连接错误(' + this.short(peerId) + '): ' + (err && err.message ? err.message : err));
        });
    }

    // 收包
    handleMessage(peerId, data) {
        if (!data || typeof data !== 'object') return;

        switch (data.type) {
            case 'hello':
                this.log(`👋 ${this.short(peerId)} (IP: ${data.ip})`);
                this.knownPeers.add(peerId);
                if (Array.isArray(data.knownPeers)) {
                    data.knownPeers.forEach(p => this.knownPeers.add(p));
                }
                this.saveKnownPeers();
                break;

            case 'ping': {
                const c = this.connections.get(peerId);
                if (c) c.connection.send({ type: 'pong', timestamp: data.timestamp });
                break;
            }

            case 'pong': {
                const latency = Date.now() - (data.timestamp || Date.now());
                const peerData = this.connections.get(peerId);
                if (peerData) {
                    peerData.latency = latency;
                    peerData.lastPing = Date.now();
                }
                this.updatePeerList();
                break;
            }

            case 'peers-list':
                if (Array.isArray(data.peers)) {
                    data.peers.forEach(p => {
                        if (p !== this.localId) this.knownPeers.add(p);
                    });
                    this.saveKnownPeers();
                }
                break;
        }
    }

    // 连接到指定节点
    connectToPeer(peerId) {
        if (!this.peer || !peerId || peerId === this.localId) return;
        if (this.connections.has(peerId)) {
            const ex = this.connections.get(peerId);
            if (ex && ex.connection && ex.connection.open) return;
        }

        this.log('🔗 尝试连接: ' + this.short(peerId));
        try {
            const conn = this.peer.connect(peerId, { reliable: true });
            this.handleConnection(conn);
        } catch (e) {
            this.log('❌ 连接失败: ' + e.message);
        }
    }

    // 本地发现（同机多标签页）
    connectToKnownPeersLocal() {
        const key = this.storageKey();
        try {
            const peers = JSON.parse(localStorage.getItem(key) || '[]');
            peers.forEach(p => { if (p && p !== this.localId) this.connectToPeer(p); });
        } catch {}
    }

    announceLocal() {
        const key = this.storageKey();
        let peers = [];
        try { peers = JSON.parse(localStorage.getItem(key) || '[]'); } catch {}
        if (!peers.includes(this.localId)) {
            peers.push(this.localId);
            if (peers.length > 50) peers.shift();
            localStorage.setItem(key, JSON.stringify(peers));
        }
    }

    storageKey() {
        return 'easytier_network_' + (this.networkName || 'default');
    }

    // 生成邀请链接与二维码
    generateShareArtifacts() {
        const url = new URL(window.location.href);
        url.searchParams.set('network', this.networkName || 'public');
        url.searchParams.set('peer', this.localId);
        const link = url.toString();

        const linkEl = document.getElementById('shareLink');
        const sec = document.getElementById('shareSection');
        if (linkEl && sec) {
            linkEl.value = link;
            sec.style.display = 'block';
        }

        const qrEl = document.getElementById('qr');
        if (qrEl && window.QRCode) {
            if (window._qrInstance) {
                try { window._qrInstance.clear(); window._qrInstance.makeCode(link); } catch {}
            } else {
                window._qrInstance = new QRCode(qrEl, { text: link, width: 160, height: 160 });
            }
        }
    }

    // 虚拟 IP（演示用）
    generateVirtualIp(id) {
        let h = 0;
        for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
        const a = 1 + (h & 0xff);
        const b = 1 + ((h >> 8) & 0xff);
        return `10.144.${a}.${b}`;
    }

    // 定时器
    startTimers() {
        this.stopTimers();

        this.uptimeInterval = setInterval(() => {
            if (this.isConnected && this.startTime) {
                const uptime = Math.floor((Date.now() - this.startTime) / 1000);
                const hours = Math.floor(uptime / 3600).toString().padStart(2, '0');
                const minutes = Math.floor((uptime % 3600) / 60).toString().padStart(2, '0');
                const seconds = (uptime % 60).toString().padStart(2, '0');
                const el = document.getElementById('uptime');
                if (el) el.textContent = `${hours}:${minutes}:${seconds}`;
            }
        }, 1000);

        this.heartbeatInterval = setInterval(() => {
            if (this.isConnected) {
                this.connections.forEach((data) => {
                    try { data.connection.send({ type: 'ping', timestamp: Date.now() }); } catch {}
                });
            }
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.wsSend({ type: 'heartbeat' });
            }
        }, 5000);

        this.shareInterval = setInterval(() => {
            if (this.isConnected && this.connections.size > 0) {
                const list = Array.from(this.knownPeers);
                this.connections.forEach((d) => {
                    try { d.connection.send({ type: 'peers-list', peers: list }); } catch {}
                });
            }
        }, 20000);
    }

    stopTimers() {
        if (this.uptimeInterval) { clearInterval(this.uptimeInterval); this.uptimeInterval = null; }
        if (this.heartbeatInterval) { clearInterval(this.heartbeatInterval); this.heartbeatInterval = null; }
        if (this.shareInterval) { clearInterval(this.shareInterval); this.shareInterval = null; }
        if (this.wsReconnectTimer) { clearTimeout(this.wsReconnectTimer); this.wsReconnectTimer = null; }
    }

    updateUI() {
        const statusEl = document.getElementById('status');
        const localIdEl = document.getElementById('localId');
        const virtualIpEl = document.getElementById('virtualIp');
        const connectBtn = document.getElementById('connectBtn');

        if (this.isConnected) {
            if (statusEl) { statusEl.textContent = '● 在线'; statusEl.className = 'status online'; }
            if (localIdEl) localIdEl.textContent = this.localId.substring(0, 8) + '...';
            if (virtualIpEl) virtualIpEl.textContent = this.virtualIp;
            if (connectBtn) { connectBtn.textContent = '🔌 断开连接'; connectBtn.disabled = false; }

            const nn = document.getElementById('networkName');
            const ns = document.getElementById('networkSecret');
            const ss = document.getElementById('signalServer');
            if (nn) nn.disabled = true;
            if (ns) ns.disabled = true;
            if (ss) ss.disabled = true;
        } else if (this.connecting) {
            if (statusEl) { statusEl.textContent = '● 连接中...'; statusEl.className = 'status connecting'; }
            if (connectBtn) { connectBtn.textContent = '连接中...'; connectBtn.disabled = true; }
        } else {
            if (statusEl) { statusEl.textContent = '● 离线'; statusEl.className = 'status offline'; }
            if (localIdEl) localIdEl.textContent = '-';
            if (virtualIpEl) virtualIpEl.textContent = '-';
            const pc = document.getElementById('peerCount'); if (pc) pc.textContent = '0';
            const up = document.getElementById('uptime'); if (up) up.textContent = '00:00:00';
            if (connectBtn) { connectBtn.textContent = '🔌 连接网络'; connectBtn.disabled = false; }

            const nn = document.getElementById('networkName');
            const ns = document.getElementById('networkSecret');
            const ss = document.getElementById('signalServer');
            if (nn) nn.disabled = false;
            if (ns) ns.disabled = false;
            if (ss) ss.disabled = false;

            const sec = document.getElementById('shareSection');
            if (sec) sec.style.display = 'none';

            const peersEl = document.getElementById('peersContainer');
            if (peersEl) peersEl.innerHTML = '';
        }
    }

    updatePeerList() {
        const container = document.getElementById('peersContainer');
        const countEl = document.getElementById('peerCount');
        if (countEl) countEl.textContent = String(this.connections.size);

        if (!container) return;
        if (this.connections.size === 0) {
            container.innerHTML = '';
            return;
        }

        let html = '<h3 style="margin-bottom:10px; color:#666; font-size:16px;">📡 连接的节点：</h3>';
        this.connections.forEach((data, peerId) => {
            const latencyText = data.latency > 0 ? `${data.latency}ms` : '测量中...';
            html += `
                <div class="peer-item">
                    <span class="peer-id">${this.short(peerId)}</span>
                    <span class="peer-ping">延迟: ${latencyText}</span>
                </div>
            `;
        });
        container.innerHTML = html;
    }

    short(id) { return id ? id.substring(0, 12) + '...' : ''; }

    log(message) {
        const logEl = document.getElementById('log');
        const time = new Date().toLocaleTimeString();
        if (logEl) {
            logEl.textContent += `[${time}] ${message}\n`;
            logEl.scrollTop = logEl.scrollHeight;
        } else {
            console.log(message);
        }
    }

    // 断开连接
    disconnect() {
        this.connecting = false;
        this.connections.forEach(d => { try { d.connection.close(); } catch {} });
        this.connections.clear();

        if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
        if (this.peer) { try { this.peer.destroy(); } catch {} this.peer = null; }

        this.isConnected = false;
        this.startTime = null;

        this.stopTimers();
        this.updateUI();
        this.log('🔌 已断开连接');
    }
}

// 全局实例
const easytier = new EasyTierWeb();

// UI 控制
function toggleConnection() {
    if (easytier.isConnected || easytier.connecting) {
        easytier.disconnect();
    } else {
        const networkName = document.getElementById('networkName').value.trim();
        const networkSecret = document.getElementById('networkSecret').value.trim();
        const signalServer = document.getElementById('signalServer').value.trim();

        if (!networkName) {
            alert('请输入网络名称');
            return;
        }
        easytier.connect(networkName, networkSecret, signalServer);
    }
}

function copyShareLink() {
    const el = document.getElementById('shareLink');
    if (!el || !el.value) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(el.value).then(() => {
            alert('已复制加入链接');
        }).catch(() => {
            el.select();
            document.execCommand('copy');
            alert('已复制加入链接');
        });
    } else {
        el.select();
        document.execCommand('copy');
        alert('已复制加入链接');
    }
}

window.addEventListener('DOMContentLoaded', () => {
    if (easytier.prefillNetwork) {
        const nn = document.getElementById('networkName');
        if (nn) nn.value = easytier.prefillNetwork;
    }
    if (easytier.joinPeerId) {
        const log = document.getElementById('log');
        if (log) log.textContent += '检测到邀请链接：连接后将自动加入对端...\n';
    }
});

// 页面关闭提醒
window.addEventListener('beforeunload', (e) => {
    if (easytier.isConnected) {
        e.preventDefault();
        e.returnValue = '关闭页面将断开连接，确定吗？';
    }
});

——

说明（很快看一眼就行）
- 直接 GitHub Pages 打开，点“连接网络”，复制“加入链接”/扫码，另一台打开即可连上
- 若要“同网络名自动发现”，把 server.js 部署到 Render/Railway，前端填 wss 地址
- 如果还想更稳，后面加一个 TURN 也行，但这一步不是必需

需要我顺带给你一个一键部署 Render 的按钮/Procfile 也可以，招呼我就加。