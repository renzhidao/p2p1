
/* ES5 安卓兼容 + 详细日志(Txx) + 多服务器容错但“同服锁定” + 聊天 + 传文件(队列) */
var app = (function(){
  var self = {};

  // 候选 PeerServer（A 端首连时会按序尝试；生成的邀请链接会锁定同服）
  self.candidates = [
    { host:'0.peerjs.com', secure:true, port:443, path:'/' },  // 官方云（更稳）
    { host:'peerjs.92k.de', secure:true, port:443, path:'/' }  // 社区公益（备选）
  ];
  self.server = null;           // 最终使用的服务器
  self.lockedByParam = false;   // 链接中带 srv/port/ssl/path 时，锁服，不做切换
  self.openTimeoutMs = 10000;   // 打开 Peer 超时切换
  self.dialTimeoutMs = 12000;   // 拨号 DataConnection 超时

  // ICE（与“第一个版本思路”一致，穿透更好）
  self.ices = [
    { urls:'stun:stun.l.google.com:19302' },
    { urls:'stun:global.stun.twilio.com:3478' },
    { urls:'stun:stun.services.mozilla.com' }
  ];

  self.peer = null;
  self.conns = {}; // peerId -> { conn, latency, sending:false, queue:[], recv:{cur:null} }
  self.isConnected = false;
  self.startAt = 0;
  self.localId = '';
  self.virtualIp = '';
  self.network = '';

  self.timers = { up:null, ping:null };
  self.logBuf = '> 初始化中...';

  // 工具
  function now(){ return new Date().toLocaleTimeString(); }
  function shortId(id){ return id ? id.substr(0,10)+'...' : ''; }
  function human(n){
    if (n<1024) return n+' B';
    if (n<1024*1024) return (n/1024).toFixed(1)+' KB';
    if (n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB';
    return (n/1024/1024/1024).toFixed(1)+' GB';
  }
  function genIp(id){
    var h=0; for (var i=0;i<id.length;i++){ h=(h*31+id.charCodeAt(i))>>>0; }
    return '10.144.'+(((h)&0xff)+1)+'.'+(((h>>8)&0xff)+1);
  }
  function params(){
    var out={}, s=window.location.search;
    if (!s||s.length<2) return out;
    var arr=s.substring(1).split('&');
    for (var i=0;i<arr.length;i++){ var kv=arr[i].split('='); out[decodeURIComponent(kv[0]||'')]=decodeURIComponent(kv[1]||''); }
    return out;
  }

  // 日志（Txx）
  self.log = function(s){
    var el = document.getElementById('log');
    self.logBuf += "\n["+now()+"] "+s;
    if (el){ el.textContent = self.logBuf; el.scrollTop = el.scrollHeight; }
  };
  self.copyLog = function(){
    try{
      if (navigator.clipboard && navigator.clipboard.writeText){
        navigator.clipboard.writeText(self.logBuf).then(function(){ alert('日志已复制'); });
      } else {
        var ta=document.createElement('textarea'); ta.value=self.logBuf; document.body.appendChild(ta);
        ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
        alert('日志已复制');
      }
    }catch(e){ alert('复制失败：'+e.message); }
  };
  self.clearLog = function(){ self.logBuf=''; var el=document.getElementById('log'); if (el) el.textContent=''; };

  // UI
  self.setStatus = function(txt, cls){ var st=document.getElementById('status'); st.textContent=txt; st.className='status '+cls; };
  self.updateInfo = function(){
    document.getElementById('localId').textContent = self.localId ? shortId(self.localId) : '-';
    document.getElementById('virtualIp').textContent = self.virtualIp || '-';
    var n=0; for (var k in self.conns){ if (self.conns.hasOwnProperty(k)) n++; }
    document.getElementById('peerCount').textContent = String(n);
  };
  self.showShare = function(){
    var base = window.location.origin + window.location.pathname;
    var u = base + '?network=' + encodeURIComponent(self.network) +
      '&peer=' + encodeURIComponent(self.localId) +
      '&srv=' + encodeURIComponent(self.server.host) +
      '&port=' + encodeURIComponent(self.server.port) +
      '&ssl=' + (self.server.secure ? '1' : '0') +
      '&path=' + encodeURIComponent(self.server.path);
    var input=document.getElementById('shareLink'); input.value=u;
    var box=document.getElementById('share'); box.style.display='block';
    var qr=document.getElementById('qr'); if (qr && window.QRCode){ qr.innerHTML=''; new QRCode(qr,{text:u,width:150,height:150}); }
  };
  self.copyLink = function(){
    var el=document.getElementById('shareLink');
    try{
      if (navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(el.value).then(function(){ alert('已复制'); }); }
      else { el.select(); document.execCommand('copy'); alert('已复制'); }
    }catch(e){ alert('复制失败：'+e.message); }
  };

  // 聊天
  function pushMsg(text, me){
    var box=document.getElementById('msgs'); if (!box) return;
    var div=document.createElement('div'); div.className='msg '+(me?'me':'peer');
    var sm=document.createElement('small'); sm.textContent=now();
    var p=document.createElement('div'); p.textContent=text;
    div.appendChild(sm); div.appendChild(p); box.appendChild(div); box.scrollTop=box.scrollHeight;
  }
  function pushFile(name, url, size, me){
    var box=document.getElementById('msgs'); if (!box) return;
    var div=document.createElement('div'); div.className='msg '+(me?'me':'peer');
    var sm=document.createElement('small'); sm.textContent=now();
    var a=document.createElement('a'); a.href=url; a.download=name; a.textContent='下载：'+name+' ('+human(size)+')'; a.style.wordBreak='break-all';
    div.appendChild(sm); div.appendChild(a); box.appendChild(div); box.scrollTop=box.scrollHeight;
  }
  self.sendMsg = function(){
    var ipt=document.getElementById('msgInput'); if (!ipt) return;
    var t=(ipt.value||'').replace(/^\s+|\s+$/g,''); if (!t) return; ipt.value='';
    pushMsg(t,true);
    var sent=0; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue;
      try{ self.conns[k].conn.send({type:'chat', text:t}); sent++; }catch(e){ self.log('T14 OUT_ERROR: send chat failed '+(e.message||e)); }
    }
    if (!sent) self.log('T14 OUT_ERROR: no peers online');
  };

  // 文件传输（每个对端一个队列，依次发送）
  self.sendFiles = function(){
    var fi=document.getElementById('fileInput');
    if (!fi || !fi.files || fi.files.length===0){ alert('请选择文件'); return; }
    var peers=[]; for (var k in self.conns){ if (self.conns.hasOwnProperty(k)) peers.push(k); }
    if (!peers.length){ self.log('T40 FILE_SEND_BEGIN: no peers online'); return; }
    for (var i=0;i<fi.files.length;i++){
      (function(file){
        for (var j=0;j<peers.length;j++){ enqueueFile(peers[j], file); }
      })(fi.files[i]);
    }
    fi.value='';
  };
  function enqueueFile(peerId, file){
    var st=self.conns[peerId]; if (!st || !st.conn || !st.conn.open){ self.log('T40 FILE_SEND_BEGIN: peer offline '+shortId(peerId)); return; }
    if (!st.queue) st.queue=[];
    st.queue.push(file);
    if (!st.sending){ st.sending=true; sendNext(peerId); }
  }
  function sendNext(peerId){
    var st=self.conns[peerId]; if (!st) return;
    var file=st.queue.shift();
    if (!file){ st.sending=false; return; }
    sendFile(peerId, file, function(){ sendNext(peerId); });
  }
  function sendFile(peerId, file, done){
    var st=self.conns[peerId]; if (!st || !st.conn || !st.conn.open){ self.log('T40 FILE_SEND_BEGIN: peer offline '+shortId(peerId)); return done&&done(); }
    var c=st.conn, id=String(Date.now())+'_'+Math.floor(Math.random()*1e6), chunk=64*1024, off=0;
    self.log('T40 FILE_SEND_BEGIN: '+shortId(peerId)+' '+file.name+' '+human(file.size));
    try{ c.send({type:'file-begin', id:id, name:file.name, size:file.size, mime:file.type||'application/octet-stream', chunk:chunk}); }catch(e){ self.log('T14 OUT_ERROR: file meta send failed '+(e.message||e)); return done&&done(); }
    var reader=new FileReader();
    reader.onerror=function(){ self.log('T14 OUT_ERROR: file read failed'); done&&done(); };
    reader.onload=function(e){
      try{ c.send(e.target.result); }catch(err){ self.log('T14 OUT_ERROR: data send failed '+(err.message||err)); return done&&done(); }
      off+=e.target.result.byteLength;
      var pct=Math.min(100, Math.floor(off*100/file.size));
      self.log('T41 FILE_SEND_PROGRESS: '+shortId(peerId)+' '+pct+'%');
      if (off<file.size){ setTimeout(readNext,0); }
      else{
        try{ c.send({type:'file-end', id:id}); }catch(err2){}
        self.log('T42 FILE_SEND_END: '+file.name+' -> '+shortId(peerId));
        try{ var url=URL.createObjectURL(file); pushFile(file.name,url,file.size,true); setTimeout(function(){ URL.revokeObjectURL(url); },60000);}catch(ee){}
        done&&done();
      }
    };
    function readNext(){ var slice=file.slice(off, Math.min(off+chunk,file.size)); reader.readAsArrayBuffer(slice); }
    readNext();
  }

  // 连接流程
  self.toggle = function(){
    if (self.isConnected){ self.disconnect(); return; }
    var name=document.getElementById('networkName').value.replace(/^\s+|\s+$/g,'');
    if (!name){ alert('请输入网络名称'); return; }
    self.log('T00 UI_CLICK_CONNECT: network='+name);
    connectStart(name);
  };

  function connectStart(net){
    self.network = net;
    document.getElementById('connectBtn').textContent='连接中...';
    document.getElementById('connectBtn').disabled=true;
    self.setStatus('● 连接中...','connecting');

    // 解析链接里的同服参数（有则锁定，不做切换）
    var pm=params();
    var srv = pm.srv||'', port = pm.port||'', ssl = pm.ssl||'', pth = pm.path||'';
    if (srv || port || ssl || pth){
      self.lockedByParam = true;
      self.server = {
        host: srv || self.candidates[0].host,
        port: port ? parseInt(port,10)||443 : self.candidates[0].port,
        secure: (ssl==='1'||ssl==='true'||(ssl===''?self.candidates[0].secure:true)),
        path: pth || self.candidates[0].path
      };
      tryPeer(self.server);
    } else {
      // 无锁服参数：A 端按候选顺序尝试，成功后在邀请链接里写入同服参数
      tryCandidates(0);
    }
  }

  function tryCandidates(i){
    if (i >= self.candidates.length){
      self.log('T03 PEER_OPEN_TIMEOUT: all servers failed');
      failUI(); return;
    }
    var s=self.candidates[i];
    self.server = { host:s.host, port:s.port, secure:s.secure, path:(s.path||'/') };
    tryPeer(self.server, function(){ tryCandidates(i+1); });
  }

  function tryPeer(s, onFailNext){
    self.log('T01 PEER_CREATE: '+s.host+':'+s.port+' ssl='+(s.secure?1:0)+' path='+s.path);
    var opts={ host:s.host, port:s.port, secure:s.secure, path:s.path, config:{ iceServers:self.ices } };
    var p; try{ p=new Peer(null, opts); }catch(e){ self.log('T04 PEER_ERROR: init '+(e.message||e)); return onFail(); }
    self.peer=p;

    var opened=false;
    var openTimer=setTimeout(function(){
      if (!opened){
        self.log('T03 PEER_OPEN_TIMEOUT: '+s.host);
        safeDestroyPeer();
        onFail();
      }
    }, self.openTimeoutMs);

    function onFail(){
      if (self.lockedByParam){ failUI(); }
      else if (typeof onFailNext==='function'){ onFailNext(); }
      else { failUI(); }
    }

    p.on('open', function(id){
      opened=true; clearTimeout(openTimer);
      self.localId=id; self.virtualIp=genIp(id); self.isConnected=true; self.startAt=Date.now();
      self.setStatus('● 在线','online');
      var btn=document.getElementById('connectBtn'); btn.textContent='🔌 断开'; btn.disabled=false;
      document.getElementById('chat').style.display='block';
      document.getElementById('tools').style.display='block';
      self.updateInfo();
      self.showShare();
      self.log('T02 PEER_OPEN_OK: id='+id);

      // 邀请参数：自动拨号
      var pm=params();
      if (pm.peer){
        self.log('T10 JOIN_PARAM: peer='+pm.peer);
        setTimeout(function(){ connectPeer(pm.peer); }, 400);
      }
      startTimers();
    });

    p.on('connection', function(conn){ handleConn(conn, true); });
    p.on('error', function(err){ self.log('T04 PEER_ERROR: '+(err && (err.message||err.type)||err)); });
    p.on('disconnected', function(){ self.log('T90 PEER_DISCONNECTED: will reconnect'); try{ p.reconnect(); }catch(e){} });
    p.on('close', function(){ self.log('T90 PEER_CLOSE'); });
  }

  function failUI(){
    self.setStatus('● 离线','offline');
    var btn=document.getElementById('connectBtn'); btn.textContent='🔌 连接网络'; btn.disabled=false;
  }
  function safeDestroyPeer(){ try{ if (self.peer) self.peer.destroy(); }catch(e){} self.peer=null; }

  // 拨号
  function connectPeer(peerId){
    if (!self.peer || !peerId || peerId===self.localId) return;
    if (self.conns[peerId] && self.conns[peerId].conn && self.conns[peerId].conn.open) return;
    self.log('T11 OUT_DIAL: '+peerId);
    var c; try{ c=self.peer.connect(peerId, { reliable:true }); }catch(e){ self.log('T14 OUT_ERROR: connect '+(e.message||e)); return; }
    handleConn(c, false);
    // 拨号超时
    var timedOut=false;
    var t=setTimeout(function(){
      if (!timedOut && (!self.conns[peerId] || !self.conns[peerId].conn || !self.conns[peerId].conn.open)){
        timedOut=true; try{ c.close(); }catch(e){}
        self.log('T14 OUT_ERROR: dial timeout '+shortId(peerId));
      }
    }, self.dialTimeoutMs);
  }

  // 连接入出处理
  function handleConn(c, inbound){
    if (!c || !c.peer) return;
    var pid=c.peer;

    // 已有打开连接则关重复
    if (self.conns[pid] && self.conns[pid].conn && self.conns[pid].conn.open){
      self.log('T60 DEDUP_CLOSE: '+shortId(pid));
      try{ c.close(); }catch(e){}
      return;
    }

    if (inbound) self.log('T20 IN_CONN: '+shortId(pid)); else self.log('T11 OUT_DIAL: pending '+shortId(pid));

    self.conns[pid] = { conn:c, latency:0, sending:false, queue:[], recv:{cur:null} };

    c.on('open', function(){
      if (inbound) self.log('T21 IN_OPEN: '+shortId(pid)); else self.log('T12 OUT_OPEN: '+shortId(pid));
      self.updateInfo();
      try{ c.send({type:'hello', id:self.localId, ip:self.virtualIp, network:self.network}); }catch(e){}
    });

    c.on('data', function(d){
      // 控制消息
      if (d && typeof d==='object' && d.type){
        if (d.type==='hello'){ self.log('T20 IN_CONN: hello from '+shortId(pid)+' ip='+(d.ip||'-')); }
        else if (d.type==='ping'){ try{ c.send({type:'pong', ts:d.ts}); }catch(e){} }
        else if (d.type==='pong'){
          var lat=Date.now()-(d.ts||Date.now());
          if (self.conns[pid]) self.conns[pid].latency=lat;
          self.log('T31 PONG: '+shortId(pid)+' rtt='+lat+'ms'); self.updateInfo();
        }
        else if (d.type==='chat'){ pushMsg(String(d.text||''), false); }
        else if (d.type==='file-begin'){
          self.log('T50 FILE_RECV_BEGIN: '+(d.name||'file')+' '+human(d.size||0)+' from '+shortId(pid));
          self.conns[pid].recv.cur={ id:d.id, name:d.name, size:d.size||0, mime:d.mime||'application/octet-stream', got:0, parts:[] };
        }
        else if (d.type==='file-end'){
          var ctx=self.conns[pid].recv.cur;
          if (ctx && ctx.id===d.id){
            var blob=new Blob(ctx.parts,{type:ctx.mime}); var url=URL.createObjectURL(blob);
            pushFile(ctx.name, url, ctx.size, false);
            self.log('T52 FILE_RECV_END: '+ctx.name+' '+human(ctx.size)+' from '+shortId(pid));
            (function(u){ setTimeout(function(){ URL.revokeObjectURL(u); }, 60000); })(url);
            self.conns[pid].recv.cur=null;
          }
        }
        return;
      }
      // 二进制块
      var cur=self.conns[pid] && self.conns[pid].recv && self.conns[pid].recv.cur;
      if (!cur){ self.log('T51 FILE_RECV_PROGRESS: no ctx, dropped'); return; }
      var sz=0;
      if (d && d.byteLength!==undefined){ sz=d.byteLength; cur.parts.push(new Blob([d])); }
      else if (d && d.size!==undefined){ sz=d.size; cur.parts.push(d); }
      cur.got+=sz;
      var pct=cur.size?Math.min(100, Math.floor(cur.got*100/cur.size)):0;
      self.log('T51 FILE_RECV_PROGRESS: '+shortId(pid)+' '+pct+'%');
    });

    c.on('close', function(){
      if (inbound) self.log('T22 IN_CLOSE: '+shortId(pid)); else self.log('T13 OUT_CLOSE: '+shortId(pid));
      delete self.conns[pid]; self.updateInfo();
    });

    c.on('error', function(err){
      self.log('T14 OUT_ERROR: conn '+shortId(pid)+' '+(err && (err.message||err.type)||err));
    });
  }

  // 定时器
  function startTimers(){
    stopTimers();
    self.timers.up=setInterval(function(){
      if (!self.isConnected || !self.startAt) return;
      var s=Math.floor((Date.now()-self.startAt)/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
      var txt=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
      document.getElementById('uptime').textContent=txt;
    },1000);
    self.timers.ping=setInterval(function(){
      for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue;
        try{ self.conns[k].conn.send({type:'ping', ts:Date.now()}); self.log('T30 HEARTBEAT: ping '+shortId(k)); }catch(e){}
      }
    },5000);
  }
  function stopTimers(){ if (self.timers.up){clearInterval(self.timers.up); self.timers.up=null;} if (self.timers.ping){clearInterval(self.timers.ping); self.timers.ping=null;} }

  // 断开
  self.disconnect = function(){
    for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; try{ self.conns[k].conn.close(); }catch(e){} }
    self.conns={};
    safeDestroyPeer();
    stopTimers();
    self.isConnected=false; self.startAt=0; self.localId=''; self.virtualIp='';
    document.getElementById('chat').style.display='none';
    document.getElementById('tools').style.display='none';
    document.getElementById('share').style.display='none';
    self.setStatus('● 离线','offline');
    var btn=document.getElementById('connectBtn'); btn.textContent='🔌 连接网络'; btn.disabled=false;
    self.updateInfo();
    self.log('T90 PEER_CLOSE: disconnected');
  };

  // 初始化
  (function(){
    var pm=params();
    if (pm.network){ document.getElementById('networkName').value=pm.network; }
    var initSrv = pm.srv || self.candidates[0].host;
    var initPort = pm.port || self.candidates[0].port;
    self.log('> 就绪：点击“连接网络”开始（优先服务器 '+initSrv+':'+initPort+'）');
  })();

  return self;
})();

window.addEventListener('beforeunload', function(e){
  if (app.isConnected){ e.preventDefault(); e.returnValue='关闭页面将断开连接，确定吗？'; }
});