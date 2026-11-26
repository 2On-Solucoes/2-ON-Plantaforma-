const LS={get:k=>{try{return localStorage.getItem(k)}catch{return null}},set:(k,v)=>{try{localStorage.setItem(k,v)}catch{}},del:k=>{try{localStorage.removeItem(k)}catch{}}};

/* ---- Global loading helper (professional UX) ---- */
window.ONLoading = {
  show(msg) {
    const el = document.getElementById('global-loading');
    if (!el) return;
    const text = el.querySelector('.loading-text');
    if (text && msg) text.innerHTML = msg + '<span class="dots">…</span>';
    el.classList.add('is-active');
    el.setAttribute('aria-busy', 'true');
  },
  hide() {
    const el = document.getElementById('global-loading');
    if (!el) return;
    el.classList.remove('is-active');
    el.setAttribute('aria-busy', 'false');
  }
};
// Auto-hide after first paint if still visible
document.addEventListener('DOMContentLoaded', () => {
  setTimeout(() => window.ONLoading && window.ONLoading.hide(), 600);
});

(() => {
'use strict';
const $=id=>document.getElementById(id), pages=[...document.querySelectorAll('.page')];
let ws=null,reconnectTimer=null,reconnectDelay=800,roomCode=null,mySymbol=null,myName='',myTeam='',playerId='',state=null,intentionalClose=false,chatScope='general',clockTimer=null,pendingAction=null,selectedGameType='tictactoe';
let sessionToken=LS.get('2on_session_token')||'',sessionReady=false,wsAuthenticated=false,pendingActions=[];
let pc=null,localStream=null,voiceOn=false,isSpectator=false,currentChampChat=[],teamMessages=[],globalMessages=[],globalUnread=0,teamUnread=0,globalChatOpen=false,pendingIce=[],activeFixtureId=null,resultActionToken=0,lastChatSentAt=0;
const seen=new Set();
let actionBusy=false,createWatchdog=null,sessionRecovery=false;
let saved=null;
try{saved=JSON.parse(LS.get('2on_game_session')||'null')}catch{LS.del('2on_game_session')}
playerId=LS.get('2on_player_id')||'';
myName=LS.get('2on_player_name')||'';myTeam=LS.get('2on_player_team')||'';
if(saved&&/^[A-Z0-9]{4,12}$/i.test(String(saved.roomCode||''))&&typeof saved.mySymbol==='string'&&saved.mySymbol.length<=12){roomCode=String(saved.roomCode).toUpperCase();mySymbol=saved.mySymbol;myName=saved.myName||myName;myTeam=saved.myTeam||myTeam;}
$('playerName').value=myName;$('teamName').value=myTeam;
function apiFetch(url,options={}){const headers=new Headers(options.headers||{});if(sessionToken)headers.set('Authorization','Bearer '+sessionToken);return fetch(url,{...options,headers});}
async function initSession(){
  try{const headers={'content-type':'application/json'};if(sessionToken)headers.Authorization='Bearer '+sessionToken;const r=await apiFetch('/api/session',{method:'POST',headers,body:JSON.stringify({name:myName||'Jogador'})});const d=await r.json();if(!r.ok||!d.playerId)throw new Error(d.error||'Sessão indisponível.');if(d.playerId!==playerId){const saved=JSON.parse(LS.get('2on_game_session')||'null');if(saved?.playerId&&saved.playerId!==d.playerId){LS.del('2on_game_session');roomCode=null;mySymbol=null;state=null;activeFixtureId=null;}}playerId=d.playerId;sessionReady=true;LS.set('2on_player_id',playerId);if(d.token){sessionToken=d.token;LS.set('2on_session_token',sessionToken)}myName=d.name||myName||'Jogador';LS.set('2on_player_name',myName);$('playerName').value=myName;return true}catch(e){sessionReady=false;toast('Não foi possível iniciar a sessão.');return false}}
function page(id){pages.forEach(p=>p.classList.toggle('active',p.id===id));document.querySelectorAll('nav button').forEach(b=>b.classList.toggle('active',b.dataset.page===id));const dock=$('globalChatDock');if(dock)dock.hidden=id==='play';if(id==='play'){if(globalChatOpen){$('globalChatPanel').hidden=true;globalChatOpen=false}}else renderGlobalDock();if(id!=='championships'){clearInterval(cupPollTimer);cupPollTimer=null}if(id==='championships')loadCups();if(id==='ranking'){loadRanking();loadProfile();}}
function toast(m){$('toast').textContent=m;$('toast').style.display='block';clearTimeout(toast.t);toast.t=setTimeout(()=>$('toast').style.display='none',2400)}
function openConfirm(title,text,yes){$('confirmTitle').textContent=title;$('confirmText').textContent=text;$('confirm').classList.add('open');$('confirm').setAttribute('aria-hidden','false');$('confirmYes').onclick=()=>{closeConfirm();yes()};$('confirmNo').onclick=closeConfirm}
function closeConfirm(){$('confirm').classList.remove('open');$('confirm').setAttribute('aria-hidden','true')}
function socketOpen(){return ws&&ws.readyState===WebSocket.OPEN}
function send(payload){const copy={...payload};if((copy.type==='game-move'||copy.type==='game-reset')&&(!sessionReady||!wsAuthenticated||!socketOpen())){toast('📡 Sem ligação — aguarda a reconexão.');connect();return false}if(!copy.actionId&&copy.type!=='session-auth')copy.actionId=crypto.randomUUID();if(!sessionReady||!wsAuthenticated||!socketOpen()){pendingActions.push(copy);if(pendingActions.length>30)pendingActions.shift();connect();return false}try{ws.send(JSON.stringify(copy));return true}catch{pendingActions.push(copy);toast('Não foi possível concluir a ação.');return false}}
function flushQueuedActions(){if(!wsAuthenticated||!socketOpen())return;const actions=pendingActions.splice(0);for(const action of actions)ws.send(JSON.stringify(action));}
function flushSocketState(){if(!sessionReady||!wsAuthenticated||!socketOpen())return;ws.send(JSON.stringify({type:'global-chat-join'}));if(currentCupId)ws.send(JSON.stringify({type:'championship-watch',championshipId:currentCupId}));if(roomCode&&mySymbol)ws.send(JSON.stringify({type:'game-rejoin',roomCode,name:myName||'Jogador'}));if(pendingAction){pendingActions.unshift(pendingAction);pendingAction=null}flushQueuedActions()}
let hbTimer=null,lastPong=0;
function startHeartbeat(){stopHeartbeat();lastPong=Date.now();hbTimer=setInterval(()=>{if(!socketOpen())return;if(Date.now()-lastPong>45000){try{ws.close()}catch{}return}try{ws.send(JSON.stringify({type:'ping',t:Date.now()}))}catch{}},15000)}
function stopHeartbeat(){clearInterval(hbTimer);hbTimer=null}
function setConn(text,online){const c=$('connectionState');if(!c)return;c.textContent=text;c.className='status-dot '+(online?'online':'offline')}
function reconnectNow(){
  if(!sessionReady){initSession().then(ok=>{if(ok)connect()});return}
  if(socketOpen()){const t0=Date.now();try{ws.send(JSON.stringify({type:'ping',t:t0}))}catch{}setTimeout(()=>{if(lastPong<t0&&socketOpen()){try{ws.close()}catch{}}},4000);return}
  if(ws&&ws.readyState===0)return;
  clearTimeout(reconnectTimer);reconnectDelay=800;connect()
}
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')reconnectNow()});
window.addEventListener('online',reconnectNow);
window.addEventListener('offline',()=>setConn('Sem internet',false));
window.addEventListener('pageshow',e=>{if(e.persisted){intentionalClose=false;reconnectNow()}});
function connect(){if(!sessionReady)return;if(ws&&(ws.readyState===1||ws.readyState===0))return;clearTimeout(reconnectTimer);const proto=location.protocol==='https:'?'wss:':'ws:';ws=new WebSocket(proto+'//'+location.host);ws.onopen=()=>{startHeartbeat();reconnectDelay=800;$('connectionState').textContent='Ligado';$('connectionState').className='status-dot online';ws.send(JSON.stringify({type:'session-auth',token:sessionToken}))};ws.onmessage=e=>{let m;try{m=JSON.parse(e.data)}catch{return}handle(m)};ws.onclose=()=>{stopHeartbeat();wsAuthenticated=false;if(actionBusy&&!createWatchdog){setActionBusy(false);const s=$('lobbyStatus');if(s)s.textContent='Ligação ao servidor interrompida. A tentar novamente…'}if(intentionalClose)return;$('connectionState').textContent='Reconectando…';$('connectionState').className='status-dot offline';clearTimeout(reconnectTimer);reconnectTimer=setTimeout(connect,reconnectDelay*(.8+Math.random()*.4));reconnectDelay=Math.min(reconnectDelay*2,8000)};ws.onerror=()=>{wsAuthenticated=false}}
function handle(m){switch(m.type){case'pong':lastPong=Date.now();break;case'session-required':case'session-error':{wsAuthenticated=false;sessionReady=false;try{ws?.close()}catch{};ws=null;if(!sessionRecovery){sessionRecovery=true;initSession().then(ok=>{sessionRecovery=false;if(ok){connect();}else{setActionBusy(false)}}).catch(()=>{sessionRecovery=false;setActionBusy(false)})}break;}case'session-ready':sessionReady=true;wsAuthenticated=true;playerId=m.playerId||playerId;myName=m.name||myName;LS.set('2on_player_id',playerId);LS.set('2on_player_name',myName);flushSocketState();break;case'global-chat-history':globalMessages=Array.isArray(m.messages)?m.messages.slice(-200):[];globalMessages.forEach(x=>x?.id&&seen.add(x.id));renderGlobalMessages();renderGlobalDock();break;case'global-chat':{const msg=m.message;if(!msg?.id||seen.has(msg.id))break;seen.add(msg.id);if(msg.isMe!==true)FX.play('msg');globalMessages.push(msg);if(globalMessages.length>200)globalMessages.shift();if(chatScope==='general'&&$('play')?.classList.contains('active'))renderChat();else{globalUnread++;renderGlobalDock()}renderGlobalMessages();break;}case'team-chat-history':teamMessages=Array.isArray(m.messages)?m.messages.slice(-200):[];teamMessages.forEach(x=>x?.id&&seen.add(x.id));if(chatScope==='team')renderChat();break;case'team-chat':{const msg=m.message;if(!msg?.id||seen.has(msg.id))break;seen.add(msg.id);teamMessages.push(msg);if(teamMessages.length>200)teamMessages.shift();if(chatScope==='team'&&$('play')?.classList.contains('active'))renderChat();else teamUnread++;updateTeamBadge();break;}case'game-created':case'game-joined':case'game-rejoined':setActionBusy(false);selectedCheckers=null;roomCode=m.roomCode;mySymbol=m.symbol;isSpectator=!!m.spectator;setState(m.state);activeFixtureId=state?.championshipFixture?.fixtureId||null;saveSession();render();page('play');if(voiceOn&&!isSpectator&&state?.players?.X&&state?.players?.O){if(mySymbol==='X')makeVoiceOffer().catch(()=>{});else send({type:'game-voice-ready'});}flushQueuedActions();break;case'game-state':setState(m.state);render();break;case'game-timeout':setState(m.state);render();toast('⏱️ Tempo esgotado. A vez passou para o adversário.');break;case'game-disconnected':setState(m.state);render();toast('📡 O adversário perdeu a ligação. Aguardando reconexão…');break;case'game-left':if(state){state.players[m.symbol]=false;state.names[m.symbol]=null;state.disconnected=null;render()}toast('👋 O adversário saiu da partida.');break;case'game-info':toast(m.message||'');break;case'game-error':setActionBusy(false);pendingAction=null;if(m.code==='room-not-found'){const had=!!state;exitCurrentGame();if($('play')?.classList.contains('active'))page('home');if(had){toast('⚠️ A partida já não existe.');break}}if($('lobbyStatus')&&$('lobbyEntry')&&!$('lobbyEntry').hidden)$('lobbyStatus').textContent=m.message||'Não foi possível concluir a operação.';toast(m.message||'Não foi possível concluir.');break;case'game-chat-error':actionBusy=false;toast(m.message||'Aguarda um momento antes de enviar outra mensagem.');break;case'game-chat':if(m.messageId&&seen.has(m.messageId))break;if(m.messageId){seen.add(m.messageId);if(seen.size>300)seen.delete(seen.values().next().value)}if(!m.scope||m.scope===chatScope)addMsg(m.name,m.text,m.from===mySymbol,m.scope,m.at);break;case'championship-chat-history':currentChampChat=m.messages||[];if($('cupMessages')){$('cupMessages').innerHTML='';currentChampChat.forEach(x=>addChampMsg(x.name,x.text,x.isMe===true,x.scope||'general',x.at))}break;case'championship-chat':if(m.message?.id&&seen.has(m.message.id))break;if(m.message?.id)seen.add(m.message.id);currentChampChat.push(m.message);if(currentChampChat.length>200)currentChampChat.shift();if(m.message?.scope==='team'){teamMessages.push(m.message);if(teamMessages.length>200)teamMessages.shift();if(chatScope==='team'&&$('play')?.classList.contains('active'))renderChat();else{teamUnread++;updateTeamBadge()}}addChampMsg(m.message.name,m.message.text,m.message.isMe===true,m.message.scope||m.scope,m.message.at);break;case'championship-deleted':if(currentCupId===m.championshipId||state?.championshipFixture?.championshipId===m.championshipId){stopVoice();roomCode=null;mySymbol=null;state=null;activeFixtureId=null;clearSession();currentCupId=null;hideCupPanels();page('championships');loadCups(false);toast('🗑️ O campeonato foi eliminado pelo criador.')}break;case'championship-updated':if(currentCupId===m.championshipId){if(roomCode&&state?.championshipFixture)fetchChampionshipSilently(m.championshipId);else openChampionship(m.championshipId)}break;case'championship-finished':if(state?.championshipFixture?.championshipId===m.championshipId){updateChampionshipResultActions(m.championshipId,state.championshipFixture.fixtureId)}else if(currentCupId===m.championshipId){openChampionship(m.championshipId)}break;case'championship-fixture-ready':{
  const isPlayer=!!m.homeIsMe||!!m.awayIsMe;
  if(!isPlayer)break;
  currentCupId=m.championshipId;
  if(state?.championshipFixture?.championshipId===m.championshipId && m.fixtureId!==activeFixtureId){
    toast(`🎮 Jogo ${m.order} pronto. Escolhe como continuar.`);
    if(state.winner)updateChampionshipResultActions(m.championshipId,state.championshipFixture.fixtureId);
    break;
  }
  if(activeFixtureId===m.fixtureId && roomCode===String(m.roomCode).toUpperCase())break;
  if(roomCode&&socketOpen())send({type:'game-leave'});
  stopVoice();
  roomCode=String(m.roomCode).toUpperCase(); mySymbol=null; state=null; isSpectator=false; activeFixtureId=m.fixtureId;
  const action={type:'game-join',roomCode,name:myName,teamName:myTeam};
  pendingAction=action;
  page('play');
  if(socketOpen()){pendingAction=null;send(action)}else connect();
  toast(`🎮 Jogo ${m.order} pronto. A entrar…`);
  break;
}
case'championship-next':if(!!m.homeIsMe||!!m.awayIsMe){toast('🎮 Próxima partida pronta! A entrar…');openFixture(m.championshipId,m.fixtureId)}else{toast('👀 A próxima partida começou. Podes assistir.')}break;case'game-rematch-declined':toast('A revanche foi recusada.');break;case'game-voice-ready':if(mySymbol==='X'&&voiceOn&&state?.players?.O){makeVoiceOffer().catch(()=>{})}break;case'game-voice-state':if(m.enabled===false)resetRemoteVoice();break;
case'game-voice':handleVoiceSignal(m);break}}
/* ---------- Efeitos: sons (WebAudio), vibração e confetis ---------- */
const FX=(()=>{
  let ctx=null,muted=LS.get('2on_muted')==='1';
  function ac(){if(!ctx){try{ctx=new(window.AudioContext||window.webkitAudioContext)()}catch{return null}}if(ctx.state==='suspended')ctx.resume().catch(()=>{});return ctx}
  function tone(f,t0,d,type='sine',v=.08){const c=ac();if(!c)return;const o=c.createOscillator(),g=c.createGain(),t=c.currentTime+t0;o.type=type;o.frequency.setValueAtTime(f,t);g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(v,t+.01);g.gain.exponentialRampToValueAtTime(.0001,t+d);o.connect(g);g.connect(c.destination);o.start(t);o.stop(t+d+.02)}
  const S={
    move:()=>tone(520,0,.08,'triangle'),
    capture:()=>{tone(300,0,.09,'square',.05);tone(180,.07,.14,'square',.05)},
    turn:()=>{tone(660,0,.07);tone(880,.08,.09)},
    tick:()=>tone(1000,0,.04,'square',.03),
    join:()=>{tone(523,0,.1);tone(659,.1,.1);tone(784,.2,.16)},
    start:()=>{tone(440,0,.08);tone(554,.09,.08);tone(659,.18,.12)},
    win:()=>[523,659,784,1047].forEach((f,i)=>tone(f,i*.11,.2,'triangle',.09)),
    lose:()=>[392,330,262].forEach((f,i)=>tone(f,i*.14,.24,'sawtooth',.045)),
    draw:()=>{tone(440,0,.15);tone(440,.18,.15)},
    end:()=>tone(440,0,.2),
    msg:()=>tone(900,0,.05,'sine',.04)
  };
  const reduced=()=>window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;
  document.addEventListener('pointerdown',()=>ac(),{once:true});
  return{
    play(n){if(muted)return;try{S[n]&&S[n]()}catch{}},
    buzz(p){if(muted)return;try{navigator.vibrate&&navigator.vibrate(p)}catch{}},
    get muted(){return muted},
    toggle(){muted=!muted;LS.set('2on_muted',muted?'1':'0');return muted},
    confetti(){
      if(reduced())return;
      const box=document.createElement('div');box.className='fx-confetti';box.setAttribute('aria-hidden','true');
      const colors=['#35e0a1','#f5c542','#5aa9ff','#ff6b8a','#ffffff'];
      for(let i=0;i<36;i++){const s=document.createElement('i');s.style.left=Math.random()*100+'%';s.style.background=colors[i%5];s.style.animationDelay=Math.random()*.4+'s';s.style.animationDuration=1.4+Math.random()*1.2+'s';s.style.setProperty('--dx',Math.random()*160-80+'px');box.appendChild(s)}
      document.body.appendChild(box);setTimeout(()=>box.remove(),3200)
    }
  }
})();
function updateSoundBtn(){const b=$('soundBtn');if(!b)return;b.textContent=FX.muted?'🔇 Mudo':'🔊 Som';b.setAttribute('aria-pressed',String(!FX.muted))}
let clockSkew=0,lastTickSound=-1;
function isMyTurn(s){if(!s||s.winner||isSpectator||!mySymbol)return false;if(s.gameType==='rps')return !s.rps?.myChoice&&!!(s.players?.X&&s.players?.O);if(!(s.players?.X&&s.players?.O)||s.disconnected)return false;if(s.gameType==='checkers')return s.turn===(mySymbol==='X'?1:2);return !s.turn||s.turn===mySymbol}
function setState(s){const prev=state;state=s;if(s&&s.serverTime)clockSkew=s.serverTime-Date.now();try{onStateChange(prev,s)}catch(e){}}
function onStateChange(prev,s){
  if(!s)return;
  if(selectedCheckers){const ok=s.gameType==='checkers'&&s.board?.[selectedCheckers.r]?.[selectedCheckers.c]?.color===(mySymbol==='X'?1:2)&&(s.checkers?.legalTargets||[]).some(m=>m.from.r===selectedCheckers.r&&m.from.c===selectedCheckers.c);if(!ok)selectedCheckers=null}
  if(s.gameType==='checkers'&&s.checkers?.mustContinue&&isMyTurn(s)){selectedCheckers={...s.checkers.mustContinue};toast('⚔️ Continua a capturar com a mesma peça.')}
  if(!prev||prev.roomCode!==s.roomCode){return}
  if(prev.matchNumber!==s.matchNumber){FX.play('start');return}
  if(s.winner&&!prev.winner){
    if(isSpectator)FX.play('end');
    else if(s.winner==='draw')FX.play('draw');
    else if(s.winner===mySymbol){FX.play('win');FX.confetti();FX.buzz([60,40,60,40,120])}
    else{FX.play('lose');FX.buzz(200)}
    return
  }
  if(s.lastMove&&JSON.stringify(s.lastMove)!==JSON.stringify(prev.lastMove))FX.play(s.lastMove.capture?'capture':'move');
  if(isMyTurn(s)&&!isMyTurn(prev)){FX.play('turn');FX.buzz(30)}
  if(!prev.players?.O&&s.players?.O&&!isSpectator)FX.play('join');
  if(s.disconnected&&!prev.disconnected)FX.buzz(80);
}
function saveSession(){if(roomCode&&mySymbol)LS.set('2on_game_session',JSON.stringify({roomCode,mySymbol,myName,myTeam,playerId}))}
function clearSession(){LS.del('2on_game_session')}
function startWithData(){myName=$('playerName').value.trim().slice(0,24)||'Jogador';myTeam=$('teamName').value.trim().slice(0,40);LS.set('2on_player_name',myName);LS.set('2on_player_team',myTeam);return true}
function setActionBusy(v){actionBusy=!!v;clearTimeout(createWatchdog);createWatchdog=null;const b=$('lobbyCreateBtn');if(b){b.disabled=actionBusy;b.textContent=actionBusy?'A criar…':'Criar partida'}const s=$('lobbyStatus');if(!actionBusy&&s&&!s.textContent.startsWith('Partida'))s.textContent=''}
async function create(){
  if(actionBusy)return;
  startWithData();
  activeFixtureId=null;
  const action={type:'game-create',name:myName,teamName:myTeam,gameType:selectedGameType};
  setActionBusy(true);
  const status=$('lobbyStatus');
  if(status)status.textContent='A ligar ao servidor…';
  try{
    if(!sessionReady){
      const ok=await initSession();
      if(!ok)throw new Error('Não foi possível iniciar a sessão.');
    }
    if(!socketOpen()||!wsAuthenticated){
      pendingAction=action;
      if(status)status.textContent='A ligar ao servidor…';
      connect();
    }else{
      pendingAction=null;
      if(status)status.textContent='A criar a sala…';
      if(!send(action))throw new Error('A ligação ao servidor ainda não está pronta.');
    }
    clearTimeout(createWatchdog);
    createWatchdog=setTimeout(()=>{
      if(actionBusy){
        setActionBusy(false);
        pendingAction=null;
        if(status)status.textContent='O servidor não respondeu. Verifica a ligação e tenta novamente.';
        toast('⚠️ Não foi possível criar a sala.');
      }
    },15000);
  }catch(e){
    setActionBusy(false);
    pendingAction=null;
    if(status)status.textContent=e?.message||'Não foi possível criar a sala.';
    toast(e?.message||'Não foi possível criar a sala.');
  }
}

function join(){const inp=$('roomCodeInput'),st=$('lobbyStatus');const code=(inp?inp.value:'').trim().toUpperCase();if(!code){if(st)st.textContent='Escreve o código da sala para entrar.';if(inp)inp.focus();return}if(!/^[A-Z2-9]{5,10}$/.test(code)){if(st)st.textContent='Código inválido. Usa 5 a 10 letras ou números.';if(inp)inp.focus();return}if(st)st.textContent='A entrar na sala…';startWithData();activeFixtureId=null;roomCode=code;mySymbol=null;const action={type:'game-join',roomCode:code,name:myName,teamName:myTeam};if(!socketOpen()){pendingAction=action;toast('A ligar ao servidor…');connect();return}send(action)}
function leave(){openConfirm('Sair da partida?','A partida será encerrada para ti e o adversário será informado.',()=>{send({type:'game-leave'});roomCode=null;mySymbol=null;state=null;activeFixtureId=null;clearSession();stopVoice();page('home')})}
function initials(name){return(name||'?').trim().split(/\s+/).slice(0,2).map(x=>x[0]).join('').toUpperCase().slice(0,2)}
function render(){
  if(!state)return;
  const isRps=state.gameType==='rps';
  const isCheckers=state.gameType==='checkers';
  const me=isSpectator?'X':mySymbol;
  const op=me==='X'?'O':'X';
  const connected=!!state.players?.[op];
  const opName=state.names?.[op]||'A aguardar';
  $('backChamp').hidden=!state.championshipFixture;
  $('roomTitle').textContent=roomCode||'SALA';
  $('meSymbol').textContent=isCheckers?(me==='X'?'⚪':'⚫'):(me||'—');
  $('opSymbol').textContent=isCheckers?(op==='X'?'⚪':'⚫'):op;
  $('meName').textContent=isSpectator?(state.names?.[me]||'Jogador X'):(myName||'Tu');
  $('meTeam').textContent=state.teams?.[me]||'Sem equipa';
  $('opponentName').textContent=connected?opName:'A aguardar';
  $('opTeam').textContent=connected?(state.teams?.[op]||'Sem equipa'):'A aguardar';
  $('meAvatar').textContent=initials(isSpectator?state.names?.[me]:myName);
  $('opAvatar').textContent=initials(connected?opName:'O');
  $('matchNumber').textContent=state.matchNumber||1;
  $('scoreValue').textContent=`${state.score?.[me]||0} — ${state.score?.[op]||0}`+(isSpectator?' · AO VIVO':'');
  const winner=state.winner;
  let status;
  if(isSpectator) status=winner?(winner==='draw'?'🏁 Empate terminado':'🏁 Jogo terminado'):(connected?'👀 A acompanhar esta partida':'👀 A acompanhar');
  else if(winner) status=winner==='draw'?'🤝 Empate':`🏆 Vitória de ${state.names?.[winner]||'Jogador'}`;
  else if(state.disconnected) status=`Reconectando ${state.names?.[state.disconnected]||'adversário'}…`;
  else if(!connected) status='⏳ A aguardar o adversário';
  else if(isRps) status=state.rps?.myChoice?'⏳ Escolha registada · aguarda o adversário':'🎯 Escolhe a tua jogada';
  else if(isCheckers) status=state.turn===(mySymbol==='X'?1:2)?'🎯 É a tua vez':`⏳ Vez de ${opName}`;
  else status=state.turn===null?'👆 Quem tocar primeiro começa':state.turn===mySymbol?'🎯 É a tua vez':`⏳ Vez de ${opName}`;
  $('gameStatus').textContent=status;
  $('gameStatus').classList.toggle('my-turn',isMyTurn(state));
  $('resultBanner').textContent=winner?(winner==='draw'?(isRps?'🤝 As escolhas foram iguais':'🤝 Partida empatada'):`🏁 Partida terminada · ${state.names?.[winner]||winner}`):isSpectator?'👀 Estás a assistir — não podes jogar':'';
  $('board').hidden=isRps;
  $('rpsChoices').hidden=!isRps;
  $('board').setAttribute('aria-hidden', String(isRps));
  $('rpsChoices').setAttribute('aria-hidden', String(!isRps));
  if(isRps){ $('board').replaceChildren(); renderRps(connected,winner); } else if(isCheckers){ $('rpsChoices').replaceChildren(); renderCheckers(connected,winner); } else { $('rpsChoices').replaceChildren(); renderTicTacToe(connected,winner); }
  $('rematchBtn').disabled=!winner||!!state.championshipFixture||isSpectator;
  $('rematchBtn').hidden=!!state.championshipFixture;
  $('rematchBtn').textContent='🔁 Revanche';
  $('voiceBtn').disabled=isSpectator;
  $('voiceBtn').textContent=voiceOn?'🔴 Desligar voz':'🎙️ Voz';
  $('chat').classList.toggle('champ-chat-mode',!!state.championshipFixture);
  renderChat();
  if(state.championshipFixture&&winner){
    $('champResultActions').hidden=false;
    $('champResultActions').innerHTML='<div class="result-loading">A preparar a próxima etapa…</div>';
    updateChampionshipResultActions(state.championshipFixture.championshipId,state.championshipFixture.fixtureId);
  }else{$('champResultActions').hidden=true;$('champResultActions').innerHTML=''}
  updateClock();
}
function renderTicTacToe(connected,winner){
  $('board').classList.remove('checkers-board');
  const active=!isSpectator&&connected&&!winner&&(!state.turn||state.turn===mySymbol)&&!state.disconnected;
  $('board').innerHTML=state.board.map((v,i)=>`<button class="cell ${v?v.toLowerCase()+' place':''} ${state.winningLine?.includes(i)?'win':''} ${state.lastMove?.cell===i&&!state.winner?'last':''}" data-cell="${i}" ${v||!active?'disabled':''}>${v||''}</button>`).join('');
  document.querySelectorAll('.cell').forEach(b=>b.onclick=()=>{const cell=+b.dataset.cell;if(active&&!state.board[cell])send({type:'game-move',cell})});
}
function renderCheckers(connected,winner){
  const myColor=mySymbol==='X'?1:2,flip=!isSpectator&&mySymbol==='O';
  const myTurn=!isSpectator&&connected&&!winner&&state.turn===myColor&&!state.disconnected;
  const targets=myTurn&&Array.isArray(state.checkers?.legalTargets)?state.checkers.legalTargets:[];
  const sel=selectedCheckers,lm=state.lastMove;
  const movable=new Set(targets.map(m=>m.from.r+','+m.from.c));
  const forced=targets.some(m=>m.capture);
  $('board').classList.add('checkers-board');
  const rows=[0,1,2,3,4,5,6,7],cols=[0,1,2,3,4,5,6,7];
  if(flip){rows.reverse();cols.reverse()}
  $('board').innerHTML=rows.map(r=>cols.map(c=>{
    const piece=state.board[r][c],dark=(r+c)%2===1;
    const isSel=sel&&sel.r===r&&sel.c===c;
    const legal=!!sel&&targets.some(m=>m.from.r===sel.r&&m.from.c===sel.c&&m.to.r===r&&m.to.c===c);
    const canPick=!sel&&movable.has(r+','+c);
    const last=lm&&((lm.from&&lm.from.r===r&&lm.from.c===c)||(lm.to&&lm.to.r===r&&lm.to.c===c));
    const p=piece?`<span class="checkers-piece ${piece.color===1?'white':'black'}${piece.king?' king':''}">${piece.king?'♛':''}</span>`:'';
    return `<button type="button" class="cell checkers-cell ${dark?'dark':'light'}${isSel?' selected':''}${legal?' legal':''}${canPick?' movable':''}${forced&&canPick?' must':''}${last?' last':''}" data-r="${r}" data-c="${c}" ${dark?'':'aria-label="Casa clara" tabindex="-1"'}>${p}</button>`;
  }).join('')).join('');
  $('board').querySelectorAll('.checkers-cell').forEach(cell=>cell.onclick=()=>clickCheckers(+cell.dataset.r,+cell.dataset.c));
}
let selectedCheckers=null;
function clickCheckers(r,c){
  if(!state||state.gameType!=='checkers'||state.winner||isSpectator)return;
  const myColor=mySymbol==='X'?1:2;
  if(!(state.players?.X&&state.players?.O)){toast('⏳ Aguarda o adversário entrar.');return}
  if(state.disconnected){toast('📡 Aguarda a reconexão do adversário.');return}
  if(state.turn!==myColor){toast('⏳ Ainda não é a tua vez.');return}
  const targets=state.checkers?.legalTargets||[];
  const piece=state.board?.[r]?.[c];
  if(piece?.color===myColor){
    const mine=targets.filter(m=>m.from.r===r&&m.from.c===c);
    if(!mine.length){toast(targets.some(m=>m.capture)?'⚠️ Tens de capturar com outra peça.':'Esta peça não tem jogadas.');FX.buzz(30);return}
    selectedCheckers=(selectedCheckers&&selectedCheckers.r===r&&selectedCheckers.c===c)?null:{r,c};
    render();return;
  }
  if(!selectedCheckers)return;
  const move=targets.find(m=>m.from.r===selectedCheckers.r&&m.from.c===selectedCheckers.c&&m.to.r===r&&m.to.c===c);
  if(!move){toast('Essa jogada não é válida.');FX.buzz(30);return}
  send({type:'game-move',from:selectedCheckers,to:{r,c}});
  selectedCheckers=null;
}
function rpsLabel(choice){return choice==='rock'?'✊ Pedra':choice==='paper'?'✋ Papel':'✌️ Tesoura'}
function renderRps(connected,winner){
  $('board').classList.remove('checkers-board');
  const choices=[['rock','✊','Pedra'],['paper','✋','Papel'],['scissors','✌️','Tesoura']];
  const mine=state.rps?.myChoice||null;
  const opponentChosen=!!(mySymbol&&state.rps?.choices?.[opponentSymbol()]);
  const active=!isSpectator&&connected&&!winner&&!state.disconnected&&!mine;
  $('rpsChoices').innerHTML=`<div class="rps-intro"><b>${mine?'Escolha registada':'Escolhe uma opção'}</b><span>${opponentChosen?'O adversário já escolheu.':'A escolha do adversário fica oculta até ambos decidirem.'}</span></div><div class="rps-grid">${choices.map(([key,icon,label])=>`<button type="button" class="rps-choice ${mine===key?'selected':''}" data-rps="${key}" ${active?'':'disabled'}><span>${icon}</span><b>${label}</b></button>`).join('')}</div>${winner&&state.rps?.revealedChoices?`<div class="rps-result"><span>${rpsLabel(state.rps.revealedChoices.X)}</span><strong>VS</strong><span>${rpsLabel(state.rps.revealedChoices.O)}</span></div>`:''}`;
  $('rpsChoices').querySelectorAll('[data-rps]').forEach(btn=>btn.onclick=()=>{if(active)send({type:'game-move',choice:btn.dataset.rps})});
}
function opponentSymbol(){return mySymbol==='X'?'O':'X'}
function updateClock(){
  clearInterval(clockTimer);const el=$('turnClock');
  const tick=()=>{
    if(!state?.turn||state.winner||!state.turnStartedAt||state.disconnected){el.textContent=state?.disconnected?'⏸ em pausa':'—';el.classList.remove('low');return}
    const left=Math.max(0,Math.ceil((state.turnStartedAt+state.turnSeconds*1000-(Date.now()+clockSkew))/1000));
    const mine=isMyTurn(state);
    el.textContent=`${left}s · ${mine?'a tua vez':'vez do adversário'}`;
    el.classList.toggle('low',mine&&left<=5);
    if(mine&&left>0&&left<=5&&left!==lastTickSound){lastTickSound=left;FX.play('tick')}
  };
  tick();clockTimer=setInterval(tick,250)
}
async function updateChampionshipResultActions(cupId,fixtureId){
  const box=$('champResultActions'); if(!box)return;
  const token=++resultActionToken;
  box.hidden=false;
  box.innerHTML='<div class="result-loading">A preparar a próxima etapa…</div>';
  try{
    const r=await apiFetch('/api/games/championships/'+encodeURIComponent(cupId),{cache:'no-store'});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Não foi possível consultar o campeonato.');
    if(token!==resultActionToken)return;
    const c=d.championship||{};

    if(c.status==='finished'){
      const winnerTeam=c.winnerTeamId?(c.teams||[]).find(t=>t.id===c.winnerTeamId):null;
      box.innerHTML=`<div class="champ-result-card finished"><div class="result-kicker">🏆 CAMPEONATO TERMINADO</div><h3>${winnerTeam?'Vitória da '+esc(winnerTeam.name):'Campeonato empatado'}</h3><p>${winnerTeam?'A equipa vencedora do campeonato foi definida.':'As duas equipas terminaram com a mesma pontuação.'}</p><div class="result-actions"><button id="restartCupBtn" class="primary" ${!!c.isOwner?'':'disabled'}>🔁 Recomeçar campeonato</button><button id="closeFinishedCupBtn">Encerrar campeonato</button></div>${!!c.isOwner?'':'<small class="result-hint">Só o criador pode recomeçar o campeonato.</small>'}</div>`;
      $('restartCupBtn').onclick=()=>restartChampionship(c.id);
      $('closeFinishedCupBtn').onclick=()=>closeFinishedChampionship();
      return;
    }

    const current=(c.fixtures||[]).find(f=>f.status==='ready'||f.status==='playing');
    if(!current){
      box.hidden=false;
      box.innerHTML='<div class="champ-result-card"><p>🏁 Esta partida terminou. A próxima partida ainda está a ser preparada.</p><button id="returnCupBtn">🏆 Voltar ao campeonato</button></div>';
      $('returnCupBtn').onclick=()=>closeFinishedChampionship();
      return;
    }

    const mine=!!current.homeIsMe||!!current.awayIsMe;
    const home=c.teams?.find(t=>t.id===current.homeTeamId)?.name||'Equipa A';
    const away=c.teams?.find(t=>t.id===current.awayTeamId)?.name||'Equipa B';
    const title=mine?'PRÓXIMA PARTIDA · ÉS JOGADOR':'PRÓXIMA PARTIDA · AO VIVO';
    const playLabel=current.status==='playing'?'🎮 Entrar no outro jogo':'🎮 Partir para o outro jogo';
    const watchLabel=current.status==='playing'?'👀 Assistir ao outro jogo':'👀 Aguardar e assistir';

    // Para quem está escalado no próximo jogo, a ação principal é jogar.
    // Para quem não está escalado, a única ação válida é assistir.
    box.innerHTML=`<div class="champ-result-card"><div class="result-kicker">${title}</div><h3>${esc(current.homePlayerName)} <span>vs</span> ${esc(current.awayPlayerName)}</h3><p>${esc(home)} × ${esc(away)} · Partida ${Number(current.order)||0}</p><div class="result-actions">${mine?`<button id="nextPlayBtn" class="primary">${playLabel}</button><button id="nextWatchBtn">${watchLabel}</button>`:`<button id="nextWatchBtn" class="primary">${watchLabel}</button>`}</div>${mine?'<small class="result-hint">Podes entrar para jogar ou acompanhar esta partida como espectador.</small>':'<small class="result-hint">Não estás escalado nesta partida. Podes acompanhar o jogo como espectador.</small>'}</div>`;
    if($('nextPlayBtn'))$('nextPlayBtn').onclick=()=>openFixture(c.id,current.id);
    $('nextWatchBtn').onclick=()=>openFixture(c.id,current.id);
  }catch(e){
    if(token!==resultActionToken)return;
    box.hidden=false;
    box.innerHTML=`<div class="champ-result-card"><p>⚠️ ${esc(e.message||'Não foi possível preparar a próxima etapa.')}</p><button id="returnCupBtn">🏆 Voltar ao campeonato</button></div>`;
    $('returnCupBtn').onclick=()=>closeFinishedChampionship();
  }
}
function closeFinishedChampionship(){stopVoice();if(roomCode&&socketOpen())send({type:'game-leave'});roomCode=null;mySymbol=null;state=null;activeFixtureId=null;isSpectator=false;clearSession();$('champResultActions').hidden=true;$('champResultActions').innerHTML='';page('championships');if(currentCupId)openChampionship(currentCupId)}
async function restartChampionship(id){try{const r=await apiFetch('/api/games/championships/'+encodeURIComponent(id)+'/restart',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Não foi possível recomeçar o campeonato.');exitCurrentGame();toast('🔁 Campeonato recomeçado.');page('championships');await openChampionship(id)}catch(e){toast(e.message||'Não foi possível recomeçar o campeonato.')}}
function timeLabel(at){if(!at)return'';try{return new Date(at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}catch{return''}}
function addMsg(name,text,me,scope,at,target='messages'){const root=$(target);if(!root)return;const n=document.createElement('div');n.className='msg'+(me?' me':'');const body=document.createElement('span');body.textContent=text;const who=document.createElement('small');who.textContent=(scope==='team'?'👥 Equipa · ':'')+(name||'Jogador')+(at?' · '+timeLabel(at):'');n.append(body,who);root.appendChild(n);root.scrollTop=root.scrollHeight}
function renderChat(){const root=$('messages');if(!root)return;root.innerHTML='';if(chatScope==='general'){globalMessages.forEach(m=>addMsg(m.name,m.text,m.isMe===true,'general',m.at));globalUnread=0}else{teamMessages.forEach(m=>addMsg(m.name,m.text,m.isMe===true,'team',m.at));teamUnread=0}updateTeamBadge()}
function renderGlobalMessages(){const root=$('globalMessages');if(!root)return;root.innerHTML='';globalMessages.forEach(m=>addMsg(m.name,m.text,m.isMe===true,'general',m.at,'globalMessages'))}
function updateTeamBadge(){const b=$('teamChatBadge');if(!b)return;b.hidden=teamUnread<=0;b.textContent=teamUnread>99?'99+':String(teamUnread)}
function renderGlobalDock(){const dock=$('globalChatDock');if(!dock||dock.hidden)return;const badge=$('globalChatBadge');if(badge){badge.hidden=globalUnread<=0;badge.textContent=globalUnread>99?'99+':String(globalUnread)}renderGlobalMessages()}
function sendGlobalChat(){const input=$('globalChatInput'),text=input?.value.trim();if(!text)return;if(Date.now()-lastChatSentAt<500)return toast('Aguarda um instante.');if(send({type:'global-chat',text,clientMessageId:crypto.randomUUID()})){input.value='';lastChatSentAt=Date.now()}}
function sendChat(){const input=$('chatInput'),text=input.value.trim();if(!text)return;if(Date.now()-lastChatSentAt<500)return toast('Aguarda um instante.');if(chatScope==='team'&&isSpectator)return toast('👀 O modo espectador não usa o chat da equipa.');if(chatScope==='team'&&!state?.championshipFixture)return toast('👥 O chat da equipa está disponível nos campeonatos.');const clientMessageId=crypto.randomUUID();const payload={type:'game-chat',text,scope:chatScope,clientMessageId};if(send(payload)){input.value='';lastChatSentAt=Date.now()}}
function addChampMsg(name,text,me,scope,at){if(!$('cupMessages'))return;const n=document.createElement('div');n.className='msg'+(me?' me':'');const body=document.createElement('span');body.textContent=text;const who=document.createElement('small');who.textContent=(scope==='team'?'👥 Equipa · ':'💬 Geral · ')+(name||'Jogador')+(at?' · '+timeLabel(at):'');n.append(body,who);$('cupMessages').appendChild(n);$('cupMessages').scrollTop=$('cupMessages').scrollHeight}
function sendChampionshipChat(){const input=$('cupChatInput'),text=input?.value.trim();if(!text||!currentCupId)return;if(Date.now()-lastChatSentAt<500)return toast('Aguarda um instante.');if(send({type:'championship-chat',championshipId:currentCupId,text,clientMessageId:crypto.randomUUID()})){input.value='';lastChatSentAt=Date.now()}}
let cupPollTimer=null,currentCupId=null,currentCupTimer=null;
function cupStatusLabel(status){return ({waiting:'Preparação',ready:'Pronto',in_progress:'Em andamento',finished:'Concluído'})[status]||status||'Preparação'}
function cupStatusClass(status){return status==='in_progress'?'live':status==='finished'?'done':status==='ready'?'ready':''}
function hideCupPanels(){ $('cupCreate').hidden=true; $('cupJoin').hidden=true; $('cupAccess').hidden=true; $('cupChat').hidden=true; currentCupId=null; clearInterval(currentCupTimer); currentCupTimer=null; }
function startCupPolling(){clearInterval(cupPollTimer);cupPollTimer=setInterval(()=>{if(document.getElementById('championships')?.classList.contains('active'))loadCups(false)},3000)}
async function loadCups(showEmpty=true){
  startCupPolling();
  try{
    const r=await apiFetch('/api/games/championships',{cache:'no-store'}); if(!r.ok)throw 0; const d=await r.json();
    if(!d.championships.length){$('cups').innerHTML='<div class="empty-action">Ainda não existem campeonatos.<br><small>Cria o primeiro confronto entre duas equipas.</small></div>';return}
    $('cups').innerHTML=d.championships.map(c=>{
      const mine=!!c.isOwner;
      const teams=(c.teams||[]).map(t=>`<span><b>${esc(t.name)}</b> ${Array.isArray(t.players)?t.players.length:0}/${Number(t.capacity)||0}</span>`).join(' · ');
      return `<article class="item cup-item"><div class="cup-main"><div class="cup-title"><b>${esc(c.name)}</b><span class="state ${cupStatusClass(c.status)}">${cupStatusLabel(c.status)}</span></div><div class="team-progress">${teams}</div></div><div class="cup-actions"><button data-open-cup="${esc(c.id)}">Abrir</button>${mine?`<button class="danger" data-delete-cup="${esc(c.id)}">Eliminar</button>`:''}</div></article>`;
    }).join('');
    document.querySelectorAll('[data-open-cup]').forEach(b=>b.onclick=()=>openChampionship(b.dataset.openCup));
    document.querySelectorAll('[data-delete-cup]').forEach(b=>b.onclick=()=>deleteChampionship(b.dataset.deleteCup));
  }catch{$('cups').innerHTML='<div class="empty-action">Não foi possível carregar os campeonatos.</div>'}
}
function buildShareUrl(kind,value){const url=new URL(location.href);url.hash='';url.search='';url.searchParams.set(kind,value);return url.toString()}
async function shareAccess(title,code,kind='join'){
  const url=buildShareUrl(kind,code);
  const text=`${title}\nCódigo: ${code}\n${url}`;
  if(navigator.share){try{await navigator.share({title,text,url});return}catch(e){if(e?.name==='AbortError')return}}
  try{await navigator.clipboard.writeText(url);toast('🔗 Link de acesso copiado.')}catch{toast(url)}
}
async function showQr(title,code,kind='join'){
  const url=buildShareUrl(kind,code),modal=$('qrModal'),canvas=$('qrCanvas'),fallback=$('qrImage'),label=$('qrTitle'),link=$('qrLink');
  label.textContent=title;link.textContent=url;link.href=url;
  // Prefer qrcodejs (new QRCode) which is the included vendor library
  canvas.hidden=true; fallback.hidden=true;
  // Clear previous QR content
  const wrap = canvas.parentElement;
  const oldHolder = wrap.querySelector('#qrcode-holder, table, canvas:not(#qrCanvas)');
  if (oldHolder && oldHolder !== canvas) oldHolder.remove();
  if (window.QRCode && typeof QRCode === 'function') {
    try {
      const holder = document.createElement('div');
      holder.id = 'qrcode-holder';
      holder.style.display = 'inline-block';
      wrap.insertBefore(holder, canvas);
      new QRCode(holder, {
        text: url,
        width: 240,
        height: 240,
        colorDark: '#101827',
        colorLight: '#ffffff',
        correctLevel: QRCode.CorrectLevel.M
      });
      modal.classList.add('open');
      modal.setAttribute('aria-hidden','false');
      return;
    } catch (e) {
      console.warn('QR render failed', e);
    }
  }
  // Fallback: show empty canvas area + toast
  canvas.hidden = false;
  modal.classList.add('open');
  modal.setAttribute('aria-hidden','false');
  toast('QR local indisponível.');
}
function closeQr(){
  $('qrModal').classList.remove('open');
  $('qrModal').setAttribute('aria-hidden','true');
  const holder = document.getElementById('qrcode-holder');
  if (holder) holder.remove();
}
async function shareRoomCode(){if(!roomCode)return;await shareAccess('2 ON · Entrar na partida',roomCode,'room')}
function renderChampionship(c){
  const a=c.teams?.[0],b=c.teams?.[1],mine=c.memberTeamId,mineTeam=c.teams?.find(t=>t.id===mine),isOwner=!!c.isOwner;
  const scoreA=(c.fixtures||[]).filter(f=>f.status==='finished'&&((f.homeTeamId===a?.id&&f.homeScore>f.awayScore)||(f.awayTeamId===a?.id&&f.awayScore>f.homeScore))).length;
  const scoreB=(c.fixtures||[]).filter(f=>f.status==='finished'&&((f.homeTeamId===b?.id&&f.homeScore>f.awayScore)||(f.awayTeamId===b?.id&&f.awayScore>f.homeScore))).length;
  const canStart=isOwner&&c.status==='ready'; const winner=c.winnerTeamId?(c.teams.find(t=>t.id===c.winnerTeamId)?.name):null; const championshipDraw=c.status==='finished'&&!c.winnerTeamId; const codeA=a?.joinCode,codeB=b?.joinCode;
  $('cupAccess').hidden=false;$('cupChat').hidden=false;
  $('cupAccess').innerHTML=`<div class="champ-shell"><div class="champ-top"><div><div class="eyebrow">${cupStatusLabel(c.status).toUpperCase()}</div><h3>🏆 ${esc(c.name)}</h3><p class="sub">👥 ${Number(c.participantCount)||0} jogadores · 🎯 ${Number(c.plannedMatches||c.fixtures?.length||1)||1} partidas · ${esc(a?.name||'Equipa A')} vs ${esc(b?.name||'Equipa B')}</p></div><div class="row compact">${isOwner?`<button id="deleteCupView" class="danger">Eliminar campeonato</button>`:``}<button id="closeCupView">Fechar</button></div></div>
    <div class="champ-score"><div class="team-score"><b>🅰️ ${esc(a?.name||'Equipa A')}</b><strong>${scoreA}</strong><small>${a?.players?.length||0}/${a?.capacity||0} jogadores</small></div><div class="versus">VS</div><div class="team-score right"><b>🅱️ ${esc(b?.name||'Equipa B')}</b><strong>${scoreB}</strong><small>${b?.players?.length||0}/${b?.capacity||0} jogadores</small></div></div>
    ${c.status==='waiting'||c.status==='ready'?`<div class="access-grid"><div class="access-code"><small>🅰️ ${esc(a?.name||'Equipa A')}</small><strong>${codeA?esc(codeA):'••••••'}</strong>${codeA?`<div class="access-actions"><button data-copy="${esc(codeA)}">Copiar</button><button data-share-code="${esc(codeA)}" data-share-title="Entrar na Equipa A">🔗 Partilhar</button><button data-qr-code="${esc(codeA)}" data-qr-title="QR · ${esc(a?.name||'Equipa A')}">▦ QR</button></div>`:''}</div><div class="access-code"><small>🅱️ ${esc(b?.name||'Equipa B')}</small><strong>${codeB?esc(codeB):'••••••'}</strong>${codeB?`<div class="access-actions"><button data-copy="${esc(codeB)}">Copiar</button><button data-share-code="${esc(codeB)}" data-share-title="Entrar na Equipa B">🔗 Partilhar</button><button data-qr-code="${esc(codeB)}" data-qr-title="QR · ${esc(b?.name||'Equipa B')}">▦ QR</button></div>`:''}</div></div><div class="create-note">${isOwner?'👑 Como criador, tens os dois códigos. Usa o link ou QR para convidar cada equipa.':mineTeam?'👤 Estás na '+esc(mineTeam.name)+'.':''}</div>`:''}
    ${mineTeam?`<div class="create-note">📌 Estás na <b>${esc(mineTeam.name)}</b>. ${c.status==='waiting'?'Aguarda o preenchimento das vagas.':''}</div>`:''}
    ${canStart?`<div class="start-panel"><div><b>🚀 Tudo pronto!</b><span>${c.plannedMatches||1} partidas foram configuradas.</span></div><button id="startCup" class="primary">▶️ Iniciar campeonato</button></div>`:c.status==='waiting'?`<div class="create-note">⏳ ${(a?.players?.length||0)}/${a?.capacity||0} na Equipa A · ${(b?.players?.length||0)}/${b?.capacity||0} na Equipa B. O início aparece quando todas as vagas estiverem preenchidas.</div>`:''}
    ${c.status==='in_progress'||c.status==='finished'?`<div class="list-heading"><span>🎮 JOGOS DO CAMPEONATO</span><small>${(c.fixtures||[]).filter(f=>f.status==='finished').length}/${c.fixtures?.length||0} concluídos</small></div><div class="fixture-list">${(c.fixtures||[]).map(f=>renderFixture(c,f)).join('')}</div>`:''}
    ${winner?`<div class="winner-line">🏆 <b>${esc(winner)}</b><div class="sub">Campeã do campeonato.</div></div>`:championshipDraw?`<div class="winner-line">🤝 <b>Campeonato empatado</b><div class="sub">As equipas terminaram com a mesma pontuação.</div></div>`:''}
  </div>`;
  $('closeCupView').onclick=()=>{$('cupAccess').hidden=true;$('cupChat').hidden=true};if($('deleteCupView'))$('deleteCupView').onclick=()=>deleteChampionship(c.id);
  document.querySelectorAll('[data-copy]').forEach(btn=>btn.onclick=async()=>{try{await navigator.clipboard.writeText(btn.dataset.copy);toast('📋 Código copiado.')}catch{toast(btn.dataset.copy)}});
  document.querySelectorAll('[data-share-code]').forEach(btn=>btn.onclick=()=>shareAccess(btn.dataset.shareTitle,btn.dataset.shareCode));
  document.querySelectorAll('[data-qr-code]').forEach(btn=>btn.onclick=()=>showQr(btn.dataset.qrTitle,btn.dataset.qrCode));
  if($('startCup'))$('startCup').onclick=()=>startChampionship(c.id);
  document.querySelectorAll('[data-play-fixture]').forEach(btn=>btn.onclick=()=>openFixture(c.id,btn.dataset.playFixture));
  currentChampChat=c.chat||[];teamMessages=currentChampChat.filter(m=>m.scope==='team');if($('cupMessages')){$('cupMessages').innerHTML='';currentChampChat.forEach(m=>addChampMsg(m.name,m.text,m.isMe===true,m.scope||'general',m.at))}
  if(socketOpen()&&mine)send({type:'championship-watch',championshipId:c.id,playerId});
}
function renderFixture(c,f){
  const mine=!!f.homeIsMe||!!f.awayIsMe;
  const firstOpen=(c.fixtures||[]).find(x=>x.status!=='finished');
  const isCurrent=f.status==='playing'||(firstOpen&&firstOpen.id===f.id);
  const final=f.order===(c.plannedMatches||c.fixtures?.length);
  const status=f.status==='finished'?'🏁 Concluído':f.status==='playing'?'🔴 Ao vivo':isCurrent?'🟢 Pronta':'🔒 Bloqueada';
  const result=f.status==='finished'?`${f.homeScore} — ${f.awayScore}`:status;
  const canOpen=f.status==='finished'||isCurrent;
  const action=f.status==='finished'?(mine?'📺 Rever':'👀 Rever'):(isCurrent?(mine?(final?'🏆 JOGAR FINAL':'🎮 JOGAR AGORA'):(final?'👀 ASSISTIR FINAL':'👀 ASSISTIR AO VIVO')):'🔒 AGUARDA');
  const note=!canOpen&&f.status!=='finished'?`<small class="fixture-lock-note">Disponível após o Jogo ${(f.order||2)-1}</small>`:'';
  return `<div class="fixture ${isCurrent?'is-current':''} ${f.status==='finished'?'is-finished':'is-locked'}"><div class="fixture-num">${f.order}</div><div class="fixture-names"><b>${esc(f.homePlayerName)} <span class="sub">(${esc(c.teams.find(t=>t.id===f.homeTeamId)?.name||'')})</span></b><small>vs ${esc(f.awayPlayerName)} <span>(${esc(c.teams.find(t=>t.id===f.awayTeamId)?.name||'')})</span></small>${note}</div><div class="fixture-result"><strong>${esc(result)}</strong><button data-play-fixture="${esc(f.id)}" ${canOpen?'':'disabled'} class="${mine&&f.status!=='finished'&&canOpen?'primary':''}">${action}</button></div></div>`;
}
async function fetchChampionshipSilently(id){
  try{
    const r=await apiFetch('/api/games/championships/'+encodeURIComponent(id),{cache:'no-store'});
    const d=await r.json();
    if(!r.ok)throw new Error(d.error||'Não foi possível atualizar o campeonato.');
    if(currentCupId===id && $('championships')?.classList.contains('active')) renderChampionship(d.championship);
  }catch(e){}
}
async function openChampionship(id){
  currentCupId=id; clearInterval(currentCupTimer);
  const refresh=async()=>{try{const r=await apiFetch('/api/games/championships/'+encodeURIComponent(id),{cache:'no-store'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Campeonato não encontrado.');renderChampionship(d.championship);return true}catch(e){toast(e.message||'Não foi possível abrir o campeonato.');return false}};
  await refresh();
  if(socketOpen())send({type:'championship-watch',championshipId:id});
  currentCupTimer=setInterval(()=>{if(currentCupId===id&&$('championships')?.classList.contains('active'))refresh()},5000);
}
async function startChampionship(id){
  try{const r=await apiFetch('/api/games/championships/'+encodeURIComponent(id)+'/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});const d=await r.json();if(!r.ok)throw new Error(d.error);toast(d.message||'Campeonato iniciado.');openChampionship(id);loadCups(false)}catch(e){toast(e.message||'Não foi possível iniciar o campeonato.')}
}
async function openFixture(cupId,fixtureId){
  try{
    const r=await apiFetch(`/api/games/championships/${encodeURIComponent(cupId)}/fixtures/${encodeURIComponent(fixtureId)}/room`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({})});
    const d=await r.json(); if(!r.ok)throw new Error(d.error||'Não foi possível preparar a partida.');
    currentCupId=cupId;
    roomCode=String(d.roomCode).toUpperCase();
    mySymbol=null;
    state=null;
    isSpectator=!!d.spectator;
    activeFixtureId=fixtureId;
    clearSession();
    myName=LS.get('2on_player_name')||myName;
    myTeam=LS.get('2on_player_team')||myTeam;
    const action={type:'game-join',roomCode,name:myName,teamName:myTeam};
    pendingAction=action;
    page('play');
    if(!socketOpen()){toast('🔄 A ligar à partida…');connect();return;}
    pendingAction=null;
    if(send(action)) toast(isSpectator?'👀 A abrir o modo espectador…':'🎮 A entrar na partida…');
  }catch(e){toast(e.message||'Não foi possível abrir este jogo.')}
}
async function deleteChampionship(id){openConfirm('Eliminar campeonato?','Esta ação é definitiva. O campeonato será removido mesmo que esteja em andamento, e as partidas ativas serão encerradas.',async()=>{try{const r=await apiFetch('/api/games/championships/'+encodeURIComponent(id),{method:'DELETE'});const d=await r.json();if(!r.ok)throw new Error(d.error||'Não foi possível eliminar.');if(currentCupId===id)currentCupId=null;$('cupAccess').hidden=true;$('cupChat').hidden=true;toast('🗑️ Campeonato eliminado.');loadCups(false)}catch(e){toast(e.message||'Não foi possível eliminar o campeonato.')}})}
async function createChampionship(){
  const name=$('cupName').value.trim(),gameType=$('cupGameType').value==='rps'?'rps':'tictactoe',participantCount=Number($('cupParticipants').value),plannedMatches=Number($('cupMatches').value),teamAName=$('teamAName').value.trim(),teamBName=$('teamBName').value.trim();
  if(!name||!teamAName||!teamBName)return toast('Preenche o nome do campeonato e das duas equipas.');
  myName=$('playerName').value.trim().slice(0,24)||'Jogador';LS.set('2on_player_name',myName);
  try{const r=await apiFetch('/api/games/championships',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,gameType,participantCount,plannedMatches,teamAName,teamBName,ownerName:myName})});const d=await r.json();if(!r.ok)throw new Error(d.error);hideCupPanels();toast('Campeonato criado. Entraste na Equipa A.');openChampionship(d.championship.id);loadCups(false)}catch(e){toast(e.message||'Não foi possível criar o campeonato.')}
}
async function joinChampionship(){
  const code=$('cupJoinCode').value.trim().toUpperCase(),name=$('cupJoinName').value.trim()||myName||'Jogador';if(!code)return toast('Indica o código da equipa.');
  try{const r=await apiFetch('/api/games/championships/join',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,name})});const d=await r.json();if(!r.ok)throw new Error(d.error);myName=name;myTeam=d.team.name;LS.set('2on_player_name',myName);LS.set('2on_player_team',myTeam);hideCupPanels();toast(d.message||`Entraste na equipa ${d.team.name}.`);openChampionship(d.championship.id);loadCups(false)}catch(e){toast(e.message||'Não foi possível entrar na equipa.')}
}
async function loadRanking(){try{const r=await apiFetch('/api/games/ranking',{cache:'no-store'});if(!r.ok)throw 0;const d=await r.json();$('rankingBox').innerHTML=d.ranking.length?d.ranking.map((p,i)=>`<div class="item rank"><span class="ranknum">#${i+1}</span><span class="rank-avatar">${esc(initials(p.name))}</span><div><b>${esc(p.name)}</b><span class="sub">${p.wins} vitórias · ${p.losses} derrotas · ${p.draws} empates · ${p.games} partidas</span></div><strong>${p.rate}%</strong></div>`).join(''):'<div class="empty">O ranking começa a ganhar dados quando as partidas terminarem.</div>'}catch{$('rankingBox').innerHTML='<div class="empty">Não foi possível carregar o ranking.</div>'}}
async function loadProfile(){try{const r=await apiFetch('/api/games/profile/me',{cache:'no-store'});const p=await r.json();$('profileBox').innerHTML=`<div class="profile-avatar">${esc(initials(p.name))}</div><div><b>${esc(p.name||'Jogador')}</b><small>O teu perfil · histórico até 50 partidas</small></div><div class="profile-stat"><strong>${p.wins||0}</strong><small>VITÓRIAS</small></div><div class="profile-stat"><strong>${p.losses||0}</strong><small>DERROTAS</small></div><div class="profile-stat"><strong>${p.draws||0}</strong><small>EMPATES</small></div><div class="profile-stat"><strong>${p.games||0}</strong><small>PARTIDAS</small></div>`}catch{$('profileBox').innerHTML=''}}
function esc(v){return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
async function toggleVoice(){
  if(isSpectator)return toast('👀 O modo espectador não usa microfone.');
  if(voiceOn){stopVoice();return}
  if(!navigator.mediaDevices?.getUserMedia)return toast('🎙️ O teu navegador não disponibiliza microfone.');
  if(location.protocol!=='https:'&&location.hostname!=='localhost'&&location.hostname!=='127.0.0.1')return toast('🔒 No telemóvel, o microfone requer HTTPS.');
  try{localStream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true,channelCount:1}});voiceOn=true;await setupVoicePeer();send({type:'game-voice-ready'});send({type:'game-voice-state',enabled:true});render();toast(state?.players?.X&&state?.players?.O?'🎙️ Voz ativada. A ligar ao adversário…':'🎙️ Voz ativada. Aguarda o outro jogador.')}catch(e){stopVoice();toast(e?.name==='NotAllowedError'?'🎙️ Permissão do microfone recusada.':'❌ Não foi possível ativar o microfone.')}}
async function setupVoicePeer(){if(pc)return;pc=new RTCPeerConnection({iceServers:await getIceServers(),bundlePolicy:'max-bundle',rtcpMuxPolicy:'require',iceCandidatePoolSize:2});localStream?.getTracks().forEach(t=>{if(!pc.getSenders().some(s=>s.track===t))pc.addTrack(t,localStream)});pc.onicecandidate=e=>{if(e.candidate)send({type:'game-voice',signal:{type:'ice',candidate:e.candidate}})};pc.ontrack=e=>{const audio=$('remoteAudio');audio.srcObject=e.streams[0];audio.play?.().catch(()=>{})};pc.oniceconnectionstatechange=()=>{if(pc?.iceConnectionState==='failed'){try{pc.restartIce()}catch{}}};pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState))toast('📡 A ligação de voz foi interrompida.')} }
async function getIceServers(){try{const r=await fetch('/ice-servers',{cache:'no-store'});if(r.ok){const data=await r.json();if(Array.isArray(data)&&data.length)return data}}catch{}return[{urls:'stun:stun.l.google.com:19302'}]}
async function makeVoiceOffer(){if(!voiceOn||isSpectator)return;await setupVoicePeer();const offer=await pc.createOffer({offerToReceiveAudio:true});await pc.setLocalDescription(offer);send({type:'game-voice',signal:{type:'offer',sdp:offer}})}
async function handleVoiceSignal(m){if(!m.signal||isSpectator||!voiceOn)return;try{if(m.signal.type==='offer'){await setupVoicePeer();await pc.setRemoteDescription(m.signal.sdp);for(const c of pendingIce){try{await pc.addIceCandidate(c)}catch{}}pendingIce=[];const answer=await pc.createAnswer();await pc.setLocalDescription(answer);send({type:'game-voice',signal:{type:'answer',sdp:answer}})}else if(m.signal.type==='answer'&&pc){await pc.setRemoteDescription(m.signal.sdp);for(const c of pendingIce){try{await pc.addIceCandidate(c)}catch{}}pendingIce=[]}else if(m.signal.type==='ice'&&m.signal.candidate){if(pc?.remoteDescription)await pc.addIceCandidate(m.signal.candidate);else pendingIce.push(m.signal.candidate)}}catch(e){toast('📡 Não foi possível estabelecer a voz.')}}
function resetRemoteVoice(){pendingIce=[];if(pc){pc.close();pc=null}if($('remoteAudio'))$('remoteAudio').srcObject=null}
function stopVoice(){if(socketOpen()&&roomCode&&!isSpectator)send({type:'game-voice-state',enabled:false});voiceOn=false;pendingIce=[];if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null}resetRemoteVoice();if(state)render()}
function exitCurrentGame(){stopVoice();if(roomCode&&socketOpen())send({type:'game-leave'});teamMessages=[];teamUnread=0;updateTeamBadge();currentChampChat=[];roomCode=null;mySymbol=null;state=null;activeFixtureId=null;isSpectator=false;clearSession();$('board').replaceChildren();$('rpsChoices').replaceChildren();$('board').hidden=false;$('rpsChoices').hidden=true;$('board').removeAttribute('aria-hidden');$('rpsChoices').setAttribute('aria-hidden','true');clearInterval(clockTimer);clockTimer=null;}
window.goToHomePanel=()=>{
  if($('play')?.classList.contains('active')&&roomCode&&!state?.winner){
    openConfirm('Voltar ao painel?','A ligação à partida será encerrada neste dispositivo.',()=>{exitCurrentGame();page('home')});
    return;
  }
  if($('play')?.classList.contains('active')&&roomCode)exitCurrentGame();
  page('home');
};
$('topbarBrand').onclick=e=>{e.preventDefault();goToHomePanel()};
$('backHome').onclick=()=>{
  if(state&&!state.winner){openConfirm('Voltar ao painel?','A ligação à partida será encerrada neste dispositivo.',()=>{exitCurrentGame();page('home')});}
  else{exitCurrentGame();page('home');}
};
$('backChamp').onclick=async()=>{const cid=state?.championshipFixture?.championshipId;if(cid){exitCurrentGame();page('championships');await openChampionship(cid)}};
function lobbyStep(step){
  const pick=$('lobbyPick'),form=$('lobbyForm'),sub=$('lobbyEntrySub');
  if(pick)pick.hidden=(step!=='pick');if(form)form.hidden=(step!=='form');
  if(sub)sub.textContent='Prepara a partida';
}
function goToGames(){
  const box=$('lobbyEntry'); if(box)box.hidden=true;
  const target=$('availableGames')||$('gamesGrid'); if(!target)return;
  target.scrollIntoView({behavior:'smooth',block:'start'});
  const grid=$('gamesGrid');
  if(grid){grid.classList.remove('is-highlight');void grid.offsetWidth;grid.classList.add('is-highlight');setTimeout(()=>grid.classList.remove('is-highlight'),2200)}
  toast('👇 Escolhe o jogo que queres iniciar.');
}
function openLobbyEntry(mode='create',gameType=null){
  const box=$('lobbyEntry'); if(!box)return;
  const valid=['rps','checkers','tictactoe'].includes(gameType);
  if(!valid){goToGames();return}
  box.hidden=false;
  selectedGameType=gameType;
  const label=$('selectedGameLabel'); if(label)label.textContent=selectedGameType==='rps'?'Pedra, Papel e Tesoura':selectedGameType==='checkers'?'Damas':'X Vs O';
  lobbyStep('form');
  if(mode==='create') $('lobbyCreateBtn').focus(); else ($('roomCodeInput')||$('lobbyJoinBtn')).focus();
  box.scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('connectGame').onclick=()=>goToGames();
if($('changeGame'))$('changeGame').onclick=()=>goToGames();
$('closeLobbyEntry').onclick=()=>{$('lobbyEntry').hidden=true};
$('lobbyCreateBtn').onclick=()=>create();
$('lobbyJoinBtn').onclick=()=>join();
if($('roomCodeInput')){$('roomCodeInput').addEventListener('input',e=>{e.target.value=e.target.value.toUpperCase().replace(/[^A-Z2-9]/g,'')});$('roomCodeInput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();join()}})}
document.querySelectorAll('.lobby-game-button').forEach(b=>b.onclick=()=>{
  const game=b.dataset.game;
  if(game==='tictactoe'||game==='rps'||game==='checkers') openLobbyEntry('create',game);
  else toast('🎮 Este jogo está em preparação.');
});
$('copyCode').onclick=async()=>{try{await navigator.clipboard.writeText(roomCode);toast('Código copiado.')}catch{toast('Código: '+roomCode)}};$('shareCode').onclick=shareRoomCode;$('leaveGame').onclick=leave;$('soundBtn')&&($('soundBtn').onclick=()=>{const m=FX.toggle();updateSoundBtn();if(!m)FX.play('turn')});updateSoundBtn();$('gameStatus')&&$('gameStatus').setAttribute('aria-live','polite');$('rematchBtn').onclick=()=>{if(!state?.winner)return;if(send({type:'game-reset'}))toast('Revanche iniciada.');};$('voiceBtn').onclick=toggleVoice;$('chatSend').onclick=sendChat;$('chatInput').onkeydown=e=>{if(e.key==='Enter')sendChat()};document.querySelectorAll('.chat-tabs button').forEach(b=>b.onclick=()=>{chatScope=b.dataset.scope;document.querySelectorAll('.chat-tabs button').forEach(x=>x.classList.toggle('active',x===b));if(chatScope==='team'&&!state?.championshipFixture){toast('👥 O chat da equipa está disponível nos campeonatos.');chatScope='general';document.querySelectorAll('.chat-tabs button').forEach(x=>x.classList.toggle('active',x.dataset.scope==='general'));return}if(chatScope==='team')teamUnread=0;renderChat()});$('globalChatToggle').onclick=()=>{$('globalChatPanel').hidden=!$('globalChatPanel').hidden;globalChatOpen=!$('globalChatPanel').hidden;if(globalChatOpen){globalUnread=0;renderGlobalDock();setTimeout(()=>$('globalChatInput')?.focus(),30)}};$('globalChatClose').onclick=()=>{$('globalChatPanel').hidden=true;globalChatOpen=false};$('globalChatSend').onclick=sendGlobalChat;$('globalChatInput').onkeydown=e=>{if(e.key==='Enter')sendGlobalChat()};document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>page(b.dataset.page));$('createCup').onclick=()=>{$('cupCreate').hidden=false;$('cupJoin').hidden=true;$('cupAccess').hidden=true};$('cupCancel').onclick=()=>{$('cupCreate').hidden=true};$('joinCup').onclick=()=>{$('cupJoin').hidden=false;$('cupCreate').hidden=true;$('cupAccess').hidden=true;$('cupJoinName').value=myName};$('cupJoinCancel').onclick=()=>{$('cupJoin').hidden=true};$('cupCreateSubmit').onclick=createChampionship;$('cupJoinSubmit').onclick=joinChampionship;$('cupChatSend').onclick=sendChampionshipChat;$('cupChatInput').onkeydown=e=>{if(e.key==='Enter')sendChampionshipChat()};$('qrClose').onclick=closeQr;$('qrModal').onclick=e=>{if(e.target===$('qrModal'))closeQr()};$('qrShare').onclick=async()=>{const url=$('qrLink').href;if(navigator.share){try{await navigator.share({title:$('qrTitle').textContent,url});return}catch(e){if(e?.name==='AbortError')return}}try{await navigator.clipboard.writeText(url);toast('🔗 Link copiado.')}catch{toast(url)}};$('qrDownload').onclick=()=>{const canvas=$('qrCanvas');const holder=document.getElementById('qrcode-holder');let src=null;if(holder){const c=holder.querySelector('canvas');if(c)src=c.toDataURL('image/png');else{const img=holder.querySelector('img');if(img)src=img.src}}if(!src&&canvas&&!canvas.hidden)src=canvas.toDataURL('image/png');if(src){const a=document.createElement('a');a.download='2-on-acesso-qr.png';a.href=src;a.click()}else if($('qrImage')&&$('qrImage').src)window.open($('qrImage').src,'_blank','noopener');};
function handleDeepLink(){const q=new URLSearchParams(location.search);const join=q.get('join'),room=q.get('room');if(join){page('championships');$('cupJoin').hidden=false;$('cupCreate').hidden=true;$('cupAccess').hidden=true;$('cupJoinCode').value=join.toUpperCase().trim();$('cupJoinName').value=myName;toast('🔗 Código de equipa carregado. Confirma o teu nome para entrar.')}else if(room){const code=room.toUpperCase().trim();try{history.replaceState(null,'',location.pathname)}catch{}if(/^[A-Z2-9]{5,10}$/.test(code)){
    page('home');
    const hasName=myName&&myName!=='Jogador';
    if(hasName){setTimeout(()=>joinRoomCode(code),120)}
    else{ // sem nome guardado: pede o nome antes de entrar
      setTimeout(()=>{openLobbyEntry('join',selectedGameType);const l=$('selectedGameLabel');if(l)l.textContent='o jogo desta sala';if($('roomCodeInput'))$('roomCodeInput').value=code;const n=$('playerName');if(n){n.value='';n.focus()}const st=$('lobbyStatus');if(st)st.textContent='Escreve o teu nome e toca em «Entrar com código».';toast('🔗 Código da sala carregado.')},150)
    }
  }}}
function joinRoomCode(code){if(!startWithData())return;roomCode=code;mySymbol=null;activeFixtureId=null;const action={type:'game-join',roomCode:code,name:myName,teamName:myTeam};pendingAction=action;if(!socketOpen()){toast('🔄 A ligar à partida…');connect();return}pendingAction=null;send(action)}
window.addEventListener('beforeunload',()=>{intentionalClose=true;stopVoice()});initSession().then(ok=>{if(ok){connect();handleDeepLink()}});
})();
