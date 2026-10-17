"""Install only visual identity; never change worker, network or enrollment IDs.

Payload: {identity, binaryBase64, wallpaperBase64, expected}. For fleet deployment
the existing Max Monitor SSH transport supplies this payload in memory.
"""
import base64, hashlib, json, os, pathlib, plistlib, re, shlex, shutil, subprocess, sys, time

def run(args, **kwargs):
    return subprocess.run(args, capture_output=True, text=True, timeout=20, **kwargs)
def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def install(payload):
    home = pathlib.Path.home()
    identity = payload['identity']
    expected = payload['expected']
    assert not identity.get('personal') and re.fullmatch(r'#[0-9A-Fa-f]{6}',identity['color'])
    assert identity['workerId'] == expected['workerId']
    assert home.name == expected['user']
    root = pathlib.Path(expected['root'])
    worker_agent = home/'Library/LaunchAgents/de.ruegamer-steiner.ai-newsletter.plist'
    protected = {root/'config/worker.local.json':expected['configHash'], worker_agent:expected['launchAgentHash']}
    for path,digest in protected.items():assert sha(path)==digest, 'Production config changed: '+str(path)
    raw = json.loads((root/'config/worker.local.json').read_text())
    assert raw['worker_id']==identity['workerId']
    assert run(['stat','-f','%Su','/dev/console']).stdout.strip()==home.name
    directory = home/'Library/Application Support/RS Worker Identity'
    previous=directory.exists()
    if previous:
        assert json.loads((directory/'identity.json').read_text())==identity, 'Existing identity differs'
        run(['launchctl','bootout',f'gui/{os.getuid()}/de.ruegamer-steiner.worker-identity'])
    else:
        directory.mkdir(parents=True,mode=0o700)
        (directory/'before.json').write_text(json.dumps(expected,ensure_ascii=False,indent=2)+'\n')
    (directory/'applied.json').unlink(missing_ok=True)
    (directory/'identity.json').write_text(json.dumps(identity,ensure_ascii=False)+'\n')
    finish=directory/'finish-computer-name.command'
    finish.write_text('#!/bin/zsh\nset -e\n/usr/bin/sudo /usr/sbin/scutil --set ComputerName '+shlex.quote(identity['name'])+'\n/usr/sbin/scutil --get ComputerName\necho "Fertig. Dieses Fenster kann geschlossen werden."\n')
    finish.chmod(0o700)
    (directory/'wallpaper.png').write_bytes(base64.b64decode(payload['wallpaperBase64']))
    app = home/'Applications/RS Worker Identity.app'
    assert not app.exists() or previous
    executable = app/'Contents/MacOS/RSWorkerIdentity'
    executable.parent.mkdir(parents=True,exist_ok=True)
    candidate=executable.with_suffix('.new')
    candidate.write_bytes(base64.b64decode(payload['binaryBase64']));candidate.chmod(0o755)
    os.replace(candidate,executable)
    info={'CFBundleIdentifier':'de.ruegamer-steiner.worker-identity','CFBundleName':'RS Worker Identity',
          'CFBundleDisplayName':'RS Worker Identity','CFBundleExecutable':'RSWorkerIdentity',
          'CFBundlePackageType':'APPL','CFBundleVersion':'1','CFBundleShortVersionString':'1.0',
          'LSUIElement':True,'LSMinimumSystemVersion':'13.0','NSHighResolutionCapable':True}
    (app/'Contents/Info.plist').write_bytes(plistlib.dumps(info))
    signature=run(['codesign','--force','--sign','-',str(app)])
    assert signature.returncode==0,signature.stderr
    label='de.ruegamer-steiner.worker-identity'
    agent=home/'Library/LaunchAgents'/f'{label}.plist'
    assert not agent.exists() or previous
    agent.parent.mkdir(exist_ok=True)
    agent.write_bytes(plistlib.dumps({'Label':label,'ProgramArguments':[str(executable)],'RunAtLoad':True,
        'LimitLoadToSessionType':'Aqua','ProcessType':'Background','ThrottleInterval':30,
        'StandardOutPath':str(directory/'app.log'),'StandardErrorPath':str(directory/'app-error.log')}))
    result=run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(agent)])
    assert result.returncode==0,result.stderr
    for _ in range(40):
        if (directory/'applied.json').exists():break
        time.sleep(0.25)
    applied=json.loads((directory/'applied.json').read_text())
    assert applied['workerId']==identity['workerId'] and applied['menuItemVisible'] is True
    assert applied['screens'] and all(s['wallpaper']==str(directory/'wallpaper.png') for s in applied['screens'])
    # ComputerName is cosmetic. LocalHostName/HostName stay untouched for SSH/Bonjour.
    rename=run(['sudo','-n','/usr/sbin/scutil','--set','ComputerName',identity['name']])
    name=run(['scutil','--get','ComputerName']).stdout.strip()
    for key in ['LocalHostName','HostName']:
        r=run(['scutil','--get',key]);value=r.stdout.strip() if r.returncode==0 else None
        assert value==expected[{'LocalHostName':'localHostName','HostName':'hostName'}[key]]
    for path,digest in protected.items():assert sha(path)==digest
    service=run(['launchctl','print',f'gui/{os.getuid()}/de.ruegamer-steiner.ai-newsletter']).stdout
    match=re.search(r'\n\s*pid = (\d+)',service)
    assert match and int(match.group(1))==expected['servicePid'], 'Production service changed during installation'
    result={'workerId':identity['workerId'],'name':identity['name'],'computerName':name,
        'computerNameUpdated':name==identity['name'],'renameRequiresAuthentication':rename.returncode!=0,
        'servicePid':int(match.group(1)),'protectedFilesUnchanged':True,'applied':applied}
    (directory/'installation.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(result,ensure_ascii=False))

if __name__=='__main__':
    payload=globals().get('PAYLOAD')
    if payload is None:payload=json.loads(pathlib.Path(sys.argv[1]).read_text())
    install(payload)
