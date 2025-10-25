
/* 固定入口版（仅 /p2p1/ 就能用）
   - 固定服务器：peerjs.92k.de（同服锁定）
   - 固定网络名：public-network
   - 自动连接，无需参数；仅识别 ?peer= 用于拨号
   - 更快传输：默认 512KB 分片 + SCTP bufferedAmount 流控
   - 预览：图片即显；视频到阈值先预览，完成后不丢播放进度
   - 日志：T00..T99；仅对 open 的连接心跳；在线数只统计 open
*/
var app = (function(){
  var self = {};

  // 固定配置
  self.server = { host:'peerjs.92k.de', port:443, secure:true, path:'/' };
  self.network = 'public-network';

  // 传输参数
  self.chunkSize = 512 * 1024; // 512KB
  self.previewPct = 10;        // 视频达到 10% 先行预览
  self.highWater  = 1.5 * 1024 * 1024;
  self.lowWater   = 0.6 * 1024 * 1024;

  // ICE（STUN，稳定直连；VPN 下若要中继，另做 TURN 版）
  self.iceServers = [
    { urls:'stun:stun.l.google.com:19302' },
    { urls:'stun:global.stun.twilio.com:3478' },
    { urls:'stun:stun.services.mozilla.com' }
  ];

  // 状态
  self.peer = null;
  self.conns = {}; // peerId -> { conn, open:false, latency:0, sending:false, queue:[], recv:{cur,ui} }
  self.isConnected = false;
  self.startAt = 0;
  self.localId = ''; self.virtualIp = '';
  self.timers = { up:null, ping:null };
  self.logBuf = '> 初始化中...';

  // 工具
  function now(){ return new Date().toLocaleTimeString(); }
  function shortId(id){ return id ? id.substr(0,10)+'...' : ''; }
  function human(n){ if (n<1024) return n+' B'; if (n<1024*1024) return (n/1024).toFixed(1)+' KB'; if (n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB'; return (n/1024/1024/1024).toFixed(1)+' GB'; }
  function genIp(id){ var h=0; for (var i=0;i<id.length;i++){ h=(h*31+id.charCodeAt(i))>>>0; } return '10.144.'+(((h)&0xff)+1)+'.'+(((h>>8)&0xff)+1); }
  function getParamPeer(){ var s=window.location.search; if (!s||s.length<2) return ''; var m=s.match(/[?&]peer=([^&]+)/); return m? decodeURIComponent(m[1]):''; }

  // 日志
  self.log = function(s){ var el=document.getElementById('log'); self.logBuf += "\n["+now()+"] "+s; if (el){ el.textContent=self.logBuf; el.scrollTop=el.scrollHeight; } };
  self.copyLog = function(){ try{ if (navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(self.logBuf).then(function(){alert('日志已复制')}); } else { var ta=document.createElement('textarea'); ta.value=self.logBuf; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); alert('日志已复制'); } }catch(e){ alert('复制失败：'+e.message); } };
  self.clearLog = function(){ self.logBuf=''; var el=document.getElementById('log'); if (el) el.textContent=''; };

  // UI 辅助
  self.setStatus = function(txt, cls){ var st=document.getElementById('status'); if (st){ st.textContent=txt; st.className='status '+cls; } };
  self.updateInfo = function(){
    var openCount=0; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; if (self.conns[k].open) openCount++; }
    var lid=document.getElementById('localId'), vip=document.getElementById('virtualIp'), pc=document.getElementById('peerCount');
    if (lid) lid.textContent = self.localId ? shortId(self.localId) : '-';
    if (vip) vip.textContent = self.virtualIp || '-';
    if (pc) pc.textContent = String(openCount);
  };
  self.showShare = function(){
    var base = window.location.origin + window.location.pathname;
    var url  = base + '?peer=' + encodeURIComponent(self.localId); // 仅 peer 参数，已固定同服
    var input=document.getElementById('shareLink'); var box=document.getElementById('share'); var qr=document.getElementById('qr');
    if (input){ input.value=url; } if (box){ box.style.display='block'; } if (qr && window.QRCode){ qr.innerHTML=''; new QRCode(qr,{text:url,width:150,height:150}); }
  };
  self.copyLink = function(){ var el=document.getElementById('shareLink'); if (!el) return; try{ if (navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(el.value).then(function(){alert('已复制')}); } else { el.select(); document.execCommand('copy'); alert('已复制'); } }catch(e){ alert('复制失败：'+e.message); } };

  // 消息区
  function box(){ return document.getElementById('msgs'); }
  function escapeHtml(s){ return String(s||'').replace(/[&<>"']/g,function(c){return({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'})[c];}); }
  function appendMsg(inner, mine){ var b=box(); if (!b) return null; var div=document.createElement('div'); div.className='msg '+(mine?'me':'peer'); div.innerHTML=inner; b.appendChild(div); b.scrollTop=b.scrollHeight; return div; }
  function pushChat(text, mine){ return appendMsg('<small>'+now()+'</small><div>'+escapeHtml(text)+'</div>', mine); }
  function pushMediaPlaceholder(name,size,mine){ var html='<small>'+now()+'</small><div class="media-bubble"><div>'+escapeHtml(name)+' ('+human(size)+')</div><div class="progress-line">接收中… 0%</div></div>'; var el=appendMsg(html,mine); return { root:el, progress:el?el.querySelector('.progress-line'):null, mediaWrap:el?el.querySelector('.media-bubble'):null }; }
  function updateProgress(ui,p){ if (ui&&ui.progress){ ui.progress.textContent='接收中… '+p+'%'; } }
  function wrapOpenInNew(url, innerHtml){ return '<a href="'+url+'" target="_blank" rel="noopener">'+innerHtml+'</a>'; }
  function showImage(ui,url){ if (!ui||!ui.mediaWrap) return; ui.mediaWrap.innerHTML = wrapOpenInNew(url,'<img class="media-thumb" src="'+url+'" alt="image">')+'<div class="progress-line">图片可预览</div>'; }
  function showVideo(ui,url,note,restore){ if (!ui||!ui.mediaWrap) return;
    var info = note || '可预览';
    ui.mediaWrap.innerHTML = wrapOpenInNew(url,'<video class="media-video" controls preload="metadata" src="'+url+'"></video>')+'<div class="progress-line">'+info+'</div>';
    // 恢复播放位置
    if (restore && typeof restore.time==='number'){
      var v = ui.mediaWrap.querySelector('video');
      if (v){
        v.addEventListener('loadedmetadata', function(){ try{ v.currentTime = Math.min(restore.time, (v.duration||restore.time)); if (!restore.paused) v.play().catch(function(){}); }catch(e){} }, {once:true});
      }
    }
  }
  function showFileLink(ui,url,name,size){ if (!ui||!ui.mediaWrap) return; var safe=escapeHtml(name||'文件'); ui.mediaWrap.innerHTML = '<a href="'+url+'" target="_blank" rel="noopener" download="'+safe+'">下载：'+safe+' ('+human(size)+')</a>'; }

  self.sendMsg = function(){
    var ipt=document.getElementById('msgInput'); if (!ipt) return; var t=(ipt.value||'').replace(/^\s+|\s+$/g,''); if (!t) return; ipt.value='';
    pushChat(t,true);
    var sent=0; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; var st=self.conns[k]; if (!st.open) continue; try{ st.conn.send({type:'chat', text:t}); sent++; }catch(e){ self.log('T14 OUT_ERROR: send chat '+(e.message||e)); } }
    if (!sent) self.log('T14 OUT_ERROR: no peers open');
  };

  // 文件（队列 + 流控）
  self.sendFiles = function(){
    var fi=document.getElementById('fileInput'); if (!fi||!fi.files||fi.files.length===0){ alert('请选择文件'); return; }
    var peers=[]; for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; if (self.conns[k].open) peers.push(k); }
    if (!peers.length){ self.log('T40 FILE_SEND_BEGIN: no peers open'); return; }
    for (var i=0;i<fi.files.length;i++){ (function(file){ for (var j=0;j<peers.length;j++){ enqueueFile(peers[j],file); } })(fi.files[i]); }
    fi.value='';
  };
  function enqueueFile(peerId,file){ var st=self.conns[peerId]; if (!st||!st.open){ self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(peerId)); return; } if (!st.queue) st.queue=[]; st.queue.push(file); if (!st.sending){ st.sending=true; sendNext(peerId); } }
  function sendNext(peerId){ var st=self.conns[peerId]; if (!st) return; var f=st.queue.shift(); if (!f){ st.sending=false; return; } sendFile(peerId,f,function(){ sendNext(peerId); }); }
  function getBuffered(c){ try{ if (c&&c._dc&&typeof c._dc.bufferedAmount==='number') return c._dc.bufferedAmount; if (c&&typeof c.bufferSize==='number') return c.bufferSize; }catch(e){} return 0; }
  function flowSend(c,data,cb){ var trySend=function(){ if (getBuffered(c) > self.highWater){ setTimeout(trySend,20); return; } try{ c.send(data); }catch(e){ cb(e); return; } cb(null); }; trySend(); }
  function sendFile(peerId,file,done){
    var st=self.conns[peerId]; if (!st||!st.open){ self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(peerId)); return done&&done(); }
    var c=st.conn, id=String(Date.now())+'_'+Math.floor(Math.random()*1e6), chunk=self.chunkSize, off=0, lastTs=0, lastPct=-1;
    self.log('T40 FILE_SEND_BEGIN: '+shortId(peerId)+' '+file.name+' '+human(file.size));
    try{ c.send({type:'file-begin', id:id, name:file.name, size:file.size, mime:file.type||'application/octet-stream', chunk:chunk}); }catch(e){ self.log('T14 OUT_ERROR: file meta '+(e.message||e)); return done&&done(); }
    var reader=new FileReader();
    reader.onerror=function(){ self.log('T14 OUT_ERROR: file read'); done&&done(); };
    reader.onload=function(e){
      flowSend(c,e.target.result,function(err){
        if (err){ self.log('T14 OUT_ERROR: data send '+(err.message||err)); return done&&done(); }
        off+=e.target.result.byteLength; var pct=Math.min(100,Math.floor(off*100/file.size)); var nowTs=Date.now();
        if (pct!==lastPct && (nowTs-lastTs>200 || pct===100)){ self.log('T41 FILE_SEND_PROGRESS: '+shortId(peerId)+' '+pct+'%'); lastTs=nowTs; lastPct=pct; }
        if (off<file.size){ setTimeout(readNext,0); } else { try{ c.send({type:'file-end', id:id}); }catch(e2){} self.log('T42 FILE_SEND_END: '+file.name+' -> '+shortId(peerId));
          try{ var url=URL.createObjectURL(file); // 自己这边也给预览/新页
            if ((file.type||'').indexOf('image/')===0) showImage({mediaWrap:box()}, url);
            else if ((file.type||'').indexOf('video/')===0) showVideo({mediaWrap:box()}, url, '本地预览', null);
            setTimeout(function(){ URL.revokeObjectURL(url); }, 60000);
          }catch(ee){} done&&done();
        }
      });
    };
    function readNext(){ var slice=file.slice(off,Math.min(off+chunk,file.size)); reader.readAsArrayBuffer(slice); }
    readNext();
  }

  // 连接流程
  self.toggle = function(){
    if (self.isConnected){ self.disconnect(); return; }
    self.log('T00 UI_CLICK_CONNECT: network='+self.network);
    connectStart();
  };
  function connectStart(){
    var btn=document.getElementById('connectBtn'); if (btn){ btn.textContent='连接中...'; btn.disabled=true; }
    self.setStatus('● 连接中...','connecting');
    self.log('T05 ICE_CONFIG: stun=3 turn=0 forceRelay=0');
    tryPeer(self.server);
  }
  function tryPeer(s){
    self.log('T01 PEER_CREATE: '+s.host+':'+s.port+' ssl='+(s.secure?1:0)+' path='+s.path);
    var p; try{ p=new Peer(null,{host:s.host,port:s.port,secure:s.secure,path:s.path,config:{iceServers:self.iceServers}}); }catch(e){ self.log('T04 PEER_ERROR: init '+(e.message||e)); return failUI(); }
    self.peer=p;
    var opened=false, t=setTimeout(function(){ if (!opened){ self.log('T03 PEER_OPEN_TIMEOUT: '+s.host); safeDestroyPeer(); failUI(); } },10000);
    p.on('open', function(id){
      opened=true; clearTimeout(t);
      self.localId=id; self.virtualIp=genIp(id); self.isConnected=true; self.startAt=Date.now();
      self.setStatus('● 在线','online'); var b=document.getElementById('connectBtn'); if (b){ b.textContent='🔌 断开'; b.disabled=false; }
      document.getElementById('chat') && (document.getElementById('chat').style.display='block');
      document.getElementById('tools') && (document.getElementById('tools').style.display='block');
      self.updateInfo(); self.showShare(); self.log('T02 PEER_OPEN_OK: id='+id);
      var toDial=getParamPeer(); if (toDial){ self.log('T10 JOIN_PARAM: peer='+toDial); setTimeout(function(){ connectPeer(toDial); },400); }
      startTimers();
    });
    p.on('connection', function(conn){ handleConn(conn,true); });
    p.on('error', function(err){ self.log('T04 PEER_ERROR: '+(err && (err.message||err.type)||err)); });
    p.on('disconnected', function(){ self.log('T90 PEER_DISCONNECTED: will reconnect'); try{ p.reconnect(); }catch(e){} });
    p.on('close', function(){ self.log('T90 PEER_CLOSE'); });
  }
  function failUI(){ self.setStatus('● 离线','offline'); var b=document.getElementById('connectBtn'); if (b){ b.textContent='🔌 连接网络'; b.disabled=false; } }
  function safeDestroyPeer(){ try{ if (self.peer) self.peer.destroy(); }catch(e){} self.peer=null; }

  // 拨号
  function connectPeer(peerId){
    if (!self.peer || !peerId || peerId===self.localId) return;
    if (self.conns[peerId] && self.conns[peerId].open) return;
    self.log('T11 OUT_DIAL: '+peerId);
    var c; try{ c=self.peer.connect(peerId,{reliable:true}); }catch(e){ self.log('T14 OUT_ERROR: connect '+(e.message||e)); return; }
    handleConn(c,false);
    setTimeout(function(){ var st=self.conns[peerId]; if (!st||!st.open){ try{ c.close(); }catch(e){} self.log('T14 OUT_ERROR: dial timeout '+shortId(peerId)); } },12000);
  }

  function handleConn(c,inbound){
    if (!c||!c.peer) return; var pid=c.peer;
    if (self.conns[pid] && self.conns[pid].open){ self.log('T60 DEDUP_CLOSE: '+shortId(pid)); try{ c.close(); }catch(e){} return; }
    if (!self.conns[pid]) self.conns[pid]={ conn:c, open:false, latency:0, sending:false, queue:[], recv:{cur:null,ui:null} };
    if (inbound) self.log('T20 IN_CONN: '+shortId(pid)); else self.log('T11 OUT_DIAL: pending '+shortId(pid));
    c.on('open', function(){ self.conns[pid].open=true; if (inbound) self.log('T21 IN_OPEN: '+shortId(pid)); else self.log('T12 OUT_OPEN: '+shortId(pid)); self.updateInfo(); try{ c.send({type:'hello',id:self.localId,ip:self.virtualIp,network:self.network}); }catch(e){} });
    c.on('data', function(d){
      if (d && typeof d==='object' && d.type){
        if (d.type==='hello'){ self.log('T20 IN_CONN: hello from '+shortId(pid)+' ip='+(d.ip||'-')); }
        else if (d.type==='ping'){ if (self.conns[pid].open){ try{ c.send({type:'pong',ts:d.ts}); }catch(e){} } }
        else if (d.type==='pong'){ var lat=Date.now()-(d.ts||Date.now()); self.conns[pid].latency=lat; self.log('T31 PONG: '+shortId(pid)+' rtt='+lat+'ms'); self.updateInfo(); }
        else if (d.type==='chat'){ pushChat(String(d.text||''),false); }
        else if (d.type==='file-begin'){
          self.log('T50 FILE_RECV_BEGIN: '+(d.name||'file')+' '+human(d.size||0)+' from '+shortId(pid));
          var ui=pushMediaPlaceholder(d.name||'文件',d.size||0,false);
          self.conns[pid].recv.cur={ id:d.id, name:d.name, size:d.size||0, mime:d.mime||'application/octet-stream', got:0, parts:[], previewed:false, previewUrl:null, videoState:null };
          self.conns[pid].recv.ui=ui;
        } else if (d.type==='file-end'){ finalizeReceive(pid,d.id); }
        return;
      }
      var st=self.conns[pid], ctx=st&&st.recv&&st.recv.cur, ui=st&&st.recv&&st.recv.ui; if (!ctx) { self.log('T51 FILE_RECV_PROGRESS: no ctx, dropped'); return; }
      var sz=0; if (d && d.byteLength!==undefined){ sz=d.byteLength; ctx.parts.push(new Blob([d])); } else if (d && d.size!==undefined){ sz=d.size; ctx.parts.push(d); }
      ctx.got+=sz; var pct=ctx.size?Math.min(100,Math.floor(ctx.got*100/ctx.size)):0;
      if (!ctx._lastLogTs || Date.now()-ctx._lastLogTs>200 || pct===100){ self.log('T51 FILE_RECV_PROGRESS: '+shortId(pid)+' '+pct+'%'); ctx._lastLogTs=Date.now(); }
      updateProgress(ui,pct);
      // 对视频进行一次预览，且记住播放状态，最后替换不丢进度
      if (!ctx.previewed){
        try{
          var url=URL.createObjectURL(new Blob(ctx.parts,{type:ctx.mime}));
          if ((ctx.mime||'').indexOf('image/')===0){ showImage(ui,url); ctx.previewed=true; ctx.previewUrl=url; }
          else if ((ctx.mime||'').indexOf('video/')===0){
            var need=Math.max(1,Math.floor(ctx.size*self.previewPct/100));
            if (ctx.got>=need){
              showVideo(ui,url,'可预览（未完成）',null); ctx.previewed=true; ctx.previewUrl=url;
              var v=ui.mediaWrap.querySelector('video'); if (v){ // 记录播放状态
                ctx.videoState={ time:0, paused:true }; v.addEventListener('timeupdate',function(){ ctx.videoState.time = v.currentTime||0; ctx.videoState.paused = v.paused; });
              }
            } else { URL.revokeObjectURL(url); }
          }
        }catch(e){}
      } else {
        // 如果已经在预览视频，更新记录的播放状态（上面 timeupdate 也会更新）
      }
    });
    c.on('close', function(){ if (inbound) self.log('T22 IN_CLOSE: '+shortId(pid)); else self.log('T13 OUT_CLOSE: '+shortId(pid)); // 清理预览URL
      try{ var r=self.conns[pid]&&self.conns[pid].recv&&self.conns[pid].recv.cur; if (r&&r.previewUrl) URL.revokeObjectURL(r.previewUrl); }catch(e){}
      delete self.conns[pid]; self.updateInfo(); });
    c.on('error', function(err){ self.log('T14 OUT_ERROR: conn '+shortId(pid)+' '+(err && (err.message||err.type)||err)); });
  }

  function finalizeReceive(pid,id){
    var st=self.conns[pid]; if (!st||!st.recv) return; var ctx=st.recv.cur, ui=st.recv.ui; if (!ctx||ctx.id!==id) return;
    var blob=new Blob(ctx.parts,{type:ctx.mime}); var url=URL.createObjectURL(blob);
    if ((ctx.mime||'').indexOf('image/')===0){ showImage(ui,url); }
    else if ((ctx.mime||'').indexOf('video/')===0){
      var restore = ctx.videoState ? { time:ctx.videoState.time||0, paused:ctx.videoState.paused } : null;
      showVideo(ui,url,'接收完成', restore);
    } else { showFileLink(ui,url,ctx.name,ctx.size); }
    self.log('T52 FILE_RECV_END: '+(ctx.name||'文件')+' '+human(ctx.size)+' from '+shortId(pid));
    try{ if (ctx.previewUrl) URL.revokeObjectURL(ctx.previewUrl); }catch(e){} (function(u){ setTimeout(function(){ URL.revokeObjectURL(u); },60000); })(url);
    st.recv.cur=null; st.recv.ui=null;
  }

  // 定时器（仅对 open 的连接）
  function startTimers(){
    stopTimers();
    self.timers.up=setInterval(function(){ if (!self.isConnected||!self.startAt) return; var s=Math.floor((Date.now()-self.startAt)/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60; var t=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec; var up=document.getElementById('uptime'); if (up) up.textContent=t; },1000);
    self.timers.ping=setInterval(function(){ for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; var st=self.conns[k]; if (!st.open) continue; try{ st.conn.send({type:'ping',ts:Date.now()}); self.log('T30 HEARTBEAT: ping '+shortId(k)); }catch(e){} } },5000);
  }
  function stopTimers(){ if (self.timers.up){clearInterval(self.timers.up); self.timers.up=null;} if (self.timers.ping){clearInterval(self.timers.ping); self.timers.ping=null;} }

  self.disconnect = function(){
    for (var k in self.conns){ if (!self.conns.hasOwnProperty(k)) continue; try{ self.conns[k].conn.close(); }catch(e){} }
    self.conns={}; safeDestroyPeer(); stopTimers(); self.isConnected=false; self.startAt=0; self.localId=''; self.virtualIp='';
    var c=document.getElementById('chat'); if (c) c.style.display='none'; var t=document.getElementById('tools'); if (t) t.style.display='none'; var s=document.getElementById('share'); if (s) s.style.display='none';
    self.setStatus('● 离线','offline'); var b=document.getElementById('connectBtn'); if (b){ b.textContent='🔌 连接网络'; b.disabled=false; } self.updateInfo(); self.log('T90 PEER_CLOSE: disconnected');
  };

  function safeDestroyPeer(){ try{ if (self.peer) self.peer.destroy(); }catch(e){} self.peer=null; }

  // 初始化
  (function(){ self.log('> 就绪：点击“连接网络”开始（固定服务器 '+self.server.host+':'+self.server.port+'）'); })();

  return self;
})();

window.addEventListener('beforeunload', function(e){ if (app.isConnected){ e.preventDefault(); e.returnValue='关闭页面将断开连接，确定吗？'; } });