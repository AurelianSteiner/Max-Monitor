'use strict';
(() => {
  const $=id=>document.getElementById(id);
  const names={newsletter:'Pre-Gen',correction:'Korrektur',translation:'Übersetzung',upload:'Klaviyo-Upload',sales:'Sales',other:'Sonstige Aufgaben'};
  const numeric=new Intl.NumberFormat('de-DE',{maximumFractionDigits:1,minimumFractionDigits:1});
  const percent=new Intl.NumberFormat('de-DE',{maximumFractionDigits:0});
  const date=new Intl.DateTimeFormat('de-DE',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Berlin'});
  let data=null, request=null, busy=false, dirty=false, saving=false, generation=0, draftRevision=null;
  function node(tag,cls,text){const e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
  function status(text,error=false){$('effort-status').textContent=text;$('effort-status').dataset.error=String(error);}
  function average(metric){return metric?.mean==null?'—':`≈ ${numeric.format(metric.mean)} PP`;}
  function drawDistribution(){
    const kind=$('distribution-kind').value;
    const view=data?.distribution?.by_kind?.[kind];
    const rows=view?.rows||[];
    const preferred=rows.filter(r=>r.preferred);
    const reasons={unavailable:'Verteilungsdaten fehlen oder sind veraltet',stale_worker:'Keine frische Aufgabenabfrage',not_accepting:'Nimmt derzeit keine Aufgaben an',missing_slots:'Platzmeldung unvollständig',full:'Alle Plätze belegt',kind_full:'Kein freier Platz für diese Aufgabenart',quota:'Kontingent reicht mit Puffer nicht aus'};
    $('distribution-preferred').textContent=preferred.length?`${preferred.length>1?'Gleichrangig bevorzugt':'Aktuell bevorzugt'}: ${preferred.map(r=>r.name).join(', ')}`:view?.mode==='unavailable'?'Aktuell keine verlässliche Präferenz':'Aktuell kein Mac startbereit';
    $('distribution-explanation').textContent=view?.mode==='unavailable'?'Die aktuelle Verteilung kann noch nicht berechnet werden. Die Ansicht aktualisiert sich automatisch.':!preferred.length?'Die Gründe je Mac zeigen, was einen neuen Start derzeit verhindert.':view?.mode==='quota'?'Reset-Nähe, verbleibendes Kontingent und freie Plätze bestimmen die Präferenz für '+names[kind]+'.':'Keine aktuellen Kontingentwerte verfügbar. Die belegten Plätze bestimmen die Präferenz.';
    const body=$('distribution-body');body.replaceChildren();
    for(const row of rows){
      const tr=node('tr',row.preferred?'distribution-preferred':'');
      const mac=node('th');mac.scope='row';mac.append(node('span','',row.name),node('small','distribution-detail',row.preferred?'Bevorzugt':row.reason?'Derzeit ausgeschlossen':'Alternative'));tr.append(mac);
      for(const [name,label] of [['five_hour','5 h frei / Reset'],['seven_day','Woche frei / Reset']]){
        const w=row.windows[name];const cell=node('td');cell.dataset.label=label;
        const content=node('div');const value=node('span','distribution-number',w.remaining===null?'Unbekannt':`${percent.format(w.remaining)} % frei`);if(w.at)value.title=`Gemessen ${date.format(new Date(w.at*1000))} · Berlin`;content.append(value);
        content.append(node('small','distribution-detail',w.reset?`Reset ${date.format(new Date(w.reset*1000))}`:name==='five_hour'&&w.fresh?'Fenster startet bei Nutzung':'Reset unbekannt'));
        if(!w.fresh)content.append(node('small','distribution-warning',w.remaining===null?'Keine Kontingentmessung':'Veraltet · nicht gewertet'));
        if(w.fresh&&w.remaining_pp<w.remaining-.05)content.append(node('small','distribution-detail',`≈ ${numeric.format(w.remaining_pp)} PP nach laufenden Aufgaben`));
        cell.append(content);tr.append(cell);
      }
      const load=node('td');load.dataset.label='Auslastung';
      const count=node('div');count.append(node('span','distribution-number',row.load===null||row.cap===null?'Unbekannt':`${row.load} / ${row.cap} Plätze`));
      if(row.cap>0&&row.load!==null){const meter=node('meter','distribution-meter');meter.min=0;meter.max=row.cap;meter.value=row.load;meter.setAttribute('aria-label',`${row.name}: ${row.load} von ${row.cap} Plätzen belegt`);count.append(meter);}
      load.append(count);tr.append(load);
      const reason=node('td','distribution-reason');reason.dataset.label='Warum?';
      const details=[];
      if(row.reason)details.push(reasons[row.reason]);
      else if(row.budget_per_hour!==null)details.push(`${numeric.format(row.budget_per_hour)} PP Wochenbudget je Stunde bis zum Ziel`);
      else details.push(view.mode==='load'?'Verteilung nach belegten Plätzen':'Wochenbudget unbekannt · neutral gewertet');
      if(!row.reason){
        if(!row.windows.five_hour.fresh)details.push('5-Stunden-Budget unbekannt · neutral gewertet');
        const measured=Object.values(row.windows).filter(w=>w.fresh&&w.n>=3);
        details.push(measured.length?'Aufgabenbedarf aus gemessenen Durchschnittswerten berücksichtigt':'Aufgabenbedarf noch nicht belastbar gemessen');
      }
      for(const detail of details)reason.append(node('span','distribution-detail',detail));
      tr.append(reason);body.append(tr);
    }
    $('distribution-updated').textContent=data?.distribution?.source_at?`Berechnungsgrundlage: ${date.format(new Date(data.distribution.source_at))} · Berlin. Belegung umfasst laufende und reservierte Aufgaben aller Arten.`:'Noch keine Berechnungsgrundlage vom RS Hub.';
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
        const cell=node('td','num',text);cell.dataset.label=['Abgeschlossen','Ø 5 h','Ø Woche','Auswertbar 5 h / Woche','Messung offen'][i];tr.append(cell);
      });
      body.append(tr);
    }
    $('consumption-empty').hidden=Boolean(summary?.closed);
    $('consumption-totals').textContent=summary?`${summary.tracked} erfasst · ${summary.closed} abgeschlossen seit Start${summary.carryover?` · ${summary.carryover} ältere Überhänge getrennt`:''}`:'Erfassung wird geladen…';
  }
  function draw(){
    const summary=data?.summary;
    $('consumption-error').hidden=!data?.error && !data?.stale;
    $('consumption-error').textContent=data?.error||'Die Verbrauchsmeldung ist veraltet. Prüfe die Erfassung auf dem RS Hub und aktualisiere erneut.';
    $('consumption-since').textContent=summary?`Tracking seit ${date.format(new Date(summary.tracking_since))} · Berlin`:'Tracking-Start wird geladen…';
    $('consumption-updated').textContent=summary?`Stand ${date.format(new Date(summary.generated_at))}`:'Noch keine Meldung';
    const settings=summary?.settings||[];
    const fresh=settings.filter(s=>Date.now()-Date.parse(s.at)<180000);
    const ready=fresh.filter(s=>s.values.policy_supported==='True' && Number(s.values.policy_revision)===data.policy.revision);
    $('effort-adoption').textContent=`${ready.length} / ${settings.length} Macs bereit · neue Phasenstarts`;
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
    account.replaceChildren(node('option','','Alle Accounts · beschreibender Durchschnitt'));
    account.firstChild.value='';
    for(const email of [...new Set(accounts)].sort()){const option=node('option','',email);option.value=email;account.append(option);}
    account.value=accounts.includes(previous)?previous:'';
    drawRows();
    drawDistribution();
    const collectors=summary?.collectors||[];
    $('consumption-health').textContent=`Erfassung ${collectors.filter(c=>Date.now()/1000-c.last_seen<180 && !c.errors).length} / ${settings.length} Macs aktuell · ${numeric.format((summary?.compact_bytes||0)/1024)} KB komprimierte Aufgabenwerte · Rohdaten höchstens ${summary?.raw_retention_days||2} Tage, vollständige Aufgaben nach 30 min verdichtet`;
    const list=$('effort-macs');list.replaceChildren();
    for(const setting of settings){const ready=setting.values.policy_supported==='True' && Number(setting.values.policy_revision)===data.policy.revision && Date.now()-Date.parse(setting.at)<180000;
      const item=node('li','',`${setting.values.mac_name||setting.worker} · ${ready?'bereit':'Übernahme ausstehend'} · ${date.format(new Date(setting.at))}`);list.append(item);}
  }
  async function refresh(fetcher){
    if(fetcher)request=fetcher;
    if(!request||busy)return;
    const epoch=generation;
    busy=true;
    try {const result=await request('/consumption');if(epoch===generation){data=result;draw();}}
    catch(e){if(epoch===generation){if(data)data.distribution=null;drawDistribution();$('consumption-error').hidden=false;$('consumption-error').textContent=`Verbrauch & Aufwand konnten nicht geladen werden: ${e.message}`;}}
    finally{if(epoch===generation)busy=false;}
  }
  $('consumption-account').addEventListener('change',drawRows);
  const distributionKind=new URL(location.href).searchParams.get('distribution');
  if(['newsletter','correction','translation','upload'].includes(distributionKind))$('distribution-kind').value=distributionKind;
  $('distribution-kind').addEventListener('change',()=>{const url=new URL(location.href);url.searchParams.set('distribution',$('distribution-kind').value);history.replaceState(null,'',url);drawDistribution();});
  $('effort-more').addEventListener('click',()=>{
    const expanded=$('effort-form').classList.toggle('all-phases');$('effort-more').setAttribute('aria-expanded',String(expanded));
    $('effort-more').textContent=expanded?'Weniger Phasen anzeigen':'Sales & Kundenablage anzeigen';
  });
  $('consumption-retry').addEventListener('click',()=>refresh());
  $('effort-discard').addEventListener('click',()=>{dirty=false;draftRevision=null;status('');draw();refresh();});
  $('effort-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!request||saving||!data?.canManage)return;
    const phases=Object.fromEntries([...$('effort-body').querySelectorAll('select')].filter(s=>s.value).map(s=>[s.name,s.value]));
    const epoch=generation;
    saving=true;$('effort-save').disabled=true;status('Aufwand wird gespeichert…');
    try{const result=await request('/effort','PATCH',{revision:draftRevision??data.policy.revision,phases});if(epoch!==generation)return;data.policy=result.policy;dirty=false;draftRevision=null;status('Gespeichert. Die Macs übernehmen die Werte innerhalb einer Minute für neue Phasenstarts.');}
    catch(e){if(epoch===generation)status(e.message,true);}
    finally{if(epoch===generation){saving=false;draw();}}
  });
  window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
  window.MaxMonitorConsumption={refresh,reset(){generation++;data=null;request=null;dirty=false;draftRevision=null;busy=false;saving=false;status('');$('effort-body').replaceChildren();$('effort-save').hidden=true;$('effort-discard').hidden=true;$('effort-macs').replaceChildren();$('consumption-account').replaceChildren(node('option','','Alle Accounts'));$('consumption-since').textContent='Verbinde den Team-Server für den Tracking-Stand.';drawRows();drawDistribution();}};
})();
