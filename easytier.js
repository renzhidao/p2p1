/* 固定入口核心：同服锁定 + 文本/文件传输
   修复：
   1. sendMsg 适配 classic UI 的 contenteditable editor
   2. 视频添加缩略图提取
   3. 降低预览阈值到 3%
   4. 修复按钮状态同步
*/

function bindClassicUI(app) {
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

  if (!msgScroll || !statusChip || !onlineChip) return;

  // 获取编辑器文本（处理 contenteditable）
  function textOfEditor() {
    if (!editor) return '';
    var text = editor.innerText || editor.textContent || '';
    return text.replace(/\u00A0/g,' ').replace(/\r/g,'').trim();
  }

  // 清空编辑器
  function clearEditor() {
    if (!editor) return;
    editor.innerHTML = '';
    editor.textContent = '';
  }

  // 同步发送按钮状态
  function syncSendBtn() {
    if (!sendBtn) return;
    var hasText = textOfEditor().length > 0;
    var isConnected = app && app.isConnected;
    sendBtn.disabled = !isConnected || !hasText;
  }

  // 把 classic 页面的"显示渲染"注入到 app._classic
  app._classic = {
    appendChat: function(text, mine) {
      if (!msgScroll) return;
      var row = document.createElement('div');
      row.className = 'row' + (mine ? ' right' : '');
      var av = document.createElement('div');
      av.className = 'avatar-sm';
      var lt = document.createElement('span');
      lt.className = 'letter';
      lt.textContent = mine ? '我' : '他';
      av.appendChild(lt);
      var bubble = document.createElement('div');
      bubble.className = 'bubble' + (mine ? ' me' : '');
      bubble.textContent = text;
      if (mine) { row.appendChild(bubble); row.appendChild(av); }
      else { row.appendChild(av); row.appendChild(bubble); }
      msgScroll.appendChild(row);
      msgScroll.scrollTop = msgScroll.scrollHeight;
    },
    placeholder: function(name, size, mine) {
      if (!msgScroll) return null;
      var row = document.createElement('div');
      row.className = 'row' + (mine ? ' right' : '');
      var av = document.createElement('div');
      av.className = 'avatar-sm';
      var lt = document.createElement('span');
      lt.className = 'letter';
      lt.textContent = mine ? '我' : '他';
      av.appendChild(lt);
      var bubble = document.createElement('div');
      bubble.className = 'bubble file' + (mine ? ' me' : '');
      var safe = String(name || '文件').replace(/"/g, '&quot;');
      bubble.innerHTML = '<div class="file-link"><div class="file-info"><span class="file-icon">📄</span>'
                       + '<span class="file-name" title="' + safe + '">' + safe + '</span></div>'
                       + '<div class="progress-line">准备接收…</div></div>';
      if (mine) { row.appendChild(bubble); row.appendChild(av); }
      else { row.appendChild(av); row.appendChild(bubble); }
      msgScroll.appendChild(row);
      msgScroll.scrollTop = msgScroll.scrollHeight;
      return { root: row, progress: bubble.querySelector('.progress-line'), mediaWrap: bubble };
    },
    showImage: function(ui, url) {
      if (!ui || !ui.mediaWrap) return;
      ui.mediaWrap.classList.add('media');
      ui.mediaWrap.innerHTML = '<a href="' + url + '" target="_blank" rel="noopener" class="thumb-link">'
                             + '<img class="thumb img" src="' + url + '"></a>';
    },
    showVideo: function(ui, url, info, restore) {
      if (!ui || !ui.mediaWrap) return;
      ui.mediaWrap.classList.add('media');
      var posterAttr = ui.poster ? ' poster="' + ui.poster + '"' : '';
      ui.mediaWrap.innerHTML = '<a href="' + url + '" target="_blank" rel="noopener">'
                             + '<video class="media-video" controls preload="metadata" src="' + url + '"' + posterAttr + '></video></a>'
                             + '<div class="progress-line">' + (info || '可预览') + '</div>';
      if (restore && typeof restore.time === 'number') {
        var v = ui.mediaWrap.querySelector('video');
        if (v) v.addEventListener('loadedmetadata', function() {
          try {
            v.currentTime = Math.min(restore.time, (v.duration || restore.time));
            if (!restore.paused) v.play().catch(function(){});
          } catch(e){}
        }, { once: true });
      }
    },
    showFileLink: function(ui, url, name, size) {
      if (!ui || !ui.mediaWrap) return;
      var safe = String(name || '文件').replace(/"/g, '&quot;');
      ui.mediaWrap.classList.remove('media');
      ui.mediaWrap.innerHTML = '<a href="' + url + '" target="_blank" rel="noopener" class="file-link" title="' + safe + '">'
                             + '<div class="file-info"><span class="file-icon">📄</span><span class="file-name">' + safe + '</span></div>'
                             + '<div class="progress-line">下载：' + safe + ' (' + Math.round((size || 0)/1024) + ' KB)</div></a>';
    },
    updateProgress: function(ui, p) {
      if (ui && ui.progress) ui.progress.textContent = '接收中… ' + p + '%';
    },
    updateStatus: function() {
      if (!statusChip || !onlineChip) return;
      statusChip.textContent = app.isConnected ? '已连接' : '未连接';
      var openCount = 0;
      for (var k in app.conns) {
        if (!app.conns.hasOwnProperty(k)) continue;
        if (app.conns[k].open) openCount++;
      }
      onlineChip.textContent = '在线 ' + openCount;
      syncSendBtn();
    },
    getEditorText: textOfEditor,
    clearEditor: clearEditor
  };

  // 事件绑定
  if (editor) {
    editor.addEventListener('input', syncSendBtn);
    var composing = false;
    editor.addEventListener('compositionstart', function(){ composing = true; });
    editor.addEventListener('compositionend', function(){ composing = false; });
    editor.addEventListener('keydown', function(e){
      if (e.key === 'Enter' && !e.shiftKey && !composing) {
        e.preventDefault();
        if (app && typeof app.sendMsg === 'function') app.sendMsg();
      }
    });
  }

  var emojiBtn = document.getElementById('emojiBtn');
  if (emojiBtn && editor) {
    emojiBtn.addEventListener('click', function(){
      editor.focus();
      try {
        document.execCommand('insertText', false, '😀');
      } catch(e) {
        var r = document.createRange();
        r.selectNodeContents(editor);
        r.collapse(false);
        var s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        var node = document.createTextNode('😀');
        r.insertNode(node);
      }
      syncSendBtn();
    });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', function(){
      if (app && typeof app.sendMsg === 'function') app.sendMsg();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', function(e){
      var files = Array.prototype.slice.call(e.target.files || []);
      if (files.length && app && typeof app.sendFilesFrom === 'function') {
        app.sendFilesFrom(files);
      }
      e.target.value = '';
    });
  }

  // 拖拽上传
  if (sendArea) {
    function onDragEnter(e){ e.preventDefault(); sendArea.classList.add('drag-over'); }
    function onDragOver(e){ e.preventDefault(); }
    function onDragLeave(e){
      e.preventDefault();
      if (e.target===sendArea || !sendArea.contains(e.relatedTarget)) {
        sendArea.classList.remove('drag-over');
      }
    }
    function onDrop(e){
      e.preventDefault();
      sendArea.classList.remove('drag-over');
      var files = Array.prototype.slice.call((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length && app && typeof app.sendFilesFrom === 'function') {
        app.sendFilesFrom(files);
      }
    }
    sendArea.addEventListener('dragenter', onDragEnter);
    sendArea.addEventListener('dragover', onDragOver);
    sendArea.addEventListener('dragleave', onDragLeave);
    sendArea.addEventListener('drop', onDrop);
  }

  // 联系人列表
  function renderContacts(){
    if (!contactList) return;
    var kw = (contactSearch && contactSearch.value || '').trim().toLowerCase();
    contactList.innerHTML = '';
    var all = document.createElement('div');
    all.className = 'contact active';
    all.innerHTML = '<div class="avatar"></div><div><div class="cname">所有��（群聊）</div><div class="cmsg">群聊</div></div>';
    contactList.appendChild(all);
    for (var pid in app.conns) {
      if (!app.conns.hasOwnProperty(pid)) continue;
      var st = app.conns[pid];
      if (!st.open) continue;
      var nm = '节点 ' + pid.substring(0,8);
      if (kw && nm.toLowerCase().indexOf(kw) === -1) continue;
      var row = document.createElement('div');
      row.className = 'contact';
      row.innerHTML = '<div class="avatar"></div><div><div class="cname">' + nm + '</div><div class="cmsg">在线</div></div>';
      contactList.appendChild(row);
    }
  }
  if (contactSearch) contactSearch.addEventListener('input', renderContacts);

  setInterval(function(){
    if (app && app._classic && typeof app._classic.updateStatus === 'function') {
      app._classic.updateStatus();
    }
    renderContacts();
  }, 1000);
}

(function(){
  if (window.__CLASSIC_UI__ && window.__USE_OPENER_APP__ && window.opener && window.opener.app) {
    window.app = window.opener.app;
    bindClassicUI(window.app);
    return;
  }

  var app = (function(){
    var self={};

    var injectedServer = (typeof window.__FIXED_SERVER__ === 'object' && window.__FIXED_SERVER__) || null;
    var injectedNetwork = (typeof window.__FIXED_NETWORK__ === 'string' && window.__FIXED_NETWORK__) || null;

    self.server = injectedServer || {host:'peerjs.92k.de', port:443, secure:true, path:'/'};
    self.network = injectedNetwork || 'public-network';

    // 传输参数（降低视频预览阈值到 3%）
    self.chunkSize=512*1024;
    self.previewPct=3;
    self.highWater=1.5*1024*1024;
    self.lowWater=0.6*1024*1024;

    self.iceServers=[
      {urls:'stun:stun.l.google.com:19302'},
      {urls:'stun:global.stun.twilio.com:3478'},
      {urls:'stun:stun.services.mozilla.com'}
    ];

    self.peer=null; self.conns={}; self.isConnected=false; self.startAt=0;
    self.localId=''; self.virtualIp='';
    self.timers={up:null,ping:null};
    self.logBuf='> 初始化中...';

    self.fullSources={};
    var idb, idbReady=false;
    (function openIDB(){
      try{
        var req=indexedDB.open('p2p-cache',1);
        req.onupgradeneeded=function(e){
          var db=e.target.result;
          if(!db.objectStoreNames.contains('files'))
            db.createObjectStore('files',{keyPath:'hash'});
        };
        req.onsuccess=function(e){ idb=e.target.result; idbReady=true; };
        req.onerror=function(){ idbReady=false; };
      }catch(e){ idbReady=false; }
    })();

    function idbPut(hash, blob, meta){
      if(!idbReady) return;
      try{
        var tx=idb.transaction('files','readwrite');
        tx.objectStore('files').put({hash:hash, blob:blob, meta:meta, ts:Date.now()});
      }catch(e){}
    }

    function idbGet(hash, cb){
      if(!idbReady) return cb(null);
      try{
        var tx=idb.transaction('files','readonly');
        var rq=tx.objectStore('files').get(hash);
        rq.onsuccess=function(){ cb(rq.result||null); };
        rq.onerror=function(){ cb(null); };
      }catch(e){ cb(null); }
    }

    function now(){ return new Date().toLocaleTimeString(); }
    function shortId(id){ return id? id.substr(0,10)+'...' : ''; }
    function human(n){
      if(n<1024) return n+' B';
      if(n<1024*1024) return (n/1024).toFixed(1)+' KB';
      if(n<1024*1024*1024) return (n/1024/1024).toFixed(1)+' MB';
      return (n/1024/1024/1024).toFixed(1)+' GB';
    }
    function genIp(id){
      var h=0;
      for(var i=0;i<id.length;i++){ h=(h*31+id.charCodeAt(i))>>>0; }
      return '10.144.'+(((h)&0xff)+1)+'.'+(((h>>8)&0xff)+1);
    }
    function getPeerParam(){
      var s=window.location.search;
      if(!s||s.length<2) return '';
      var m=s.match(/[?&]peer=([^&]+)/);
      return m? decodeURIComponent(m[1]):'';
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

    // 视频缩略图提取
    function extractVideoThumbnail(file, cb) {
      var video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      
      var url = URL.createObjectURL(file);
      video.src = url;
      
      video.addEventListener('loadeddata', function() {
        video.currentTime = Math.min(1, video.duration * 0.1);
      });
      
      video.addEventListener('seeked', function() {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = 320;
          canvas.height = 180;
          var ctx = canvas.getContext('2d');
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          var thumbUrl = canvas.toDataURL('image/jpeg', 0.7);
          URL.revokeObjectURL(url);
          cb(thumbUrl);
        } catch(e) {
          URL.revokeObjectURL(url);
          cb(null);
        }
      });
      
      video.addEventListener('error', function() {
        URL.revokeObjectURL(url);
        cb(null);
      });
    }

    self.log=function(s){
      var el=document.getElementById('log');
      self.logBuf+="\n["+now()+"] "+s;
      if(el){ el.textContent=self.logBuf; el.scrollTop=el.scrollHeight; }
    };

    self.copyLog=function(){
      try{
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(self.logBuf).then(function(){alert('日志已复制')});
        }else{
          var ta=document.createElement('textarea');
          ta.value=self.logBuf;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          alert('已复制');
        }
      }catch(e){ alert('复制失败：'+e.message); }
    };

    self.clearLog=function(){
      self.logBuf='';
      var el=document.getElementById('log');
      if(el) el.textContent='';
    };

    function setStatus(txt,cls){
      var st=document.getElementById('statusChip');
      if(!st) st=document.getElementById('status');
      if(st){
        st.textContent=txt.replace('状态：','');
        st.className=st.className||'';
      }
    }

    self.updateInfo=function(){
      var openCount=0;
      for(var k in self.conns){
        if(!self.conns.hasOwnProperty(k)) continue;
        if(self.conns[k].open) openCount++;
      }
      var lid=document.getElementById('localId'),
          vip=document.getElementById('virtualIp'),
          pc=document.getElementById('peerCount');
      if(lid) lid.textContent = self.localId ? shortId(self.localId) : '-';
      if(vip) vip.textContent = self.virtualIp || '-';
      if(pc) pc.textContent = String(openCount);
      var onlineChip=document.getElementById('onlineChip');
      if(onlineChip) onlineChip.textContent='在线 '+openCount;
      if(self._classic && typeof self._classic.updateStatus==='function') {
        self._classic.updateStatus();
      }
    };

    self.showShare=function(){
      var base=window.location.origin+window.location.pathname;
      var url = base + '?peer='+encodeURIComponent(self.localId);
      var input=document.getElementById('shareLink'),
          box=document.getElementById('share'),
          qr=document.getElementById('qr');
      if(input) input.value=url;
      if(box) box.style.display='block';
      if(qr&&window.QRCode){
        qr.innerHTML='';
        new QRCode(qr,{text:url,width:150,height:150});
      }
    };

    self.copyLink=function(){
      var el=document.getElementById('shareLink');
      if(!el) return;
      try{
        if(navigator.clipboard&&navigator.clipboard.writeText){
          navigator.clipboard.writeText(el.value).then(function(){ alert('已复制')});
        } else {
          el.select();
          document.execCommand('copy');
          alert('已复制');
        }
      }catch(e){ alert('复制失败：'+e.message); }
    };

    function pushChat(text,mine){
      if(self._classic && typeof self._classic.appendChat==='function') {
        self._classic.appendChat(text,mine);
      }
    }

    function placeholder(name,size,mine){
      return self._classic && typeof self._classic.placeholder==='function' ?
        self._classic.placeholder(name,size,mine) : null;
    }

    function showImg(ui,url){
      if(self._classic && typeof self._classic.showImage==='function') {
        self._classic.showImage(ui,url);
      }
    }

    function showVid(ui,url,note,restore){
      if(self._classic && typeof self._classic.showVideo==='function') {
        self._classic.showVideo(ui,url,note,restore);
      }
    }

    function fileLink(ui,url,name,size){
      if(self._classic && typeof self._classic.showFileLink==='function') {
        self._classic.showFileLink(ui,url,name,size);
      }
    }

    function updProg(ui,p){
      if(self._classic && typeof self._classic.updateProgress==='function') {
        self._classic.updateProgress(ui,p);
      }
    }

    // 修复：文本发送函数适配 Classic UI
    self.sendMsg=function(){
      var val = '';
      
      // 优先使用 Classic UI 的 editor
      if (self._classic && typeof self._classic.getEditorText === 'function') {
        val = self._classic.getEditorText();
      } else {
        // 兼容入口页的 msgInput
        var ipt = document.getElementById('msgInput');
        if (ipt && ipt.value) val = ipt.value.trim();
      }
      
      if (!val) {
        self.log('T14 OUT_ERROR: empty message');
        return;
      }
      
      // 清空输入框
      if (self._classic && typeof self._classic.clearEditor === 'function') {
        self._classic.clearEditor();
      } else {
        var ipt = document.getElementById('msgInput');
        if (ipt) ipt.value = '';
      }
      
      pushChat(val, true);
      
      var sent = 0;
      for (var k in self.conns) {
        if (!self.conns.hasOwnProperty(k)) continue;
        var st = self.conns[k];
        if (!st.open) continue;
        try {
          st.conn.send({type:'chat', text:val});
          sent++;
        } catch(e) {
          self.log('T14 OUT_ERROR: chat send '+(e.message||e));
        }
      }
      
      if (!sent) {
        self.log('T14 OUT_ERROR: no open peers to send');
      } else {
        self.log('T40 CHAT_SENT: "' + val.substring(0, 30) + (val.length > 30 ? '...' : '') + '" to ' + sent + ' peer(s)');
      }
    };

    self.sendFiles=function(){
      var fi=document.getElementById('fileInput');
      if(!fi||!fi.files||fi.files.length===0){
        alert('请选择文件');
        return;
      }
      self.sendFilesFrom([].slice.call(fi.files));
      fi.value='';
    };

    self.sendFilesFrom=function(files){
      var peers=[];
      for(var k in self.conns){
        if(!self.conns.hasOwnProperty(k)) continue;
        if(self.conns[k].open) peers.push(k);
      }
      if(!peers.length){
        self.log('T40 FILE_SEND_BEGIN: no peers open');
        alert('没有在线节点，无法发送文件');
        return;
      }
      files.forEach(function(file){
        fileHashMeta(file).then(function(hash){
          peers.forEach(function(pid){ enqueueFile(pid,file,hash); });
        });
      });
    };

    function enqueueFile(pid,file,hash){
      var st=self.conns[pid];
      if(!st||!st.open){
        self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(pid));
        return;
      }
      if(!st.queue) st.queue=[];
      st.queue.push({file:file,hash:hash});
      if(!st.sending){ st.sending=true; sendNext(pid); }
    }

    function sendNext(pid){
      var st=self.conns[pid];
      if(!st) return;
      var job=st.queue.shift();
      if(!job){ st.sending=false; return; }
      sendFileTo(pid, job.file, job.hash, function(){ sendNext(pid); });
    }

    function getBuffered(c){
      try{
        if(c&&c._dc&&typeof c._dc.bufferedAmount==='number')
          return c._dc.bufferedAmount;
        if(c&&typeof c.bufferSize==='number')
          return c.bufferSize;
      }catch(e){}
      return 0;
    }

    function flowSend(c,data,cb){
      var loop=function(){
        if(getBuffered(c)>self.highWater){
          setTimeout(loop,20);
          return;
        }
        try{ c.send(data);}catch(e){ cb(e); return;}
        cb(null);
      };
      loop();
    }

    function sendFileTo(pid,file,hash,done){
      var st=self.conns[pid];
      if(!st||!st.open){
        self.log('T40 FILE_SEND_BEGIN: peer not open '+shortId(pid));
        return done&&done();
      }
      
      var c=st.conn,
          id=String(Date.now())+'_'+Math.floor(Math.random()*1e6),
          chunk=self.chunkSize,
          off=0,
          lastTs=0,
          lastPct=-1;
      
      self.log('T40 FILE_SEND_BEGIN: '+shortId(pid)+' '+file.name+' '+human(file.size));
      
      try{
        c.send({
          type:'file-begin',
          id:id,
          name:file.name,
          size:file.size,
          mime:file.type||'application/octet-stream',
          chunk:chunk,
          hash:hash
        });
      } catch(e){
        self.log('T14 OUT_ERROR: file meta '+(e.message||e));
        return done&&done();
      }
      
      var reader=new FileReader();
      reader.onerror=function(){
        self.log('T14 OUT_ERROR: file read');
        done&&done();
      };
      reader.onload=function(e){
        flowSend(c,e.target.result,function(err){
          if(err){
            self.log('T14 OUT_ERROR: data send '+(err.message||err));
            return done&&done();
          }
          off+=e.target.result.byteLength;
          var pct=Math.min(100,Math.floor(off*100/file.size));
          var nowTs=Date.now();
          if(pct!==lastPct && (nowTs-lastTs>200 || pct===100)){
            self.log('T41 FILE_SEND_PROGRESS: '+shortId(pid)+' '+pct+'%');
            lastTs=nowTs;
            lastPct=pct;
          }
          if(off<file.size){
            setTimeout(readNext,0);
          } else {
            try{ c.send({type:'file-end',id:id,hash:hash}); }catch(e2){}
            self.log('T42 FILE_SEND_END: '+file.name+' -> '+shortId(pid));
            try{
              idbPut(hash||'', file, {name:file.name,size:file.size,mime:file.type||'application/octet-stream'});
              self.fullSources[hash||'']=self.fullSources[hash||'']||new Set();
              self.fullSources[hash||''].add(self.localId);
            }catch(e){}
            done&&done();
          }
        });
      };
      
      function readNext(){
        var slice=file.slice(off,Math.min(off+chunk,file.size));
        reader.readAsArrayBuffer(slice);
      }
      readNext();
    }

    self.toggle=function(){
      if(self.isConnected){ self.disconnect(); return; }
      var nameEl = document.getElementById('networkName');
      if (nameEl && nameEl.value.trim()) self.network = nameEl.value.trim();
      self.log('T00 UI_CLICK_CONNECT: network='+self.network);
      connectStart();
    };

    function connectStart(){
      var btn=document.getElementById('connectBtn');
      if(btn){ btn.textContent='连接中...'; btn.disabled=true; }
      setStatus('● 连接中...','connecting');
      self.log('T05 ICE_CONFIG: stun=3 turn=0');
      tryPeer(self.server);
    }

    function tryPeer(s){
      self.log('T01 PEER_CREATE: '+s.host+':'+s.port+' ssl='+(s.secure?1:0));
      var p;
      try{
        p=new Peer(null,{
          host:s.host,
          port:s.port,
          secure:s.secure,
          path:s.path,
          config:{iceServers:self.iceServers}
        });
      }catch(e){
        self.log('T04 PEER_ERROR: init '+(e.message||e));
        return failUI();
      }
      
      self.peer=p;
      var opened=false,
          t=setTimeout(function(){
            if(!opened){
              self.log('T03 PEER_OPEN_TIMEOUT: '+s.host);
              safeDestroyPeer();
              failUI();
            }
          },10000);
      
      p.on('open', function(id){
        opened=true;
        clearTimeout(t);
        self.localId=id;
        self.virtualIp=genIp(id);
        self.isConnected=true;
        self.startAt=Date.now();
        setStatus('● 在线','online');
        var b=document.getElementById('connectBtn');
        if(b){ b.textContent='🔌 断开'; b.disabled=false; }
        var c=document.getElementById('chat'),
            tt=document.getElementById('tools');
        if(c) c.style.display='block';
        if(tt) tt.style.display='block';
        self.updateInfo();
        self.showShare();
        self.log('T02 PEER_OPEN_OK: id='+id);
        var toDial=getPeerParam();
        if(toDial){
          self.log('T10 JOIN_PARAM: peer='+toDial);
          setTimeout(function(){ connectPeer(toDial); },400);
        }
        startTimers();
      });
      
      p.on('connection', function(conn){ handleConn(conn,true); });
      p.on('error', function(err){
        self.log('T04 PEER_ERROR: '+(err && (err.message||err.type)||err));
      });
      p.on('disconnected', function(){
        self.log('T90 PEER_DISCONNECTED: will reconnect');
        try{ p.reconnect(); }catch(e){}
      });
      p.on('close', function(){ self.log('T90 PEER_CLOSE'); });
    }

    function failUI(){
      setStatus('● 离线','offline');
      var b=document.getElementById('connectBtn');
      if(b){ b.textContent='🔌 连接网络'; b.disabled=false; }
    }

    function safeDestroyPeer(){
      try{ if(self.peer) self.peer.destroy(); }catch(e){}
      self.peer=null;
    }

    function connectPeer(pid){
      if(!self.peer || !pid || pid===self.localId) return;
      if(self.conns[pid] && self.conns[pid].open) return;
      self.log('T11 OUT_DIAL: '+pid);
      var c;
      try{ c=self.peer.connect(pid,{reliable:true}); }
      catch(e){ self.log('T14 OUT_ERROR: connect '+(e.message||e)); return; }
      handleConn(c,false);
      setTimeout(function(){
        var st=self.conns[pid];
        if(!st||!st.open){
          try{ c.close(); }catch(e){}
          self.log('T14 OUT_ERROR: dial timeout '+shortId(pid));
        }
      },12000);
    }

    function handleConn(c,inbound){
      if(!c||!c.peer) return;
      var pid=c.peer;
      if(self.conns[pid] && self.conns[pid].open){
        self.log('T60 DEDUP_CLOSE: '+shortId(pid));
        try{ c.close(); }catch(e){}
        return;
      }
      if(!self.conns[pid]) {
        self.conns[pid]={
          conn:c,
          open:false,
          latency:0,
          sending:false,
          queue:[],
          recv:{cur:null,ui:null}
        };
      }
      if(inbound) self.log('T20 IN_CONN: '+shortId(pid));
      else self.log('T11 OUT_DIAL: pending '+shortId(pid));
      
      c.on('open', function(){
        self.conns[pid].open=true;
        if(inbound) self.log('T21 IN_OPEN: '+shortId(pid));
        else self.log('T12 OUT_OPEN: '+shortId(pid));
        self.updateInfo();
        try{
          c.send({
            type:'hello',
            id:self.localId,
            ip:self.virtualIp,
            network:self.network,
            fullList:Object.keys(self.fullSources)
          });
        }catch(e){}
      });
      
      c.on('data', function(d){
        if(d && typeof d==='object' && d.type){
          if(d.type==='hello'){
            self.log('T20 IN_CONN: hello from '+shortId(pid)+' ip='+(d.ip||'-'));
            if (d.fullList && Array.isArray(d.fullList)){
              d.fullList.forEach(function(h){
                self.fullSources[h]=self.fullSources[h]||new Set();
                self.fullSources[h].add(pid);
              });
            }
          }
          else if(d.type==='ping'){
            if(self.conns[pid].open){
              try{ c.send({type:'pong',ts:d.ts}); }catch(e){}
            }
          }
          else if(d.type==='pong'){
            var lat=Date.now()-(d.ts||Date.now());
            self.conns[pid].latency=lat;
            self.log('T31 PONG: '+shortId(pid)+' rtt='+lat+'ms');
            self.updateInfo();
          }
          else if(d.type==='chat'){
            pushChat(String(d.text||''),false);
            self.log('T50 CHAT_RECV: from '+shortId(pid));
          }
          else if(d.type==='file-begin'){
            var h=d.hash||'';
            if(h){
              idbGet(h, function(rec){
                if(rec && rec.blob){
                  var ui = placeholder(d.name||'文件', d.size||0, false);
                  var url=URL.createObjectURL(rec.blob);
                  if ((rec.meta && rec.meta.mime || '').indexOf('image/')===0) {
                    showImg(ui,url);
                  } else if ((rec.meta && rec.meta.mime || '').indexOf('video/')===0) {
                    showVid(ui,url,'本地缓存',null);
                  } else {
                    fileLink(ui,url,
                      (rec.meta && rec.meta.name) || d.name || '文件',
                      (rec.meta && rec.meta.size) || d.size || 0);
                  }
                  setTimeout(function(){ URL.revokeObjectURL(url); },60000);
                  try{ c.send({type:'file-end',id:d.id,hash:h}); }catch(e){}
                  return;
                }
              });
            }
            self.log('T50 FILE_RECV_BEGIN: '+(d.name||'file')+' '+human(d.size||0)+' from '+shortId(pid));
            var ui=placeholder(d.name||'文件',d.size||0,false);
            
            // 如果是视频，提取缩略图
            if ((d.mime||'').indexOf('video/')===0) {
              ui.poster = null; // 将在接收到第一块数据后尝试提取
            }
            
            self.conns[pid].recv.cur={
              id:d.id,
              name:d.name,
              size:d.size||0,
              mime:d.mime||'application/octet-stream',
              got:0,
              parts:[],
              previewed:false,
              previewUrl:null,
              videoState:null,
              hash:d.hash||''
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
          return;
        }
        
        var st=self.conns[pid],
            ctx=st&&st.recv&&st.recv.cur,
            ui=st&&st.recv&&st.recv.ui;
        if(!ctx){
          self.log('T51 FILE_RECV_PROGRESS: no ctx, dropped');
          return;
        }
        
        var sz=0;
        if(d && d.byteLength!==undefined){
          sz=d.byteLength;
          ctx.parts.push(new Blob([d]));
        } else if(d && d.size!==undefined){
          sz=d.size;
          ctx.parts.push(d);
        }
        ctx.got+=sz;
        var pct=ctx.size?Math.min(100,Math.floor(ctx.got*100/ctx.size)):0;
        updProg(ui,pct);
        
        if(!ctx.previewed){
          try{
            var url=URL.createObjectURL(new Blob(ctx.parts,{type:ctx.mime}));
            if ((ctx.mime||'').indexOf('image/')===0){
              showImg(ui,url);
              ctx.previewed=true;
              ctx.previewUrl=url;
            }
            else if ((ctx.mime||'').indexOf('video/')===0){
              var need=Math.max(1,Math.floor(ctx.size*self.previewPct/100));
              if(ctx.got>=need){
                showVid(ui,url,'可预览（接收中 '+pct+'%）',null);
                ctx.previewed=true;
                ctx.previewUrl=url;
                var v=ui && ui.mediaWrap && ui.mediaWrap.querySelector && ui.mediaWrap.querySelector('video');
                if(v){
                  ctx.videoState={time:0,paused:true};
                  v.addEventListener('timeupdate',function(){
                    ctx.videoState.time=v.currentTime||0;
                    ctx.videoState.paused=v.paused;
                  });
                }
              } else {
                URL.revokeObjectURL(url);
              }
            }
          }catch(e){}
        }
      });
      
      c.on('close', function(){
        if(inbound) self.log('T22 IN_CLOSE: '+shortId(pid));
        else self.log('T13 OUT_CLOSE: '+shortId(pid));
        try{
          var r=self.conns[pid]&&self.conns[pid].recv&&self.conns[pid].recv.cur;
          if(r&&r.previewUrl) URL.revokeObjectURL(r.previewUrl);
        }catch(e){}
        delete self.conns[pid];
        self.updateInfo();
      });
      
      c.on('error', function(err){
        self.log('T14 OUT_ERROR: conn '+shortId(pid)+' '+(err && (err.message||err.type)||err));
      });
    }

    function finalizeReceive(pid,id,hash){
      var st=self.conns[pid];
      if(!st||!st.recv) return;
      var ctx=st.recv.cur, ui=st.recv.ui;
      if(!ctx||ctx.id!==id) return;
      
      var blob=new Blob(ctx.parts,{type:ctx.mime});
      var url=URL.createObjectURL(blob);
      
      if ((ctx.mime||'').indexOf('image/')===0){
        showImg(ui,url);
      }
      else if ((ctx.mime||'').indexOf('video/')===0){
        var restore=ctx.videoState?{time:ctx.videoState.time||0,paused:ctx.videoState.paused}:null;
        showVid(ui,url,'接收完成',restore);
      }
      else {
        fileLink(ui,url,ctx.name,ctx.size);
      }
      
      self.log('T52 FILE_RECV_END: '+(ctx.name||'文件')+' '+human(ctx.size)+' from '+shortId(pid));
      
      try{
        idbPut(hash||ctx.hash||'', blob, {name:ctx.name,size:ctx.size,mime:ctx.mime});
        self.fullSources[hash||ctx.hash||'']=self.fullSources[hash||ctx.hash||'']||new Set();
        self.fullSources[hash||ctx.hash||''].add(self.localId);
        for(var k in self.conns){
          if(!self.conns.hasOwnProperty(k)) continue;
          var s=self.conns[k];
          if(s.open){
            try{ s.conn.send({type:'file-has', hash: (hash||ctx.hash||'')}); }catch(e){}
          }
        }
      }catch(e){}
      
      try{ if(ctx.previewUrl) URL.revokeObjectURL(ctx.previewUrl);}catch(e){}
      (function(u){ setTimeout(function(){ URL.revokeObjectURL(u); },60000); })(url);
      st.recv.cur=null;
      st.recv.ui=null;
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
        var up=document.getElementById('uptime');
        if(up) up.textContent=t;
      },1000);
      
      self.timers.ping=setInterval(function(){
        for(var k in self.conns){
          if(!self.conns.hasOwnProperty(k)) continue;
          var st=self.conns[k];
          if(!st.open) continue;
          try{
            st.conn.send({type:'ping',ts:Date.now()});
            self.log('T30 HEARTBEAT: ping '+shortId(k));
          }catch(e){}
        }
      },5000);
    }

    function stopTimers(){
      if(self.timers.up){clearInterval(self.timers.up); self.timers.up=null;}
      if(self.timers.ping){clearInterval(self.timers.ping); self.timers.ping=null;}
    }

    self.disconnect=function(){
      for(var k in self.conns){
        if(!self.conns.hasOwnProperty(k)) continue;
        try{ self.conns[k].conn.close(); }catch(e){}
      }
      self.conns={};
      safeDestroyPeer();
      stopTimers();
      self.isConnected=false;
      self.startAt=0;
      self.localId='';
      self.virtualIp='';
      var c=document.getElementById('chat');
      if(c) c.style.display='none';
      var t=document.getElementById('tools');
      if(t) t.style.display='none';
      var s=document.getElementById('share');
      if(s) s.style.display='none';
      setStatus('● 离线','offline');
      var b=document.getElementById('connectBtn');
      if(b){ b.textContent='🔌 连接网络'; b.disabled=false; }
      self.updateInfo();
      self.log('T90 PEER_CLOSE: disconnected');
    };

    (function(){ self.log('> 就绪：点击"连接网络"开始（固定服务器 '+self.server.host+':'+self.server.port+'）'); })();

    return self;
  })();

  window.app = app;

  if (window.__CLASSIC_UI__) {
    bindClassicUI(app);
    if (!app.isConnected) app.toggle();
  }
})();

window.addEventListener('beforeunload', function(e){
  if (window.app && app.isConnected) {
    e.preventDefault();
    e.returnValue = '关闭页面将断开连接，确定吗？';
  }
});