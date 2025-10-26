(function(){
  'use strict';

  // -------------------- 配置注入与常量 --------------------
  var injectedServer  = (typeof window !== 'undefined' && ((window.FIXED_SERVER && typeof window.FIXED_SERVER === 'object' && window.FIXED_SERVER) || (window.__FIXED_SERVER__ && typeof window.__FIXED_SERVER__ === 'object' && window.__FIXED_SERVER__))) || null;
  var injectedNetwork = (typeof window !== 'undefined' && (typeof window.FIXED_NETWORK === 'string' && window.FIXED_NETWORK || typeof window.__FIXED_NETWORK__ === 'string' && window.__FIXED_NETWORK__)) || null;

  var ICE = (function(){
    var base = [
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:stun1.l.google.com:19302'},
      {urls:'stun:global.stun.twilio.com:3478'}
    ];
    var override = (typeof window !== 'undefined') && ((window.ICE_OVERRIDE && Array.isArray(window.ICE_OVERRIDE) && window.ICE_OVERRIDE) || (window.__ICE_OVERRIDE__ && Array.isArray(window.__ICE_OVERRIDE__) && window.__ICE_OVERRIDE__));
    return override || base;
  })();

  var CHUNK = 512 * 1024;        // 512KB
  var PREVIEW_PCT = 1;           // 1% 提前预览
  var HIGH_WATER  = 1.5 * 1024 * 1024; // 1.5MB
  var LOW_WATER   = 0.6 * 1024 * 1024; // 0.6MB
  var PART_FLUSH  = 512 * 1024;  // 512KB
  var CACHE_LIMIT = 300 * 1024 * 1024; // 300MB

  // -------------------- 小工具 --------------------
  function now(){ return new Date().toLocaleTimeString(); }
  function shortId(id){ id=String(id||''); return id ? id.substr(0,10)+'...' : '-'; }
  function human(n){
    if(n < 1024) return n+' B';
    if(n < 1024*1024) return (n/1024).toFixed(1)+' KB';
    if(n < 1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB';
    return (n/1024/1024/1024).toFixed(1)+' GB';
  }
  function ext(name){ var m=String(name||'').match(/\.([a-z0-9]+)$/i); return m? m[1].toLowerCase():''; }
  function isImg(mime,name){
    return (String(mime||'').indexOf('image/')===0) || ['jpg','jpeg','png','gif','webp','bmp','heic','heif','avif','svg'].indexOf(ext(name))!==-1;
  }
  function isVid(mime,name){
    return (String(mime||'').indexOf('video/')===0) || ['mp4','webm','mkv','mov','m4v','avi','ts','3gp','flv','wmv'].indexOf(ext(name))!==-1;
  }
  function isAudio(mime,name){
    return (String(mime||'').indexOf('audio/')===0) || ['mp3','wav','ogg','oga','m4a','aac','flac','opus','amr','wma'].indexOf(ext(name))!==-1;
  }
  function canPlayVideo(mime,name){
    try{
      var v=document.createElement('video');
      if(!v || !v.canPlayType) return false;
      var type = String(mime||'');
      if(!type){
        var e = ext(name);
        var map = {mp4:'video/mp4',m4v:'video/mp4',webm:'video/webm',ogv:'video/ogg',mov:'video/quicktime',mkv:'video/x-matroska',ts:'video/mp2t',avi:'video/x-msvideo',wmv:'video/x-ms-wmv','3gp':'video/3gpp'};
        type = map[e] || '';
      }
      if(!type) return false;
      var res = v.canPlayType(type);
      return !!res && res !== 'no';
    }catch(e){ return false; }
  }
  function canPlayAudio(mime,name){
    try{
      var a=document.createElement('audio');
      if(!a || !a.canPlayType) return false;
      var type = String(mime||'');
      if(!type){
        var e = ext(name);
        var map = {mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',ogg:'audio/ogg',oga:'audio/ogg',opus:'audio/opus',flac:'audio/flac',amr:'audio/amr',wma:'audio/x-ms-wma'};
        type = map[e] || '';
      }
      if(!type) return false;
      var res = a.canPlayType(type);
      return !!res && res !== 'no';
    }catch(e){ return false; }
  }
  function genIp(id){
    var h=0; id=String(id||'');
    for(var i=0;i<id.length;i++){ h=(h*31 + id.charCodeAt(i))>>>0; }
    return '10.144.'+(((h)&0xff)+1)+'.'+(((h>>8)&0xff)+1);
  }
  function getPeerParam(){
    var s=window.location.search; if(!s||s.length<2) return '';
    var m=s.match(/[?&]peer=([^&]+)/); return m? decodeURIComponent(m[1]):'';
  }
  function sha256Hex(buf){
    return crypto.subtle.digest('SHA-256', buf).then(function(d){
      var b=new Uint8Array(d), s=''; for(var i=0;i<b.length;i++){ s+=('0'+b[i].toString(16)).slice(-2); }
      return s;
    });
  }
  function fileHashMeta(file){
    var headSize = Math.min(file.size||0, 256*1024);
    return new Promise(function(resolve){
      try{
        var r = new FileReader();
        r.onload = function(e){
          try{
            var head = new Uint8Array(e.target.result||new ArrayBuffer(0));
            var meta = new TextEncoder().encode([file.name||'', String(file.size||0), String(file.lastModified||0), ''].join('|'));
            var buf = new Uint8Array(meta.length + head.length);
            buf.set(meta,0); buf.set(head, meta.length);
            sha256Hex(buf).then(resolve).catch(function(){ resolve(''); });
          }catch(er){ resolve(''); }
        };
        r.onerror = function(){ resolve(''); };
        r.readAsArrayBuffer(file.slice(0, headSize));
      }catch(e){ resolve(''); }
    });
  }

  // -------------------- IndexedDB 缓存 --------------------
  var idb, idbReady=false;
  (function openIDB(){
    try{
      var req = indexedDB.open('p2p-cache', 3);
      req.onupgradeneeded = function(e){
        var db=e.target.result;
        if(!db.objectStoreNames.contains('files')) db.createObjectStore('files',{keyPath:'hash'});
        if(!db.objectStoreNames.contains('parts')) db.createObjectStore('parts',{keyPath:'hash'});
      };
      req.onsuccess = function(e){ idb=e.target.result; idbReady=true; };
      req.onerror = function(){ idbReady=false; };
    }catch(e){ idbReady=false; }
  })();

  function idbPutFull(hash, blob, meta){
    if(!idbReady || !hash) return;
    try{
      idbCleanupIfNeeded(meta && meta.size || 0);
      var tx=idb.transaction('files','readwrite');
      tx.objectStore('files').put({hash:hash, blob:blob, meta:meta, ts:Date.now()});
    }catch(e){}
  }
  function idbGetFull(hash, cb){
    if(!idbReady) return cb(null);
    try{
      var tx=idb.transaction('files','readonly');
      var rq=tx.objectStore('files').get(hash);
      rq.onsuccess=function(){ cb(rq.result||null); };
      rq.onerror=function(){ cb(null); };
    }catch(e){ cb(null); }
  }
  function idbPutPart(hash, meta){
    if(!idbReady || !hash) return;
    try{
      var tx=idb.transaction('parts','readwrite');
      tx.objectStore('parts').put({hash:hash, meta:meta, ts:Date.now()});
    }catch(e){}
  }
  function idbGetPart(hash, cb){
    if(!idbReady) return cb(null);
    try{
      var tx=idb.transaction('parts','readonly');
      var rq=tx.objectStore('parts').get(hash);
      rq.onsuccess=function(){ cb(rq.result||null); };
      rq.onerror=function(){ cb(null); };
    }catch(e){ cb(null); }
  }
  function idbDelPart(hash){
    if(!idbReady || !hash) return;
    try{
      var tx=idb.transaction('parts','readwrite');
      tx.objectStore('parts').delete(hash);
    }catch(e){}
  }
  function idbCleanupIfNeeded(addedSize){
    if(!idbReady) return;
    try{
      var total=0, items=[];
      var tx=idb.transaction('files','readonly');
      var st=tx.objectStore('files');
      var rq=st.openCursor();
      rq.onsuccess=function(e){
        var cur=e.target.result;
        if(cur){
          var v=cur.value||{};
          var sz=(v.meta&&v.meta.size)||0;
          total += sz;
          items.push({hash:v.hash, ts:v.ts||0, size:sz});
          cur.continue();
        }else{
          total += addedSize||0;
          if(total > CACHE_LIMIT){
            items.sort(function(a,b){ return (a.ts||0)-(b.ts||0); });
            var need=total-CACHE_LIMIT, freed=0, dels=[];
            for(var i=0;i<items.length && freed<need;i++){ freed+=items[i].size||0; dels.push(items[i].hash); }
            if(dels.length){
              var tx2=idb.transaction('files','readwrite'), s2=tx2.objectStore('files');
              dels.forEach(function(h){ try{s2.delete(h);}catch(e){} });
            }
          }
        }
      };
    }catch(e){}
  }

  // -------------------- 视频缩略图 --------------------
  function extractVideoThumbnail(file){
    return new Promise(function(resolve){
      try{
        var video=document.createElement('video');
        video.preload='metadata'; video.muted=true; video.playsInline=true;
        var url=URL.createObjectURL(file);
        var cleaned=false; function clean(){ if(cleaned) return; cleaned=true; try{URL.revokeObjectURL(url);}catch(e){} }
        var timeout = setTimeout(function(){ clean(); resolve(null); }, 4000);
        video.addEventListener('loadedmetadata', function(){
          try{ video.currentTime = Math.min(1, (video.duration||1)*0.1); }catch(e){ clearTimeout(timeout); clean(); resolve(null); }
        }, {once:true});
        video.addEventListener('seeked', function(){
          try{
            clearTimeout(timeout);
            var w=video.videoWidth||320, h=video.videoHeight||180, r=w/h|| (16/9), W=320, H=Math.round(W/r);
            var c=document.createElement('canvas'); c.width=W; c.height=H;
            var g=c.getContext('2d'); g.drawImage(video,0,0,W,H);
            var poster=c.toDataURL('image/jpeg',0.7);
            clean(); resolve(poster);
          }catch(e){ clearTimeout(timeout); clean(); resolve(null); }
        }, {once:true});
        video.addEventListener('error', function(){ clearTimeout(timeout); clean(); resolve(null); }, {once:true});
        video.src=url;
      }catch(e){ resolve(null); }
    });
  }

  // -------------------- 应用主体 --------------------
  var app=(function(){
    var self={};

    self.server  = injectedServer || {host:'peerjs.92k.de', port:443, secure:true, path:'/'};
    self.network = injectedNetwork || 'public-network';
    self.iceServers = ICE;

    self.chunkSize  = CHUNK;
    self.previewPct = PREVIEW_PCT;
    self.highWater  = HIGH_WATER;
    self.lowWater   = LOW_WATER;

    self.peer=null; self.conns={}; self.isConnected=false; self.startAt=0;
    self.localId=''; self.virtualIp='';
    self.timers={up:null,ping:null};
    self.logBuf='> 初始化：准备连接'; self.logFullBuf=self.logBuf;
    self.fullSources={}; self.displayNames={}; self.activePeer='all';
    self.myName = (localStorage.getItem('nickname')||'').trim() || '';

    self.uiRoot = null; // 聊天 UI 根节点（由 bindClassicUI 赋值）
    self._muted = false;

    function isImportant(s){
      var t=String(s||'');
      return /已连接|断开|错误|拨号|入站|消息|文件|开始连接|连接超时|连接已关闭|发送|接收|通话/.test(t);
    }
    function log(s){
      var line="["+now()+"] "+s;
      self.logFullBuf += "\n"+line;
      if (isImportant(s)){
        self.logBuf += "\n"+line;
        var el=document.getElementById('log');
        if(el){ el.textContent=self.logBuf; el.scrollTop=el.scrollHeight; }
      }
      if (typeof window.updateEntryStatus === 'function'){
        var up='00:00:00';
        if(self.isConnected && self.startAt){
          var sec=Math.floor((Date.now()-self.startAt)/1000), h=Math.floor(sec/3600), m=Math.floor((sec%3600)/60), s2=sec%60;
          up=(h<10?'0':'')+h+':'+(m<10?'0':'')+m+':'+(s2<10?'0':'')+s2;
        }
        window.updateEntryStatus({
          connected:self.isConnected,
          online:Object.keys(self.conns).filter(function(k){return self.conns[k].open;}).length,
          localId:self.localId, virtualIp:self.virtualIp, uptime:up
        });
      }
    }
    self.log = log;

    self.copyLog=function(){
      try{
        var txt=self.logFullBuf||'';
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(txt).then(function(){ alert('已复制全部日志'); });
        }else{
          var ta=document.createElement('textarea'); ta.value=txt;
          document.body.appendChild(ta); ta.select(); document.execCommand('copy');
          document.body.removeChild(ta); alert('已复制全部日志');
        }
      }catch(e){ alert('复制失败：'+e.message); }
    };
    self.clearLog=function(){ self.logBuf=''; self.logFullBuf=''; var el=document.getElementById('log'); if(el) el.textContent=''; };

    function setStatus(txt){
      var st=document.getElementById('statusChip');
      if(st) st.textContent = '已连接'===txt || '在线'===txt ? '已连接' : ('状态：'+txt).replace(/^状态：状态：/,'状态：');
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
      var base=window.location.origin+window.location.pathname;
      var url = base + '?peer='+encodeURIComponent(self.localId);
      var input=document.getElementById('shareLink'),
          qr=document.getElementById('qr');
      if(input) input.value=url;
      if(qr){
        qr.innerHTML='';
        if (typeof QRCode !== 'undefined'){
          new QRCode(qr,{text:url,width:256,height:256,correctLevel:QRCode.CorrectLevel.M});
        }
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
    function showVid(ui,url,note,poster){ if(self._classic && typeof self._classic.showVideo==='function') self._classic.showVideo(ui,url,note,poster); }
    function showAud(ui,url,note){ if(self._classic && typeof self._classic.showAudio==='function') self._classic.showAudio(ui,url,note); }
    function fileLink(ui,url,name,size){ if(self._classic && typeof self._classic.showFileLink==='function') self._classic.showFileLink(ui,url,name,size); }
    function updProg(ui,p){ if(self._classic && typeof self._classic.updateProgress==='function') self._classic.updateProgress(ui,p); }
    function mkUrl(blob){ return (self._classic && typeof self._classic.mkUrl==='function') ? self._classic.mkUrl(blob) : URL.createObjectURL(blob); }

    self.sendMsg=function(){
      var val='';
      if (self._classic && typeof self._classic.getEditorText==='function') val=self._classic.getEditorText();
      val = (val||'').trim();
      if (!val){ self.log('T14 OUT_ERROR: empty message'); return; }

      pushChat(val, true);
      if (self._classic && typeof self._classic.clearEditor==='function') self._classic.clearEditor();

      var targets=[];
      if (self.activePeer==='all'){
        for (var k in self.conns){ if(self.conns.hasOwnProperty(k) && self.conns[k].open) targets.push(k); }
      }else{
        if (self.conns[self.activePeer] && self.conns[self.activePeer].open) targets=[self.activePeer];
      }
      if (!targets.length){ self.log('T14 OUT_ERROR: no open peers to send'); return; }

      targets.forEach(function(pid){
        try{ self.conns[pid].conn.send({type:'chat', text:val}); }
        catch(e){ self.log('T14 OUT_ERROR: chat send '+(e.message||e)); }
      });
      self.log('T40 CHAT_SENT: '+ (val.length>30? (val.slice(0,30)+'…') : val) +' -> '+targets.length);
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
      if(!targets.length){ self.log('T40 FILE_SEND_BEGIN: no peers open'); alert('没有在线节点，无法发送文件'); return; }

      files.forEach(function(file){
        var ui = placeholder(file.name, file.size, true);
        var localUrl = mkUrl(file);
        var m = file.type||'application/octet-stream';
        if (isImg(m, file.name)) {
          showImg(ui, localUrl);
        }
        else if (isVid(m, file.name) && canPlayVideo(m, file.name)){
          showVid(ui, localUrl, '发送中…');
        }
        else if (isAudio(m, file.name) && canPlayAudio(m, file.name)){
          showAud(ui, localUrl, '发送中…');
        }
        else {
          fileLink(ui, localUrl, file.name, file.size);
        }

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
        if(c && typeof c.bufferSize==='number') return c.bufferSize;
        if(c && c._dc && typeof c._dc.bufferedAmount==='number') return c._dc.bufferedAmount;
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

      var posterP = Promise.resolve(null);
      var mime = file.type||'application/octet-stream';
      if (isVid(mime, file.name)) {
        posterP = Promise.race([
          extractVideoThumbnail(file),
          new Promise(function(resolve){ setTimeout(function(){ resolve(null); }, 3000); })
        ]);
      }

      posterP.then(function(poster){
        try{
          c.send({type:'file-begin', id:id, name:file.name, size:file.size, mime:mime, chunk:chunk, hash:hash, poster:poster||null});
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
            else {
              try{ c.send({type:'file-end', id:id, hash:hash}); }catch(e){}
              delete st._curSend[id];

              try{
                idbPutFull(hash||'', file, {name:file.name,size:file.size,mime:mime});
                self.fullSources[hash||'']=self.fullSources[hash||'']||new Set();
                self.fullSources[hash||''].add(self.localId);
              }catch(e){}

              done&&done();
            }
          });
        };
        function readNext(){
          var slice=file.slice(state.off,Math.min(state.off+chunk,file.size));
          reader.readAsArrayBuffer(slice);
        }
        readNext();
      }).catch(function(){ done&&done(); });
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
        var p=new Peer(null,{host:self.server.host,port:self.server.port,secure:self.server.secure,path:self.server.path||'/',config:{iceServers:self.iceServers}});
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
        if(self._classic && self._classic.renderContacts){
          var arr=[]; for(var k in self.conns){ if(self.conns[k].open) arr.push({id:k,name:self.displayNames[k]||('节点 '+shortId(k))}); }
          self._classic.renderContacts(arr, self.activePeer);
        }
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

            if(h){
              idbGetFull(h, function(rec){
                if(rec && rec.blob){
                  var url=mkUrl(rec.blob);
                  var m=(rec.meta&&rec.meta.mime)||'';
                  var n=(rec.meta&&rec.meta.name)||d.name||'文件';
                  if (isImg(m,n)) showImg(ui,url);
                  else if (isVid(m,n) && canPlayVideo(m,n)) showVid(ui,url,'本地缓存', d.poster||null);
                  else if (isAudio(m,n) && canPlayAudio(m,n)) showAud(ui,url,'本地缓存');
                  else fileLink(ui,url,n,(rec.meta&&rec.meta.size)||d.size||0);
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
              got:0, parts:[], previewed:false, previewUrl:null, mediaState:null, hash:h, poster:d.poster||null, lastSaved:0
            };
            self.conns[pid].recv.ui=ui;
          }
          else if(d.type==='file-end'){
            finalizeReceive(pid,d.id,d.hash||'');
          }
          else if(d.type==='file-has'){
            var h2=d.hash;
            if(h2){ self.fullSources[h2]=self.fullSources[h2]||new Set(); self.fullSources[h2].add(pid); }
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

        if(!ctx.previewed){
          try{
            var url=mkUrl(new Blob(ctx.parts,{type:ctx.mime}));
            if (isImg(ctx.mime, ctx.name)){
              showImg(ui,url); ctx.previewed=true; ctx.previewUrl=url;
            } else if (isVid(ctx.mime, ctx.name) && canPlayVideo(ctx.mime, ctx.name)){
              var need=Math.max(1,Math.floor(ctx.size*self.previewPct/100));
              if(ctx.got>=need){
                showVid(ui,url,'可预览（接收中 '+pct+'%）', ctx.poster||null);
                ctx.previewed=true; 
                ctx.previewUrl=url;
                ctx.mediaState = {time:0, paused:true, kind:'video'};
                setTimeout(function(){
                  var vw = ui && ui.mediaWrap && ui.mediaWrap.querySelector && ui.mediaWrap.querySelector('video');
                  if (vw){
                    vw.addEventListener('timeupdate', function(){ if(ctx.mediaState) ctx.mediaState.time = vw.currentTime||0; });
                    vw.addEventListener('play', function(){ if(ctx.mediaState) ctx.mediaState.paused = false; });
                    vw.addEventListener('pause', function(){ if(ctx.mediaState) ctx.mediaState.paused = true; });
                  }
                }, 100);
              }
            } else if (isAudio(ctx.mime, ctx.name) && canPlayAudio(ctx.mime, ctx.name)){
              var needA=Math.max(1,Math.floor(ctx.size*self.previewPct/100));
              if(ctx.got>=needA){
                showAud(ui,url,'可预览（接收中 '+pct+'%）');
                ctx.previewed=true;
                ctx.previewUrl=url;
                ctx.mediaState = {time:0, paused:true, kind:'audio'};
                setTimeout(function(){
                  var aw = ui && ui.mediaWrap && ui.mediaWrap.querySelector && ui.mediaWrap.querySelector('audio');
                  if (aw){
                    aw.addEventListener('timeupdate', function(){ if(ctx.mediaState) ctx.mediaState.time = aw.currentTime||0; });
                    aw.addEventListener('play', function(){ if(ctx.mediaState) ctx.mediaState.paused = false; });
                    aw.addEventListener('pause', function(){ if(ctx.mediaState) ctx.mediaState.paused = true; });
                  }
                }, 100);
              }
            }
          }catch(e){}
        }

        if(ctx.hash && ctx.got - (ctx.lastSaved||0) >= PART_FLUSH){
          try{ idbPutPart(ctx.hash,{name:ctx.name,size:ctx.size,mime:ctx.mime, got:ctx.got}); ctx.lastSaved = ctx.got; }catch(e){}
        }
      });

      c.on('close', function(){
        delete self.conns[pid];
        self.updateInfo();
        if(self._classic && self._classic.renderContacts){
          var arr=[]; for(var k in self.conns){ if(self.conns[k].open) arr.push({id:k,name:self.displayNames[k]||('节点 '+shortId(k))}); }
          self._classic.renderContacts(arr, self.activePeer);
        }
      });

      c.on('error', function(err){});
    }

    function finalizeReceive(pid,id,hash){
      var st=self.conns[pid]; if(!st||!st.recv) return;
      var ctx=st.recv.cur, ui=st.recv.ui;
      if(!ctx||ctx.id!==id) return;

      var blob=new Blob(ctx.parts,{type:ctx.mime});
      var newUrl=mkUrl(blob);

      if (isImg(ctx.mime, ctx.name)) {
        showImg(ui,newUrl);
      }
      else if (isVid(ctx.mime, ctx.name) && canPlayVideo(ctx.mime, ctx.name)){
        var savedTime = (ctx.mediaState && ctx.mediaState.time) || 0;
        var wasPaused = (ctx.mediaState && ctx.mediaState.paused) || true;
        showVid(ui, newUrl, '接收完成', ctx.poster||null);
        setTimeout(function(){
          var vw = ui && ui.mediaWrap && ui.mediaWrap.querySelector && ui.mediaWrap.querySelector('video');
          if (vw && savedTime > 0){
            vw.addEventListener('loadedmetadata', function(){
              try{
                vw.currentTime = Math.min(savedTime, vw.duration || savedTime);
                if (!wasPaused) vw.play().catch(function(){});
              }catch(e){}
            }, {once:true});
          }
        }, 100);
      }
      else if (isAudio(ctx.mime, ctx.name) && canPlayAudio(ctx.mime, ctx.name)){
        var asaved = (ctx.mediaState && ctx.mediaState.time) || 0;
        var apaused = (ctx.mediaState && ctx.mediaState.paused) || true;
        showAud(ui, newUrl, '接收完成');
        setTimeout(function(){
          var aw = ui && ui.mediaWrap && ui.mediaWrap.querySelector && ui.mediaWrap.querySelector('audio');
          if (aw && asaved > 0){
            aw.addEventListener('loadedmetadata', function(){
              try{
                aw.currentTime = Math.min(asaved, aw.duration || asaved);
                if (!apaused) aw.play().catch(function(){});
              }catch(e){}
            }, {once:true});
          }
        }, 100);
      }
      else {
        fileLink(ui,newUrl,ctx.name,ctx.size);
      }

      try{
        if(ctx.previewUrl && ctx.previewUrl !== newUrl) URL.revokeObjectURL(ctx.previewUrl);
      }catch(e){}

      try{
        idbPutFull(hash||ctx.hash||'', blob, {name:ctx.name,size:ctx.size,mime:ctx.mime});
        if (ctx.hash) idbDelPart(ctx.hash);
        self.fullSources[hash||ctx.hash||'']=self.fullSources[hash||ctx.hash||'']||new Set();
        self.fullSources[hash||ctx.hash||''].add(self.localId);
        for(var k in self.conns){
          var s=self.conns[k]; if(s.open){ try{ s.conn.send({type:'file-has', hash:(hash||ctx.hash||'')}); }catch(e){} }
        }
      }catch(e){}

      st.recv.cur=null; st.recv.ui=null;
      self.log('已接收文件：'+ctx.name+' '+human(ctx.size));
      var msgScroll=document.getElementById('msgScroll'); if(msgScroll){ msgScroll.scrollTop=msgScroll.scrollHeight; }
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
        if (typeof window.updateEntryStatus === 'function'){
          window.updateEntryStatus({connected:true, online:Object.keys(self.conns).filter(function(k){return self.conns[k].open;}).length, localId:self.localId, virtualIp:self.virtualIp, uptime:t});
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

    self.quickCall=function(){
      if (!self.peer || !self.isConnected){ alert('未连接'); return; }
      var open = Object.keys(self.conns).filter(function(k){ return self.conns[k] && self.conns[k].open; });
      if (!open.length){ alert('没有在线对象'); return; }
      var pid = (self.activePeer && self.activePeer!=='all' && self.conns[self.activePeer] && self.conns[self.activePeer].open)
                ? self.activePeer
                : (open.length===1 ? open[0] : null);
      if (!pid && open.length>1){
        var names = open.map(function(k,i){ return (i+1)+'. '+(self.displayNames[k]||('节点 '+k.slice(0,8))); }).join('\n');
        var ans = prompt('选择视频通话对象：输入序号\n'+names, '1');
        var idx = parseInt(ans||'',10);
        if (idx>=1 && idx<=open.length) pid = open[idx-1];
      }
      if (!pid){ return; }
      self.activePeer = pid;
      self.toggleCall(false);
    };

    self.toggleCall=function(forceClose){
      if (!window.__ENTRY_PAGE__) return;
      self._media = self._media || {};
      if (self._media.call || forceClose){
        try{ self._media.call && self._media.call.close(); }catch(e){}
        if (self._media.local){ try{ self._media.local.getTracks().forEach(function(t){t.stop();}); }catch(e){} }
        self._media.call=null; self._media.local=null;
        var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=null;
        var lv=document.getElementById('localVideo');  if(lv) lv.srcObject=null;
        return;
      }
      var pid=self.activePeer;
      if(!pid || pid==='all'){ alert('请先选择通话对象'); return; }
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

    // -------------------- 免打扰（完全隐藏） --------------------
    function isEmbedMode(){
      try{
        return !!document.getElementById('classicHost') || !!document.querySelector('[data-chat-root]') || !!window.__ENTRY_PAGE__;
      }catch(e){ return false; }
    }
    function applyMuted(){
      try{
        var muted = !!self._muted;
        var title = document.title||'';
        if (muted && title.indexOf('🔕 ')!==0) document.title = '🔕 ' + title;
        if (!muted && title.indexOf('🔕 ')===0) document.title = title.replace(/^🔕\s+/, '');
        if (self.uiRoot){
          if (isEmbedMode()){
            self.uiRoot.style.display = muted ? 'none' : '';
          } else {
            // Standalone：仅折叠消息与输入区，保留顶部栏，避免无法恢复
            var msgs = self.uiRoot.querySelector('.messages');
            var send = self.uiRoot.querySelector('.send');
            if (msgs) msgs.style.display = muted ? 'none' : '';
            if (send) send.style.display = muted ? 'none' : '';
          }
        }
      }catch(e){}
    }
    self.setMuted = function(flag){
      self._muted = !!flag;
      try{ localStorage.setItem('classicMuted', self._muted ? '1' : '0'); }catch(e){}
      applyMuted();
    };
    self.hideUI = function(){ self.setMuted(true); };
    self.showUI = function(){ self.setMuted(false); };

    return self;
  })();

  // -------------------- 经典 UI 绑定 --------------------
  function bindClassicUI(app){
    if (!window.CLASSIC_UI) return;
    if (app.__uiBound) return;
    app.__uiBound = true;

    var editor = document.getElementById('editor');
    var sendBtn = document.getElementById('sendBtn');
    var fileInput = document.getElementById('fileInput');
    var msgScroll = document.getElementById('msgScroll');
    var contactList = document.getElementById('contactList');
    var contactSearch = document.getElementById('contactSearch');
    var sendArea = document.getElementById('sendArea');
    var statusChip = document.getElementById('statusChip');
    var onlineChip = document.getElementById('onlineChip');

    var appRoot = document.querySelector('.app') || document.body;
    app.uiRoot = appRoot;

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
      mkUrl: function(blob){ return URL.createObjectURL(blob); },
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
                         + '<div class="progress-line">'+(mine?'准备发送…':'准备接收…')+'</div></div>';
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
      showVideo: function(ui,url,info,poster){
        if(!ui||!ui.mediaWrap) return;
        ui.mediaWrap.classList.add('media');
        var posterAttr = poster ? ' poster="'+poster+'"' : '';
        // 不可播放时降级为下载
        var can = (function(){ try{ var v=document.createElement('video'); return v && v.canPlayType && (v.canPlayType('video/mp4')||v.canPlayType('video/webm')); }catch(e){ return false; } })();
        if (!can){
          ui.mediaWrap.innerHTML = '<a href="'+url+'" target="_blank" rel="noopener" class="file-link">'
                                 + '<div class="file-info"><span class="file-icon">📄</span><span class="file-name">视频</span></div>'
                                 + '<div class="progress-line">'+(info||'点击下载播放')+'</div></a>';
        } else {
          ui.mediaWrap.innerHTML = '<video controls preload="metadata" src="'+url+'"'+posterAttr+' style="width:var(--thumb);border-radius:8px;background:#000"></video>'
                                 + (info?'<div class="progress-line">'+info+'</div>':'');
        }
      },
      showAudio: function(ui,url,info){
        if(!ui||!ui.mediaWrap) return;
        ui.mediaWrap.classList.add('media');
        var can = (function(){ try{ var a=document.createElement('audio'); return a && a.canPlayType; }catch(e){ return false; } })();
        if (!can){
          ui.mediaWrap.innerHTML = '<a href="'+url+'" target="_blank" rel="noopener" class="file-link">'
                                 + '<div class="file-info"><span class="file-icon">📄</span><span class="file-name">音频</span></div>'
                                 + '<div class="progress-line">'+(info||'点击下载播放')+'</div></a>';
        } else {
          ui.mediaWrap.innerHTML = '<audio controls preload="metadata" src="'+url+'" style="width:var(--thumb)"></audio>'
                                 + (info?'<div class="progress-line">'+info+'</div>':'');
        }
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

    // 编辑器交互
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

    (function initialRender(){
      if (!contactList || !app || !app._classic || !app._classic.renderContacts) return;
      var arr = [];
      for (var pid in app.conns) {
        if (!app.conns.hasOwnProperty(pid)) continue;
        if (!app.conns[pid].open) continue;
        arr.push({ id: pid, name: app.displayNames[pid] || ('节点 ' + pid.substring(0,8)) });
      }
      app._classic.renderContacts(arr, app.activePeer);
    })();

    app._classic.updateStatus();

    // 绑定“免打扰”点击（完全隐藏）
    (function bindMuteChip(){
      try{
        var header = document.querySelector('.header');
        if(!header) return;
        var chips = header.querySelectorAll('.chip');
        var target=null;
        for(var i=0;i<chips.length;i++){
          if((chips[i].textContent||'').indexOf('免打扰')!==-1){ target=chips[i]; break; }
        }
        if(target){
          target.addEventListener('click', function(){
            app.hideUI(); // 完全隐藏（在首页/嵌入模式下隐藏整个UI；独立页面折叠消息与输入区）
          });
        }
      }catch(e){}
    })();

    // 恢复免打扰状态
    (function restoreMuted(){
      try{
        var v=localStorage.getItem('classicMuted');
        var muted = v === '1';
        app._muted = muted;
        // 初次绑定后，按场景应用
        setTimeout(function(){ 
          app.uiRoot = app.uiRoot || document.querySelector('.app') || document.body;
          (function(){ try{ app._muted = !!(localStorage.getItem('classicMuted')==='1'); }catch(e){} })();
          (function(){ try{ app._muted = app._muted && isEmbedMode(); }catch(e){} })(); // 独立页面默认不隐藏整个 UI，避免“找不回”
          var title = document.title||'';
          if (!isEmbedMode() && app._muted){
            // 独立页：仅折叠消息与输入，保留头部（防止无法恢复）
            app._muted = true;
          }
          (function(){ try{ app._muted = !!app._muted; }catch(e){} })();
          (function(){ try{ if(!isEmbedMode() && app._muted){ /* ok */ } }catch(e){} })();
          // 应用
          var apply=function(){
            try{
              var muted = !!app._muted;
              var title = document.title||'';
              if (muted && title.indexOf('🔕 ')!==0) document.title = '🔕 ' + title;
              if (!muted && title.indexOf('🔕 ')===0) document.title = title.replace(/^🔕\s+/, '');
              if (app.uiRoot){
                if (isEmbedMode()){
                  app.uiRoot.style.display = muted ? 'none' : '';
                } else {
                  var msgs = app.uiRoot.querySelector('.messages');
                  var send = app.uiRoot.querySelector('.send');
                  if (msgs) msgs.style.display = muted ? 'none' : '';
                  if (send) send.style.display = muted ? 'none' : '';
                }
              }
            }catch(e){}
          };
          apply();
        }, 0);
      }catch(e){}
    })();
  }

  // -------------------- 启动/注入 --------------------
  if (window.CLASSIC_UI && window.opener) {
    (function waitOpener(){
      try{
        if (window.opener && window.opener.app) {
          window.app = window.opener.app;
          bindClassicUI(window.app);
          return;
        }
      }catch(e){}
      setTimeout(waitOpener, 200);
    })();
  } else {
    window.app = app;
    bindClassicUI(app);
    if (!app.isConnected) app.toggle();
  }
})();