(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  const scenarios = {
    office:     { label: 'Oficina con aire acondicionado', base: 0.16, temp: 22.5, turb: 0.18 },
    diffuser:   { label: 'Puesto bajo difusor',            base: 0.42, temp: 20.5, turb: 0.30 },
    window:     { label: 'Puesto junto a ventana',          base: 0.55, temp: 23.2, turb: 0.42 },
    industrial: { label: 'Área industrial variable',        base: 1.35, temp: 29.0, turb: 0.28 },
    grille:     { label: 'Salida de ventilación',            base: 3.80, temp: 18.8, turb: 0.12 },
    duct:       { label: 'Ducto de ventilación',             base: 7.20, temp: 19.5, turb: 0.10 }
  };

  const modes = {
    hotwire: { title: 'HOT WIRE · Hilo caliente', badge: '0–20 m/s · 0,01 m/s', range: [0, 20], resolution: 0.01, warmup: 5, dir: {0:1,30:.92,60:.62,90:.18} },
    vane:    { title: 'VANE · Hélice', badge: '0,4–20 m/s · 0,1 m/s', range: [.4, 20], resolution: 0.1, warmup: 0, dir: {0:1,30:.87,60:.52,90:.10} },
    pitot:   { title: 'PITOT · Ducto avanzado', badge: 'Δp → velocidad local', range: [0, 60], resolution: 0.01, warmup: 0, dir: {0:1,30:.75,60:.25,90:.03} }
  };

  const heightLabels = {
    seated:  { head: 'Cabeza · 1,1 m', abdomen: 'Abdomen · 0,6 m', ankles: 'Tobillos · 0,1 m' },
    standing:{ head: 'Cabeza · 1,7 m', abdomen: 'Abdomen · 1,1 m', ankles: 'Tobillos · 0,1 m' }
  };
  const heightFactors = {
    seated:  { head: 1.08, abdomen: 1.00, ankles: 1.22 },
    standing:{ head: 1.04, abdomen: 1.00, ankles: 1.18 }
  };
  const units = {
    ms:  { label:'m/s', factor:1 },
    fpm: { label:'fpm', factor:196.850394 },
    kmh: { label:'km/h', factor:3.6 }
  };

  const state = {
    mode:'hotwire', scenario:'office', posture:'seated', height:'abdomen', orientation:0, unit:'ms',
    powered:false, warmed:false, warming:false, running:false, hold:false, displayMode:'live', holdValue:null,
    samples:[], current:null, min:null, max:null, avg:null, sd:null, tu:null, temp:22.5,
    startAt:0, elapsed:0, trend:[], heights:{}, points:[], pitot:[], memory:loadMemory()
  };

  let sampleTimer = null;
  let warmTimer = null;
  let toastTimer = null;
  let warmCountdown = 0;

  function loadMemory() {
    try { return JSON.parse(localStorage.getItem('movida-anemometro-memory') || '[]'); }
    catch { return []; }
  }
  function persistMemory() {
    try { localStorage.setItem('movida-anemometro-memory', JSON.stringify(state.memory.slice(0, 20))); } catch {}
  }
  function toast(text) {
    $('toast').textContent = text;
    $('toast').classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('toast').classList.remove('show'), 2400);
  }
  function fmtTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
  }
  function unitInfo() { return units[state.unit]; }
  function convert(v) { return Number.isFinite(v) ? v * unitInfo().factor : null; }
  function formatValue(v) {
    if (!Number.isFinite(v)) return '----';
    const x = convert(v);
    const res = modes[state.mode].resolution * unitInfo().factor;
    if (res < .1) return x.toFixed(2);
    if (res < 1) return x.toFixed(1);
    return Math.round(x).toLocaleString('es-ES');
  }
  function calcStats() {
    const a = state.samples;
    if (!a.length) { state.avg = state.sd = state.tu = null; return; }
    state.avg = a.reduce((s,v)=>s+v,0) / a.length;
    state.sd = a.length > 1 ? Math.sqrt(a.reduce((s,v)=>s + (v-state.avg)**2,0)/(a.length-1)) : 0;
    state.tu = state.avg > 0 ? state.sd/state.avg*100 : 0;
  }
  function simulatedVelocity() {
    const s = scenarios[state.scenario];
    const m = modes[state.mode];
    const t = performance.now()/1000;
    const h = heightFactors[state.posture][state.height] || 1;
    const d = m.dir[state.orientation] ?? 1;
    const base = s.base * h;
    const wave = Math.sin(t*2.15)*s.turb*base*.55 + Math.sin(t*.73+1.3)*s.turb*base*.35;
    const random = (Math.random()-.5)*s.turb*base*.9;
    return Math.max(0, (base + wave + random) * d);
  }

  function resetRunData() {
    state.samples = [];
    state.current = state.min = state.max = state.avg = state.sd = state.tu = null;
    state.elapsed = 0;
    state.trend = [];
    state.hold = false;
    state.holdValue = null;
    state.displayMode = 'live';
  }

  function powerToggle() {
    if (state.powered) {
      stopMeasurement();
      clearInterval(warmTimer);
      warmTimer = null;
      state.powered = state.warmed = state.warming = false;
      warmCountdown = 0;
      resetRunData();
      update();
      return;
    }
    state.powered = true;
    const warmup = modes[state.mode].warmup;
    state.warmed = warmup === 0;
    state.warming = warmup > 0;
    warmCountdown = warmup;
    if (state.warming) {
      warmTimer = setInterval(() => {
        warmCountdown -= 1;
        if (warmCountdown <= 0) {
          clearInterval(warmTimer);
          warmTimer = null;
          state.warming = false;
          state.warmed = true;
          toast('Sensor térmico listo');
        }
        update();
      }, 1000);
      toast('Calentando sonda de hilo caliente…');
    } else toast('Equipo encendido');
    update();
  }

  function startStop() {
    if (!state.powered) return toast('Enciende primero el equipo');
    if (!state.warmed) return toast(`Espera el calentamiento: ${warmCountdown || 1} s`);
    if (state.running) {
      stopMeasurement();
      toast('Medición detenida');
      update();
      return;
    }
    resetRunData();
    state.running = true;
    state.startAt = performance.now();
    sample();
    sampleTimer = setInterval(sample, 500);
    toast('Medición iniciada');
    update();
  }

  function stopMeasurement() {
    clearInterval(sampleTimer);
    sampleTimer = null;
    state.running = false;
  }

  function sample() {
    if (!state.running) return;
    const v = simulatedVelocity();
    state.current = v;
    state.samples.push(v);
    if (state.samples.length > 1200) state.samples.shift();
    state.min = state.min == null ? v : Math.min(state.min, v);
    state.max = state.max == null ? v : Math.max(state.max, v);
    state.temp = scenarios[state.scenario].temp + (Math.random()-.5)*.18;
    state.elapsed = (performance.now() - state.startAt)/1000;
    calcStats();
    state.trend.push(v);
    if (state.trend.length > 100) state.trend.shift();
    update(false);
  }

  function currentForDisplay() {
    if (state.hold && Number.isFinite(state.holdValue)) return state.holdValue;
    if (state.displayMode === 'max') return state.max;
    if (state.displayMode === 'min') return state.min;
    if (state.displayMode === 'avg') return state.avg;
    return state.current;
  }

  function toggleHold() {
    if (!state.running && !Number.isFinite(state.current)) return toast('Inicia una medición primero');
    state.hold = !state.hold;
    state.holdValue = state.hold ? currentForDisplay() : null;
    toast(state.hold ? 'Lectura retenida' : 'HOLD liberado');
    update();
  }

  function cycleDisplay() {
    const order = ['live','max','min','avg'];
    state.displayMode = order[(order.indexOf(state.displayMode)+1)%order.length];
    state.hold = false;
    update();
  }

  function cycleUnit() {
    const order = ['ms','fpm','kmh'];
    state.unit = order[(order.indexOf(state.unit)+1)%order.length];
    $('unitSelect').value = state.unit;
    update();
  }

  function flowRate() {
    if (!Number.isFinite(state.avg) || state.mode === 'pitot') return null;
    const area = Math.max(.0001, (Number($('areaWidth').value)||0) * (Number($('areaHeight').value)||0));
    return state.avg * area * 3600;
  }

  function qualityFlags() {
    const flags = [];
    flags.push({ok:state.powered, text:state.powered?'Equipo encendido':'Equipo apagado'});
    if (state.mode === 'hotwire') flags.push({ok:state.warmed, text:state.warmed?'Sonda térmica estabilizada':'Sonda térmica aún no lista'});
    flags.push({ok:state.orientation===0, text:state.orientation===0?'Sonda alineada con el flujo':`Orientación ${state.orientation}°: posible subestimación`});
    if (state.mode === 'vane') {
      const ref = state.current ?? scenarios[state.scenario].base;
      flags.push({ok:ref>=.4, text:ref>=.4?'Velocidad compatible con VANE':'Velocidad baja para el rango de la hélice'});
    }
    flags.push({ok:state.samples.length>=10, text:state.samples.length>=10?'Varias muestras acumuladas':'Período de medición todavía corto'});
    return flags;
  }

  function qualitySummary() {
    const bad = qualityFlags().filter(f=>!f.ok).length;
    return bad === 0 ? 'Correcta' : bad <= 2 ? 'Revisar' : 'Deficiente';
  }

  function renderQuality() {
    $('qualityFlags').innerHTML = qualityFlags().map(f=>`<div class="flag ${f.ok?'ok':'warn'}"><b>${f.ok?'✓':'!'}</b><span>${f.text}</span></div>`).join('');
  }

  function updateLesson() {
    let kicker = 'SELECCIÓN DE SONDA';
    let title = 'No todos los anemómetros sirven igual';
    let text = 'HOT WIRE es preferible para bajas velocidades; VANE para corrientes definidas; PITOT para ductos.';
    if (state.powered && !state.warmed) {
      kicker='CALENTAMIENTO'; title='La sonda térmica necesita estabilizarse'; text=`Espera ${warmCountdown || 1} s antes de iniciar la práctica.`;
    } else if (state.orientation !== 0) {
      kicker='ORIENTACIÓN'; title='Alinea la sonda con el flujo'; text='Una sonda direccional mal orientada puede subestimar la velocidad. Corrige el ángulo antes de registrar.';
    } else if (state.running && state.samples.length < 10) {
      kicker='TIEMPO DE MEDICIÓN'; title='No interpretes una sola lectura'; text='La velocidad del aire fluctúa. Deja acumular muestras antes de interpretar media, SD y TU.';
    } else if (state.running && Number.isFinite(state.tu)) {
      kicker='TURBULENCIA'; title='Promedio y variabilidad cuentan historias distintas'; text=`Media ${state.avg.toFixed(2)} m/s · TU ${state.tu.toFixed(1)}%.`;
    } else if (Object.keys(state.heights).length) {
      kicker='PERFIL VERTICAL'; title='Compara cabeza, abdomen y tobillos'; text='Diferencias relevantes entre alturas sugieren un ambiente heterogéneo alrededor de la persona.';
    }
    $('lessonKicker').textContent = kicker;
    $('lessonTitle').textContent = title;
    $('lessonText').textContent = text;
    $('formulaResult').textContent = Number.isFinite(state.tu) ? `SD ${state.sd.toFixed(3)} m/s · v̄ ${state.avg.toFixed(3)} m/s · TU ${state.tu.toFixed(1)}%` : '—';
  }

  function updateHeightOptions() {
    const labels = heightLabels[state.posture];
    $('heightSelect').innerHTML = Object.entries(labels).map(([k,v])=>`<option value="${k}">${v}</option>`).join('');
    if (!labels[state.height]) state.height = 'abdomen';
    $('heightSelect').value = state.height;
    renderHeightResults();
  }

  function recordHeight() {
    const v = Number.isFinite(state.avg) ? state.avg : state.current;
    if (!Number.isFinite(v)) return toast('Realiza una medición primero');
    state.heights[state.height] = v;
    renderHeightResults();
    toast(`${heightLabels[state.posture][state.height]} registrado`);
  }

  function renderHeightResults() {
    const labels = heightLabels[state.posture];
    $('heightResults').innerHTML = Object.keys(labels).map(k=>`<div><span>${labels[k]}</span><b>${Number.isFinite(state.heights[k]) ? state.heights[k].toFixed(2)+' m/s' : '—'}</b></div>`).join('');
  }

  function addPoint() {
    const v = Number.isFinite(state.avg) ? state.avg : state.current;
    if (!Number.isFinite(v)) return toast('Realiza una medición primero');
    state.points.push(v);
    renderPoints();
    toast('Lectura agregada al promedio multipunto');
  }

  function renderPoints() {
    const avg = state.points.length ? state.points.reduce((a,b)=>a+b,0)/state.points.length : null;
    let html = state.points.map((v,i)=>`<div><span>P${i+1}</span><b>${v.toFixed(2)} m/s</b></div>`).join('');
    if (!html) html = '<p class="note">Sin puntos registrados.</p>';
    if (Number.isFinite(avg)) html += `<div class="point-avg"><span>Promedio espacial</span><b>${avg.toFixed(2)} m/s</b></div>`;
    $('pointList').innerHTML = html;
  }

  function renderTrend() {
    const arr = state.trend;
    if (!arr.length) { $('trendLine').setAttribute('points',''); return; }
    const max = Math.max(...arr, .2);
    const pts = arr.map((v,i)=>`${i/Math.max(1,arr.length-1)*900},${245-(v/max)*220}`).join(' ');
    $('trendLine').setAttribute('points', pts);
  }

  function ductArea() {
    const a = Number($('ductA').value) || .5;
    const b = Number($('ductB').value) || .4;
    return $('ductShape').value === 'round' ? Math.PI*a*a/4 : a*b;
  }

  function generatePitot() {
    if (state.mode !== 'pitot') {
      state.mode = 'pitot';
      stopMeasurement();
      state.powered = state.warmed = state.warming = false;
      updateModeUI();
    }
    const count = $('ductShape').value === 'round' ? 12 : 25;
    state.pitot = Array.from({length:count},(_,i)=>({i,dp:null,v:null}));
    renderPitot();
    toast(`${count} puntos generados`);
  }

  function recordPitot(i) {
    const rho = Number($('airDensity').value) || 1.2;
    const base = scenarios[state.scenario].base;
    const n = state.pitot.length;
    const pos = (i+.5)/n;
    const profile = .45 + .65*Math.sin(Math.PI*pos);
    const v = Math.max(.05, base*profile*(.96+Math.random()*.08));
    const dp = .5*rho*v*v;
    state.pitot[i] = {i,dp,v};
    renderPitot();
  }

  function renderPitot() {
    const grid = $('pitotGrid');
    if (!state.pitot.length) {
      grid.innerHTML=''; $('pitotSummary').textContent='Sin recorrido generado.'; return;
    }
    grid.innerHTML = state.pitot.map(p=>`<button class="${Number.isFinite(p.v)?'done':''}" data-pitot="${p.i}"><span>P${p.i+1}</span><b>${Number.isFinite(p.dp)?p.dp.toFixed(1)+' Pa':'Δp'}</b><small>${Number.isFinite(p.v)?p.v.toFixed(2)+' m/s':'pendiente'}</small></button>`).join('');
    $$('[data-pitot]').forEach(btn=>btn.addEventListener('click',()=>recordPitot(Number(btn.dataset.pitot))));
    const vals = state.pitot.map(p=>p.v).filter(Number.isFinite);
    if (!vals.length) { $('pitotSummary').textContent = `0/${state.pitot.length} puntos medidos.`; return; }
    const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
    const q = avg*ductArea()*3600;
    $('pitotSummary').innerHTML = `<b>${vals.length}/${state.pitot.length} puntos</b> · v̄ ${avg.toFixed(2)} m/s · Q ${Math.round(q).toLocaleString('es-ES')} m³/h`;
  }

  function renderMemory() {
    if (!state.memory.length) { $('memoryList').innerHTML = '<p class="note">No hay prácticas guardadas.</p>'; return; }
    $('memoryList').innerHTML = state.memory.map((m,i)=>`<article><div><b>${m.mode}</b><span>${m.scenario}</span></div><div><strong>${m.avg}</strong><small>${m.date}</small></div><button data-delmem="${i}" aria-label="Eliminar">×</button></article>`).join('');
    $$('[data-delmem]').forEach(b=>b.addEventListener('click',()=>{state.memory.splice(Number(b.dataset.delmem),1);persistMemory();renderMemory();}));
  }

  function savePractice() {
    if (!Number.isFinite(state.avg)) return toast('Completa una medición antes de guardar');
    state.memory.unshift({
      date:new Date().toLocaleString('es-ES'),
      mode:modes[state.mode].title,
      scenario:scenarios[state.scenario].label,
      avg:`${state.avg.toFixed(2)} m/s`,
      tu:Number.isFinite(state.tu)?`${state.tu.toFixed(1)}%`:'—'
    });
    persistMemory(); renderMemory(); toast('Práctica guardada en este dispositivo');
  }

  function switchTab(name) {
    $$('.tabs button').forEach(b=>b.classList.toggle('active',b.dataset.tab===name));
    ['trend','multipoint','pitot','memory'].forEach(n=>{ const p=$(n+'Pane'); if(p) p.hidden = n!==name; });
  }

  function updateModeUI() {
    const m = modes[state.mode];
    $('modeTitle').textContent = m.title;
    $('probeBadge').textContent = m.badge;
    $('screenMode').textContent = state.mode==='hotwire'?'HOT':state.mode==='vane'?'VANE':'PIT';
    $('probeVisual').className = `probe ${state.mode}`;
    $('pitotBox').hidden = state.mode !== 'pitot';
    $('flowAreaBox').hidden = state.mode === 'pitot';
    $$('.mode-card').forEach(b=>b.classList.toggle('active',b.dataset.mode===state.mode));
    if (state.mode === 'pitot') switchTab('pitot');
    update();
  }

  function updateGuide() {
    let step=1,title='Selecciona el modo',text='Para velocidad ambiental baja, comienza con HOT WIRE.',target='.mode-cards';
    if (state.mode) { step=2; title='Selecciona escenario y altura'; text='Define el lugar, postura y altura de evaluación.'; target='#scenarioSelect'; }
    if (state.powered) { step=3; title=state.warmed?'Equipo listo':'Espera la estabilización'; text=state.warmed?'Verifica orientación antes de medir.':'La sonda térmica está calentando.'; target='#screen'; }
    if (state.powered && state.warmed && state.orientation===0) { step=4; title='Inicia la medición'; text='Pulsa START y deja acumular muestras.'; target='#runBtn'; }
    if (state.samples.length>=10) { step=5; title='Interpreta AVG, SD y TU'; text='Compara el promedio con la variabilidad temporal.'; target='#formulaResult'; }
    if (Object.keys(state.heights).length>=2) { step=6; title='Compara alturas'; text='Completa cabeza, abdomen y tobillos.'; target='#heightResults'; }
    if (Object.keys(state.heights).length>=3 || state.points.length>=3 || state.pitot.filter(p=>Number.isFinite(p.v)).length>=3) { step=7; title='Práctica avanzada'; text='Guarda resultados o completa el recorrido multipunto/Pitot.'; target='#advancedPanel'; }
    $('guideStep').textContent=`Paso ${step} de 7`;
    $('guidePct').textContent=`${Math.round(step/7*100)}%`;
    $('guideBar').style.width=`${step/7*100}%`;
    $('guideTitle').textContent=title;
    $('guideText').textContent=text;
    $('guideLocate').dataset.target=target;
  }

  function update(full=true) {
    $('screen').classList.toggle('off', !state.powered);
    $('screenStatus').textContent = !state.powered?'OFF':state.warming?`WARM ${warmCountdown}s`:state.hold?'HOLD':state.running?state.displayMode.toUpperCase():'READY';
    $('mainReading').textContent = formatValue(currentForDisplay());
    $('mainUnit').textContent = unitInfo().label;
    $('avgReading').textContent = formatValue(state.avg);
    $('maxReading').textContent = formatValue(state.max);
    $('minReading').textContent = formatValue(state.min);
    $('sdReading').textContent = formatValue(state.sd);
    $('tuReading').textContent = Number.isFinite(state.tu)?`${state.tu.toFixed(1)}%`:'----';
    $('tempReading').textContent = `${state.temp.toFixed(1)} °C`;
    $('timerReading').textContent = fmtTime(state.elapsed);
    $('sampleCount').textContent = state.samples.length;
    const q=flowRate(); $('flowReading').textContent = Number.isFinite(q)?`${Math.round(q).toLocaleString('es-ES')} m³/h`:'----';
    $('qualityState').textContent = qualitySummary();
    $('runBtn').classList.toggle('active',state.running);
    $('mobileRun').classList.toggle('active',state.running);
    $('mobileRun').querySelector('span').textContent = state.running?'Parar':'Medir';
    renderQuality(); updateLesson(); updateGuide(); renderTrend();
    if (full) { renderHeightResults(); renderPoints(); renderMemory(); renderPitot(); }
  }

  function onModeChange(mode) {
    if (!modes[mode]) return;
    stopMeasurement();
    clearInterval(warmTimer); warmTimer=null;
    state.mode=mode; state.powered=state.warmed=state.warming=false; warmCountdown=0;
    resetRunData();
    updateModeUI();
  }

  function bind() {
    $$('.mode-card').forEach(b=>b.addEventListener('click',()=>onModeChange(b.dataset.mode)));
    $('scenarioSelect').addEventListener('change',e=>{state.scenario=e.target.value;state.temp=scenarios[state.scenario].temp;update();});
    $('postureSelect').addEventListener('change',e=>{state.posture=e.target.value;state.heights={};updateHeightOptions();update();});
    $('heightSelect').addEventListener('change',e=>{state.height=e.target.value;update();});
    $('orientationSelect').addEventListener('change',e=>{state.orientation=Number(e.target.value);update();});
    $('unitSelect').addEventListener('change',e=>{state.unit=e.target.value;update();});
    ['areaWidth','areaHeight','ductA','ductB','airDensity','ductShape'].forEach(id=>$(id).addEventListener('change',()=>update()));

    $('powerBtn').addEventListener('click',powerToggle);
    $('runBtn').addEventListener('click',startStop);
    $('mobileRun').addEventListener('click',startStop);
    $('holdBtn').addEventListener('click',toggleHold);
    $('modeBtn').addEventListener('click',cycleDisplay);
    $('avgBtn').addEventListener('click',()=>{state.displayMode='avg';state.hold=false;update();toast('Mostrando promedio temporal');});
    $('unitBtn').addEventListener('click',cycleUnit);
    $('recordHeightBtn').addEventListener('click',recordHeight);
    $('addPointBtn').addEventListener('click',addPoint);
    $('generatePitotBtn').addEventListener('click',generatePitot);
    $('resetTrend').addEventListener('click',()=>{state.trend=[];renderTrend();});
    $('savePractice').addEventListener('click',savePractice);
    $('clearMemory').addEventListener('click',()=>{state.memory=[];persistMemory();renderMemory();toast('Memoria vaciada');});

    $$('.tabs button').forEach(b=>b.addEventListener('click',()=>switchTab(b.dataset.tab)));
    $('manualBtn').addEventListener('click',()=>$('manualDialog').showModal());
    $('guideLocate').addEventListener('click',()=>{const el=document.querySelector($('guideLocate').dataset.target);if(el){el.scrollIntoView({behavior:'smooth',block:'center'});el.classList.add('pulse-focus');setTimeout(()=>el.classList.remove('pulse-focus'),1400);}});
    $$('.mobile-dock [data-mobile]').forEach(b=>b.addEventListener('click',()=>{
      const map={setup:'.setup-panel',meter:'.instrument-panel',learn:'.learning-panel'};
      document.querySelector(map[b.dataset.mobile])?.scrollIntoView({behavior:'smooth',block:'start'});
    }));
  }

  function init() {
    updateHeightOptions();
    bind();
    renderPoints(); renderMemory(); renderPitot();
    updateModeUI();
  }

  init();
})();
