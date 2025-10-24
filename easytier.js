
var app = {
    peer: null,
    conn: new Map(),
    localId: '',
    virtualIp: '',
    networkName: '',
    isConnected: false,
    startTime: null,
    timers: {},
    
    log: function(msg) {
        var el = document.getElementById('log');
        var t = new Date().toLocaleTimeString();
        if (el) {
            el.textContent += '[' + t + '] ' + msg + '\n';
            el.scrollTop = el.scrollHeight;
        }
    },
    
    showMsg: function(text, isSelf) {
        var box = document.getElementById('chatMessages');
        if (!box) return;
        
        var div = document.createElement('div');
        div.className = 'chat-msg ' + (isSelf ? 'me' : 'peer');
        
        var time = document.createElement('div');
        time.className = 'time';
        time.textContent = new Date().toLocaleTimeString();
        
        var content = document.createElement('div');
        content.textContent = text;
        
        div.appendChild(time);
        div.appendChild(content);
        box.appendChild(div);
        box.scrollTop = box.scrollHeight;
    },
    
    sendMsg: function() {
        var self = this;
        var input = document.getElementById('msgInput');
        if (!input || !input.value.trim()) return;
        
        var text = input.value.trim();
        input.value = '';
        
        self.showMsg(text, true);
        
        var count = 0;
        self.conn.forEach(function(data) {
            try {
                data.connection.send({ type: 'msg', text: text, from: self.localId });
                count++;
            } catch (e) {
                self.log('发送失败: ' + e.message);
            }
        });
        
        if (count === 0) {
            self.log('⚠️ 没有在线节点');
        }
    },
    
    connect: function(networkName) {
        var self = this;
        self.networkName = networkName;
        self.log('🔄 连接中: ' + networkName);
        
        document.getElementById('status').textContent = '● 连接中...';
        document.getElementById('status').className = 'status connecting';
        
        try {
            self.peer = new Peer(null, {
                config: {
                    iceServers: [
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun.miwifi.com:3478' }
                    ]
                }
            });
        } catch (e) {
            self.log('❌ 初始化失败: ' + e.message);
            return;
        }
        
        self.peer.on('open', function(id) {
            self.localId = id;
            self.virtualIp = self.genIP(id);
            self.isConnected = true;
            self.startTime = Date.now();
            
            self.log('✅ 已连接');
            self.log('📍 ID: ' + id);
            self.log('🌐 IP: ' + self.virtualIp);
            
            self.updateUI();
            self.genShare();
            self.startTimers();
            
            var chatBox = document.getElementById('chatBox');
            if (chatBox) chatBox.style.display = 'block';
            
            var joinPeer = self.getUrlParam('peer');
            if (joinPeer) {
                self.log('🔗 自动连接: ' + joinPeer.substring(0, 8) + '...');
                setTimeout(function() {
                    self.connectPeer(joinPeer);
                }, 500);
            }
        });
        
        self.peer.on('connection', function(c) {
            self.handleConn(c);
        });
        
        self.peer.on('error', function(err) {
            self.log('❌ 错误: ' + (err.message || err.type));
        });
    },
    
    handleConn: function(c) {
        var self = this;
        var pid = c.peer;
        
        self.log('📡 新连接: ' + pid.substring(0, 8) + '...');
        
        c.on('open', function() {
            self.conn.set(pid, { connection: c, latency: 0 });
            self.updatePeerList();
            c.send({ type: 'hello', id: self.localId, ip: self.virtualIp });
        });
        
        c.on('data', function(data) {
            if (!data || !data.type) return;
            
            if (data.type === 'hello') {
                self.log('👋 ' + pid.substring(0, 8) + '... (IP: ' + data.ip + ')');
            } else if (data.type === 'ping') {
                c.send({ type: 'pong', timestamp: data.timestamp });
            } else if (data.type === 'pong') {
                var lat = Date.now() - data.timestamp;
                var p = self.conn.get(pid);
                if (p) p.latency = lat;
                self.updatePeerList();
            } else if (data.type === 'msg') {
                self.log('💬 收到消息: ' + data.text);
                self.showMsg(data.text, false);
            }
        });
        
        c.on('close', function() {
            self.conn.delete(pid);
            self.updatePeerList();
            self.log('📴 断开: ' + pid.substring(0, 8) + '...');
        });
    },
    
    connectPeer: function(pid) {
        var self = this;
        if (!self.peer || !pid || pid === self.localId || self.conn.has(pid)) return;
        
        self.log('🔗 连接: ' + pid.substring(0, 8) + '...');
        try {
            var c = self.peer.connect(pid, { reliable: true });
            self.handleConn(c);
        } catch (e) {
            self.log('❌ 连接失败: ' + e.message);
        }
    },
    
    genIP: function(id) {
        var h = 0;
        for (var i = 0; i < id.length; i++) {
            h = (h * 31 + id.charCodeAt(i)) >>> 0;
        }
        return '10.144.' + ((h & 0xff) + 1) + '.' + (((h >> 8) & 0xff) + 1);
    },
    
    genShare: function() {
        var self = this;
        var url = window.location.href.split('?')[0];
        url += '?network=' + encodeURIComponent(self.networkName) + '&peer=' + self.localId;
        
        var el = document.getElementById('shareLink');
        var sec = document.getElementById('shareSection');
        if (el && sec) {
            el.value = url;
            sec.style.display = 'block';
        }
        
        var qr = document.getElementById('qr');
        if (qr && window.QRCode) {
            qr.innerHTML = '';
            new QRCode(qr, { text: url, width: 160, height: 160 });
        }
    },
    
    updateUI: function() {
        var self = this;
        var st = document.getElementById('status');
        var lid = document.getElementById('localId');
        var vip = document.getElementById('virtualIp');
        var btn = document.getElementById('connectBtn');
        
        if (self.isConnected) {
            if (st) { st.textContent = '● 在线'; st.className = 'status online'; }
            if (lid) lid.textContent = self.localId.substring(0, 8) + '...';
            if (vip) vip.textContent = self.virtualIp;
            if (btn) btn.textContent = '🔌 断开';
        } else {
            if (st) { st.textContent = '● 离线'; st.className = 'status offline'; }
            if (lid) lid.textContent = '-';
            if (vip) vip.textContent = '-';
            if (btn) btn.textContent = '🔌 连接网络';
            
            var chatBox = document.getElementById('chatBox');
            if (chatBox) chatBox.style.display = 'none';
        }
    },
    
    updatePeerList: function() {
        var cnt = document.getElementById('peerCount');
        if (cnt) cnt.textContent = String(this.conn.size);
    },
    
    startTimers: function() {
        var self = this;
        
        self.timers.uptime = setInterval(function() {
            if (!self.isConnected || !self.startTime) return;
            var s = Math.floor((Date.now() - self.startTime) / 1000);
            var h = Math.floor(s / 3600);
            var m = Math.floor((s % 3600) / 60);
            var sec = s % 60;
            var txt = (h < 10 ? '0' : '') + h + ':' + 
                      (m < 10 ? '0' : '') + m + ':' + 
                      (sec < 10 ? '0' : '') + sec;
            var el = document.getElementById('uptime');
            if (el) el.textContent = txt;
        }, 1000);
        
        self.timers.ping = setInterval(function() {
            if (!self.isConnected) return;
            self.conn.forEach(function(data) {
                try {
                    data.connection.send({ type: 'ping', timestamp: Date.now() });
                } catch (e) {}
            });
        }, 5000);
    },
    
    disconnect: function() {
        var self = this;
        self.conn.forEach(function(data) {
            try { data.connection.close(); } catch (e) {}
        });
        self.conn.clear();
        
        if (self.peer) {
            try { self.peer.destroy(); } catch (e) {}
            self.peer = null;
        }
        
        for (var k in self.timers) {
            clearInterval(self.timers[k]);
        }
        self.timers = {};
        
        self.isConnected = false;
        self.startTime = null;
        self.updateUI();
        self.log('🔌 已断开');
        
        var sec = document.getElementById('shareSection');
        if (sec) sec.style.display = 'none';
    },
    
    toggle: function() {
        var self = this;
        if (self.isConnected) {
            self.disconnect();
        } else {
            var name = document.getElementById('networkName').value.trim();
            if (!name) {
                alert('请输入网络名称');
                return;
            }
            self.connect(name);
        }
    },
    
    copyLink: function() {
        var el = document.getElementById('shareLink');
        if (!el || !el.value) return;
        el.select();
        document.execCommand('copy');
        alert('已复制');
    },
    
    getUrlParam: function(name) {
        var url = window.location.href;
        var idx = url.indexOf('?');
        if (idx === -1) return '';
        var params = url.substring(idx + 1).split('&');
        for (var i = 0; i < params.length; i++) {
            var p = params[i].split('=');
            if (p[0] === name) return decodeURIComponent(p[1]);
        }
        return '';
    }
};

window.addEventListener('DOMContentLoaded', function() {
    app.log('> 就绪，点击"连接网络"');
    var prefill = app.getUrlParam('network');
    if (prefill) {
        document.getElementById('networkName').value = prefill;
        app.log('> 检测到邀请链接，连接后将自动加入对端');
    }
});

window.addEventListener('beforeunload', function(e) {
    if (app.isConnected) {
        e.preventDefault();
        e.returnValue = '确定关闭？';
    }
});