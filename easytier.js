
/* 固定入口核心：同服锁定（peerjs.92k.de）+ 公网 STUN；DataChannel 文本/文件；图片即显、视频阈值预览，合并后保留播放进度；
   更快传输：512KB + bufferedAmount 流控；日志 Txx；仅对 open 心跳；在线数只统计 open；简易“缓存者优先”回源（完整文件持久化后作为源）。
*/
var app=(function(){
  var self={};

  // 固定配置
  self.server={host:'peerjs.92k.de',port:443,secure:true,path:'/'};
  self.network='public-network';

  // 传输参数
  self.chunkSize=512*1024; self.previewPct=10;
  self.highWater=1.5*1024*1024; self.lowWater=0.6*1024*1024;

  // ICE
  self.iceServers=[
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:global.stun.twilio.com:3478'},
    {urls:'stun:stun.services.mozilla.com'}
  ];

  // 状态
  self.peer=null; self.conns={}; self.isConnected=false; self.startAt=0;
  self.localId=''; self.virtualIp='';
  self.timers={up:null,ping:null};
  self.logBuf='> 初始化中...';

  // 简易“完整缓存源列表”：hash -> Set(peerId)
  self.fullSources={}; // {hash: Set}
  // 本地缓存：IndexedDB（完成后持久化）
  var idb, idbReady=false; (function openIDB(){
    try{
      var req=indexedDB.open('p2p-cache',1);
      req.onupgradeneeded=function(e){ var db=e.target.result; if(!db.objectStoreNames.contains('files')) db.createObjectStore('files',{keyPath:'hash'}); };
      req.onsuccess=function(e){ idb=e.target.result; idbReady=true; };
      req.onerror=function(){ idbReady=false; };
    }catch(e){ idbReady=false; }
  })();
  function idbPut(hash, blob, meta){
    if(!idbReady) return;
    try{ var tx=idb.transaction('files','readwrite'); tx.objectStore('files').put({hash:hash, blob:blob, meta:meta, ts:Date.now()}); }catch(e){}
  }
  function idbGet(hash, cb){
    if(!idbReady) return cb(null);
    try{ var tx=idb.transaction('files','readonly'); var rq=tx.objectStore('files').get(hash);
      rq.onsuccess=function(){ cb(rq.result||null); }; rq.onerror=function(){ cb(null); };
    }catch(e){ cb(null); }
  }

  // 工具
  function now(){ return new Date().toLocaleTimeString(); }
  function shortId(id){ return id? id.substr(0,10)+'...' : ''; }
  function human(n){ if(n<1024) return n+' B'; if(n<1024*1024) return (n/1024).toFixed(1)+' KB'; if(n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB'; return (n/1024/1024/1024).toFixed(1)+' GB'; }
  function genIp(id){ var h=0; for(var i=0;i<id.length;i++){ h=(h*31+id.charCodeAt(i))>>>0; } return '10.144.'+(((h)&0xff)+1)+'.'+(((h>>8)&0xff)+1); }
  function getPeerParam(){ var s=window.location.search; if(!s||s.length<2) return ''; var m=s.match(/[?&]peer=([^&]+)/); return m? decodeURIComponent(m[1]):''; }

  // 简易内容哈希（弱）：name|size 的 sha-256
  function sha256(str){ var enc=new TextEncoder().encode(str); return crypto.subtle.digest('SHA-256', enc).then(buf=>{ var b=new Uint8Array(buf), s=''; for(var i=0;i<b.length;i++){ s+=('0'+b[i].toString(16)).slice(-2);} return s; }); }
  function fileHashMeta(file){ return sha256(file.name+'|'+file.size); }

  // 日志
  self.log=function(s){ var el=document.getElementById('log'); self.logBuf+="\n["+now()+"] "+s; if(el){ el.textContent=self.logBuf; el.scrollTop=el.scrollHeight; } };
  self.copyLog=function(){ try{ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(self.logBuf).then(function(){alert('日志已复制')}); }else{ var ta=document.createElement('textarea'); ta.value=self.logBuf; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); alert('日志已复制'); } }catch(e){ alert('复制失败：'+e.message); } };
  self.clearLog=function(){ self.logBuf=''; var el=document.getElementById('log'); if(el) el.textContent=''; };

  // UI
  function setStatus(txt,cls){ var st=document.getElementById('statusChip'); if(!st) st=document.getElementById('status'); if(st){ st.textContent=txt.replace('状态：',''); st.className = st.className||''; } }
  self.updateInfo=function(){
    var openCount=0; for(var k in self.conns){ if(!self.conns.hasOwnProperty(k)) continue; if(self.conns[k].open) openCount++; }
    var lid=document.getElementById('localId'), vip=document.getElementById('virtualIp'), pc=document.getElementById('peerCount');
    if(lid) lid.textContent = self.localId ? shortId(self.localId) : '-';
    if(vip) vip.textContent = self.virtualIp || '-';
    if(pc) pc.textContent = String(openCount);
    var onlineChip=document.getElementById('onlineChip'); if(onlineChip) onlineChip.textContent='在线 '+openCount;
    if(self._classic) self._classic.updateStatus();
  };
  self.showShare=function(){
    var base=window.location.origin+window.location.pathname;
    var url = base + '?peer='+encodeURIComponent(self.localId);
    var input=document.getElementById('shareLink'), box=document.getElementById('share'), qr=document.getElementById('qr');
    if(input) input.value=url; if(box) box.style.display='block'; if(qr&&window.QRCode){ qr.innerHTML=''; new QRCode(qr,{text:url,width:150,height:150}); }
  };
  self.copyLink=function(){ var el=document.getElementById('shareLink'); if(!el) return; try{ if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(el.value).then(function(){ alert('已复制')}); } else { el.select(); document.execCommand('copy'); alert('已复制'); } }catch(e){ alert('复制失败：'+e.message); } };

  // 消息→原版 UI
  function pushChat(text,mine){ if(self._classic) self._classic.appendChat(text,mine); }
  function placeholder(name,size,mine){ return self._classic? self._classic.placeholder(name,size,mine) : null; }
  function showImg(ui,url){ if(self._classic) self._classic.showImage(ui,url); }
  function showVid(ui,url,note,restore){ if(self._classic) self._classic.showVideo(ui,url,note,restore); }
  function fileLink(ui,url,name,size){ if(self._classic) self._classic.showFileLink(ui,url,name,size); }
  function updProg(ui,p){ if(self._classic) self._classic.updateProgress(ui,p); }

  // 发送文本
  self.sendMsg=function(){
    var ipt=document.getElementById('msgInput'); var val=(ipt&&ipt.value? ipt.value.trim(): '');
    if(!val) return;
    ipt.value='';
    pushChat(val,true);
    var sent=0; for(var k in self.conns){ if(!self.conns.hasOwnProperty(k)) continue; var st=self.conns[k]; if(!st.open) continue; try{ st.conn.send({type:'chat',text:val}); sent++; }catch(e){ self.log('T14 OUT_ERROR: chat '+(e.message||e)); } }
    if(!sent) self.log('T14 OUT_ERROR: no peers open');
  };

  // 发送文件：支持页面 file input 调用
  self.sendFiles=function(){
    var fi=document.getElementById('fileInput'); if(!fi||!fi.files||fi.files.length===0){ alert('请选择文件'); return; }
    self.sendFilesFrom([].slice.call(fi.files)); fi.value='';
  };
  self.sendFilesFrom=function(files){
    var peers=[]; for(var k in self.conns){ if(!self.conns.hasOwnProperty(k)) continue; if(self.conns[k].open) peers.push(k); }
    if(!peers.length){ self.log('T40 FILE_SEND_BEGIN: no peers open'); return; }
    files.forEach(function(file){
      // 为每个文件计算 hash（弱）用于缓存标识
      fileHashMeta(file).then(function(hash){
        peers.forEach(function(pid){ enqueueFile(pid,file,hash); });
      });
    });
  };
  function enqueueFile(pid,file,hash){
    var st=self.conns[pid]; if(!st||!st.open){ self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(pid)); return; }
    if(!st.queue) st.queue=[]; st.queue.push({file:file,hash:hash});
    if(!st.sending){ st.sending=true; sendNext(pid); }
  }
  function sendNext(pid){
    var st=self.conns[pid]; if(!st) return;
    var job=st.queue.shift(); if(!job){ st.sending=false; return; }
    sendFileTo(pid, job.file, job.hash, function(){ sendNext(pid); });
  }
  function getBuffered(c){ try{ if(c&&c._dc&&typeof c._dc.bufferedAmount==='number') return c._dc.bufferedAmount; if(c&&typeof c.bufferSize==='number') return c.bufferSize; }catch(e){} return 0; }
  function flowSend(c,data,cb){ var loop=function(){ if(getBuffered(c)>self.highWater){ setTimeout(loop,20); return; } try{ c.send(data);}catch(e){ cb(e); return;} cb(null);}; loop(); }
  function sendFileTo(pid,file,hash,done){
    var st=self.conns[pid]; if(!st||!st.open){ self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(pid)); return done&&done(); }
    var c=st.conn, id=String(Date.now())+'_'+Math.floor(Math.random()*1e6), chunk=self.chunkSize, off=0, lastTs=0, lastPct=-1;
    self.log('T40 FILE_SEND_BEGIN: '+shortId(pid)+' '+file.name+' '+human(file.size));
    try{ c.send({type:'file-begin',id:id,name:file.name,size:file.size,mime:file.type||'application/octet-stream',chunk:chunk,hash:hash}); }
    catch(e){ self.log('T14 OUT_ERROR: file meta '+(e.message||e)); return done&&done(); }
    var reader=new FileReader();
    reader.onerror=function(){ self.log('T14 OUT_ERROR: file read'); done&&done(); };
    reader.onload=function(e){
      flowSend(c,e.target.result,function(err){
        if(err){ self.log('T14 OUT_ERROR: data send '+(err.message||err)); return done&&done(); }
        off+=e.target.result.byteLength;
        var pct=Math.min(100,Math.floor(off*100/file.size)); var nowTs=Date.now();
        if(pct!==lastPct && (nowTs-lastTs>200 || pct===100)){ self.log('T41 FILE_SEND_PROGRESS: '+shortId(pid)+' '+pct+'%'); lastTs=nowTs; lastPct=pct; }
        if(off<file.size){ setTimeout(readNext,0); }
        else{ try{ c.send({type:'file-end',id:id,hash:hash}); }catch(e2){} self.log('T42 FILE_SEND_END: '+file.name+' -> '+shortId(pid));
          // 自己也做源：持久化
          try{ var url=URL.createObjectURL(file); setTimeout(function(){ URL.revokeObjectURL(url);},60000);}catch(ee){}
          try{ idbPut(hash,file,{name:file.name,size:file.size,mime:file.type||'application/octet-stream'}); self.fullSources[hash]=self.fullSources[hash]||new Set(); self.fullSources[hash].add(self.localId);}catch(e){}
          done&&done();
        }
      });
    };
    function readNext(){ var slice=file.slice(off,Math.min(off+chunk,file.size)); reader.readAsArrayBuffer(slice); }
    readNext();
  }

  // 连接
  self.toggle=function(){
    if(self.isConnected){ self.disconnect(); return; }
    self.log('T00 UI_CLICK_CONNECT: network='+self.network); connectStart();
  };
  function connectStart(){
    var btn=document.getElementById('connectBtn'); if(btn){ btn.textContent='连接中...'; btn.disabled=true; }
    setStatus('● 连接中...','connecting');
    self.log('T05 ICE_CONFIG: stun=3 turn=0 forceRelay=0'); tryPeer(self.server);
  }
  function tryPeer(s){
    self.log('T01 PEER_CREATE: '+s.host+':'+s.port+' ssl='+(s.secure?1:0)+' path='+s.path);
    var p; try{ p=new Peer(null,{host:s.host,port:s.port,secure:s.secure,path:s.path,config:{iceServers:self.iceServers}});}catch(e){ self.log('T04 PEER_ERROR: init '+(e.message||e)); return failUI(); }
    self.peer=p;
    var opened=false, t=setTimeout(function(){ if(!opened){ self.log('T03 PEER_OPEN_TIMEOUT: '+s.host); safeDestroyPeer(); failUI(); }},10000);
    p.on('open', function(id){
      opened=true; clearTimeout(t);
      self.localId=id; self.virtualIp=genIp(id); self.isConnected=true; self.startAt=Date.now();
      setStatus('● 在线','online');
      var b=document.getElementById('connectBtn'); if(b){ b.textContent='🔌 断开'; b.disabled=false; }
      var c=document.getElementById('chat'), tt=document.getElementById('tools'); if(c) c.style.display='block'; if(tt) tt.style.display='block';
      self.updateInfo(); self.showShare(); self.log('T02 PEER_OPEN_OK: id='+id);
      var toDial=getPeerParam(); if(toDial){ self.log('T10 JOIN_PARAM: peer='+toDial); setTimeout(function(){ connectPeer(toDial); },400); }
      startTimers();
    });
    p.on('connection', function(conn){ handleConn(conn,true); });
    p.on('error', function(err){ self.log('T04 PEER_ERROR: '+(err && (err.message||err.type)||err)); });
    p.on('disconnected', function(){ self.log('T90 PEER_DISCONNECTED: will reconnect'); try{ p.reconnect(); }catch(e){} });
    p.on('close', function(){ self.log('T90 PEER_CLOSE'); });
  }
  function failUI(){ setStatus('● 离线','offline'); var b=document.getElementById('connectBtn'); if(b){ b.textContent='🔌 连接网络'; b.disabled=false; } }
  function safeDestroyPeer(){ try{ if(self.peer) self.peer.destroy(); }catch(e){} self.peer=null; }

  // 拨号
  function connectPeer(pid){
    if(!self.peer || !pid || pid===self.localId) return;
    if(self.conns[pid] && self.conns[pid].open) return;
    self.log('T11 OUT_DIAL: '+pid);
    var c; try{ c=self.peer.connect(pid,{reliable:true}); }catch(e){ self.log('T14 OUT_ERROR: connect '+(e.message||e)); return; }
    handleConn(c,false);
    setTimeout(function(){ var st=self.conns[pid]; if(!st||!st.open){ try{ c.close(); }catch(e){} self.log('T14 OUT_ERROR: dial timeout '+shortId(pid)); } },12000);
  }

  function handleConn(c,inbound){
    if(!c||!c.peer) return;
    var pid=c.peer;
    if(self.conns[pid] && self.conns[pid].open){ self.log('T60 DEDUP_CLOSE: '+shortId(pid)); try{ c.close(); }catch(e){} return; }
    if(!self.conns[pid]) self.conns[pid]={ conn:c, open:false, latency:0, sending:false, queue:[], recv:{cur:null,ui:null} };
    if(inbound) self.log('T20 IN_CONN: '+shortId(pid)); else self.log('T11 OUT_DIAL: pending '+shortId(pid));
    c.on('open', function(){ self.conns[pid].open=true; if(inbound) self.log('T21 IN_OPEN: '+shortId(pid)); else self.log('T12 OUT_OPEN: '+shortId(pid)); self.updateInfo(); try{ c.send({type:'hello',id:self.localId,ip:self.virtualIp,network:self.network,fullList: Object.keys(self.fullSources)});}catch(e){} });
    c.on('data', function(d){
      if(d && typeof d==='object' && d.type){
        if(d.type==='hello'){ self.log('T20 IN_CONN: hello from '+shortId(pid)+' ip='+(d.ip||'-'));
          // 对方告知其拥有完整缓存的 hash 列表（散列名）
          if (d.fullList && Array.isArray(d.fullList)){ d.fullList.forEach(function(h){ self.fullSources[h]=self.fullSources[h]||new Set(); self.fullSources[h].add(pid); }); }
        }else if(d.type==='ping'){ if(self.conns[pid].open){ try{ c.send({type:'pong',ts:d.ts}); }catch(e){} } }
        else if(d.type==='pong'){ var lat=Date.now()-(d.ts||Date.now()); self.conns[pid].latency=lat; self.log('T31 PONG: '+shortId(pid)+' rtt='+lat+'ms'); self.updateInfo(); }
        else if(d.type==='chat'){ pushChat(String(d.text||''),false); }
        else if(d.type==='file-begin'){
          // 若本地已缓存该 hash，且完整，直接用本地文件供预览/播放，不再等待对方发送
          var h=d.hash||''; if(h){ idbGet(h, function(rec){ if(rec && rec.blob){ // 直接展示本地缓存
                var ui = placeholder(d.name||'文件', d.size||0, false);
                var url=URL.createObjectURL(rec.blob);
                if ((rec.meta?.mime||'').indexOf('image/')===0) showImg(ui,url);
                else if ((rec.meta?.mime||'').indexOf('video/')===0) showVid(ui,url,'本地缓存',null);
                else fileLink(ui,url,rec.meta?.name||d.name||'文件', rec.meta?.size||d.size||0);
                setTimeout(function(){ URL.revokeObjectURL(url); },60000);
                // 告知对方我有完整缓存
                try{ c.send({type:'file-end',id:d.id,hash:h}); }catch(e){}
                return;
            }});}
          self.log('T50 FILE_RECV_BEGIN: '+(d.name||'file')+' '+human(d.size||0)+' from '+shortId(pid));
          var ui=placeholder(d.name||'文件',d.size||0,false);
          self.conns[pid].recv.cur={id:d.id,name:d.name,size:d.size||0,mime:d.mime||'application/octet-stream',got:0,parts:[],previewed:false,previewUrl:null,videoState:null,hash:d.hash||''};
          self.conns[pid].recv.ui=ui;
        }else if(d.type==='file-end'){ finalizeReceive(pid,d.id,d.hash||''); }
        else if(d.type==='file-has'){ // 对方声明自己拥有完整 hash
          var h=d.hash; if(h){ self.fullSources[h]=self.fullSources[h]||new Set(); self.fullSources[h].add(pid); }
        }
        return;
      }
      // 二进制块
      var st=self.conns[pid], ctx=st&&st.recv&&st.recv.cur, ui=st&&st.recv&&st.recv.ui; if(!ctx){ self.log('T51 FILE_RECV_PROGRESS: no ctx, dropped'); return; }
      var sz=0; if(d && d.byteLength!==undefined){ sz=d.byteLength; ctx.parts.push(new Blob([d])); } else if(d && d.size!==undefined){ sz=d.size; ctx.parts.push(d); }
      ctx.got+=sz; var pct=ctx.size?Math.min(100,Math.floor(ctx.got*100/ctx.size)):0;
      updProg(ui,pct);
      // 预览
      if(!ctx.previewed){
        try{
          var url=URL.createObjectURL(new Blob(ctx.parts,{type:ctx.mime}));
          if ((ctx.mime||'').indexOf('image/')===0){ showImg(ui,url); ctx.previewed=true; ctx.previewUrl=url; }
          else if ((ctx.mime||'').indexOf('video/')===0){
            var need=Math.max(1,Math.floor(ctx.size*self.previewPct/100));
            if(ctx.got>=need){ showVid(ui,url,'可预览（未完成）',null); ctx.previewed=true; ctx.previewUrl=url;
              var v=ui.mediaWrap.querySelector('video'); if(v){ ctx.videoState={time:0,paused:true}; v.addEventListener('timeupdate',function(){ ctx.videoState.time=v.currentTime||0; ctx.videoState.paused=v.paused; }); }
            } else { URL.revokeObjectURL(url); }
          }
        }catch(e){}
      }
    });
    c.on('close', function(){
      if(inbound) self.log('T22 IN_CLOSE: '+shortId(pid)); else self.log('T13 OUT_CLOSE: '+shortId(pid));
      try{ var r=self.conns[pid]&&self.conns[pid].recv&&self.conns[pid].recv.cur; if(r&&r.previewUrl) URL.revokeObjectURL(r.previewUrl);}catch(e){}
      delete self.conns[pid]; self.updateInfo();
    });
    c.on('error', function(err){ self.log('T14 OUT_ERROR: conn '+shortId(pid)+' '+(err && (err.message||err.type)||err)); });
  }

  function finalizeReceive(pid,id,hash){
    var st=self.conns[pid]; if(!st||!st.recv) return;
    var ctx=st.recv.cur, ui=st.recv.ui; if(!ctx||ctx.id!==id) return;
    var blob=new Blob(ctx.parts,{type:ctx.mime}); var url=URL.createObjectURL(blob);
    if ((ctx.mime||'').indexOf('image/')===0){ showImg(ui,url); }
    else if ((ctx.mime||'').indexOf('video/')===0){ var restore=ctx.videoState?{time:ctx.videoState.time||0,paused:ctx.videoState.paused}:null; showVid(ui,url,'接收完成',restore); }
    else { fileLink(ui,url,ctx.name,ctx.size); }
    self.log('T52 FILE_RECV_END: '+(ctx.name||'文件')+' '+human(ctx.size)+' from '+shortId(pid));
    // 本地持久化 + 广播“我也有完整缓存”
    try{ idbPut(hash||ctx.hash||'', blob, {name:ctx.name,size:ctx.size,mime:ctx.mime}); self.fullSources[hash||ctx.hash||'']=self.fullSources[hash||ctx.hash||'']||new Set(); self.fullSources[hash||ctx.hash||''].add(self.localId);
      for(var k in self.conns){ if(!self.conns.hasOwnProperty(k)) continue; var s=self.conns[k]; if(s.open){ try{ s.conn.send({type:'file-has', hash: (hash||ctx.hash||'')}); }catch(e){} } }
    }catch(e){}
    try{ if(ctx.previewUrl) URL.revokeObjectURL(ctx.previewUrl);}catch(e){}
    (function(u){ setTimeout(function(){ URL.revokeObjectURL(u); },60000); })(url);
    st.recv.cur=null; st.recv.ui=null;
  }

  // 定时器
  function startTimers(){
    stopTimers();
    self.timers.up=setInterval(function(){
      if(!self.isConnected||!self.startAt) return;
      var s=Math.floor((Date.now()-self.startAt)/1000),h=Math.floor(s/3600),m=Math.floor((s%3600)/60),sec=s%60;
      var t=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec; var up=document.getElementById('uptime'); if(up) up.textContent=t;
    },1000);
    self.timers.ping=setInterval(function(){
      for(var k in self.conns){ if(!self.conns.hasOwnProperty(k)) continue; var st=self.conns[k]; if(!st.open) continue;
        try{ st.conn.send({type:'ping',ts:Date.now()}); self.log('T30 HEARTBEAT: ping '+shortId(k)); }catch(e){}
      }
    },5000);
  }
  function stopTimers(){ if(self.timers.up){clearInterval(self.timers.up); self.timers.up=null;} if(self.timers.ping){clearInterval(self.timers.ping); self.timers.ping=null;} }

  self.disconnect=function(){
    for(var k in self.conns){ if(!self.conns.hasOwnProperty(k)) continue; try{ self.conns[k].conn.close(); }catch(e){} }
    self.conns={}; safeDestroyPeer(); stopTimers();
    self.isConnected=false; self.startAt=0; self.localId=''; self.virtualIp='';
    var c=document.getElementById('chat'); if(c) c.style.display='none'; var t=document.getElementById('tools'); if(t) t.style.display='none'; var s=document.getElementById('share'); if(s) s.style.display='none';
    setStatus('● 离线','offline');
    var b=document.getElementById('connectBtn'); if(b){ b.textContent='🔌 连接网络'; b.disabled=false; }
    self.updateInfo(); self.log('T90 PEER_CLOSE: disconnected');
  };
  function safeDestroyPeer(){ try{ if(self.peer) self.peer.destroy(); }catch(e){} self.peer=null; }

  // 初始化
  (function(){ self.log('> 就绪：点击“连接网络”开始（固定服务器 '+self.server.host+':'+self.server.port+'）'); })();

  return self;
})();

window.addEventListener('beforeunload', function(e){ if(app.isConnected){ e.preventDefault(); e.returnValue='关闭页面将断开连接，确定吗？'; } });