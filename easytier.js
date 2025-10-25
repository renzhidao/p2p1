
/* ES5 安卓兼容 + 更稳：
   - 同服锁定（srv/port/ssl/path），无则候选(0.peerjs.com→92k)
   - TURN/relay：URL 支持 turnUrl/turnUser/turnPass（可多组，编号1..5），forceRelay=1
   - 大块传输(默认256KB) + SCTP bufferedAmount 流控 + 进度节流
   - 图片即时预览；视频：首帧海报 + 阈值到达时先行预览，完成后替换完整
   - 详细日志：T00..T99，含 T93 VPN_HINT
   - 心跳/在线计数：仅对 open 的连接
*/
var app = (function(){
  var self = {};

  // 候选 PeerServer（无锁服参数时按序尝试）
  self.candidates = [
    { host:'0.peerjs.com', secure:true, port:443, path:'/' },
    { host:'peerjs.92k.de', secure:true, port:443, path:'/' }
  ];
  self.server = null;
  self.lockedByParam = false;
  self.openTimeoutMs = 10000;
  self.dialTimeoutMs = 12000;

  // 传输参数（可通过 URL 覆盖：chunk、previewPct）
  self.chunkSize = 256 * 1024; // 256KB
  self.previewPct = 10; // 达到 10% 时尝试预览视频（一次）
  self.highWater = 1.5 * 1024 * 1024; // 1.5MB
  self.lowWater  = 0.6 * 1024 * 1024; // 0.6MB

  // ICE（可通过 URL 增减 TURN；forceRelay=1 时仅走中继）
  self.forceRelay = false;
  self.iceServers = [
    { urls:'stun:stun.l.google.com:19302' },
    { urls:'stun:global.stun.twilio.com:3478' },
    { urls:'stun:stun.services.mozilla.com' }
  ];
  self.turns = []; // {urls, username, credential}

  self.peer = null;
  self.conns = {}; // peerId -> { conn, open:false, latency:0, sending:false, queue:[], recv:{cur:{...}, ui:{...}}, failDial:0 }
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
    for (var i=0;i<arr.length;i++){
      var kv=arr[i].split('=');
      out[decodeURIComponent(kv[0]||'')]=decodeURIComponent(kv[1]||'');
    }
    return out;
  }

  function parseUrlOptions(){
    var pm = params();
    // 服务器锁定
    if (pm.srv || pm.port || pm.ssl || pm.path){
      self.lockedByParam = true;
      self.server = {
        host: pm.srv || self.candidates[0].host,
        port: pm.port ? (parseInt(pm.port,10)||443) : self.candidates[0].port,
        secure: (pm.ssl==='1'||pm.ssl==='true'||(pm.ssl===''?self.candidates[0].secure:true)),
        path: pm.path || self.candidates[0].path
      };
    }
    // 传输参数
    if (pm.chunk){ var c=parseInt(pm.chunk,10); if (c && c>16384 && c<=1024*1024) self.chunkSize=c; }
    if (pm.previewPct){ var p=parseInt(pm.previewPct,10); if (p>=1 && p<=90) self.previewPct=p; }
    // TURN
    self.forceRelay = (pm.forceRelay==='1'||pm.forceRelay==='true');
    var addTurn = function(url,user,pass){ if (url){ self.turns.push({urls:url, username:user||'', credential:pass||''}); } };
    // 支持 turnUrl/turnUser/turnPass 与编号 1..5
    addTurn(pm.turnUrl, pm.turnUser, pm.turnPass);
    for (var i=1;i<=5;i++){
      var u=pm['turnUrl'+i], usr=pm['turnUser'+i], ps=pm['turnPass'+i];
      addTurn(u,usr,ps);
    }
    // 自定义 STUN
    if (pm.stunUrl){ self.iceServers.push({urls:pm.stunUrl}); }
    for (var j=1;j<=5;j++){ var su=pm['stunUrl'+j]; if (su) self.iceServers.push({urls:su}); }
    // 合并 TURN
    for (var k=0;k<self.turns.length;k++){ self.iceServers.push(self.turns[k]); }
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
    var n=0; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; if (self.conns[k].open) n++; }
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
    if (self.turns.length){
      for (var i=0;i<self.turns.length;i++){
        var idx = (i===0?'':(i+1));
        u += '&turnUrl'+idx+'=' + encodeURIComponent(self.turns[i].urls);
        if (self.turns[i].username) u += '&turnUser'+idx+'=' + encodeURIComponent(self.turns[i].username);
        if (self.turns[i].credential) u += '&turnPass'+idx+'=' + encodeURIComponent(self.turns[i].credential);
      }
    }
    if (self.forceRelay) u += '&forceRelay=1';
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

  // 聊天/消息区
  function msgBox(){ return document.getElementById('msgs'); }
  function appendMsgHtml(inner, mine){
    var box=msgBox(); if (!box) return null;
    var div=document.createElement('div'); div.className='msg '+(mine?'me peer-me':'peer');
    div.innerHTML=inner;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }
  function pushChat(text, mine){ return appendMsgHtml('<small>'+now()+'</small><div>'+escapeHtml(text)+'</div>', mine); }
  function pushMediaPlaceholder(name, size, mine){
    var html = '<small>'+now()+'</small><div class="media-bubble">'
             + '<div>'+escapeHtml(name)+' ('+human(size)+')</div>'
             + '<div class="progress-line">接收中… 0%</div>'
             + '</div>';
    var el = appendMsgHtml(html, mine);
    return { root: el, progress: el ? el.querySelector('.progress-line') : null, mediaWrap: el ? el.querySelector('.media-bubble') : null };
  }
  function updateProgress(ui, pct){
    if (ui && ui.progress){ ui.progress.textContent = '接收中… '+pct+'%'; }
  }
  function showImage(ui, url){
    if (!ui || !ui.mediaWrap) return;
    ui.mediaWrap.innerHTML = '<img class="media-thumb" src="'+url+'" alt="image"><div class="progress-line">图片已接收</div>';
  }
  function showVideo(ui, url, note){
    if (!ui || !ui.mediaWrap) return;
    var n = note || '可预览';
    ui.mediaWrap.innerHTML = '<video class="media-video" controls preload="metadata" src="'+url+'"></video>'
                           + '<div class="progress-line">'+n+'</div>';
  }
  function showFileLink(ui, url, name, size){
    if (!ui || !ui.mediaWrap) return;
    var safe = escapeHtml(name||'文件');
    ui.mediaWrap.innerHTML = '<a href="'+url+'" download="'+safe+'">下载：'+safe+' ('+human(size)+')</a>';
  }
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[c];}); }

  self.sendMsg = function(){
    var ipt=document.getElementById('msgInput'); if (!ipt) return;
    var t=(ipt.value||'').replace(/^\s+|\s+$/g,''); if (!t) return; ipt.value='';
    pushChat(t,true);
    var sent=0; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; var st=self.conns[k];
      if (!st.open) continue;
      try{ st.conn.send({type:'chat', text:t}); sent++; }catch(e){ self.log('T14 OUT_ERROR: send chat '+(e.message||e)); }
    }
    if (!sent) self.log('T14 OUT_ERROR: no peers open');
  };

  // 文件传输（队列 + 流控）
  self.sendFiles = function(){
    var fi=document.getElementById('fileInput');
    if (!fi || !fi.files || fi.files.length===0){ alert('请选择文件'); return; }
    var peers=[]; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; if (self.conns[k].open) peers.push(k); }
    if (!peers.length){ self.log('T40 FILE_SEND_BEGIN: no peers open'); return; }
    for (var i=0;i<fi.files.length;i++){
      (function(file){
        for (var j=0;j<peers.length;j++){ enqueueFile(peers[j], file); }
      })(fi.files[i]);
    }
    fi.value='';
  };
  function enqueueFile(peerId, file){
    var st=self.conns[peerId]; if (!st || !st.open){ self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(peerId)); return; }
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
  function getBuffered(c){
    try{
      if (c && c._dc && typeof c._dc.bufferedAmount==='number') return c._dc.bufferedAmount;
      if (c && typeof c.bufferSize==='number') return c.bufferSize;
    }catch(e){}
    return 0;
  }
  function flowSend(c, data, cb){
    // 等待 bufferedAmount 下降
    var trySend=function(){
      var buf=getBuffered(c);
      if (buf > self.highWater){ setTimeout(trySend, 20); return; }
      try{ c.send(data); }catch(e){ cb(e); return; }
      cb(null);
    };
    trySend();
  }
  function sendFile(peerId, file, done){
    var st=self.conns[peerId]; if (!st || !st.open){ self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(peerId)); return done&&done(); }
    var c=st.conn, id=String(Date.now())+'_'+Math.floor(Math.random()*1e6);
    var chunk=self.chunkSize, off=0, lastLogTs=0, lastPct=-1;
    self.log('T40 FILE_SEND_BEGIN: '+shortId(peerId)+' '+file.name+' '+human(file.size));
    try{ c.send({type:'file-begin', id:id, name:file.name, size:file.size, mime:file.type||'application/octet-stream', chunk:chunk}); }
    catch(e){ self.log('T14 OUT_ERROR: file meta '+(e.message||e)); return done&&done(); }

    var reader=new FileReader();
    reader.onerror=function(){ self.log('T14 OUT_ERROR: file read failed'); done&&done(); };
    reader.onload=function(e){
      flowSend(c, e.target.result, function(err){
        if (err){ self.log('T14 OUT_ERROR: data send '+(err.message||err)); return done&&done(); }
        off+=e.target.result.byteLength;
        var pct = Math.min(100, Math.floor(off*100/file.size));
        var nowTs = Date.now();
        if (pct!==lastPct && (nowTs-lastLogTs>200 || pct===100)){ self.log('T41 FILE_SEND_PROGRESS: '+shortId(peerId)+' '+pct+'%'); lastLogTs=nowTs; lastPct=pct; }
        if (off<file.size){ setTimeout(readNext, 0); }
        else{
          try{ c.send({type:'file-end', id:id}); }catch(err2){}
          self.log('T42 FILE_SEND_END: '+file.name+' -> '+shortId(peerId));
          // 自己也展示
          try{
            var url=URL.createObjectURL(file);
            previewOrLink({mime:file.type||'', name:file.name, size:file.size, url:url}, true);
            setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
          }catch(ee){}
          done&&done();
        }
      });
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

    parseUrlOptions();
    self.log('T05 ICE_CONFIG: stun='+countKind('stun')+' turn='+countKind('turn')+' forceRelay='+(self.forceRelay?1:0));

    if (self.lockedByParam){ tryPeer(self.server); }
    else { tryCandidates(0); }
  }
  function countKind(kind){
    var n=0; for (var i=0;i<self.iceServers.length;i++){ var u=self.iceServers[i].urls||''; if (typeof u==='string'){ if (u.indexOf(kind+':')===0) n++; } else if (u && u.length){ for (var j=0;j<u.length;j++){ if (String(u[j]).indexOf(kind+':')===0) n++; } } }
    return n;
  }

  function tryCandidates(i){
    if (i >= self.candidates.length){ self.log('T03 PEER_OPEN_TIMEOUT: all servers failed'); self.log('T93 VPN_HINT: 服务器不可达，检查网络/VPN或改用 TURN + ?forceRelay=1'); failUI(); return; }
    var s=self.candidates[i]; self.server = { host:s.host, port:s.port, secure:s.secure, path:(s.path||'/') };
    tryPeer(self.server, function(){ tryCandidates(i+1); });
  }
  function tryPeer(s, onFailNext){
    self.log('T01 PEER_CREATE: '+s.host+':'+s.port+' ssl='+(s.secure?1:0)+' path='+s.path);
    var cfg = { iceServers: self.iceServers };
    if (self.forceRelay){ cfg.iceTransportPolicy = 'relay'; self.log('T92 RELAY_MODE: force relay enabled'); }
    var opts={ host:s.host, port:s.port, secure:s.secure, path:s.path, config: cfg };
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
      if (self.lockedByParam){ self.log('T93 VPN_HINT: Peer open 超时（锁服），可能被 VPN/防火墙拦截，尝试关闭 VPN 或使用 TURN'); failUI(); }
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

      // 自动拨号
      var pm=params();
      if (pm.peer){ self.log('T10 JOIN_PARAM: peer='+pm.peer); setTimeout(function(){ connectPeer(pm.peer); }, 400); }
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
    if (self.conns[peerId] && self.conns[peerId].open) return;
    self.log('T11 OUT_DIAL: '+peerId);
    var c; try{ c=self.peer.connect(peerId, { reliable:true }); }catch(e){ self.log('T14 OUT_ERROR: connect '+(e.message||e)); return; }
    handleConn(c, false);

    var timedOut=false;
    setTimeout(function(){
      if (!timedOut){
        var st=self.conns[peerId];
        if (!st || !st.open){
          timedOut=true;
          try{ c.close(); }catch(e){}
          if (st){ st.failDial=(st.failDial||0)+1; if (st.failDial>=2){ self.log('T93 VPN_HINT: 多次拨号超时，可能被 VPN/防火墙拦截；关闭 VPN 或使用 TURN + ?forceRelay=1'); } }
          self.log('T14 OUT_ERROR: dial timeout '+shortId(peerId));
        }
      }
    }, self.dialTimeoutMs);
  }

  // 连接入出处理
  function handleConn(c, inbound){
    if (!c || !c.peer) return;
    var pid=c.peer;

    if (self.conns[pid] && self.conns[pid].open){
      self.log('T60 DEDUP_CLOSE: '+shortId(pid));
      try{ c.close(); }catch(e){}
      return;
    }
    if (!self.conns[pid]) self.conns[pid]={ conn:c, open:false, latency:0, sending:false, queue:[], recv:{cur:null, ui:null}, failDial:0 };
    if (inbound) self.log('T20 IN_CONN: '+shortId(pid)); else self.log('T11 OUT_DIAL: pending '+shortId(pid));

    c.on('open', function(){
      self.conns[pid].open=true;
      if (inbound) self.log('T21 IN_OPEN: '+shortId(pid)); else self.log('T12 OUT_OPEN: '+shortId(pid));
      self.updateInfo();
      try{ c.send({type:'hello', id:self.localId, ip:self.virtualIp, network:self.network}); }catch(e){}
    });

    c.on('data', function(d){
      // 控制消息
      if (d && typeof d==='object' && d.type){
        if (d.type==='hello'){ self.log('T20 IN_CONN: hello from '+shortId(pid)+' ip='+(d.ip||'-')); }
        else if (d.type==='ping'){ if (self.conns[pid].open){ try{ c.send({type:'pong', ts:d.ts}); }catch(e){} } }
        else if (d.type==='pong'){
          var lat=Date.now()-(d.ts||Date.now());
          self.conns[pid].latency=lat; self.log('T31 PONG: '+shortId(pid)+' rtt='+lat+'ms'); self.updateInfo();
        }
        else if (d.type==='chat'){ pushChat(String(d.text||''), false); }
        else if (d.type==='file-begin'){
          self.log('T50 FILE_RECV_BEGIN: '+(d.name||'file')+' '+human(d.size||0)+' from '+shortId(pid));
          var ui = pushMediaPlaceholder(d.name||'文件', d.size||0, false);
          self.conns[pid].recv.cur={ id:d.id, name:d.name, size:d.size||0, mime:d.mime||'application/octet-stream', got:0, parts:[], previewed:false, previewUrl:null };
          self.conns[pid].recv.ui = ui;
        }
        else if (d.type==='file-end'){
          finalizeReceive(pid, d.id);
        }
        return;
      }
      // 二进制块
      var ctx=self.conns[pid] && self.conns[pid].recv && self.conns[pid].recv.cur;
      var ui=self.conns[pid] && self.conns[pid].recv && self.conns[pid].recv.ui;
      if (!ctx){ self.log('T51 FILE_RECV_PROGRESS: no ctx, dropped'); return; }
      var sz=0;
      if (d && d.byteLength!==undefined){ sz=d.byteLength; ctx.parts.push(new Blob([d])); }
      else if (d && d.size!==undefined){ sz=d.size; ctx.parts.push(d); }
      ctx.got+=sz;
      var pct = ctx.size ? Math.min(100, Math.floor(ctx.got*100/ctx.size)) : 0;
      // 进度节流
      if (!ctx._lastPctLogged || pct!==ctx._lastPctLogged){
        var nowTs = Date.now();
        if (!ctx._lastLogTs || nowTs-ctx._lastLogTs>200 || pct===100){
          self.log('T51 FILE_RECV_PROGRESS: '+shortId(pid)+' '+pct+'%'); ctx._lastLogTs=nowTs; ctx._lastPctLogged=pct;
        }
      }
      updateProgress(ui, pct);
      // 预览：图片立即（收到第一块后），视频在达到阈值一次
      if (!ctx.previewed){
        try{
          var url = URL.createObjectURL(new Blob(ctx.parts, {type:ctx.mime}));
          if ((ctx.mime||'').indexOf('image/')===0){
            showImage(ui, url); ctx.previewed=true; ctx.previewUrl=url;
          }else if ((ctx.mime||'').indexOf('video/')===0){
            var need = Math.max(1, Math.floor(ctx.size*self.previewPct/100));
            if (ctx.got >= need){
              showVideo(ui, url, '可预览（未完成）'); ctx.previewed=true; ctx.previewUrl=url;
            }else{ URL.revokeObjectURL(url); }
          }else{
            // 其他类型不预览
          }
        }catch(e){}
      }
    });

    c.on('close', function(){
      if (inbound) self.log('T22 IN_CLOSE: '+shortId(pid)); else self.log('T13 OUT_CLOSE: '+shortId(pid));
      if (self.conns[pid] && self.conns[pid].recv){
        // 清理预览 URL
        try{ if (self.conns[pid].recv.cur && self.conns[pid].recv.cur.previewUrl) URL.revokeObjectURL(self.conns[pid].recv.cur.previewUrl); }catch(e){}
      }
      delete self.conns[pid]; self.updateInfo();
    });

    c.on('error', function(err){
      self.log('T14 OUT_ERROR: conn '+shortId(pid)+' '+(err && (err.message||err.type)||err));
      var st=self.conns[pid]; if (st){ st.failDial=(st.failDial||0)+1; if (!st.open && st.failDial>=2){ self.log('T93 VPN_HINT: 建链失败，检查 VPN/公司网策略；或使用 TURN + ?forceRelay=1'); } }
    });
  }

  function finalizeReceive(pid, id){
    var st=self.conns[pid]; if (!st || !st.recv) return;
    var ctx=st.recv.cur, ui=st.recv.ui;
    if (!ctx || ctx.id!==id) return;
    var blob=new Blob(ctx.parts,{type:ctx.mime}); var url=URL.createObjectURL(blob);
    if ((ctx.mime||'').indexOf('image/')===0){
      showImage(ui, url);
    }else if ((ctx.mime||'').indexOf('video/')===0){
      showVideo(ui, url, '接收完成');
    }else{
      showFileLink(ui, url, ctx.name, ctx.size);
    }
    self.log('T52 FILE_RECV_END: '+(ctx.name||'文件')+' '+human(ctx.size)+' from '+shortId(pid));
    // 清理旧预览
    try{ if (ctx.previewUrl) URL.revokeObjectURL(ctx.previewUrl); }catch(e){}
    // 最终 URL 1 分钟后释放（给用户下载/播放时间）
    (function(u){ setTimeout(function(){ URL.revokeObjectURL(u); }, 60000); })(url);
    st.recv.cur=null; st.recv.ui=null;
  }

  // 定时器：仅对 open 的连接
  function startTimers(){
    stopTimers();
    self.timers.up=setInterval(function(){
      if (!self.isConnected || !self.startAt) return;
      var s=Math.floor((Date.now()-self.startAt)/1000), h=Math.floor(s/3600), m=Math.floor((s%3600)/60), sec=s%60;
      var txt=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
      document.getElementById('uptime').textContent=txt;
    },1000);
    self.timers.ping=setInterval(function(){
      for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; var st=self.conns[k];
        if (!st.open) continue;
        try{ st.conn.send({type:'ping', ts:Date.now()}); self.log('T30 HEARTBEAT: ping '+shortId(k)); }catch(e){}
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
    // 允许通过 URL 设置 chunk/previewPct/forceRelay/turn*
    if (pm.chunk){ var c=parseInt(pm.chunk,10); if (c && c>16384 && c<=1024*1024) self.chunkSize=c; }
    if (pm.previewPct){ var p=parseInt(pm.previewPct,10); if (p>=1 && p<=90) self.previewPct=p; }
    self.log('> 就绪：点击“连接网络”开始（优先服务器 '+(pm.srv||self.candidates[0].host)+':'+(pm.port||self.candidates[0].port)+'）');
  })();

  return self;
})();

window.addEventListener('beforeunload', function(e){
  if (app.isConnected){ e.preventDefault(); e.returnValue='关闭页面将断开连接，确定吗？'; }
});