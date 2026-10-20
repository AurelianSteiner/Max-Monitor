// A solid, sRGB wallpaper from the canonical monitor identity. No extra packages.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

function chunk(type, data) {
  const content = Buffer.concat([Buffer.from(type),data]);
  let crc = 0xFFFFFFFF;
  for (const byte of content) {
    crc ^= byte;
    for (let bit=0;bit<8;bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  const length = Buffer.alloc(4), checksum = Buffer.alloc(4);
  length.writeUInt32BE(data.length); checksum.writeUInt32BE((crc ^ 0xFFFFFFFF) >>> 0);
  return Buffer.concat([length,content,checksum]);
}

export function solidWallpaperPNG(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) throw new Error('Desktop-Hintergrund benötigt die zentrale Mac-Farbe als Hexfarbe.');
  const width=2560, height=1664;
  const rgb = Buffer.from(color.slice(1),'hex');
  const row = Buffer.alloc(1+width*3);
  for (let x=1;x<row.length;x+=3) rgb.copy(row,x);
  const pixels = Buffer.alloc(row.length*height);
  for (let y=0;y<height;y++) row.copy(pixels,y*row.length);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width,0); header.writeUInt32BE(height,4); header[8]=8; header[9]=2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),chunk('IHDR',header),
    chunk('sRGB',Buffer.from([0])),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);
}

// NSWorkspace works without System Events or an Apple Events permission prompt.
// Only the currently logged-in user's connected screens are changed.
export const WALLPAPER_SCRIPT = `// max-monitor-worker-wallpaper
ObjC.import('AppKit');
function run(args) {
  const workspace=$.NSWorkspace.sharedWorkspace, screens=$.NSScreen.screens;
  if (!screens.count) throw Error('Kein Bildschirm in der angemeldeten macOS-Sitzung erreichbar.');
  const target=$.NSURL.fileURLWithPath(args[1]);
  function observe() {
    const result=[];
    for(let i=0;i<screens.count;i++) {
      const screen=screens.objectAtIndex(i), url=workspace.desktopImageURLForScreen(screen);
      const options=workspace.desktopImageOptionsForScreen(screen);
      const scaling=ObjC.unwrap(options.objectForKey($.NSWorkspaceDesktopImageScalingKey));
      result.push({id:String(ObjC.unwrap(screen.deviceDescription.objectForKey('NSScreenNumber'))),
        path:ObjC.unwrap(url.path),scaling:scaling==null ? 3 : Number(scaling)});
    }
    return result;
  }
  function matches(values) {return values.every(screen=>screen.path===args[1] && screen.scaling===1);}
  const initial=observe();
  if(args[0]==='check' || matches(initial))
    return JSON.stringify({schema:1,configured:matches(initial),changed:false,screens:initial});
  const previous=[], changed=[];
  const options=$.NSMutableDictionary.alloc.init;
  options.setObjectForKey($(Number($.NSImageScaleAxesIndependently)),$.NSWorkspaceDesktopImageScalingKey);
  options.setObjectForKey($(true),$.NSWorkspaceDesktopImageAllowClippingKey);
  try {
    for(let i=0;i<screens.count;i++) {
      const screen=screens.objectAtIndex(i);
      previous.push({screen:screen,url:workspace.desktopImageURLForScreen(screen),options:workspace.desktopImageOptionsForScreen(screen)});
      changed.push(i);
      if(!workspace.setDesktopImageURLForScreenOptionsError(target,screen,options,Ref()))
        throw Error('macOS hat den Desktop-Hintergrund nicht übernommen.');
    }
    for(let attempt=0;attempt<10;attempt++) {
      const current=observe();
      if(matches(current)) return JSON.stringify({schema:1,configured:true,changed:true,screens:current});
      $.NSThread.sleepForTimeInterval(0.2);
    }
    throw Error('Desktop-Hintergrund nach dem Setzen nicht bestätigt.');
  } catch(error) {
    for(const index of changed) {
      const old=previous[index];
      workspace.setDesktopImageURLForScreenOptionsError(old.url,old.screen,old.options,Ref());
    }
    throw error;
  }
}`;

async function nativeRunner(command,args,options) {
  return (await promisify(execFile)(command,args,{timeout:options.timeout,maxBuffer:128*1024})).stdout;
}

export async function ensureWorkerWallpaper({workerId,workerIdentity,check=false}, {
  runner=nativeRunner,directory=path.join(os.homedir(),'Pictures','MacWorker'),
}={}) {
  if (workerIdentity?.personal === true) return {skipped:true,reason:'personal'};
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/.test(workerId || '')) throw new Error('Worker-ID für den Desktop-Hintergrund fehlt.');
  const png=solidWallpaperPNG(workerIdentity?.color);
  const file=path.join(directory,`${workerId}-${workerIdentity.color.slice(1).toUpperCase()}.png`);
  let current;
  try {current=await fs.readFile(file);} catch(error) {if(error.code!=='ENOENT') throw error;}
  if (!current?.equals(png)) {
    if(check) throw new Error('Desktop-Hintergrund fehlt oder hat nicht die zentrale Mac-Farbe. Onboarding erneut ausführen.');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const temporary=`${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary,png,{mode:0o600,flag:'wx'});
      await fs.rename(temporary,file);
    } finally {await fs.rm(temporary,{force:true});}
  }
  const output=await runner('/usr/bin/osascript',['-l','JavaScript','-e',WALLPAPER_SCRIPT,check ? 'check' : 'apply',file],
    {label:'Desktop-Hintergrund setzen und prüfen',timeout:15000});
  let result;
  try {result=JSON.parse(output);} catch {throw new Error('macOS liefert keine gültige Bestätigung des Desktop-Hintergrunds.');}
  if(result.schema!==1 || result.configured!==true || !Array.isArray(result.screens) || !result.screens.length ||
      result.screens.some(screen=>screen.path!==file || screen.scaling!==1))
    throw new Error('Desktop-Hintergrund nicht auf allen Bildschirmen bestätigt. Onboarding in der angemeldeten macOS-Sitzung erneut ausführen.');
  if (!(await fs.readFile(file)).equals(png)) throw new Error('Gespeicherte Desktop-Bildfarbe stimmt nicht mit der Mac-Farbe überein.');
  return {configured:true,color:workerIdentity.color,file,screens:result.screens,changed:result.changed===true};
}
