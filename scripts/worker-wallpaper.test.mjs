import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {ensureWorkerWallpaper,solidWallpaperPNG} from './worker-wallpaper.mjs';

const identity={workerId:'pink',workerIdentity:{name:'Pink',color:'#FF69B4'}};
async function fixture(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'worker-wallpaper-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const calls=[];
  const runner=async (command,args)=>{
    calls.push({command,args});
    return JSON.stringify({schema:1,configured:true,changed:args.at(-2)==='apply',
      screens:[{id:'1',path:args.at(-1),scaling:1},{id:'2',path:args.at(-1),scaling:1}]});
  };
  return {directory,calls,runner};
}

test('wallpaper is an opaque sRGB PNG with the exact Mac color in every pixel',()=>{
  const png=solidWallpaperPNG('#FF69B4');
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const chunks=new Map();
  for(let offset=8;offset<png.length;) {
    const size=png.readUInt32BE(offset), name=png.toString('ascii',offset+4,offset+8);
    chunks.set(name,png.subarray(offset+8,offset+8+size)); offset+=size+12;
  }
  const header=chunks.get('IHDR');
  assert.deepEqual([...header.subarray(8,10)],[8,2]);
  assert.deepEqual([...chunks.get('sRGB')],[0]);
  const width=header.readUInt32BE(0),height=header.readUInt32BE(4),pixels=inflateSync(chunks.get('IDAT'));
  assert.equal(width,2560); assert.equal(height,1664);
  for(let y=0;y<height;y++) {
    const start=y*(1+width*3);
    assert.equal(pixels[start],0);
    for(let x=0;x<width;x++) {
      const offset=start+1+x*3;
      if(pixels[offset]!==255 || pixels[offset+1]!==105 || pixels[offset+2]!==180)
        assert.fail(`Wrong pixel at ${x},${y}`);
    }
  }
});

test('apply saves a persistent image and confirms every display; repeat/check reuse the image',async t=>{
  const f=await fixture(t);
  const first=await ensureWorkerWallpaper(identity,f);
  assert.equal(first.screens.length,2);
  assert.equal(first.configured,true);
  assert.equal(first.color,'#FF69B4');
  const before=await fs.stat(first.file);
  await ensureWorkerWallpaper(identity,f);
  assert.equal((await fs.stat(first.file)).mtimeMs,before.mtimeMs);
  const check=await ensureWorkerWallpaper({...identity,check:true},f);
  assert.equal(check.changed,false);
  assert.equal(f.calls[2].args.at(-2),'check');
  assert.ok(f.calls.every(call=>call.command==='/usr/bin/osascript' && call.args.at(-1)===first.file));
  assert.equal((await fs.stat(first.file)).mode & 0o777,0o600);
});

test('read-only checks preserve missing or modified images and never invoke a setter',async t=>{
  const f=await fixture(t);
  const directory=path.join(f.directory,'missing');
  await assert.rejects(ensureWorkerWallpaper({...identity,check:true},{...f,directory}),/fehlt/);
  await assert.rejects(fs.access(directory),{code:'ENOENT'});
  assert.equal(f.calls.length,0);
  const result=await ensureWorkerWallpaper(identity,f);
  await fs.writeFile(result.file,'different image');
  const calls=f.calls.length;
  await assert.rejects(ensureWorkerWallpaper({...identity,check:true},f),/Mac-Farbe/);
  assert.equal(await fs.readFile(result.file,'utf8'),'different image');
  assert.equal(f.calls.length,calls);
});

test('a missing display, another wallpaper or changed stored pixels cannot pass acceptance',async t=>{
  const f=await fixture(t);
  for(const screens of [[],[{id:'1',path:'/other.png',scaling:1}]])
    await assert.rejects(ensureWorkerWallpaper(identity,{...f,runner:async()=>JSON.stringify({schema:1,configured:true,screens})}),/nicht auf allen/);
  await assert.rejects(ensureWorkerWallpaper(identity,{...f,runner:async(command,args)=>{
    await fs.writeFile(args.at(-1),'wrong pixels');
    return JSON.stringify({schema:1,configured:true,screens:[{id:'1',path:args.at(-1),scaling:1}]});
  }}),/Bildfarbe stimmt nicht/);
});

test('personal Macs are unchanged; invalid worker identities never write files or call macOS',async t=>{
  const f=await fixture(t);
  assert.deepEqual(await ensureWorkerWallpaper({workerIdentity:{personal:true}},f),{skipped:true,reason:'personal'});
  for(const value of [{...identity,workerId:'../escape'},{...identity,workerIdentity:{color:'red'}},{...identity,workerIdentity:{}}])
    await assert.rejects(ensureWorkerWallpaper(value,f));
  assert.deepEqual(await fs.readdir(f.directory),[]);
  assert.equal(f.calls.length,0);
});
