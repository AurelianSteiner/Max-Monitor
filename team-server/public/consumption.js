'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const names={newsletter:'Pre-Gen',correction:'Korrektur',translation:'Übersetzung',upload:'Klaviyo-Upload',sales:'Sales',other:'Sonstige Aufgaben'};
  const numeric=new Intl.NumberFormat('de-DE',{maximumFractionDigits:1,minimumFractionDigits:1});
  const percent=new Intl.NumberFormat('de-DE',{maximumFractionDigits:0});
  const date=new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Berlin'});
  let data=null, request=null, busy=false, dirty=false, saving=false, generation=0, draftRevision=null;
  let distributionKind='newsletter';
  function node(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function status(text,error=false){$('effort-status').textContent=text;$('effort-status').dataset.error=String(error);}
  function average(metric){return metric?.mean==null?'—':`≈ ${numeric.format(metric.mean)}`;}
  function drawDistribution(){
    const view=data?.distribution?.by_kind?.[distributionKind];
    const unavailable=!view||view.mode==='unavailable';
    const rows=view?.rows||[];
    const preferred=rows.filter(r=>r.preferred);
    $('distribution-preferred').textContent=preferred.length?`${preferred.length>1?'Gleichrangig bevorzugt':'Aktuell bevorzugt'}: ${preferred.map(r=>r.name).join(', ')}`:unavailable?'Aktuell keine verlässliche Präferenz':'Aktuell kein Mac startbereit';
    const body=$('distribution-body');body.replaceChildren();
    for(const row of rows){
      const tr=node('tr',row.preferred?'distribution-preferred':'');
      const mac=node('th');mac.scope='row';
      mac.append(node('span','',row.name),node('span','distribution-detail',row.preferred?'Bevorzugt':row.reason?'Derzeit ausgeschlossen':'Alternative'));tr.append(mac);
      for(const [name,label] of [['five_hour','5 h frei'],['seven_day','Woche frei']]){
        const w=row.windows[name];const cell=node('td');cell.dataset.label=label;
        const content=node('div');const value=node('span','distribution-number',w.remaining===null?'Unbekannt':`${percent.format(w.remaining)} %`);
        if(w.at)value.title=`Gemessen ${date.format(new Date(w.at*1000))} · Berlin`;content.append(value);
        content.append(node('span','distribution-detail',w.reset?`Reset ${date.format(new Date(w.reset*1000))}`:name==='five_hour'&&w.fresh?'Fenster noch nicht gestartet':'Reset unbekannt'));
        if(!w.fresh)content.append(node('span','distribution-warning',w.remaining===null?'Keine Messung':'Veraltet'));
        cell.append(content);tr.append(cell);
      }
      const load=node('td');load.dataset.label='Auslastung';
      const count=node('div');count.append(node('span','distribution-number',row.load===null||row.cap===null?'Unbekannt':`${row.load} / ${row.cap} Plätze`));
      if(row.cap>0&&row.load!==null){const meter=node('meter','distribution-meter');meter.min=0;meter.max=row.cap;meter.value=row.load;meter.setAttribute('aria-label',`${row.name}: ${row.load} von ${row.cap} Plätzen belegt`);count.append(meter);}
      load.append(count);tr.append(load);body.append(tr);
    }
  }
  function drawRows(){
    const summary=data?.summary;
    const account=$('consumption-account').value;
    const rows=account?(summary?.by_account_kind||[]).filter(r=>r.key.startsWith(account+'|')).map(r=>({...r,key:r.key.slice(account.length+1)})):summary?.by_kind||[];
    const body=$('consumption-body');body.replaceChildren();
    for(const kind of Object.keys(names)){
      const row=rows.find(r=>r.key===kind)||{closed:0,weekly_pp:{n:0},five_hour_pp:{n:0},pending:0};
      const tr=node('tr');
      const title=node('th','',names[kind]);title.scope='row';tr.append(title);
      [String(row.closed),average(row.five_hour_pp),average(row.weekly_pp),`${row.five_hour_pp?.n||0} / ${row.weekly_pp?.n||0}`,String(row.pending||0)].forEach((text,i)=>{
        const cell=node('td','num',text);cell.dataset.label=['Abgeschlossen','Ø 5 h (Punkte)','Ø Woche (Punkte)','Auswertbar 5 h / Woche','Messung offen'][i];tr.append(cell);
      });
      body.append(tr);
    }
    $('consumption-empty').hidden=Boolean(summary?.closed);
    $('consumption-totals').textContent=summary?`${summary.closed} abgeschlossen`:'Erfassung wird geladen…';
  }
  function draw(){
    window.MaxMonitorPlanning?.update(data, request);
    const summary=data?.summary;
    $('consumption-error').hidden=!data?.error;
    $('consumption-error').textContent=data?.error||'';
    const generated=Date.parse(summary?.generated_at);
    $('consumption-updated').textContent=Number.isFinite(generated)
      ?`Stand ${date.format(new Date(generated))}${data?.stale?' · wird automatisch aktualisiert':''}`:'Noch keine Meldung';
    const settings=summary?.settings||[];
    const fresh=settings.filter(s=>Date.now()-Date.parse(s.at)<180000);
    const body=$('effort-body');
    if(!dirty && !saving){
      body.replaceChildren();
      for(const [phase,label] of Object.entries(data?.phases||{})){
        const row=node('tr');if(phase.startsWith('sales')||phase==='filing')row.className='effort-secondary';const th=node('th','',label);th.scope='row';row.append(th);
        const observed=[...new Set(fresh.map(s=>s.values[phase]).filter(Boolean))];
        const observedCell=node('td','effort-observed',observed.length?observed.join(' / '):'Noch keine Meldung');observedCell.dataset.label='Auf den Macs bereit';row.append(observedCell);
        const cell=node('td');const select=node('select','effort-select');select.name=phase;select.setAttribute('aria-label',`${label}: zentraler Aufwand`);
        const inherit=node('option','','Bestehende Einstellung');inherit.value='';select.append(inherit);
        for(const level of data.levels){const option=node('option','',level);option.value=level;select.append(option);}
        select.value=data.policy.phases[phase]||'';select.disabled=!data.canManage;select.addEventListener('change',()=>{if(!dirty)draftRevision=data.policy.revision;dirty=true;$('effort-discard').hidden=false;status('Änderungen noch nicht gespeichert.');});
        cell.dataset.label='Zentraler Sollwert';cell.append(select);row.append(cell);body.append(row);
      }
    }
    $('effort-save').hidden=!data?.canManage;
    $('effort-discard').hidden=!dirty;
    $('effort-discard').disabled=saving;
    body.querySelectorAll('select').forEach(select=>{select.disabled=saving||!data?.canManage;});
    $('effort-save').disabled=saving;
    $('effort-save').textContent=saving?'Wird gespeichert…':'Aufwand zentral speichern';
    const account=$('consumption-account');const previous=account.value;
    const accounts=[...new Set((summary?.by_account_kind||[]).map(r=>r.key.split('|')[0]))];
    for(const setting of settings){const email=(summary?.accounts||[]).find(a=>a.worker===setting.worker)?.account;if(email)accounts.push(email);}
    account.replaceChildren(node('option','','Alle Accounts'));
    account.firstChild.value='';
    for(const email of [...new Set(accounts)].sort()){const option=node('option','',email);option.value=email;account.append(option);}
    account.value=accounts.includes(previous)?previous:'';
    drawRows();
    drawDistribution();
  }
  async function refresh(fetcher){
    if(fetcher)request=fetcher;
    if(!request||busy)return;
    const epoch=generation;
    busy=true;
    try {const result=await request('/consumption');if(epoch===generation){data=result;draw();}}
    catch(e){if(epoch===generation){if(data)data.distribution=null;window.MaxMonitorPlanning?.invalidate();drawDistribution();$('consumption-error').hidden=false;$('consumption-error').textContent=`Verbrauch & Aufwand konnten nicht geladen werden: ${e.message}`;}}
    finally{if(epoch===generation)busy=false;}
  }
  $('consumption-account').addEventListener('change',drawRows);
  function selectTabs(list, selected){
    for(const tab of list.querySelectorAll('[role="tab"]')){
      const active=tab===selected;
      tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;
    }
  }
  function bindTabs(list, choose){
    const tabs=[...list.querySelectorAll('[role="tab"]')];
    for(const tab of tabs){
      tab.addEventListener('click',()=>choose(tab));
      tab.addEventListener('keydown',event=>{
        const index=tabs.indexOf(tab);
        const next={ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[event.key];
        if(next===undefined)return;
        event.preventDefault();choose(tabs[next]);tabs[next].focus();
      });
    }
  }
  function rememberTab(name,value){
    const url=new URL(location.href);url.searchParams.set(name,value);history.replaceState(null,'',url);
  }
  const usageTabs=document.querySelector('.consumption-tabs');
  const kindTabs=document.querySelector('.distribution-tabs');
  function selectUsage(tab,persist=true){
    selectTabs(usageTabs,tab);
    for(const item of usageTabs.querySelectorAll('[role="tab"]'))$(item.getAttribute('aria-controls')).hidden=item!==tab;
    if(persist)rememberTab('usage-tab',tab.dataset.usageTab);
  }
  function selectKind(tab,persist=true){
    selectTabs(kindTabs,tab);distributionKind=tab.dataset.distributionKind;
    $('distribution-content').setAttribute('aria-labelledby',tab.id);
    if(persist)rememberTab('distribution',distributionKind);
    drawDistribution();
  }
  bindTabs(usageTabs,selectUsage);bindTabs(kindTabs,selectKind);
  const params=new URL(location.href).searchParams;
  selectUsage([...usageTabs.querySelectorAll('[role="tab"]')].find(t=>t.dataset.usageTab===params.get('usage-tab'))||$('usage-next-tab'),false);
  selectKind([...kindTabs.querySelectorAll('[role="tab"]')].find(t=>t.dataset.distributionKind===params.get('distribution'))||$('distribution-newsletter'),false);
  $('consumption-retry').addEventListener('click',()=>refresh());
  $('effort-discard').addEventListener('click',()=>{dirty=false;draftRevision=null;status('');draw();refresh();});
  $('effort-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!request||saving||!data?.canManage)return;
    const phases=Object.fromEntries([...$('effort-body').querySelectorAll('select')].filter(s=>s.value).map(s=>[s.name,s.value]));
    const epoch=generation;
    saving=true;$('effort-save').disabled=true;status('Aufwand wird gespeichert…');
    try{const result=await request('/effort','PATCH',{revision:draftRevision??data.policy.revision,phases});if(epoch!==generation)return;data.policy=result.policy;dirty=false;draftRevision=null;status('Gespeichert.');}
    catch(e){if(epoch===generation)status(e.message,true);}
    finally{if(epoch===generation){saving=false;draw();}}
  });
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  window.MaxMonitorConsumption={refresh,reset(){generation++;window.MaxMonitorPlanning?.reset();data=null;request=null;dirty=false;draftRevision=null;busy=false;saving=false;status('');$('effort-body').replaceChildren();$('effort-save').hidden=true;$('effort-discard').hidden=true;$('consumption-error').hidden=true;$('consumption-updated').textContent='Noch keine Meldung';$('consumption-account').replaceChildren(node('option','','Alle Accounts'));drawRows();drawDistribution();}};
})();
