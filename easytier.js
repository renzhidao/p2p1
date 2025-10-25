(function(){
  // 配置
  var server = (typeof window.__FIXED_SERVER__ === 'object' && window.__FIXED_SERVER__) || {host:'peerjs.92k.de', port:443, secure:true, path:'/'};
  var networkName = (typeof window.__FIXED_NETWORK__ === 'string' && window.__FIXED_NETWORK__) || 'public-network';

  var ICE = [
    {urls:'stun:stun.l.google.com:19302'},
    {urls:'stun:stun1.l.google.com:19302'},
    {urls:'stun:global.stun.twilio.com:3478'}
  ];

  var CHUNK = 512*1024;        // 512KB
  var PREVIEW_PCT = 3;         // 3%
  var HIGH_WATER = 1.5*1024*1024;
  var LOW_WATER  = 0.6*1024*1024;

  // 工具
  var log = function(s){ try{ (window._entryLog||console.log)('[ET] '+s); }catch(e){} };
  var nowStr = function(){ return new Date().toLocaleTimeString(); };

  function sanitizeId(s){
    return String(s||'').toLowerCase().replace(/[^a-z0-9_-]/g,'-').slice(0,48) || 'room';
  }
  function roomIdOf(name){ return 'et-' + sanitizeId(name||'public-network'); }
  function short(id){ if(!id) return '-'; return id.slice(0,8)+'…'; }
  function human(n){
    if(n<1024) return n+' B';
    if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
    if(n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB';
    return (n/1024/1024/1024).toFixed(1)+' GB';
  }
  function firstCharSafe(str, fallback){
    try{
      var s=String(str||'').trim();
      if(!s) return fallback||'?';
      var it = s[Symbol.iterator](); var f = it.next(); return f.value || fallback || '?';
    }catch(e){ return fallback||'?'; }
  }
  function sha256(str){
    var enc=new TextEncoder().encode(str);
    return crypto.subtle.digest('SHA-256', enc).then(function(buf){
      var b=new Uint8Array(buf), s='';
      for(var i=0;i<b.length;i++){ s+=('0'+b[i].toString(16)).slice(-2);}
      return s;
    });
  }
  function fileHashMeta(file){ return sha256(file.name+'|'+file.size); }

  // IDB（断点续传/缓存）
  var idb, idbReady=false;
  (function openIDB(){
    try{
      var req=indexedDB.open('p2p-cache',2);
      req.onupgradeneeded=function(e){
        var db=e.target.result;
        if(!db.objectStoreNames.contains('files')) db.createObjectStore('files',{keyPath:'hash'});
        if(!db.objectStoreNames.contains('parts')) db.createObjectStore('parts',{keyPath:'hash'}); // 部分
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
  function idbPutPart(hash, partsMeta){
    if(!idbReady) return;
    try{ var tx=idb.transaction('parts','readwrite'); tx.objectStore('parts').put({hash:hash, meta:partsMeta, ts:Date.now()}); }catch(e){}
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

  // 视频首帧
  function extractVideoThumbnailFromBlob(blob, cb){
    try{
      var v=document.createElement('video'); v.preload='metadata'; v.muted=true; v.playsInline=true;
      var url=URL.createObjectURL(blob); v.src=url;
      var done=false, clean=function(){ if(done) return; done=true; try{URL.revokeObjectURL(url);}catch(e){} };
      v.addEventListener('loadeddata', function(){
        try{ v.currentTime = Math.min(1, (v.duration||1)*0.1); }catch(e){ clean(); cb(null); }
      }, {once:true});
      v.addEventListener('seeked', function(){
        try{
          var w=v.videoWidth||320, h=v.videoHeight||180, r=w/h, W=320, H=Math.round(W/r);
          var c=document.createElement('canvas'); c.width=W; c.height=H;
          var g=c.getContext('2d'); g.drawImage(v,0,0,W,H);
          var poster=c.toDataURL('image/jpeg',0.7);
          clean(); cb(poster);
        }catch(e){ clean(); cb(null); }
      }, {once:true});
      v.addEventListener('error', function(){ clean(); cb(null); }, {once:true});
    }catch(e){ cb(null); }
  }

  // 应用对象
  var app=(function(){
    var self={};

    // 公开状态
    self.connected=false;
    self.isHub=false;
    self.peer=null;
    self.anchorId = roomIdOf(networkName);
    self.localId='';
    self.myName = (localStorage.getItem('nickname')||'').trim() || '';
    self.users = new Map(); // id -> {id,name}
    self.activePeer='all';

    // 房主转发表：fid -> {fromId, toIds:Set}
    var routes = Object.create(null);

    // 连接字典：id -> {conn, open, sending, queue:[]}
    self.conns = {};

    // 视频通话（入口页用）
    self._media = { local:null, remote:null, call:null };
    var haveEntry = !!window.__ENTRY_PAGE__;

    // classic UI 绑定（UI 页面不改）
    bindClassicUI(self);

    function updateEntryChips(){
      if (typeof window.updateEntryChips === 'function'){
        window.updateEntryChips({connected:self.connected, online:self.users.size, isHub:self.isHub});
      }
    }
    function setStatus(connected){
      self.connected = !!connected;
      updateEntryChips();
      if (self._classic && typeof self._classic.updateStatus==='function') self._classic.updateStatus();
    }

    // hub 广播 users
    function broadcastUsers(){
      var list=[]; self.users.forEach(function(v){ list.push({id:v.id,name:v.name}); });
      // 给自己 UI
      if (self._classic && typeof self._classic.renderContacts==='function'){
        self._classic.renderContacts(list, self.activePeer);
      }
      // 广播给客户端
      if (self.isHub){
        Object.keys(self.conns).forEach(function(pid){
          var st=self.conns[pid]; if(!st.open) return;
          try{ st.conn.send({type:'users', users:list}); }catch(e){}
        });
      }
      updateEntryChips();
    }

    // 添加/删除用户
    function setUser(id,name){ self.users.set(id,{id:id,name:name||('节点 '+short(id))}); broadcastUsers(); }
    function delUser(id){ self.users.delete(id); if (self.activePeer===id) self.activePeer='all'; broadcastUsers(); }

    // 发送文本（按 activePeer 或 all）
    self.sendMsg=function(){
      var text='';
      if (self._classic && typeof self._classic.getEditorText==='function') text=self._classic.getEditorText();
      text = (text||'').trim();
      if (!text) return;

      // 本地回显
      if (self._classic && typeof self._classic.appendChat==='function'){
        self._classic.appendChat(text, true);
        if (self._classic.clearEditor) self._classic.clearEditor();
      }

      var to = self.activePeer || 'all';
      if (self.isHub){
        // hub 直接转发
        routeText(self.localId, to, text);
      }else{
        // 客户端发给 hub
        var hub = self.conns[self.anchorId] && self.conns[self.anchorId].conn;
        if (!hub || !self.connected){ return; }
        try{ hub.send({type:'msg', from:self.localId, to:to, text:text}); }catch(e){}
      }
    };

    function routeText(from, to, text){
      if (!self.isHub) return;
      if (to==='all'){
        Object.keys(self.conns).forEach(function(pid){
          // 给所有人，包括发送者，让他也“回显一致”
          try{ self.conns[pid].conn.send({type:'msg', from:from, to:'all', text:text}); }catch(e){}
        });
      }else{
        // 单发，双方都收到
        var a=self.conns[to], b=self.conns[from];
        if (a) try{ a.conn.send({type:'msg', from:from, to:to, text:text}); }catch(e){}
        if (b) try{ b.conn.send({type:'msg', from:from, to:to, text:text}); }catch(e){}
      }
    }

    // 发文件（从 UI 的文件列表来）
    self.sendFilesFrom=function(files){
      files = Array.prototype.slice.call(files||[]);
      if (!files.length) return;

      var to = self.activePeer || 'all';
      // 本地一次回显（不等对端）
      files.forEach(function(file){
        // 先回显自己一条
        var ui = self._classic && self._classic.placeholder ? self._classic.placeholder(file.name, file.size, true) : null;
        var localUrl = URL.createObjectURL(file);
        if (file.type.indexOf('image/')===0){
          self._classic && self._classic.showImage && self._classic.showImage(ui, localUrl);
        }else if (file.type.indexOf('video/')===0){
          extractVideoThumbnailFromBlob(file, function(p){
            if (ui) ui.poster = p||null;
            self._classic && self._classic.showVideo && self._classic.showVideo(ui, localUrl, '已发送', null);
          });
        }else{
          self._classic && self._classic.showFileLink && self._classic.showFileLink(ui, localUrl, file.name, file.size);
        }
        setTimeout(function(){ try{URL.revokeObjectURL(localUrl);}catch(e){} }, 60000);

        // 真正发送
        fileHashMeta(file).then(function(hash){
          doSendFile(to, file, hash);
        });
      });
    };

    function doSendFile(to, file, hash){
      var fid = String(Date.now())+'_'+Math.floor(Math.random()*1e6);
      var posterP = (file.type||'').indexOf('video/')===0 ?
        new Promise(function(res){ extractVideoThumbnailFromBlob(file, res); }) :
        Promise.resolve(null);

      posterP.then(function(poster){
        if (self.isHub){
          // hub 本机也可能发送：复用客户端通道逻辑（发给自己转发）
          sendFileViaHub(self.localId, to, fid, file, hash, poster);
        }else{
          var hub = self.conns[self.anchorId] && self.conns[self.anchorId].conn;
          if (!hub || !self.connected) return;

          try{
            hub.send({type:'file-begin', fid:fid, from:self.localId, to:to, name:file.name, size:file.size, mime:file.type||'application/octet-stream', chunk:CHUNK, hash:hash, poster:poster||null});
          }catch(e){ return; }

          // 读并发数据
          var off=0; var reader=new FileReader();
          reader.onerror=function(){ try{ hub.send({type:'file-end', fid:fid, from:self.localId, to:to, hash:hash}); }catch(e){} };
          reader.onload=function(e){
            // 节流
            var buf=e.target.result;
            // 分块传（直接发 ArrayBuffer）
            try{ hub.send(buf); }catch(ex){}
            off+=buf.byteLength;
            if (off < file.size){
              readNext();
            } else {
              try{ hub.send({type:'file-end', fid:fid, from:self.localId, to:to, hash:hash}); }catch(e){}
            }
          };
          function readNext(){
            var slice=file.slice(off, Math.min(off+CHUNK, file.size));
            reader.readAsArrayBuffer(slice);
          }
          readNext();
        }
      });
    }

    // hub 路由：文件
    function sendFileViaHub(fromId, to, fid, file, hash, poster){
      if (!self.isHub) return;
      // 建立路由
      var targets=[];
      if (to==='all'){
        targets = Object.keys(self.conns).filter(function(pid){ return pid!==fromId; });
      }else{
        if (self.conns[to]) targets=[to];
      }
      routes[fid] = {fromId:fromId, toIds:new Set(targets)};

      // 发 meta 给目标
      targets.forEach(function(pid){
        var st=self.conns[pid]; if(!st||!st.open) return;
        try{ st.conn.send({type:'file-begin', fid:fid, from:fromId, to:pid, name:file.name, size:file.size, mime:file.type||'application/octet-stream', chunk:CHUNK, hash:hash, poster:poster||null}); }catch(e){}
      });

      // hub 自己从文件读 chunk，转发
      var off=0; var reader=new FileReader();
      reader.onerror=function(){
        targets.forEach(function(pid){ var st=self.conns[pid]; if(st&&st.open) try{ st.conn.send({type:'file-end', fid:fid, from:fromId, to:pid, hash:hash}); }catch(e){} });
        delete routes[fid];
      };
      reader.onload=function(e){
        var buf=e.target.result;
        targets.forEach(function(pid){
          var st=self.conns[pid]; if(!st||!st.open) return;
          try{ st.conn.send(buf); }catch(ex){}
        });
        off+=buf.byteLength;
        if (off < file.size){
          readNext();
        } else {
          targets.forEach(function(pid){ var st=self.conns[pid]; if(st&&st.open) try{ st.conn.send({type:'file-end', fid:fid, from:fromId, to:pid, hash:hash}); }catch(e){} });
          delete routes[fid];
        }
      };
      function readNext(){
        var slice=file.slice(off, Math.min(off+CHUNK, file.size));
        reader.readAsArrayBuffer(slice);
      }
      readNext();
    }

    // 客户端接收：文件处理
    function handleIncomingFileBegin(meta){
      // 本端创建占位
      var ui = self._classic && self._classic.placeholder ? self._classic.placeholder(meta.name, meta.size, false) : null;
      if (ui && meta.poster) ui.poster = meta.poster;

      // 断点：查 IDB
      var hash = meta.hash||'';
      if (hash){
        idbGetFull(hash, function(rec){
          if (rec && rec.blob && rec.meta && rec.meta.size===meta.size){
            // 秒回：已完整
            var url=URL.createObjectURL(rec.blob);
            if ((rec.meta.mime||'').indexOf('image/')===0){
              self._classic && self._classic.showImage && self._classic.showImage(ui, url);
            }else if ((rec.meta.mime||'').indexOf('video/')===0){
              self._classic && self._classic.showVideo && self._classic.showVideo(ui, url, '本地缓存', null);
            }else{
              self._classic && self._classic.showFileLink && self._classic.showFileLink(ui, url, rec.meta.name, rec.meta.size);
            }
            setTimeout(function(){ try{URL.revokeObjectURL(url);}catch(e){} },60000);
            // 告知对端完成
            tryRoute({type:'file-end', fid:meta.fid, from:meta.from, to:meta.to, hash:hash});
            return;
          }
          // 查部分
          idbGetPart(hash, function(part){
            if (part && part.meta && typeof part.meta.got==='number' && part.meta.got<meta.size){
              tryRoute({type:'file-resume', fid:meta.fid, from:meta.to, to:meta.from, hash:hash, offset:part.meta.got});
            }
          });
        });
      }

      // 新建接收上下文
      self._recv = self._recv || {};
      self._recv[meta.fid] = {
        fid:meta.fid, name:meta.name, size:meta.size, mime:meta.mime, from:meta.from, to:meta.to,
        got:0, parts:[], previewed:false, previewUrl:null, poster:meta.poster||null, hash:meta.hash||'',
        ui:ui, lastFlush:0
      };

      // 如果带海报，先显示缩略图
      if ((meta.mime||'').indexOf('video/')===0 && meta.poster && self._classic && self._classic.showVideo){
        // 先占位缩略图，不可点
        self._classic.showVideo(ui, '#', '等待数据…', null);
      }
    }

    function handleIncomingFileChunk(buf){
      self._recv = self._recv || {};
      // 只有一个在收？
      var keys = Object.keys(self._recv); if (!keys.length) return;
      var fid = keys[0]; var ctx = self._recv[fid]; if(!ctx) return;

      ctx.parts.push(new Blob([buf], {type:ctx.mime}));
      ctx.got += buf.byteLength;
      var pct = ctx.size ? Math.min(100, Math.floor(ctx.got*100/ctx.size)) : 0;
      self._classic && self._classic.updateProgress && self._classic.updateProgress(ctx.ui, pct);

      // 分段落盘（每 2MB）
      if (ctx.hash && ctx.got - ctx.lastFlush >= 2*1024*1024){
        try{ idbPutPart(ctx.hash, {name:ctx.name,size:ctx.size,mime:ctx.mime, got:ctx.got}); ctx.lastFlush = ctx.got; }catch(e){}
      }

      // 预览
      if (!ctx.previewed){
        try{
          var url = URL.createObjectURL(new Blob(ctx.parts, {type:ctx.mime}));
          if ((ctx.mime||'').indexOf('image/')===0){
            self._classic && self._classic.showImage && self._classic.showImage(ctx.ui, url);
            ctx.previewed=true; ctx.previewUrl=url;
          }else if ((ctx.mime||'').indexOf('video/')===0){
            var need = Math.max(1, Math.floor(ctx.size*PREVIEW_PCT/100));
            if (ctx.got >= need){
              self._classic && self._classic.showVideo && self._classic.showVideo(ctx.ui, url, '可预览（接收中 '+pct+'%）', null);
              ctx.previewed=true; ctx.previewUrl=url;
            }else{
              try{ URL.revokeObjectURL(url);}catch(e){}
            }
          }
        }catch(e){}
      }
    }

    function finalizeIncomingFile(meta){
      var ctx = self._recv && self._recv[meta.fid];
      if (!ctx) return;

      var blob = new Blob(ctx.parts, {type:ctx.mime});
      var url  = URL.createObjectURL(blob);

      if ((ctx.mime||'').indexOf('image/')===0){
        self._classic && self._classic.showImage && self._classic.showImage(ctx.ui, url);
      }else if ((ctx.mime||'').indexOf('video/')===0){
        self._classic && self._classic.showVideo && self._classic.showVideo(ctx.ui, url, '接收完成', null);
      }else{
        self._classic && self._classic.showFileLink && self._classic.showFileLink(ctx.ui, url, ctx.name, ctx.size);
      }

      // 完整落盘，删除部分
      try{
        idbPutFull(ctx.hash||'', blob, {name:ctx.name,size:ctx.size,mime:ctx.mime});
        if (ctx.hash) idbDelPart(ctx.hash);
      }catch(e){}

      // 清理
      try{ if(ctx.previewUrl) URL.revokeObjectURL(ctx.previewUrl);}catch(e){}
      setTimeout(function(){ try{URL.revokeObjectURL(url);}catch(e){} },60000);
      delete self._recv[meta.fid];
    }

    // 路由发送（客户端 -> hub，或 hub -> hub 自用）
    function tryRoute(obj){
      if (self.isHub){
        // hub 自己处理
        if (obj.type==='file-end'){
          // hub 不需要本地 UI
        }else if (obj.type==='file-resume'){
          // 转发给发送方
          var st=self.conns[obj.to]; if(st&&st.open) try{ st.conn.send(obj); }catch(e){}
        }
      }else{
        var hub = self.conns[self.anchorId] && self.conns[self.anchorId].conn;
        if (!hub || !self.connected) return;
        try{ hub.send(obj); }catch(e){}
      }
    }

    // 入口页视频通话（1v1，仅对 activePeer）
    self.toggleCall = function(){
      if (!haveEntry) return;
      if (self._media.call){
        try{ self._media.call.close(); }catch(e){}
        self._media.call=null;
        if (self._media.local){ try{ self._media.local.getTracks().forEach(t=>t.stop()); }catch(e){} self._media.local=null; }
        var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=null;
        var lv=document.getElementById('localVideo');  if(lv) lv.srcObject=null;
        return;
      }
      // 仅对单聊对象有效
      var pid = self.activePeer;
      if (!pid || pid==='all'){ alert('请先在 UI 里选择一个联系人'); return; }
      var peer = self.peer; if (!peer){ alert('未连接'); return; }

      navigator.mediaDevices.getUserMedia({video:true, audio:true}).then(function(stream){
        self._media.local = stream;
        var lv=document.getElementById('localVideo'); if(lv) lv.srcObject=stream;
        var call = peer.call(pid, stream);
        self._media.call = call;
        call.on('stream', function(remote){ var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=remote; });
        call.on('close', function(){ self.toggleCall(); });
        call.on('error', function(){ self.toggleCall(); });
      }).catch(function(){ alert('无法获取摄像头/麦克风'); });
    };

    // 连接/断开
    self.toggle=function(){
      if (self.connected){ disconnect(); return; }
      connectStart();
    };

    function connectStart(){
      var rid = self.anchorId;
      var p;
      try{
        // 先尝试作为房主（占用固定房间 ID）
        p=new Peer(rid,{host:server.host,port:server.port,secure:server.secure,path:server.path,config:{iceServers:ICE}});
      }catch(e){ log('Peer init error: '+e.message); return; }

      self.peer=p;
      var opened=false, anchorOk=false;

      p.on('open', function(id){
        opened=true; anchorOk=true; self.isHub=true; self.localId=id;
        setStatus(true);
        setUser(self.localId, self.myName || ('房主-'+short(self.localId)));
        broadcastUsers();
        log('['+nowStr()+'] 作为房主上线：'+id);
        // 房主监听入站
        p.on('connection', function(conn){ handleConn(conn,true); });
        // 房主接听媒体通话
        p.on('call', function(call){
          if (!haveEntry){ try{ call.close(); }catch(e){} return; }
          navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(function(stream){
            self._media.local = stream;
            var lv=document.getElementById('localVideo'); if(lv) lv.srcObject=stream;
            call.answer(stream);
            self._media.call = call;
            call.on('stream', function(remote){ var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=remote; });
            call.on('close', function(){ self.toggleCall(); });
            call.on('error', function(){ self.toggleCall(); });
          }).catch(function(){ try{ call.close(); }catch(e){} });
        });
      });

      // 如果占用失败（ID 已被房主占用），转客户端
      p.on('error', function(err){
        if (anchorOk) { log('peer error: '+(err&&err.type||err)); return; }
        // 失败则走随机 ID + 连接到房主
        try{ p.destroy(); }catch(e){}
        tryClient();
      });

      // 超时也切客户端
      setTimeout(function(){ if(!opened && !anchorOk){ try{p.destroy();}catch(e){} tryClient(); } }, 6000);
    }

    function tryClient(){
      var p;
      try{
        p=new Peer(null,{host:server.host,port:server.port,secure:server.secure,path:server.path,config:{iceServers:ICE}});
      }catch(e){ log('Peer init error: '+e.message); return; }
      self.peer=p;
      p.on('open', function(id){
        self.isHub=false; self.localId=id; setStatus(true);
        log('['+nowStr()+'] 作为客户端上线：'+id);
        // 连接房主
        var c;
        try{ c=p.connect(self.anchorId,{reliable:true}); }catch(e){ return; }
        handleConn(c,false);
      });
      p.on('call', function(call){
        // 入口页接听
        if (!haveEntry){ try{ call.close(); }catch(e){} return; }
        navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(function(stream){
          self._media.local = stream;
          var lv=document.getElementById('localVideo'); if(lv) lv.srcObject=stream;
          call.answer(stream);
          self._media.call = call;
          call.on('stream', function(remote){ var rv=document.getElementById('remoteVideo'); if(rv) rv.srcObject=remote; });
          call.on('close', function(){ self.toggleCall(); });
          call.on('error', function(){ self.toggleCall(); });
        }).catch(function(){ try{ call.close(); }catch(e){} });
      });
      p.on('error', function(err){ log('peer error: '+(err&&err.type||err)); });
    }

    function disconnect(){
      // 关通话
      if (self._media.call){ try{ self._media.call.close(); }catch(e){} self._media.call=null; }
      if (self._media.local){ try{ self._media.local.getTracks().forEach(t=>t.stop()); }catch(e){} self._media.local=null; }
      // 关数据
      for (var k in self.conns){ try{ self.conns[k].conn.close(); }catch(e){} }
      self.conns={}; routes={}; self.users.clear();
      if (self.peer){ try{ self.peer.destroy(); }catch(e){} self.peer=null; }
      self.localId=''; self.isHub=false;
      setStatus(false); broadcastUsers();
      log('['+nowStr()+'] 断开');
    }

    function handleConn(conn, inbound){
      if(!conn) return;
      var pid = conn.peer;
      self.conns[pid] = {conn:conn, open:false};

      conn.on('open', function(){
        self.conns[pid].open=true;
        // hello 握手：带昵称
        try{ conn.send({type:'hello', id:self.localId, name: self.myName || ('用户-'+short(self.localId))}); }catch(e){}
        if (!self.isHub){
          // 客户端连上房主后，设置房主和自己
          setUser(self.localId, self.myName || ('用户-'+short(self.localId)));
        }
      });

      conn.on('data', function(d){
        // JSON or ArrayBuffer?
        if (d && (d.byteLength===undefined) && typeof d==='object' && d.type){
          // 控制面
          if (self.isHub){
            // 房主：处理来自客户端的控制
            if (d.type==='hello'){
              // 记录用户并广播
              setUser(pid, d.name||('用户-'+short(pid)));
              // 同步用户列表给这个客户端
              var list=[]; self.users.forEach(function(v){ list.push({id:v.id,name:v.name}); });
              try{ conn.send({type:'users', users:list}); }catch(e){}
            }else if (d.type==='msg'){
              routeText(d.from||pid, d.to||'all', String(d.text||''));
            }else if (d.type==='file-begin'){
              // 建立路由并把 meta 发给目标
              var fromId=d.from||pid, to=d.to||'all';
              routes[d.fid]={fromId:fromId, toIds:new Set()};
              var targets=[];
              if (to==='all'){
                targets = Object.keys(self.conns).filter(function(x){ return x!==fromId; });
              }else{
                if (self.conns[to]) targets=[to];
              }
              // 记路由
              targets.forEach(function(x){ routes[d.fid].toIds.add(x); });
              // 转发 meta
              targets.forEach(function(x){ var st=self.conns[x]; if(st&&st.open) try{ st.conn.send(d); }catch(e){} });
            }else if (d.type==='file-end' || d.type==='file-resume'){
              // 路由给目标或发送者
              if (d.type==='file-resume'){
                var st=self.conns[d.to]; if(st&&st.open) try{ st.conn.send(d); }catch(e){}
              }else{
                var route=routes[d.fid]; if(!route) return;
                route.toIds.forEach(function(x){ var st=self.conns[x]; if(st&&st.open) try{ st.conn.send(d); }catch(e){} });
                if (d.type==='file-end'){ delete routes[d.fid]; }
              }
            }
          }else{
            // 客户端：处理房主下发
            if (d.type==='hello'){
              // 可忽略
            }else if (d.type==='users'){
              // 同步用户列表
              self.users.clear(); (d.users||[]).forEach(function(u){ self.users.set(u.id,{id:u.id,name:u.name}); });
              if (self._classic && typeof self._classic.renderContacts==='function'){
                var list=[]; self.users.forEach(function(v){ list.push({id:v.id,name:v.name}); });
                self._classic.renderContacts(list, self.activePeer);
              }
              updateEntryChips();
            }else if (d.type==='msg'){
              // 显示消息
              if (self._classic && typeof self._classic.appendChat==='function'){
                self._classic.appendChat(String(d.text||''), d.from===self.localId);
              }
            }else if (d.type==='file-begin'){
              handleIncomingFileBegin(d);
            }else if (d.type==='file-end'){
              finalizeIncomingFile(d);
            }else if (d.type==='file-resume'){
              // 我是发送方：从 offset 续传
              resumeSendFromOffset(d);
            }
          }
        }else if (d && d.byteLength!==undefined){
          // 二进制：文件数据
          if (self.isHub){
            // 房主转发：找到属于哪个 fid（简化：每个连接同一时间只传一个）
            // 这里我们不解析 fid，只要该连接最近的 fid 在 routes 中，即转发
            // 为保证确定性，anchor 仅支持“一个连接同一时间一个文件”
            // 因为 file-begin 一定先到，这里遍历 routes 找 fromId==pid 的项
            for (var fid in routes){
              if (routes[fid] && routes[fid].fromId===pid){
                routes[fid].toIds.forEach(function(x){ var st=self.conns[x]; if(st&&st.open) try{ st.conn.send(d); }catch(e){} });
                break;
              }
            }
          }else{
            handleIncomingFileChunk(d);
          }
        }
      });

      conn.on('close', function(){
        if (self.isHub){
          // 客户端离线
          delUser(pid);
        }
        delete self.conns[pid];
        updateEntryChips();
      });

      conn.on('error', function(err){ /* 忽略 */ });
    }

    // 发送端收到 file-resume：从 offset 继续
    function resumeSendFromOffset(req){
      // 仅客户端路径支持（发送方为本端）
      // 在我们简化的实现中，不缓存整个文件对象引用；因此断点续传仅在“同一会话未刷新”的情况下可靠；
      // 刷新后依赖 IDB 的完整命中（已做）。如需真正跨刷新续传，需要把 File 句柄固化（受浏览器限制有限）。
      // 这里做最小实现：忽略（发送侧不持久化 File）。
      // 可扩展：把最近一次发送的 File 保存在 self._lastSend[hash] 里，这里拿到继续读。
    }

    // classic UI 绑定（不改 UI 页面）
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

      // 运行时修复“所有人（群聊）”文案可能的乱码
      function fixAllLabel(){
        try{
          var el = contactList && contactList.querySelector('.contact .cname');
          if (el && /所有.?（群聊）/.test(el.textContent.replace(/\s/g,''))) {
            el.textContent = '所有人（群聊）';
          }
        }catch(e){}
      }

      function textOfEditor(){
        if (!editor) return '';
        var t = editor.innerText || editor.textContent || '';
        return t.replace(/\u00A0/g,' ').replace(/\r/g,'').trim();
      }
      function clearEditor(){ if(editor){ editor.innerHTML=''; editor.textContent=''; } }
      function syncSendBtn(){
        if (!sendBtn) return;
        var hasText = textOfEditor().length>0;
        sendBtn.disabled = !(app && app.connected && hasText);
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
        showVideo: function(ui,url,info,restore){
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
          if (statusChip) statusChip.textContent = app.connected ? '已连接' : '未连接';
          if (onlineChip) onlineChip.textContent = '在线 ' + (app.users.size||0);
          syncSendBtn();
        },
        getEditorText: textOfEditor,
        clearEditor: clearEditor,

        renderContacts: function(list, activeId){
          if (!contactList) return;
          list = list || (function(){ var arr=[]; app.users.forEach(function(v){ arr.push(v); }); return arr; })();
          var kw = (contactSearch && contactSearch.value || '').trim().toLowerCase();
          contactList.innerHTML='';
          // 群聊
          var all=document.createElement('div'); all.className='contact'+((activeId==='all')?' active':''); all.dataset.id='all';
          all.innerHTML='<div class="avatar"></div><div><div class="cname">所有人（群聊）</div><div class="cmsg">群聊</div></div>';
          all.addEventListener('click', function(){
            app.activePeer='all';
            contactList.querySelectorAll('.contact.active').forEach(function(el){ el.classList.remove('active'); });
            all.classList.add('active');
          });
          contactList.appendChild(all);

          list.forEach(function(u){
            if (u.id===app.localId) return; // 列表不显示自己
            var nm = u.name || ('节点 '+short(u.id));
            if (kw && nm.toLowerCase().indexOf(kw)===-1) return;
            var row=document.createElement('div'); row.className='contact'+((activeId===u.id)?' active':''); row.dataset.id=u.id;
            row.innerHTML='<div class="avatar"></div><div><div class="cname"></div><div class="cmsg">在线</div></div>';
            row.querySelector('.cname').textContent = nm;
            row.addEventListener('click', function(){
              app.activePeer = u.id;
              contactList.querySelectorAll('.contact.active').forEach(function(el){ el.classList.remove('active'); });
              row.classList.add('active');
            });
            contactList.appendChild(row);
          });

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

      // 拖拽
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
        var arr=[]; app.users.forEach(function(v){ arr.push(v); });
        app._classic.renderContacts(arr, app.activePeer);
      }); }

      // 初始状态
      app._classic.updateStatus();
    }

    // 导出
    window.app=self;

    // UI 页面复用入口实例：若是 classic.html 且 opener 有 app，则不重新连接
    if (window.__CLASSIC_UI__ && window.__USE_OPENER_APP__ && window.opener && window.opener.app){
      window.app = window.opener.app;
      return;
    }

  })();

})();