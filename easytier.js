
/* 安卓兼容 ES5 + 固定 PeerServer（避免“不同服务器互不可见”）+ 聊天 + 传文件 + 可复制日志 */
var app = (function(){
  var self = {};
  // 配置：固定同一台 PeerServer，双方一定能互相发现
  self.server = {
    host: 'peerjs.92k.de', // 若需要换服务器，在邀请链接中会携带同参数，双方一致
    port: 443,
    secure: true,
    path: '/'
  };
  // 从邀请链接参数覆盖服务器（srv/port/ssl/path）
  (function(){
    var p = parseParams();
    if (p.srv) self.server.host = p.srv;
    if (p.port) self.server.port = parseInt(p.port,10) || 443;
    if (p.ssl !== undefined) self.server.secure = (p.ssl === '1' || p.ssl === 'true');
    if (p.path) self.server.path = p.path;
  })();

  self.peer = null;
  self.conns = {}; // peerId -> { conn: DataConnection, latency: number, recv: {cur:null|{id,name,size,mime,got,parts:[]}} }
  self.isConnected = false;
  self.startAt = 0;
  self.localId = '';
  self.virtualIp = '';
  self.network = '';
  self.uptimeT = null; self.pingT = null;
  self.logBuf = '> 初始化中...';

  // STUN（国内可用）
  self.ices = [
    { urls:'stun:stun.l.google.com:19302' },
    { urls:'stun:stun.miwifi.com:3478' }
  ];

  // 工具
  function parseParams(){
    var out = {};
    var s = window.location.search;
    if (!s || s.length<2) return out;
    var qs = s.substring(1).split('&');
    for (var i=0;i<qs.length;i++){
      var kv = qs[i].split('=');
      out[decodeURIComponent(kv[0]||'')] = decodeURIComponent(kv[1]||'');
    }
    return out;
  }
  function short(id){ return id ? id.substr(0,10)+'...' : ''; }
  function now(){ return new Date().toLocaleTimeString(); }
  function humanSize(n){
    if (n<1024) return n+' B';
    if (n<1024*1024) return (n/1024).toFixed(1)+' KB';
    if (n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB';
    return (n/1024/1024/1024).toFixed(1)+' GB';
  }
  function genIp(id){
    var h=0; for (var i=0;i<id.length;i++){ h=(h*31+id.charCodeAt(i))>>>0; }
    var a=(h&0xff)+1, b=((h>>8)&0xff)+1; return '10.144.'+a+'.'+b;
  }

  // 日志
  self.log = function(s){
    var el = document.getElementById('log');
    self.logBuf += "\n["+now()+"] "+s;
    if (el){ el.textContent = self.logBuf; el.scrollTop = el.scrollHeight; }
  };
  self.copyLog = function(){
    try{
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(self.logBuf).then(function(){ alert('日志已复制'); });
      }else{
        var ta = document.createElement('textarea');
        ta.value = self.logBuf; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        alert('日志已复制');
      }
    }catch(e){ alert('复制失败：'+e.message); }
  };
  self.clearLog = function(){
    self.logBuf = '';
    var el = document.getElementById('log'); if (el){ el.textContent=''; }
  };

  // UI helpers
  self.setStatus = function(txt, cls){
    var st = document.getElementById('status'); st.textContent = txt; st.className = 'status '+cls;
  };
  self.updateInfo = function(){
    document.getElementById('localId').textContent = self.localId ? short(self.localId) : '-';
    document.getElementById('virtualIp').textContent = self.virtualIp || '-';
    var cnt=0; for (var k in self.conns){ if (self.conns.hasOwnProperty(k)) cnt++; }
    document.getElementById('peerCount').textContent = String(cnt);
  };
  self.showShare = function(){
    var base = window.location.origin + window.location.pathname;
    var u = base + '?network=' + encodeURIComponent(self.network) +
      '&peer=' + encodeURIComponent(self.localId) +
      '&srv=' + encodeURIComponent(self.server.host) +
      '&port=' + encodeURIComponent(self.server.port) +
      '&ssl=' + (self.server.secure ? '1' : '0') +
      '&path=' + encodeURIComponent(self.server.path);
    var input = document.getElementById('shareLink'); input.value = u;
    var box = document.getElementById('share'); box.style.display='block';
    var qr = document.getElementById('qr');
    if (qr && window.QRCode){ qr.innerHTML=''; new QRCode(qr,{text:u,width:150,height:150}); }
  };
  self.copyLink = function(){
    var el = document.getElementById('shareLink');
    try{
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(el.value).then(function(){ alert('已复制'); });
      }else{
        el.select(); document.execCommand('copy'); alert('已复制');
      }
    }catch(e){ alert('复制失败：'+e.message); }
  };

  // 聊天
  function pushMsg(text, me){
    var box = document.getElementById('msgs'); if (!box) return;
    var div = document.createElement('div'); div.className = 'msg ' + (me?'me':'peer');
    var sm = document.createElement('small'); sm.textContent = now();
    var p = document.createElement('div'); p.textContent = text;
    div.appendChild(sm); div.appendChild(p); box.appendChild(div); box.scrollTop = box.scrollHeight;
  }
  function pushFileMsg(name, url, size, me){
    var box = document.getElementById('msgs'); if (!box) return;
    var div = document.createElement('div'); div.className = 'msg ' + (me?'me':'peer');
    var sm = document.createElement('small'); sm.textContent = now();
    var a = document.createElement('a'); a.href = url; a.download = name; a.textContent = '下载文件：'+name+' ('+humanSize(size)+')';
    a.style.wordBreak='break-all';
    div.appendChild(sm); div.appendChild(a); box.appendChild(div); box.scrollTop = box.scrollHeight;
  }
  self.sendMsg = function(){
    var ipt = document.getElementById('msgInput'); if (!ipt) return;
    var t = (ipt.value||'').replace(/^\s+|\s+$/g,''); if (!t) return; ipt.value='';
    pushMsg(t, true);
    var sent=0; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue;
      try{ self.conns[k].conn.send({type:'chat', text:t}); sent++; }catch(e){ self.log('发送失败: '+e.message); }
    }
    if (!sent){ self.log('没有在线节点'); }
  };

  // 传文件（单连接一次只传一个，简化稳定性）
  self.sendFiles = function(){
    var fi = document.getElementById('fileInput');
    if (!fi || !fi.files || fi.files.length===0){ alert('请选择文件'); return; }
    var peers = []; for (var k in self.conns){ if (self.conns.hasOwnProperty(k)) peers.push(k); }
    if (!peers.length){ self.log('没有在线节点'); return; }
    for (var i=0;i<fi.files.length;i++){
      (function(file){
        for (var j=0;j<peers.length;j++){ sendFileToPeer(peers[j], file); }
      })(fi.files[i]);
    }
    fi.value = '';
  };

  function sendFileToPeer(peerId, file){
    var st = self.conns[peerId]; if (!st || !st.conn || !st.conn.open){ self.log('对端不在线: '+short(peerId)); return; }
    var c = st.conn;
    var id = String(Date.now()) + '_' + Math.floor(Math.random()*1e6);
    var chunk = 64*1024; // 64KB，兼容性较好
    var offset = 0;
    self.log('开始发送给 '+short(peerId)+': '+file.name+' ('+humanSize(file.size)+')');
    try{ c.send({type:'file-begin', id:id, name:file.name, size:file.size, mime:file.type||'application/octet-stream', chunk:chunk}); }catch(e){ self.log('发送元信息失败: '+e.message); return; }

    var reader = new FileReader();
    reader.onerror = function(){ self.log('读取文件失败'); };
    reader.onload = function(e){
      try{ c.send(e.target.result); }catch(err){ self.log('发送数据失败: '+(err.message||err)); return; }
      offset += e.target.result.byteLength;
      var pct = Math.min(100, Math.floor(offset*100/file.size));
      self.log('发送进度 '+short(peerId)+': '+pct+'%');
      if (offset < file.size){
        setTimeout(readNext, 0);
      }else{
        try{ c.send({type:'file-end', id:id}); }catch(err2){}
        self.log('发送完成：'+file.name+' -> '+short(peerId));
        // 自己也显示一条可下载（从源文件创建链接）
        try{
          var url = URL.createObjectURL(file);
          pushFileMsg(file.name, url, file.size, true);
          setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
        }catch(ee){}
      }
    };
    function readNext(){
      var slice = file.slice(offset, Math.min(offset+chunk, file.size));
      reader.readAsArrayBuffer(slice);
    }
    readNext();
  }

  // 连接流程
  self.toggle = function(){
    if (self.isConnected){ self.disconnect(); return; }
    var name = document.getElementById('networkName').value.replace(/^\s+|\s+$/g,'');
    if (!name){ alert('请输入网络名称'); return; }
    self.connect(name);
  };

  self.connect = function(net){
    self.network = net;
    document.getElementById('connectBtn').textContent = '连接中...';
    document.getElementById('connectBtn').disabled = true;
    self.setStatus('● 连接中...', 'connecting');
    self.log('连接到服务器: '+self.server.host+':'+self.server.port+' (ssl='+(self.server.secure?'1':'0')+', path='+self.server.path+')');

    var opts = {
      host: self.server.host,
      port: self.server.port,
      secure: self.server.secure,
      path: self.server.path,
      config: { iceServers: self.ices }
    };
    var p;
    try{ p = new Peer(null, opts); }catch(e){ self.log('Peer 初始化失败: '+e.message); failedConnectUI(); return; }
    self.peer = p;

    p.on('open', function(id){
      self.localId = id; self.virtualIp = genIp(id);
      self.isConnected = true; self.startAt = Date.now();
      self.setStatus('● 在线', 'online');
      document.getElementById('connectBtn').textContent = '🔌 断开';
      document.getElementById('connectBtn').disabled = false;
      self.updateInfo();
      document.getElementById('chat').style.display = 'block';
      document.getElementById('tools').style.display = 'block';
      self.showShare();
      self.log('已连接，ID: '+id);

      // 邀请自动拨号
      var pms = parseParams();
      if (pms.peer){ self.log('检测到邀请，将连接对端: '+short(pms.peer)); setTimeout(function(){ self.connectPeer(pms.peer); }, 400); }

      startTimers();
    });

    p.on('connection', function(conn){ handleConn(conn); });
    p.on('error', function(err){ self.log('Peer 错误: '+(err && (err.message||err.type)||err)); });
    p.on('disconnected', function(){ self.log('Peer 断开，尝试重连'); try{ p.reconnect(); }catch(e){} });
    p.on('close', function(){ self.log('Peer 已关闭'); });
  };

  function failedConnectUI(){
    self.setStatus('● 离线', 'offline');
    document.getElementById('connectBtn').textContent = '🔌 连接网络';
    document.getElementById('connectBtn').disabled = false;
  }

  self.connectPeer = function(peerId){
    if (!self.peer || !peerId || peerId===self.localId) return;
    if (self.conns[peerId] && self.conns[peerId].conn && self.conns[peerId].conn.open) return;
    self.log('尝试连接对端: '+short(peerId));
    var c;
    try{ c = self.peer.connect(peerId, { reliable:true }); }catch(e){ self.log('connect 失败: '+e.message); return; }
    handleConn(c);
  };

  function handleConn(c){
    if (!c || !c.peer) return;
    var pid = c.peer;
    // 去重：已有打开连接则关闭新连接
    if (self.conns[pid] && self.conns[pid].conn && self.conns[pid].conn.open){
      try{ c.close(); }catch(e){}
      return;
    }
    self.log('新连接: '+short(pid));
    self.conns[pid] = { conn:c, latency:0, recv:{cur:null} };

    c.on('open', function(){
      self.updateInfo();
      try{ c.send({type:'hello', id:self.localId, ip:self.virtualIp, network:self.network}); }catch(e){}
    });

    c.on('data', function(d){
      // 文本/JSON 消息
      if (d && typeof d === 'object' && d.type){
        if (d.type==='hello'){
          self.log('对端上线: '+short(pid)+' (IP: '+(d.ip||'-')+')');
        }else if (d.type==='ping'){
          try{ c.send({type:'pong', ts:d.ts}); }catch(e){}
        }else if (d.type==='pong'){
          var lat = Date.now() - (d.ts||Date.now());
          if (self.conns[pid]) self.conns[pid].latency = lat;
          self.updateInfo();
        }else if (d.type==='chat'){
          pushMsg(String(d.text||''), false);
        }else if (d.type==='file-begin'){
          self.log('开始接收：'+(d.name||'文件')+' 来自 '+short(pid)+' ('+humanSize(d.size||0)+')');
          self.conns[pid].recv.cur = { id:d.id, name:d.name, size:d.size||0, mime:d.mime||'application/octet-stream', got:0, parts:[] };
        }else if (d.type==='file-end'){
          var ctx = self.conns[pid].recv.cur;
          if (ctx && ctx.id===d.id){
            var blob = new Blob(ctx.parts, {type:ctx.mime});
            var url = URL.createObjectURL(blob);
            pushFileMsg(ctx.name, url, ctx.size, false);
            self.log('接收完成：'+ctx.name+' ('+humanSize(ctx.size)+') 来自 '+short(pid));
            // 60 秒后释放 URL
            (function(u){ setTimeout(function(){ URL.revokeObjectURL(u); }, 60000); })(url);
            self.conns[pid].recv.cur = null;
          }
        }
        return;
      }
      // 二进制块（ArrayBuffer 或 Blob）
      var cur = self.conns[pid] && self.conns[pid].recv && self.conns[pid].recv.cur;
      if (!cur){ self.log('收到未知二进制数据（无上下文），已丢弃'); return; }
      var partSize = 0;
      if (d && d.byteLength !== undefined){ // ArrayBuffer
        partSize = d.byteLength;
        cur.parts.push(new Blob([d]));
      }else if (d && d.size !== undefined){ // Blob
        partSize = d.size;
        cur.parts.push(d);
      }else{
        return;
      }
      cur.got += partSize;
      var pct = cur.size ? Math.min(100, Math.floor(cur.got*100/cur.size)) : 0;
      self.log('接收进度 '+short(pid)+': '+pct+'%');
    });

    c.on('close', function(){
      delete self.conns[pid]; self.updateInfo();
      self.log('连接关闭: '+short(pid));
    });

    c.on('error', function(err){
      self.log('连接错误('+short(pid)+'): '+(err && (err.message||err.type)||err));
    });
  }

  function startTimers(){
    stopTimers();
    self.uptimeT = setInterval(function(){
      if (!self.isConnected || !self.startAt) return;
      var s = Math.floor((Date.now()-self.startAt)/1000);
      var h = Math.floor(s/3600), m = Math.floor((s%3600)/60), sec = s%60;
      var txt = (h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
      document.getElementById('uptime').textContent = txt;
    }, 1000);
    self.pingT = setInterval(function(){
      for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue;
        try{ self.conns[k].conn.send({type:'ping', ts:Date.now()}); }catch(e){}
      }
    }, 5000);
  }
  function stopTimers(){
    if (self.uptimeT){ clearInterval(self.uptimeT); self.uptimeT=null; }
    if (self.pingT){ clearInterval(self.pingT); self.pingT=null; }
  }

  self.disconnect = function(){
    for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue;
      try{ self.conns[k].conn.close(); }catch(e){}
    }
    self.conns = {};
    if (self.peer){ try{ self.peer.destroy(); }catch(e){} self.peer=null; }
    stopTimers();
    self.isConnected = false; self.startAt=0; self.localId=''; self.virtualIp='';
    document.getElementById('chat').style.display='none';
    document.getElementById('tools').style.display='none';
    document.getElementById('share').style.display='none';
    self.setStatus('● 离线', 'offline');
    document.getElementById('connectBtn').textContent='🔌 连接网络';
    document.getElementById('connectBtn').disabled=false;
    self.updateInfo();
    self.log('已断开');
  };

  // 初始化
  (function(){
    var p = parseParams();
    if (p.network){ document.getElementById('networkName').value = p.network; }
    self.log('就绪：点击“连接网络”开始（服务器 '+self.server.host+':'+self.server.port+'）');
  })();

  return self;
})();

window.addEventListener('beforeunload', function(e){
  if (app.isConnected){
    e.preventDefault();
    e.returnValue = '关闭页面将断开连接，确定吗？';
  }
});