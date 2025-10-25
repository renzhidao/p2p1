/* P2P 安卓兼容版（ES5，无 class/Map/箭头函数），内置多 PeerServer 轮询与超时切换 */
var app = (function(){
  var self = {};
  self.peer = null;
  self.conns = {}; // peerId -> {conn: DataConnection, latency: number}
  self.isConnected = false;
  self.startAt = 0;
  self.timers = {};
  self.localId = '';
  self.virtualIp = '';
  self.network = '';

  // 多服务器轮询（避免“一直初始化中”）
  self.servers = [
    { host:'peerjs.92k.de', secure:true, port:443, path:'/' },     // 德国免费
    { cloud:true }                                                 // PeerJS Cloud（0.peerjs.com）
  ];
  self.serverIndex = 0;
  self.openWait = 9000; // ms

  self.ices = [
    { urls:'stun:stun.l.google.com:19302' },
    { urls:'stun:stun.miwifi.com:3478' }
  ];

  // UI
  self.log = function(s){
    var el = document.getElementById('log');
    var t = new Date().toLocaleTimeString();
    el.textContent += "\n[" + t + "] " + s;
    el.scrollTop = el.scrollHeight;
  };
  self.setStatus = function(txt, cls){
    var st = document.getElementById('status');
    st.textContent = txt;
    st.className = "status " + cls;
  };
  self.updateInfo = function(){
    document.getElementById('localId').textContent = self.localId ? self.localId.substr(0,8)+"..." : "-";
    document.getElementById('virtualIp').textContent = self.virtualIp || "-";
    document.getElementById('peerCount').textContent = String(self.connCount());
  };
  self.showShare = function(link){
    var box = document.getElementById('share');
    var input = document.getElementById('shareLink');
    var qr = document.getElementById('qr');
    input.value = link;
    box.style.display = 'block';
    if (window.QRCode) {
      qr.innerHTML = '';
      new QRCode(qr, { text: link, width:150, height:150 });
    }
  };
  self.copy = function(){
    var el = document.getElementById('shareLink');
    try{
      el.select(); document.execCommand('copy'); alert('已复制');
    }catch(e){ alert('复制失败，请手动长按复制'); }
  };
  self.showChat = function(show){
    document.getElementById('chat').style.display = show ? 'block' : 'none';
  };
  self.pushMsg = function(text, me){
    var box = document.getElementById('msgs');
    var item = document.createElement('div');
    item.className = 'chat-msg ' + (me?'me':'peer');
    item.textContent = text;
    box.appendChild(item);
    box.scrollTop = box.scrollHeight;
  };

  // 工具
  self.getParam = function(k){
    var href = window.location.href;
    var qIndex = href.indexOf('?');
    if (qIndex === -1) return '';
    var qs = href.substring(qIndex+1).split('&');
    for (var i=0;i<qs.length;i++){
      var kv = qs[i].split('=');
      if (kv[0] === k) return decodeURIComponent(kv[1] || '');
    }
    return '';
  };
  self.genIp = function(id){
    var h=0; for (var i=0;i<id.length;i++){ h = (h*31 + id.charCodeAt(i))>>>0; }
    var a = (h & 0xff)+1, b=((h>>8)&0xff)+1;
    return '10.144.'+a+'.'+b;
  };
  self.connCount = function(){
    var n=0; for (var k in self.conns){ if (self.conns.hasOwnProperty(k)) n++; } return n;
  };

  // 入口
  self.toggle = function(){
    if (self.isConnected) { self.disconnect(); return; }
    var name = document.getElementById('networkName').value.replace(/^\s+|\s+$/g,'');
    if (!name){ alert('请输入网络名称'); return; }
    self.connect(name);
  };

  self.connect = function(net){
    self.network = net;
    self.setStatus('● 连接中...', 'connecting');
    document.getElementById('connectBtn').textContent = '连接中...';
    document.getElementById('connectBtn').disabled = true;
    self.log('开始连接: ' + net);
    self.tryServer(0);
  };

  // 轮询 PeerServer
  self.tryServer = function(index){
    self.serverIndex = index;
    if (index >= self.servers.length){
      self.log('所有服务器均不可用');
      self.setStatus('● 离线', 'offline');
      document.getElementById('connectBtn').textContent = '🔌 连接网络';
      document.getElementById('connectBtn').disabled = false;
      return;
    }
    var s = self.servers[index];
    var opts = { debug: 0, config: { iceServers: self.ices } };
    if (!s.cloud){
      opts.host = s.host; opts.secure = s.secure; opts.port = s.port; opts.path = s.path || '/';
    }
    self.log('尝试服务器 #' + (index+1) + (s.cloud?' (PeerJS Cloud)':' ('+s.host+')'));
    var p;
    try { p = new Peer(null, opts); } catch(e){ self.log('初始化失败: '+e.message); return self.tryServer(index+1); }
    self.peer = p;

    var opened = false;
    var openTimer = setTimeout(function(){
      if (!opened){
        self.log('连接超时，切换下一台');
        try{ p.destroy(); }catch(e){}
        self.tryServer(index+1);
      }
    }, self.openWait);

    p.on('open', function(id){
      opened = true; clearTimeout(openTimer);
      self.localId = id;
      self.virtualIp = self.genIp(id);
      self.isConnected = true;
      self.startAt = Date.now();
      self.setStatus('● 在线','online');
      document.getElementById('connectBtn').textContent = '🔌 断开';
      document.getElementById('connectBtn').disabled = false;
      self.updateInfo();
      self.showChat(true);
      self.log('已连接，ID: ' + id);

      // 邀请链接
      var base = window.location.href.split('?')[0];
      var link = base + '?network=' + encodeURIComponent(self.network) + '&peer=' + id;
      self.showShare(link);

      // 自动加入对端（若来自邀请）
      var jp = self.getParam('peer');
      if (jp){ self.log('检测到邀请，将连接对端: ' + jp.substr(0,8) + '...'); setTimeout(function(){ self.connectPeer(jp); }, 400); }
      self.startTimers();
    });

    p.on('connection', function(conn){ self.handleConn(conn); });
    p.on('error', function(err){ self.log('Peer 错误: ' + (err && (err.message||err.type) || err)); });
    p.on('disconnected', function(){ self.log('Peer 断开，尝试重连'); try{ p.reconnect(); }catch(e){} });
    p.on('close', function(){ self.log('Peer 已关闭'); });
  };

  // 连接/消息
  self.connectPeer = function(peerId){
    if (!self.peer || !peerId || peerId === self.localId) return;
    if (self.conns[peerId] && self.conns[peerId].conn && self.conns[peerId].conn.open) return;
    self.log('尝试连接: ' + peerId.substr(0,8) + '...');
    var c;
    try{ c = self.peer.connect(peerId, { reliable:true }); }catch(e){ self.log('连接失败: '+e.message); return; }
    self.handleConn(c);
  };

  self.handleConn = function(c){
    if (!c || !c.peer) return;
    var pid = c.peer;
    // 去重：已有打开连接则关闭新连接
    if (self.conns[pid] && self.conns[pid].conn && self.conns[pid].conn.open){
      try{ c.close(); }catch(e){}
      return;
    }
    self.log('新连接: ' + pid.substr(0,8) + '...');
    c.on('open', function(){
      self.conns[pid] = { conn:c, latency:0 };
      self.updateInfo();
      try{ c.send({type:'hello', id:self.localId, ip:self.virtualIp, t:Date.now()}); }catch(e){}
    });
    c.on('data', function(d){
      if (!d || !d.type) return;
      if (d.type === 'hello'){
        self.log('对端上线: ' + pid.substr(0,8) + ' (IP: '+ (d.ip||'-') +')');
      }else if (d.type === 'ping'){
        try{ c.send({type:'pong', ts:d.ts}); }catch(e){}
      }else if (d.type === 'pong'){
        var lat = Date.now() - (d.ts||Date.now());
        if (self.conns[pid]){ self.conns[pid].latency = lat; }
        self.updateInfo();
      }else if (d.type === 'msg'){
        self.pushMsg(d.text || '', false);
      }
    });
    c.on('close', function(){
      delete self.conns[pid];
      self.updateInfo();
      self.log('连接关闭: ' + pid.substr(0,8) + '...');
    });
    c.on('error', function(err){
      self.log('连接错误(' + pid.substr(0,8) + '): ' + (err && (err.message||err.type) || err));
    });
  };

  self.send = function(){
    var ipt = document.getElementById('msgInput');
    if (!ipt) return;
    var txt = (ipt.value || '').replace(/^\s+|\s+$/g,'');
    if (!txt){ return; }
    ipt.value = '';
    self.pushMsg(txt, true);
    var sent = 0;
    for (var k in self.conns){
      if (!self.conns.hasOwnProperty(k)) continue;
      var dc = self.conns[k].conn;
      try{ dc.send({type:'msg', text:txt}); sent++; }catch(e){ self.log('发送失败: '+e.message); }
    }
    if (!sent){ self.log('没有在线节点'); }
  };

  // 定时器
  self.startTimers = function(){
    // uptime
    self.timers.up = setInterval(function(){
      if (!self.isConnected || !self.startAt) return;
      var s = Math.floor((Date.now()-self.startAt)/1000);
      var h = Math.floor(s/3600);
      var m = Math.floor((s%3600)/60);
      var sec = s%60;
      var txt = (h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
      document.getElementById('uptime').textContent = txt;
    }, 1000);
    // ping
    self.timers.ping = setInterval(function(){
      for (var k in self.conns){
        if (!self.conns.hasOwnProperty(k)) continue;
        var dc = self.conns[k].conn;
        try{ dc.send({type:'ping', ts:Date.now()}); }catch(e){}
      }
    }, 5000);
  };

  self.stopTimers = function(){
    for (var k in self.timers){ clearInterval(self.timers[k]); }
    self.timers = {};
  };

  self.disconnect = function(){
    for (var k in self.conns){
      if (!self.conns.hasOwnProperty(k)) continue;
      try{ self.conns[k].conn.close(); }catch(e){}
    }
    self.conns = {};
    if (self.peer){ try{ self.peer.destroy(); }catch(e){} self.peer = null; }
    self.stopTimers();
    self.isConnected = false;
    self.startAt = 0;
    self.localId = '';
    self.virtualIp = '';
    self.updateInfo();
    self.showChat(false);
    document.getElementById('share').style.display = 'none';
    self.setStatus('● 离线','offline');
    var btn = document.getElementById('connectBtn');
    btn.textContent = '🔌 连接网络';
    btn.disabled = false;
    self.log('已断开');
  };

  // 初始化提示
  (function(){
    var prefill = self.getParam('network');
    if (prefill){ document.getElementById('networkName').value = prefill; }
    self.log('就绪，点击“连接网络”开始');
  })();

  // 暴露
  self.copy = self.copy;
  return self;
})();

window.addEventListener('beforeunload', function(e){
  if (app.isConnected){
    e.preventDefault();
    e.returnValue = '关闭页面将断开连接，确定吗？';
  }
});