(function(){
  var injectedServer  = (typeof window.__FIXED_SERVER__  === 'object' && window.__FIXED_SERVER__)  || null;
  var injectedNetwork = (typeof window.__FIXED_NETWORK__ === 'string' && window.__FIXED_NETWORK__) || null;

  var ICE = [
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:global.stun.twilio.com:3478'}
  ];
  var CHUNK = 512*1024;
  var PREVIEW_PCT = 3;
  var HIGH_WATER  = 1.5*1024*1024;
  var LOW_WATER   = 0.6*1024*1024;

  function now(){ return new Date().toLocaleTimeString(); }
  function shortId(id){ return id? id.substr(0,10)+'...':'-'; }
  function human(n){
    if(n<1024) return n+' B';
    if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
    if(n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB';
    return (n/1024/1024/1024).toFixed(1)+' GB';
  }
  function genIp(id){
    var h=0; for(var i=0;i<id.length;i++){ h=(h*31+id.charCodeAt(i))>>>0; }
    return '10.144.'+(((h)&0xff)+1)+'.'+(((h>>8)&0xff)+1);
  }
  function getPeerParam(){
    var s=window.location.search; if(!s||s.length<2) return '';
    var m=s.match(/[?&]peer=([^&]+)/); return m? decodeURIComponent(m[1]):'';
  }
  function sha256(str){
    var enc=new TextEncoder().encode(str);
    return crypto.subtle.digest('SHA-256', enc).then(function(buf){
      var b=new Uint8Array(buf), s=''; for(var i=0;i<b.length;i++){ s+=('0'+b[i].toString(16)).slice(-2); }
      return s;
    });
  }
  function fileHashMeta(file){ return sha256(file.name+'|'+file.size); }

  var idb, idbReady=false;
  (function openIDB(){
    try{
      var req=indexedDB.open('p2p-cache',2);
      req.onupgradeneeded=function(e){
        var db=e.target.result;
        if(!db.objectStoreNames.contains('files')) db.createObjectStore('files',{keyPath:'hash'});
        if(!db.objectStoreNames.contains('parts')) db.createObjectStore('parts',{keyPath:'hash'});
      };
      req.onsuccess=function(e){ idb=e.target.result; idbReady=true; };
      req.onerror=function(){ idbReady=false; };
    }catch(e){ idbReady=false; }
  })();
  function idbPutFull(hash, blob, meta){
    if(!idbReady) return;
    try{ var tx=idb.transaction('files','readwrite'); tx.objectStore('files').put({hash:hash, blob:blob, meta:meta, ts:Date.now()}); }catch(e){}
  }
  function idbGetFull(hash, cb){
    if(!idbReady) return cb(null);
    try{
      var tx=idb.transaction('files','readonly'); var rq=tx.objectStore('files').get(hash);
      rq.onsuccess=function(){ cb(rq.result||null); }; rq.onerror=function(){ cb(null); };
    }catch(e){ cb(null); }
  }
  function idbPutPart(hash, meta){
    if(!idbReady) return;
    try{ var tx=idb.transaction('parts','readwrite'); tx.objectStore('parts').put({hash:hash, meta:meta, ts:Date.now()}); }catch(e){}
  }
  function idbGetPart(hash, cb){
    if(!idbReady) return cb(null);
    try{
      var tx=idb.transaction('parts','readonly'); var rq=tx.objectStore('parts').get(hash);
      rq.onsuccess=function(){ cb(rq.result||null); }; rq.onerror=function(){ cb(null); };
    }catch(e){ cb(null); }
  }
  function idbDelPart(hash){
    if(!idbReady) return;
    try{ var tx=idb.transaction('parts','readwrite'); tx.objectStore('parts').delete(hash); }catch(e){}
  }

  function extractVideoThumbnail(file, cb){
    var video=document.createElement('video');
    video.preload='metadata'; video.muted=true; video.playsInline=true;
    var url=URL.createObjectURL(file);
    var cleaned=false, clean=function(){ if(cleaned) return; cleaned=true; try{URL.revokeObjectURL(url);}catch(e){} };
    video.src=url;
    video.addEventListener('loadeddata', function(){
      try{ video.currentTime = Math.min(1, (video.duration||1)*0.1); }catch(e){ clean(); cb(null); }
    }, {once:true});
    video.addEventListener('seeked', function(){
      try{
        var w=video.videoWidth||320, h=video.videoHeight||180, r=w/h, W=320, H=Math.round(W/r);
        var c=document.createElement('canvas'); c.width=W; c.height=H;
        var g=c.getContext('2d'); g.drawImage(video,0,0,W,H);
        var poster=c.toDataURL('image/jpeg',0.7);
        clean(); cb(poster);
      }catch(e){ clean(); cb(null); }
    }, {once:true});
    video.addEventListener('error', function(){ clean(); cb(null); }, {once:true});
  }

  var app=(function(){
    var self={};

    self.server  = injectedServer || {host:'peerjs.92k.de', port:443, secure:true, path:'/'};
    self.network = injectedNetwork || 'public-network';

    self.chunkSize  = CHUNK;
    self.previewPct = PREVIEW_PCT;
    self.highWater  = HIGH_WATER;
    self.lowWater   = LOW_WATER;

    self.iceServers = ICE;

    self.peer=null; self.conns={}; self.isConnected=false; self.startAt=0;
    self.localId=''; self.virtualIp='';
    self.timers={up:null,ping:null};
    self.logBuf='> 初始化：准备连接';

    self.fullSources={};
    self.displayNames={};
    self.activePeer='all';
    self.myName = (localStorage.getItem('nickname')||'').trim() || '';

    function log(s){
      self.logBuf += "\n["+now()+"] "+s;
      var el=document.getElementById('log');
      if(el){ el.textContent=self.logBuf; el.scrollTop=el.scrollHeight; }
      if (typeof window.updateEntryStatus === 'function'){
        var up='00:00:00';
        if(self.isConnected && self.startAt){
          var sec=Math.floor((Date.now()-self.startAt)/1000), h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s2=sec%60;
          up=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s2<10?'0':'')+s2;
        }
        window.updateEntryStatus({
          connected:self.isConnected,
          online:Object.keys(self.conns).filter(k=>self.conns[k].open).length,
          localId:self.localId, virtualIp:self.virtualIp, uptime:up
        });
      }
    }
    self.log = log;
    self.copyLog=function(){
      try{
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(self.logBuf).then(function(){ alert('日志已复制'); });
        }else{
          var ta=document.createElement('textarea'); ta.value=self.logBuf; document.body.appendChild(ta);
          ta.select(); document.execCommand('copy'); document.body.removeChild(ta); alert('日志已复制');
        }
      }catch(e){ alert('复制失败：'+e.message); }
    };
    self.clearLog=function(){ self.logBuf=''; var el=document.getElementById('log'); if(el) el.textContent=''; };

    function setStatus(txt){
      var st=document.getElementById('statusChip');
      if(st) st.textContent = '状态：' + txt;
    }

    self.updateInfo=function(){
      var openCount=0; for(var k in self.conns){ if(self.conns[k].open) openCount++; }
      var lid=document.getElementById('localId'),
          vip=document.getElementById('virtualIp'),
          pc=document.getElementById('peerCount');
      if(lid) lid.textContent = self.localId ? shortId(self.localId) : '-';
      if(vip) vip.textContent = self.virtualIp || '-';
      if(pc)  pc.textContent  = String(openCount);
      var onlineChip=document.getElementById('onlineChip');
      if(onlineChip) onlineChip.textContent='在线 '+openCount;
      if(self._classic && typeof self._classic.updateStatus==='function') self._classic.updateStatus();
    };

    self.showShare=function(){
      var base=window.location.origin+window.location.pathname; // 保持原样
      var url = base + '?peer='+encodeURIComponent(self.localId);
      var input=document.getElementById('shareLink'),
          qrBox=document.getElementById('qrBox'),
          qr=document.getElementById('qr');
      if(input) input.value=url;
      if(qr){
        qr.innerHTML='';
        // 关键修复：固定 256px，不缩放；白底在外层 .qr-wrap 提供静区
        new QRCode(qr,{text:url,width:256,height:256,correctLevel:QRCode.CorrectLevel.M});
      }
      var share=document.getElementById('share'); if(share) share.style.display='block';
    };
    self.copyLink=function(){
      var el=document.getElementById('shareLink'); if(!el) return;
      try{
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(el.value).then(function(){ alert('已复制'); });
        } else { el.select(); document.execCommand('copy'); alert('已复制'); }
      }catch(e){ alert('复制失败：'+e.message); }
    };

    function pushChat(text,mine){
      if(self._classic && typeof self._classic.appendChat==='function') self._classic.appendChat(text,mine);
    }
    function placeholder(name,size,mine){
      return self._classic && typeof self._classic.placeholder==='function' ? self._classic.placeholder(name,size,mine) : null;
    }
    function showImg(ui,url){ if(self._classic && typeof self._classic.showImage==='function') self._classic.showImage(ui,url); }
    function showVid(ui,url,note){ if(self._classic && typeof self._classic.showVideo==='function') self._classic.showVideo(ui,url,note,null); }
    function fileLink(ui,url,name,size){ if(self._classic && typeof self._classic.showFileLink==='function') self._classic.showFileLink(ui,url,name,size); }
    function updProg(ui,p){ if(self._classic && typeof self._classic.updateProgress==='function') self._classic.updateProgress(ui,p); }

    self.sendMsg=function(){
      var val='';
      if (self._classic && typeof self._classic.getEditorText==='function') val=self._classic.getEditorText();
      val = (val||'').trim();
      if (!val){ return; }

      pushChat(val, true);
      if (self._classic && typeof self._classic.clearEditor==='function') self._classic.clearEditor();

      var targets=[];
      if (self.activePeer==='all'){
        for (var k in self.conns){ if(self.conns.hasOwnProperty(k) && self.conns[k].open) targets.push(k); }
      }else{
        if (self.conns[self.activePeer] && self.conns[self.activePeer].open) targets=[self.activePeer];
      }
      if (!targets.length){ self.log('无在线对象，消息未发送'); return; }

      targets.forEach(function(pid){
        try{ self.conns[pid].conn.send({type:'chat', text:val}); }
        catch(e){ self.log('消息发送失败：'+(e.message||e)); }
      });
      self.log('已发送消息：'+ (val.length>30? (val.slice(0,30)+'…') : val));
    };

    self.sendFiles=function(){
      var fi=document.getElementById('fileInput');
      if(!fi||!fi.files||fi.files.length===0){ alert('请选择文件'); return; }
      self.sendFilesFrom([].slice.call(fi.files)); fi.value='';
    };
    self.sendFilesFrom=function(files){
      var targets=[];
      if (self.activePeer==='all'){
        for(var k in self.conns){ if(self.conns[k].open) targets.push(k); }
      } else {
        if (self.conns[self.activePeer] && self.conns[self.activePeer].open) targets=[self.activePeer];
      }
      if(!targets.length){ self.log('无在线对象，无法发送文件'); alert('没有在线节点，无法发送文件'); return; }

      files.forEach(function(file){
        var ui = placeholder(file.name, file.size, true);
        var localUrl = URL.createObjectURL(file);
        if ((file.type||'').indexOf('image/')===0) showImg(ui, localUrl);
        else if ((file.type||'').indexOf('video/')===0){
          extractVideoThumbnail(file, function(p){ if (ui) ui.poster=p; showVid(ui, localUrl, '已发送'); });
        } else { fileLink(ui, localUrl, file.name, file.size); }
        setTimeout(function(){ try{URL.revokeObjectURL(localUrl);}catch(e){} },60000);

        fileHashMeta(file).then(function(hash){
          targets.forEach(function(pid){ enqueueFile(pid,file,hash); });
        });
      });
    };

    function enqueueFile(pid,file,hash){
      var st=self.conns[pid]; if(!st||!st.open){ self.log('对方不在线：'+shortId(pid)); return; }
      if(!st.queue) st.queue=[];
      st.queue.push({file:file,hash:hash});
      if(!st.sending){ st.sending=true; sendNext(pid); }
    }
    function sendNext(pid){
      var st=self.conns[pid]; if(!st) return;
      var job=st.queue.shift(); if(!job){ st.sending=false; return; }
      sendFileTo(pid, job.file, job.hash, function(){ sendNext(pid); });
    }
    function getBuffered(c){
      try{
        if(c&&c._dc&&typeof c._dc.bufferedAmount==='number') return c._dc.bufferedAmount;
        if(c&&typeof c.bufferSize==='number') return c.bufferSize;
      }catch(e){}
      return 0;
    }
    function flowSend(c,data,cb){
      var loop=function(){
        if(getBuffered(c)>HIGH_WATER){ setTimeout(loop,20); return; }
        try{ c.send(data);}catch(e){ cb(e); return; }
        cb(null);
      };
      loop();
    }

    function sendFileTo(pid,file,hash,done){
      var st=self.conns[pid]; if(!st||!st.open){ self.log('对方不在线：'+shortId(pid)); return done&&done(); }

      var c=st.conn,
          id=String(Date.now())+'_'+Math.floor(Math.random()*1e6),
          chunk=self.chunkSize,
          state={off:0},
          lastTs=0, lastPct=-1;

      var posterP = (file.type||'').indexOf('video/')===0 ? new Promise(function(r){ extractVideoThumbnail(file,r); }) : Promise.resolve(null);

      posterP.then(function(poster){
        try{
          c.send({type:'file-begin', id:id, name:file.name, size:file.size, mime:file.type||'application/octet-stream', chunk:chunk, hash:hash, poster:poster||null});
        }catch(e){ self.log('文件元信息发送失败'); return done&&done(); }

        st._curSend = st._curSend || {};
        st._curSend[id] = { setOffset:function(n){ state.off = Math.max(0, Math.min(file.size, n|0)); } };

        var reader=new FileReader();
        reader.onerror=function(){ self.log('文件读取失败'); try{ c.send({type:'file-end', id:id, hash:hash}); }catch(e){} done&&done(); };
        reader.onload=function(e){
          flowSend(c,e.target.result,function(err){
            if(err){ self.log('数据发送失败'); delete st._curSend[id]; return done&&done(); }
            state.off += e.target.result.byteLength;
            var pct=Math.min(100,Math.floor(state.off*100/file.size));
            var nowTs=Date.now();
            if(pct!==lastPct && (nowTs-lastTs>300 || pct===100)){ lastTs=nowTs; lastPct=pct; }
            if(state.off<file.size){ setTimeout(readNext,0); }
            else { try{ c.send({type:'file-end', id:id, hash:hash}); }catch(e){} delete st._curSend[id]; done&&done(); }
          });
        };
        function readNext(){
          var slice=file.slice(state.off,Math.min(state.off+chunk,file.size));
          reader.readAsArrayBuffer(slice);
        }
        readNext();
      });
    }

    self.toggle=function(){
      if(self.isConnected){ self.disconnect(); return; }
      var nameEl=document.getElementById('networkName');
      if(nameEl && nameEl.value.trim()) self.network=nameEl.value.trim();
      var nick = (localStorage.getItem('nickname')||'').trim();
      self.myName = nick || ('用户-'+Math.random().toString(36).slice(2,6));
      connect();
    };

    function connect(){
      setStatus('连接中…'); self.log('开始连接…');
      try{
        var p=new Peer(null,{host:self.server.host,port:self.server.port,secure:self.server.secure,path:self.server.path,config:{iceServers:self.iceServers}});
        self.peer=p;
      }catch(e){ self.log('初始化失败：'+e.message); setStatus('离线'); return; }

      var opened=false;
      var t=setTimeout(function(){ if(!opened){ self.log('连接超时'); try{ self.peer.destroy(); }catch(e){} setStatus('离线'); } }, 10000);

      self.peer.on('open', function(id){
        opened=true; clearTimeout(t);
        self.localId=id; self.virtualIp=genIp(id); self.isConnected=true; self.startAt=Date.now();
        setStatus('在线');
        self.updateInfo();
        self.showShare();
        self.log('已连接，ID='+id);

        var toDial=getPeerParam();
        if(toDial){ self.log('准备连接对端：'+toDial); setTimeout(function(){ connectPeer(toDial); },400); }

        startTimers();
      });

      self.peer.on('connection', function(conn){ handleConn(conn,true); });
      self.peer.on('error', function(err){ self.log('连接错误：'+(err && (err.message||err.type)||err)); });
      self.peer.on('disconnected', function(){ self.log('信令掉线，尝试重连'); try{ self.peer.reconnect(); }catch(e){} });
      self.peer.on('close', function(){ self.log('连接已关闭'); });

      self.peer.on('call', function(call){
        if (!window.__ENTRY_PAGE__){ try{ call.close(); }catch(e){} return; }
        navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(function(stream){
          self._media = self._media || {};
          self._media.local = stream;
          var lv=document.getElementById('localVideo'); if(lv) lv.srcObject=stream;
          call.answer(stream);
          self._media.call = call;
          call.on('stream', function(remote){ var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=remote; });
          call.on('close', function(){ self.toggleCall(true); });
          call.on('error', function(){ self.toggleCall(true); });
        }).catch(function(){ try{ call.close(); }catch(e){} });
      });
    }

    function connectPeer(pid){
      if(!self.peer || !pid || pid===self.localId) return;
      if(self.conns[pid] && self.conns[pid].open) return;
      self.log('拨号：'+pid);
      var c;
      try{ c=self.peer.connect(pid,{reliable:true}); }
      catch(e){ self.log('拨号失败：'+(e.message||e)); return; }
      handleConn(c,false);
      setTimeout(function(){
        var st=self.conns[pid];
        if(!st||!st.open){
          try{ c.close(); }catch(e){}
          self.log('对端未响应：'+shortId(pid));
        }
      },12000);
    }

    function handleConn(c,inbound){
      if(!c||!c.peer) return;
      var pid=c.peer;
      if(self.conns[pid] && self.conns[pid].open){
        try{ c.close(); }catch(e){}
        return;
      }
      if(!self.conns[pid]) {
        self.conns[pid]={ conn:c, open:false, latency:0, sending:false, queue:[], recv:{cur:null,ui:null}, _curSend:{} };
      }

      if(inbound) self.log('收到入站连接：'+shortId(pid));

      c.on('open', function(){
        self.conns[pid].open=true;
        self.updateInfo();
        try{
          c.send({
            type:'hello',
            id:self.localId,
            name:self.myName,
            ip:self.virtualIp,
            network:self.network,
            fullList:Object.keys(self.fullSources)
          });
        }catch(e){}
      });

      c.on('data', function(d){
        if(d && typeof d==='object' && d.type){
          if(d.type==='hello'){
            self.displayNames[pid] = d.name || ('节点 '+shortId(pid));
            if (d.fullList && Array.isArray(d.fullList)){
              d.fullList.forEach(function(h){
                self.fullSources[h]=self.fullSources[h]||new Set();
                self.fullSources[h].add(pid);
              });
            }
            if(self._classic && self._classic.renderContacts){
              var arr=[]; for(var k in self.conns){ if(self.conns[k].open) arr.push({id:k,name:self.displayNames[k]||('节点 '+shortId(k))}); }
              self._classic.renderContacts(arr, self.activePeer);
            }
          }
          else if(d.type==='ping'){
            if(self.conns[pid].open){ try{ c.send({type:'pong',ts:d.ts}); }catch(e){} }
          }
          else if(d.type==='pong'){
            var lat=Date.now()-(d.ts||Date.now());
            self.conns[pid].latency=lat;
            self.log('延迟：'+lat+'ms');
            self.updateInfo();
          }
          else if(d.type==='chat'){
            pushChat(String(d.text||''), false);
            self.log('收到消息');
          }
          else if(d.type==='file-begin'){
            var h=d.hash||'';
            var ui=placeholder(d.name||'文件', d.size||0, false);
            if ((d.mime||'').indexOf('video/')===0 && d.poster){ ui.poster = d.poster; showVid(ui,'#','等待数据…'); }

            if(h){
              idbGetFull(h, function(rec){
                if(rec && rec.blob){
                  var url=URL.createObjectURL(rec.blob);
                  if ((rec.meta && rec.meta.mime || '').indexOf('image/')===0) showImg(ui,url);
                  else if ((rec.meta && rec.meta.mime || '').indexOf('video/')===0) showVid(ui,url,'本地缓存');
                  else fileLink(ui,url, (rec.meta && rec.meta.name)||d.name||'文件', (rec.meta && rec.meta.size)||d.size||0);
                  setTimeout(function(){ try{URL.revokeObjectURL(url);}catch(e){} },60000);
                  try{ c.send({type:'file-end',id:d.id,hash:h}); }catch(e){}
                  return;
                }
                idbGetPart(h, function(rec2){
                  if(rec2 && rec2.meta && typeof rec2.meta.got==='number' && rec2.meta.got<(d.size||0)){
                    try{ c.send({type:'file-resume', id:d.id, hash:h, offset:rec2.meta.got}); }catch(e){}
                  }
                });
              });
            }

            self.conns[pid].recv.cur={
              id:d.id, name:d.name, size:d.size||0, mime:d.mime||'application/octet-stream',
              got:0, parts:[], previewed:false, previewUrl:null, videoState:null, hash:h
            };
            self.conns[pid].recv.ui=ui;
          }
          else if(d.type==='file-end'){
            finalizeReceive(pid,d.id,d.hash||'');
          }
          else if(d.type==='file-has'){
            var h2=d.hash;
            if(h2){
              self.fullSources[h2]=self.fullSources[h2]||new Set();
              self.fullSources[h2].add(pid);
            }
          }
          else if(d.type==='file-resume'){
            var st=self.conns[pid];
            if (st && st._curSend && st._curSend[d.id] && typeof d.offset==='number'){
              try{ st._curSend[d.id].setOffset(d.offset|0); }catch(e){}
            }
          }
          return;
        }

        var st=self.conns[pid],
            ctx=st&&st.recv&&st.recv.cur,
            ui=st&&st.recv&&st.recv.ui;
        if(!ctx) return;

        var sz=0;
        if(d && d.byteLength!==undefined){ sz=d.byteLength; ctx.parts.push(new Blob([d])); }
        else if(d && d.size!==undefined){ sz=d.size; ctx.parts.push(d); }
        ctx.got+=sz;
        var pct=ctx.size?Math.min(100,Math.floor(ctx.got*100/ctx.size)):0;
        updProg(ui,pct);

        if(ctx.hash && ctx.got>0 && (ctx.got % (2*1024*1024) < sz)){
          try{ idbPutPart(ctx.hash,{name:ctx.name,size:ctx.size,mime:ctx.mime, got:ctx.got}); }catch(e){}
        }

        if(!ctx.previewed){
          try{
            var url=URL.createObjectURL(new Blob(ctx.parts,{type:ctx.mime}));
            if ((ctx.mime||'').indexOf('image/')===0){
              showImg(ui,url); ctx.previewed=true; ctx.previewUrl=url;
            }else if ((ctx.mime||'').indexOf('video/')===0){
              var need=Math.max(1,Math.floor(ctx.size*self.previewPct/100));
              if(ctx.got>=need){ showVid(ui,url,'可预览（接收中 '+pct+'%）'); ctx.previewed=true; ctx.previewUrl=url; }
              else { try{ URL.revokeObjectURL(url);}catch(e){} }
            }
          }catch(e){}
        }
      });

      c.on('close', function(){
        delete self.conns[pid];
        self.updateInfo();
      });

      c.on('error', function(err){ /* 忽略 */ });
    }

    function finalizeReceive(pid,id,hash){
      var st=self.conns[pid]; if(!st||!st.recv) return;
      var ctx=st.recv.cur, ui=st.recv.ui;
      if(!ctx||ctx.id!==id) return;

      var blob=new Blob(ctx.parts,{type:ctx.mime});
      var url=URL.createObjectURL(blob);

      if ((ctx.mime||'').indexOf('image/')===0) showImg(ui,url);
      else if ((ctx.mime||'').indexOf('video/')===0) showVid(ui,url,'接收完成');
      else fileLink(ui,url,ctx.name,ctx.size);

      try{
        idbPutFull(hash||ctx.hash||'', blob, {name:ctx.name,size:ctx.size,mime:ctx.mime});
        if (ctx.hash) idbDelPart(ctx.hash);
        self.fullSources[hash||ctx.hash||'']=self.fullSources[hash||ctx.hash||'']||new Set();
        self.fullSources[hash||ctx.hash||''].add(self.localId);
        for(var k in self.conns){
          var s=self.conns[k]; if(s.open){ try{ s.conn.send({type:'file-has', hash:(hash||ctx.hash||'')}); }catch(e){} }
        }
      }catch(e){}

      try{ if(ctx.previewUrl) URL.revokeObjectURL(ctx.previewUrl);}catch(e){}
      (function(u){ setTimeout(function(){ try{URL.revokeObjectURL(u);}catch(e){} },60000); })(url);
      st.recv.cur=null; st.recv.ui=null;
      self.log('已接收文件：'+ctx.name+' '+human(ctx.size));
    }

    function startTimers(){
      stopTimers();
      self.timers.up=setInterval(function(){
        if(!self.isConnected||!self.startAt) return;
        var s=Math.floor((Date.now()-self.startAt)/1000),
            h=Math.floor(s/3600),
            m=Math.floor((s%3600)/60),
            sec=s%60;
        var t=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(sec<10?'0':'')+sec;
        var up=document.getElementById('uptime'); if(up) up.textContent=t;
        if (typeof window.updateEntryStatus==='function'){
          window.updateEntryStatus({connected:true, online:Object.keys(self.conns).filter(k=>self.conns[k].open).length, localId:self.localId, virtualIp:self.virtualIp, uptime:t});
        }
      },1000);

      self.timers.ping=setInterval(function(){
        for(var k in self.conns){
          var st=self.conns[k]; if(!st.open) continue;
          try{ st.conn.send({type:'ping',ts:Date.now()}); }catch(e){}
        }
      },5000);
    }
    function stopTimers(){
      if(self.timers.up){clearInterval(self.timers.up); self.timers.up=null;}
      if(self.timers.ping){clearInterval(self.timers.ping); self.timers.ping=null;}
    }

    self.disconnect=function(){
      for(var k in self.conns){ try{ self.conns[k].conn.close(); }catch(e){} }
      self.conns={}; self.fullSources={};
      if(self.peer){ try{ self.peer.destroy(); }catch(e){} self.peer=null; }
      self.isConnected=false; self.startAt=0; self.localId=''; self.virtualIp='';
      setStatus('离线'); self.updateInfo();
      stopTimers();
      self.log('已断开');
    };

    self.toggleCall=function(forceClose){
      if (!window.__ENTRY_PAGE__) return;
      self._media = self._media || {};
      if (self._media.call || forceClose){
        try{ self._media.call && self._media.call.close(); }catch(e){}
        if (self._media.local){ try{ self._media.local.getTracks().forEach(t=>t.stop()); }catch(e){} }
        self._media.call=null; self._media.local=null;
        var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=null;
        var lv=document.getElementById('localVideo');  if(lv) lv.srcObject=null;
        return;
      }
      var pid=self.activePeer;
      if(!pid || pid==='all'){ alert('请先在聊天 UI 里选择一个联系人'); return; }
      if(!self.peer){ alert('未连接'); return; }
      navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(function(stream){
        self._media.local=stream;
        var lv=document.getElementById('localVideo'); if(lv) lv.srcObject=stream;
        var call=self.peer.call(pid, stream);
        self._media.call=call;
        call.on('stream', function(remote){ var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=remote; });
        call.on('close', function(){ self.toggleCall(true); });
        call.on('error', function(){ self.toggleCall(true); });
      }).catch(function(){ alert('无法获取摄像头/麦克风'); });
    };

    bindClassicUI(self);
    return self;
  })();

  function bindClassicUI(app){
    if (!window.__CLASSIC_UI__) return;

    var editor = document.getElementById('editor');
    var sendBtn = document.getElementById('sendBtn');
    var fileInput = document.getElementById('fileInput');
    var msgScroll = document.getElementById('msgScroll');
    var contactList = document.getElementById('contactList');
    var contactSearch = document.getElementById('contactSearch');
    var sendArea = document.getElementById('sendArea');
    var statusChip = document.getElementById('statusChip');
    var onlineChip = document.getElementById('onlineChip');

    function textOfEditor(){
      if (!editor) return '';
      var t = editor.innerText || editor.textContent || '';
      return t.replace(/\u00A0/g,' ').replace(/\r/g,'').trim();
    }
    function clearEditor(){ if(editor){ editor.innerHTML=''; editor.textContent=''; } }
    function syncSendBtn(){
      if (!sendBtn) return;
      var hasText = textOfEditor().length>0;
      sendBtn.disabled = !(app && app.isConnected && hasText);
    }

    function fixAllLabel(){
      try{
        var rows = contactList.querySelectorAll('.contact');
        if (rows && rows[0]){
          var nm = rows[0].querySelector('.cname');
          if (nm) nm.textContent = '所有人（群聊）';
        }
      }catch(e){}
    }

    app._classic = {
      appendChat: function(text, mine){
        if (!msgScroll) return;
        var row=document.createElement('div'); row.className='row'+(mine?' right':'');
        var av=document.createElement('div'); av.className='avatar-sm';
        var lt=document.createElement('span'); lt.className='letter'; lt.textContent = mine ? '我' : '他';
        av.appendChild(lt);
        var bubble=document.createElement('div'); bubble.className='bubble'+(mine?' me':''); bubble.textContent=String(text||'');
        if (mine){ row.appendChild(bubble); row.appendChild(av); } else { row.appendChild(av); row.appendChild(bubble); }
        msgScroll.appendChild(row); msgScroll.scrollTop = msgScroll.scrollHeight;
      },
      placeholder: function(name,size,mine){
        if(!msgScroll) return null;
        var row=document.createElement('div'); row.className='row'+(mine?' right':'');
        var av=document.createElement('div'); av.className='avatar-sm';
        var lt=document.createElement('span'); lt.className='letter'; lt.textContent = mine ? '我' : '他';
        av.appendChild(lt);
        var bubble=document.createElement('div'); bubble.className='bubble file'+(mine?' me':'');
        var safe = String(name||'文件').replace(/"/g,'&quot;');
        bubble.innerHTML = '<div class="file-link"><div class="file-info"><span class="file-icon">📄</span>'
                         + '<span class="file-name" title="'+safe+'">'+safe+'</span></div>'
                         + '<div class="progress-line">准备接收…</div></div>';
        if (mine){ row.appendChild(bubble); row.appendChild(av); } else { row.appendChild(av); row.appendChild(bubble); }
        msgScroll.appendChild(row); msgScroll.scrollTop=msgScroll.scrollHeight;
        return {root:row, progress:bubble.querySelector('.progress-line'), mediaWrap:bubble};
      },
      showImage: function(ui,url){
        if(!ui||!ui.mediaWrap) return;
        ui.mediaWrap.classList.add('media');
        ui.mediaWrap.innerHTML = '<a href="'+url+'" target="_blank" rel="noopener" class="thumb-link">'
                               + '<img class="thumb img" src="'+url+'"></a>';
      },
      showVideo: function(ui,url,info){
        if(!ui||!ui.mediaWrap) return;
        ui.mediaWrap.classList.add('media');
        var bg = ui.poster ? ' style="background-image:url('+ui.poster+')"':'';
        ui.mediaWrap.innerHTML = '<a href="'+url+'" target="_blank" rel="noopener" class="thumb-link">'
                               + '<div class="thumb video"'+bg+'><div class="play">▶</div></div></a>'
                               + (info?'<div class="progress-line">'+info+'</div>':'');
      },
      showFileLink: function(ui,url,name,size){
        if(!ui||!ui.mediaWrap) return;
        var safe=String(name||'文件').replace(/"/g,'&quot;');
        ui.mediaWrap.classList.remove('media');
        ui.mediaWrap.innerHTML = '<a href="'+url+'" target="_blank" rel="noopener" class="file-link" title="'+safe+'">'
                               + '<div class="file-info"><span class="file-icon">📄</span><span class="file-name">'+safe+'</span></div>'
                               + '<div class="progress-line">下载：'+safe+' ('+human(size||0)+')</div></a>';
      },
      updateProgress: function(ui,p){ if(ui&&ui.progress) ui.progress.textContent = '接收中… '+p+'%'; },
      updateStatus: function(){
        if (statusChip) statusChip.textContent = app.isConnected ? '已连接' : '未连接';
        if (onlineChip){
          var openCount=0; for (var k in app.conns){ if(app.conns[k].open) openCount++; }
          onlineChip.textContent = '在线 ' + openCount;
        }
        syncSendBtn();
      },
      getEditorText: textOfEditor,
      clearEditor: clearEditor,

      renderContacts: function(list, activeId){
        if (!contactList) return;
        var kw = (contactSearch && contactSearch.value || '').trim().toLowerCase();
        contactList.innerHTML='';
        var all=document.createElement('div'); all.className='contact'+((activeId==='all')?' active':''); all.dataset.id='all';
        all.innerHTML='<div class="avatar"></div><div><div class="cname">所有人（群聊）</div><div class="cmsg">群聊</div></div>';
        all.addEventListener('click', function(){
          app.activePeer='all';
          contactList.querySelectorAll('.contact.active').forEach(function(el){ el.classList.remove('active'); });
          all.classList.add('active');
        });
        contactList.appendChild(all);

        for (var pid in app.conns){
          if (!app.conns.hasOwnProperty(pid)) continue;
          if (!app.conns[pid].open) continue;
          var nm = app.displayNames[pid] || ('节点 '+pid.substring(0,8));
          if (kw && nm.toLowerCase().indexOf(kw)===-1) continue;
          var row=document.createElement('div'); row.className='contact'+((activeId===pid)?' active':''); row.dataset.id=pid;
          row.innerHTML='<div class="avatar"></div><div><div class="cname"></div><div class="cmsg">在线</div></div>';
          row.querySelector('.cname').textContent = nm;
          row.addEventListener('click', function(){
            app.activePeer = this.dataset.id;
            contactList.querySelectorAll('.contact.active').forEach(function(el){ el.classList.remove('active'); });
            this.classList.add('active');
          });
          contactList.appendChild(row);
        }
        fixAllLabel();
      }
    };

    if (editor){
      editor.addEventListener('input', syncSendBtn);
      var composing=false;
      editor.addEventListener('compositionstart', function(){ composing=true; });
      editor.addEventListener('compositionend', function(){ composing=false; });
      editor.addEventListener('keydown', function(e){
        if (e.key==='Enter' && !e.shiftKey && !composing){ e.preventDefault(); app.sendMsg(); }
      });
    }
    var emojiBtn=document.getElementById('emojiBtn');
    if (emojiBtn && editor){
      emojiBtn.addEventListener('click', function(){
        editor.focus();
        try{ document.execCommand('insertText', false, '😀'); }catch(e){
          var r=document.createRange(); r.selectNodeContents(editor); r.collapse(false);
          var s=window.getSelection(); s.removeAllRanges(); s.addRange(r);
          var node=document.createTextNode('😀'); r.insertNode(node);
        }
        syncSendBtn();
      });
    }
    if (sendBtn){ sendBtn.addEventListener('click', function(){ app.sendMsg(); }); }
    if (fileInput){ fileInput.addEventListener('change', function(e){ var files=[].slice.call(e.target.files||[]); if(files.length) app.sendFilesFrom(files); e.target.value=''; }); }

    if (sendArea){
      function onDragEnter(e){ e.preventDefault(); sendArea.classList.add('drag-over'); }
      function onDragOver(e){ e.preventDefault(); }
      function onDragLeave(e){ e.preventDefault(); if(e.target===sendArea || !sendArea.contains(e.relatedTarget)) sendArea.classList.remove('drag-over'); }
      function onDrop(e){ e.preventDefault(); sendArea.classList.remove('drag-over'); var files=[].slice.call((e.dataTransfer&&e.dataTransfer.files)||[]); if(files.length) app.sendFilesFrom(files); }
      sendArea.addEventListener('dragenter', onDragEnter);
      sendArea.addEventListener('dragover', onDragOver);
      sendArea.addEventListener('dragleave', onDragLeave);
      sendArea.addEventListener('drop', onDrop);
    }

    if (contactSearch){ contactSearch.addEventListener('input', function(){
      var arr=[]; for (var k in app.conns){ if(app.conns[k].open) arr.push({id:k,name: app.displayNames[k]||('节点 '+k.substring(0,8))}); }
      app._classic.renderContacts(arr, app.activePeer);
    }); }

    app._classic.updateStatus();
  }

  if (window.__CLASSIC_UI__ && window.__USE_OPENER_APP__ && window.opener && window.opener.app){
    window.app = window.opener.app;
    bindClassicUI(window.app);
  }else{
    window.app = app;
    if (window.__CLASSIC_UI__) bindClassicUI(app);
  }
})();